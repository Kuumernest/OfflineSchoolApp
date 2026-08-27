// desktop/src/main/api/writes.js
"use strict";

/**
 * Writes made with no connection.
 *
 * ── What a write has to do here ───────────────────────────────────────────
 *
 * Three things, together or not at all:
 *
 *   1. Produce the row the screen will show a moment later, so the payment
 *      appears in the ledger and the balance moves. Without it the bursar
 *      presses Save and nothing happens, which reads as a failure.
 *   2. Queue the REQUEST — the real one, unchanged — so the server applies it
 *      with every guard it would have applied online.
 *   3. Answer the caller in the shape the server would have answered in, because
 *      the screen reads that response.
 *
 * ── The part that is not obvious ──────────────────────────────────────────
 *
 * A local write has to fill in things only the server normally knows, and the
 * value it invents has to still be right after the server sees it. A receipt
 * number is the whole problem in miniature: it comes from an atomic counter, the
 * bursar hands a printed copy to a parent immediately, and if the server later
 * replaces it then the paper and the record disagree.
 *
 * So the number is issued HERE, carrying this installation's code, and the
 * server keeps it (shared/receipts.js explains the format and why it is safe).
 * The invented value is not a placeholder to be corrected later — it is the
 * final one.
 *
 * ── An id is injected, deliberately ──────────────────────────────────────
 *
 * The UI does not send _id for a new payment; the server generates one. But a
 * queued request may be sent more than once — a connection that dropped after
 * the request arrived and before the response came back — and without a
 * client-supplied id the second attempt creates a second payment. So the id is
 * generated here and put INTO the body before queueing, which is what makes the
 * replay idempotent: the endpoint recognises it and answers with the row it
 * already has.
 */

const { randomUUID } = require("crypto");
const { formatDeviceReceipt } = require("../../../../shared/receipts");
const {
  resolveThresholds,
  requiresApprovalWith,
} = require("../../../../shared/approvalThresholds");

/**
 * The next receipt number for this school and year, on this installation.
 *
 * Counted per academic year, in the meta table, so it survives a restart. It is
 * never reconciled with the server's counter and does not need to be: the two
 * number spaces are distinguishable by shape and neither has to know about the
 * other.
 */
const nextReceipt = (meta, { schoolId, academicYear }) => {
  const key  = `receiptSeq:${schoolId}:${academicYear}`;
  const seq  = Number(meta.get(key) ?? 0) + 1;
  meta.set(key, seq);
  return formatDeviceReceipt(academicYear, meta.deviceCode(), seq);
};

module.exports = [
  {
    route: "POST /api/fees/payments",

    /**
     * Recording money at the counter — the write this whole layer is for.
     */
    handler: ({ body }, { docs, meta, queue }) => {
      const schoolId     = body.schoolId ? String(body.schoolId).trim() : null;
      const studentId    = body.studentId ? String(body.studentId).trim() : null;
      const academicYear = body.academicYear ? String(body.academicYear).trim() : null;

      // Declined rather than guessed. The server validates these and answers a
      // specific 400 for each; reproducing those messages here would be a second
      // set of validation rules to keep in step, so an incomplete request is
      // sent to the server to be refused properly.
      if (!schoolId || !studentId || !academicYear) return null;

      // Whole numbers of XAF — the currency has no minor unit, and the server
      // refuses anything else. Checked because the value goes into a local row
      // that a balance is computed from: a fractional amount would make the
      // mirror disagree with the server arithmetically rather than just be
      // refused.
      const amount = Number(body.amount);
      if (!Number.isInteger(amount) || amount <= 0) return null;

      // The student must be one this machine knows about, for the same reason
      // the server checks: a payment against an id that does not exist is money
      // reconciling against nothing.
      const student = docs.get("student", studentId);
      if (!student || student.deletedAt) return null;

      const id        = body._id ? String(body._id) : randomUUID();
      const receiptNo = nextReceipt(meta, { schoolId, academicYear });
      const now       = new Date().toISOString();

      // Shaped as the server shapes it, because this row is what every fee
      // screen reads until the server's version replaces it — and if the two
      // differ, the ledger changes under the bursar the moment the sync lands.
      const doc = {
        _id: id,
        schoolId, studentId, academicYear,
        term:       body.term ?? null,
        classId:    student.classId ?? null,
        amount,
        method:     body.method ?? "cash",
        reference:  body.reference ?? null,
        note:       body.note ?? null,
        receiptNo,
        receivedAt: body.receivedAt ? new Date(body.receivedAt).toISOString() : now,
        // Left null: the server stamps the authenticated user, and inventing a
        // value here that the server then overwrites would show the wrong name
        // against the payment until the sync landed.
        receivedBy: null,
        source:     "desktop",
        voidedAt:   null,
        deletedAt:  null,
        createdAt:  now,
        updatedAt:  now,
      };

      // The request that will be replayed, with the id and the receipt number in
      // it — so the server stores exactly what is on the printed paper.
      const request = {
        method:  "POST",
        path:    "/api/fees/payments",
        body:    { ...body, _id: id, receiptNo },
        idemKey: id,
      };

      return {
        collection: "feePayment",
        doc,
        request,
        // 201 and { success, data } — exactly the server's answer for a created
        // payment, with nothing added.
        //
        // No `queued` flag in here, tempting as it is. The response shape is a
        // contract the screens read, and a field the server never sends is a
        // field that only exists offline — so any code that came to rely on it
        // would behave differently on the two platforms. Whether something is
        // waiting to be sent is answered by the outbox, which the UI can ask
        // whenever it wants to show it.
        //
        // `totals` is absent for a different reason: the server computes it, and
        // the screens that want it re-read the ledger, which is answered locally
        // anyway.
        response: { status: 201, data: { success: true, data: doc } },
      };
    },
  },
];

module.exports.push({
  route: "POST /api/finance/expenses",

  /**
   * Recording money the school has spent.
   *
   * ── Why this one can refuse ───────────────────────────────────────────────
   *
   * An expense at or above the school's threshold does not simply get written:
   * the server records it as PENDING and raises an approval request, and the row
   * does not count towards any total until somebody signs it off. That somebody
   * is a second person, by design — and a second person is precisely what a
   * machine with no connection does not have.
   *
   * So this reads the threshold from the mirrored School document and declines
   * when approval would be needed, which sends the request to the server to be
   * handled properly. The alternative would be to write a row locally and invent
   * an approval object for the response; a bursar would then see "waiting for
   * approval" against a request nobody has been asked to approve, and the
   * approval queue would gain an entry only when the connection returned.
   *
   * Below the threshold — including the shipped default of no threshold at all —
   * it behaves like any other queued write.
   *
   * ── Simpler than a payment in one way ─────────────────────────────────────
   *
   * There is no receipt number to invent. An expense has no counter behind it,
   * so nothing here has to survive contact with the server's own numbering.
   */
  handler: ({ body }, { docs, queue }) => {
    const schoolId   = body.schoolId ? String(body.schoolId).trim() : null;
    const categoryId = body.categoryId ? String(body.categoryId).trim() : null;
    if (!schoolId || !categoryId) return null;

    // Whole XAF above zero, as the endpoint requires. Checked because the value
    // goes into a local row that a total is computed from — a fractional amount
    // would make the mirror disagree arithmetically rather than simply be
    // refused.
    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) return null;

    // The category must exist here, for the same reason the server checks: an
    // expense against a category nobody can name is a figure with no account.
    const category = docs.get("expenseCategory", categoryId);
    if (!category || category.deletedAt) return null;

    // ── Would this need a second signature? ────────────────────────────────
    //
    // The same rule the server applies, from the same module, against the
    // school's own settings as this machine last saw them. If the mirror has no
    // school document yet then the thresholds resolve to the shipped defaults —
    // no threshold — which would be the wrong answer for a school that has set
    // one. So a missing school document declines rather than assuming.
    const school = docs.get("school", schoolId);
    if (!school) return null;

    const { required } = requiresApprovalWith(
      resolveThresholds(school?.settings?.approvals),
      "expense",
      amount
    );
    if (required) return null;

    const id  = body._id ? String(body._id) : randomUUID();
    const now = new Date().toISOString();

    const doc = {
      _id: id,
      schoolId, categoryId,
      academicYear: body.academicYear ?? null,
      amount,
      description: body.description ?? null,
      vendor:      body.vendor ?? null,
      method:      body.method ?? "cash",
      reference:   body.reference ?? null,
      incurredAt:  body.incurredAt ? new Date(body.incurredAt).toISOString() : now,
      // Stamped by the server from the authenticated user; inventing a value
      // here would show the wrong name against the expense until sync landed.
      recordedBy:  null,
      // Not "pending": approval was checked above and is not required, so this
      // is the status the server will give it.
      status:      "approved",
      approvalId:  null,
      voidedAt:    null,
      deletedAt:   null,
      createdAt:   now,
      updatedAt:   now,
    };

    return {
      collection: "expense",
      doc,
      request: {
        method:  "POST",
        path:    "/api/finance/expenses",
        body:    { ...body, _id: id },
        idemKey: id,
      },
      // The endpoint's own answer for a created expense, including the two
      // fields the screen reads to decide what to say.
      response: {
        status: 201,
        data: { success: true, data: doc, approval: null, pendingApproval: false },
      },
    };
  },
});

module.exports.nextReceipt = nextReceipt;
