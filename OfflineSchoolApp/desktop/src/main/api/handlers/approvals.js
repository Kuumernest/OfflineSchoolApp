// desktop/src/main/api/handlers/approvals.js
"use strict";

/**
 * What is waiting for a second signature.
 *
 * ── The first handlers that depend on who is asking ───────────────────────
 *
 * Everything before this answered from the request alone. These cannot: the list
 * shows everything waiting to somebody who may DECIDE, and only their own
 * requests to somebody who may not — because a person cannot approve what they
 * raised, so showing them a queue they cannot act on would be a queue of
 * disappointments.
 *
 * The identity comes from the session the window handed over. It is not a
 * permission check and is not treated as one: it decides what this machine draws
 * from a mirror that already holds only what this user could pull, and every
 * decision is a write the server authorises on replay.
 *
 * ── Why the queue is worth having offline at all ──────────────────────────
 *
 * Approving needs a second person and a connection. Seeing what is waiting does
 * not, and it is the more common act: a bursar checks whether the expense they
 * raised on Tuesday has been signed off, and a head teacher walks in and asks
 * what needs them. Both of those are reads.
 *
 * Deciding is deliberately NOT handled offline. It could be queued — the server
 * enforces approver ≠ requester on replay — but a head teacher who taps Approve
 * and sees it succeed has been told the expense now counts, and it does not
 * until the machine reaches the server. The gap between those two is exactly
 * where a school would spend money it had not really released.
 */

// At the top, not inside the handler that uses it.
//
// This require was originally inside the summary handler, with one '../' too few —
// handlers/ sits a directory deeper than api/, where the same import lives in
// writes.js. A require that throws inside a handler is caught by the dispatcher
// and turned into "not answered here", so the wrong path did not fail: the
// endpoint quietly went to the network and everything looked fine. At the top it
// would have failed at load, loudly, which is the failure worth having.
const { resolveThresholds } = require("../../../../../shared/approvalThresholds");

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/** As approvals.service list() bounds it: at least 1, at most 500, default 100. */
const boundLimit = (raw) => Math.max(1, Math.min(500, Number(raw) || 100));

module.exports = [
  {
    route: "GET /api/approvals",
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;

      // No identity means this cannot be answered the way the server would.
      // Declining rather than showing everything: the difference between the two
      // answers is precisely "requests other people raised".
      if (!session?.userId) return null;

      const canDecide = session.permissions.includes("approvals.decide");

      const status = query.status ?? "pending";
      const filter = { schoolId, deletedAt: null };
      // "all" is the escape hatch the service honours; anything else is matched.
      if (status && status !== "all") filter.status = status;
      if (query.kind) filter.kind = String(query.kind).trim();
      // A decider sees the school's queue. Everybody else sees their own only.
      if (!canDecide) filter.requestedBy = session.userId;

      const rows = docs
        .find("approvalRequest", filter)
        .sort((a, b) => String(b.requestedAt ?? "").localeCompare(String(a.requestedAt ?? "")))
        .slice(0, boundLimit(query.limit));

      return ok({
        count: rows.length,
        // The screen draws Approve buttons or a status column on this.
        canDecide,
        data: rows,
      });
    },
  },

  {
    route: "GET /api/approvals/summary",
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : null;
      if (!schoolId) return null;
      if (!session?.userId) return null;

      const canDecide = session.permissions.includes("approvals.decide");

      // Everything waiting in the school — NOT narrowed by requester, even for
      // somebody who cannot decide. The tile says how much the school is holding
      // up; the `mine` figure beside it says how much of that is theirs.
      const pending = docs.count("approvalRequest", {
        schoolId, status: "pending", deletedAt: null,
      });

      const mine = docs.count("approvalRequest", {
        schoolId, status: "pending", deletedAt: null, requestedBy: session.userId,
      });

      // The thresholds in force, so a screen can explain why something did or
      // did not need approval without a second call. Read from the mirrored
      // school; the shared resolver applies the same defaults the server does.
      const school = docs.get("school", schoolId);
      if (!school) return null;

      return ok({
        data: {
          pending,
          mine,
          canDecide,
          thresholds: resolveThresholds(school?.settings?.approvals),
        },
      });
    },
  },
];
