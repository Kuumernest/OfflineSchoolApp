// desktop/src/main/api/writes/feePayments.js
"use strict";

/**
 * Undoing a payment, with no connection.
 *
 * ── A reversal is two rows, and that is the whole difficulty ───────────────
 *
 * It says the payment should never have been recorded — a mistyped amount, the
 * wrong student. The correction is a new row with the opposite sign, and the
 * original stays exactly as it was written, because a ledger that edits its own
 * history is not a ledger.
 *
 * But the original is also STAMPED, with reversedById. That stamp is not
 * bookkeeping: it is what stops the same payment being reversed a second time.
 * The endpoint refuses that with 409 ALREADY_REVERSED, and a 409 stops the
 * offline queue and waits for a person — so if this layer appended the negative
 * row without stamping the original, the screen would go on offering Reverse,
 * somebody would press it, and the queue would jam with every payment behind it
 * held up.
 *
 * So both rows commit with the request or neither does. That is what `also` on
 * the write result is for, and the queue records the second row so the engine
 * settles it too — a row nothing settles stays pending for ever, and a pending
 * row is deliberately never overwritten by a pull.
 *
 * ── Two numbers a machine with no connection has to invent ────────────────
 *
 * The reversal's id, so the reply describes a row this machine already holds.
 * And its receipt number, because the bursar prints the credit note at the
 * counter and hands it over: the server's counter is precisely what cannot be
 * reached, so the number is issued here in this installation's own space and the
 * endpoint keeps it. shared/receipts.js explains why the two spaces cannot
 * collide.
 */

const { randomUUID } = require("crypto");
const { nextReceipt } = require("../receiptCounter");
const { totalsFor }   = require("../handlers/fees");

module.exports = [
  {
    route: "POST /api/fees/payments/:id/reverse",

    handler: ({ params, body }, { docs, meta, session }) => {
      const schoolId = body.schoolId ? String(body.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;
      if (!session?.permissions?.includes("fees.manage")) return null;

      // The endpoint's 400. A reversal without one is money moved for no
      // recorded reason, which is the question an auditor asks first.
      const reason = String(body.reason ?? "").trim();
      if (!reason) return null;

      const original = docs.get("feePayment", String(params.id));
      if (!original) return null;                                   // its 404
      if (String(original.schoolId) !== String(schoolId)) return null;

      // Its two 409s. Both would stop the queue, and both are states a screen
      // working from a stale list could easily offer.
      if (original.reversedById) return null;   // ALREADY_REVERSED
      if (original.reversesId)   return null;   // IS_REVERSAL

      const id  = randomUUID();
      const now = new Date().toISOString();

      // Counted in this installation's own space, per academic year — the same
      // counter a payment taken offline draws from, so a day's paperwork numbers
      // consecutively whatever kind of row it is.
      const receiptNo = nextReceipt(meta, {
        schoolId, academicYear: original.academicYear,
      });

      const reversal = {
        _id:            id,
        schoolId,
        studentId:      original.studentId,
        academicYear:   original.academicYear,
        term:           original.term ?? null,
        classId:        original.classId ?? null,
        // The opposite sign, not a flag: the pair nets to zero and both rows
        // stay legible a year later.
        amount:         -original.amount,
        method:         original.method,
        reference:      original.reference ?? null,
        receiptNo,
        receivedAt:     now,
        receivedBy:     session?.userId ?? null,
        reversesId:     String(original._id),
        reversalReason: reason,
        // The endpoint hard-codes "web" for its own writes. This row was made on
        // a desktop with no connection, and saying so is the only way anybody
        // could later tell where it came from.
        source:         "desktop",
        voidedAt:       null,
        deletedAt:      null,
        createdAt:      now,
        updatedAt:      now,
      };

      const stamped = {
        ...original,
        reversedById:   id,
        reversalReason: reason,
        updatedAt:      now,
      };

      return {
        collection: "feePayment",
        doc:        reversal,

        // The stamp on the original. Committed in the same transaction and
        // recorded on the queue entry — see the file note.
        also: [{ collection: "feePayment", doc: stamped }],

        request: {
          method: "POST",
          path:   `/api/fees/payments/${original._id}/reverse`,
          body:   { ...body, _id: id, receiptNo },
        },

        /**
         * 201 and { success, data, totals } — exactly the endpoint's shape.
         *
         * A function rather than an object, because the balance has to be read
         * AFTER both rows are committed. Computed any earlier it would still
         * include the money that has just been taken back off the account, and
         * the bursar would be shown the figure they were trying to correct.
         */
        response: (committed) => ({
          status: 201,
          data: {
            success: true,
            data:    reversal,
            totals:  totalsFor(committed.docs, {
              schoolId,
              studentId:    original.studentId,
              academicYear: original.academicYear,
            }),
          },
        }),
      };
    },
  },
];
