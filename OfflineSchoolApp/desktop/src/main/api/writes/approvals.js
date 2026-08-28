// desktop/src/main/api/writes/approvals.js
"use strict";

/**
 * Approvals: withdrawing a request, and setting the thresholds.
 *
 * ── Deciding is NOT here, and that is the point ────────────────────────────
 *
 * POST /api/approvals/:id/approve and /reject are online-only, recorded in
 * coverage.js with their reasons. Briefly: approving does not merely record a
 * decision, it APPLIES one — services/approvals.service.js has a per-kind
 * applier that creates the refund payment, lets the pending expense count, puts
 * the waiver on the charge. Queueing that would put "approved" on a head
 * teacher's screen while the money had not moved, and the person waiting on it
 * had not in fact been answered.
 *
 * It also has a state no local implementation can reproduce: the decision is
 * saved BEFORE the effect is attempted, so a failed apply leaves a request that
 * was genuinely approved and genuinely did not take effect. Two facts, both
 * true, and an offline layer that collapsed them into one would hide whichever
 * one it dropped.
 *
 * ── What IS here ──────────────────────────────────────────────────────────
 *
 * Withdrawing your own request, which decides nothing and releases nothing. And
 * the thresholds, which are school configuration rather than an act.
 */

const {
  parseThreshold,
  resolveThresholds,
} = require("../../../../../shared/approvalThresholds");

module.exports = [
  {
    route: "PUT /api/approvals/thresholds",

    /**
     * Above what amount does an expense, a refund or a waiver need a second
     * signature.
     *
     * ── Why this is safe to queue, and it is not obvious ────────────────────
     *
     * These thresholds are a control on money, and the local expense write reads
     * them to decide whether it may act at all. So a change made here while
     * offline could plausibly desynchronise the two sides: the desktop starts
     * judging expenses against the new figure while the server still holds the
     * old one, and the same expense gets two different answers.
     *
     * It does not, because the outbox is strictly FIFO. A threshold change
     * queued at ten o'clock is sent before any expense queued after it, so the
     * server applies the new figure first and judges those expenses by it —
     * exactly as this machine did. The ordering guarantee is doing real work
     * here, not just keeping things tidy.
     *
     * ── null and zero are different, and both are real ──────────────────────
     *
     * null means "never require approval for this", which is the shipped
     * default. Zero means "always" — the setting for a school that wants every
     * refund countersigned. A handler that treated an empty field as zero would
     * silently turn a school's whole ledger into a queue of approvals.
     */
    handler: ({ body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("approvals.configure")) return null;

      // The endpoint's 400s, from the same function it uses.
      const parsed = {
        expenseThreshold: parseThreshold(body.expenseThreshold, "expenseThreshold"),
        refundThreshold:  parseThreshold(body.refundThreshold,  "refundThreshold"),
        waiverThreshold:  parseThreshold(body.waiverThreshold,  "waiverThreshold"),
      };
      for (const one of Object.values(parsed)) {
        if (one.error) return null;
      }

      // The School document, which is also what the expense write reads. A
      // mirror without it declines rather than writing thresholds onto nothing.
      const school = docs.get("school", schoolId);
      if (!school) return null;

      const next = {
        expenseThreshold: parsed.expenseThreshold.value,
        refundThreshold:  parsed.refundThreshold.value,
        waiverThreshold:  parsed.waiverThreshold.value,
        payrollRequired:  body.payrollRequired === true,
      };

      const { _pending, ...existing } = school;

      const doc = {
        ...existing,
        settings: { ...(existing.settings ?? {}), approvals: next },
        updatedAt: new Date().toISOString(),
      };

      return {
        collection: "school",
        doc,
        request: {
          method: "PUT",
          path:   "/api/approvals/thresholds",
          body,
        },
        // The endpoint answers with the RESOLVED thresholds, not the raw ones —
        // so a screen reading the reply sees the same defaults filled in that it
        // would see on a later read.
        response: { status: 200, data: { success: true, data: resolveThresholds(next) } },
      };
    },
  },

  {
    route: "POST /api/approvals/:id/cancel",

    /**
     * Taking back a request you raised, before anybody has decided it.
     *
     * ── Not gated by approvals.decide, deliberately ─────────────────────────
     *
     * Un-asking your own question is not a decision about somebody else's work.
     * The endpoint checks only that the request is yours, which is why there is
     * no permission check below and why there should not be one.
     *
     * ── Two documents ───────────────────────────────────────────────────────
     *
     * Cancelling an EXPENSE request also marks the expense itself rejected. The
     * endpoint does that because a withdrawn expense must not keep sitting
     * outside the accounts with nothing waiting to resolve it — so it is one
     * request and two rows, committed together through `also`.
     *
     * ── The race this cannot win ────────────────────────────────────────────
     *
     * Somebody may decide the request while this cancellation is queued. The
     * server then answers 409 ALREADY_DECIDED, and a 409 stops the outbox and
     * waits for a person — over an ordinary race that resolved itself correctly.
     * Every condition that can be checked here IS checked, but this one cannot
     * be: it is about the server's state, not this machine's. Worth knowing
     * about rather than hiding, and the honest mitigation would be for the queue
     * to learn that some conflicts mean "somebody got there first" and can be
     * discarded rather than escalated.
     */
    handler: ({ params, body }, { docs, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.userId) return null;

      const request = docs.get("approvalRequest", String(params.id));
      if (!request) return null;                                   // its 404
      if (String(request.schoolId) !== String(schoolId)) return null;
      if (request.deletedAt) return null;

      // Its 409: already approved, rejected or cancelled.
      if (request.status !== "pending") return null;

      // Its 403. The check the endpoint makes, and the only one it makes.
      if (String(request.requestedBy ?? "") !== String(session.userId)) return null;

      const now = new Date().toISOString();

      const { _pending: _p, ...existing } = request;
      const cancelled = {
        ...existing,
        status:    "cancelled",
        decidedBy: session.userId,
        decidedAt: now,
        updatedAt: now,
      };

      // The linked expense, where there is one. Note the endpoint's update is
      // conditional on the expense still being pending, so a row already
      // rejected or approved is left exactly as it is.
      const also = [];
      if (request.kind === "expense" && request.targetId) {
        const expense = docs.get("expense", String(request.targetId));
        if (
          expense &&
          String(expense.schoolId) === String(schoolId) &&
          !expense.deletedAt &&
          expense.status === "pending"
        ) {
          const { _pending: _q, ...row } = expense;
          also.push({
            collection: "expense",
            doc: { ...row, status: "rejected", updatedAt: now },
          });
        }
      }

      return {
        collection: "approvalRequest",
        doc:        cancelled,
        also,
        request: {
          method: "POST",
          path:   `/api/approvals/${request._id}/cancel`,
          body,
        },
        response: { status: 200, data: { success: true, data: cancelled } },
      };
    },
  },
];
