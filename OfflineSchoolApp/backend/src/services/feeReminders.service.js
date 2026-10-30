// backend/src/services/feeReminders.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHASING ARREARS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two jobs, both built on the due date a bursar entered when they set up the
 * fee structure:
 *
 *   remind    tell a family what is outstanding, and whether it is late
 *   penalise  add a late fee to a bill that has passed its deadline
 *
 * ── Why the due date lives on the charge ──────────────────────────────────
 *
 * It is copied from the structure onto every charge the structure raises, so
 * everything here is a query rather than a judgement. Two consequences worth
 * knowing:
 *
 *   A charge keeps the deadline it was raised under. Publishing a corrected
 *   structure next term does not move the date on bills already sent.
 *
 *   A charge with no due date counts as overdue at once — a bill with no
 *   deadline is not a bill with an infinite one — but only within a single
 *   academic year: the caller's if it named one, otherwise the school's
 *   current year.
 *
 *   That bound is the whole safety of it. Every charge raised before due dates
 *   existed is undated, so unbounded this would hand a school its entire
 *   history the first time a bursar opened the preview after upgrading. Older
 *   years stay silent permanently; an undated bill raised this year is a real
 *   current debt and is chased.
 *
 * ── Neither job is automatic ──────────────────────────────────────────────
 *
 * No cron, no scheduler. Both are triggered by the bursar from a preview, and
 * that is deliberate rather than unfinished: a reminder is a message to a
 * family and a penalty is money added to their bill. Somebody should have read
 * the list first. It also means a school that has been offline for a week does
 * not come back to a fortnight of backdated messages queued at once.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const FeeCharge   = require("../db/models/FeeCharge");
const FeeStructure = require("../db/models/FeeStructure");
const PaymentPlan = require("../db/models/PaymentPlan");
const Student     = require("../db/models/Student");
const Notification = require("../db/models/Notification");

const { balancesFor } = require("./fees.service");
const { endOfDay, planStatus, firstUnpaid } = require("../../../shared/arrears");
const { arrearsFor } = require("./arrears.service");
const { displayName } = require("../utils/studentName");
const notify = require("./notification");
const School = require("../db/models/School");

/**
 * How long before the same family may be reminded again.
 *
 * A bursar working through a long arrears list will press the button more than
 * once, and a parent who gets the same message four times reads the fourth one
 * less carefully than the first. Overridable per call with `force`, because
 * sometimes a second reminder is exactly the intention.
 */
const REMINDER_COOLDOWN_DAYS = 7;

/** How far ahead "due soon" looks. */
const DUE_SOON_DAYS = 14;

const startOfDay = (d) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};

/**
 * The last instant of a calendar day.
 *
 * Fees due on the 15th are not late at one minute past midnight on the 15th —
 * they are late on the 16th. Comparing against midnight would make every bill
 * overdue on its own due date, which is the kind of off-by-one a parent
 * notices and a developer does not.
 */
const daysBetween = (a, b) =>
  Math.floor((startOfDay(a) - startOfDay(b)) / 86_400_000);

const whole = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
};

const fail = (message, code, status = 400) => {
  const err = new Error(message);
  err.code   = code;
  err.status = status;
  return err;
};

// ─────────────────────────────────────────────────────────────────────────────
// AN AGREED SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

// planStatus — where a family stands against an instalment plan — lives in
// shared/arrears.js, so reminders, late fees and the arrears figures share it.

// firstUnpaid — the first charge payments have not covered — is shared/arrears.js.

/**
 * Active plans for a set of students, keyed by student id.
 *
 * One query rather than one per student: the arrears list is the screen this
 * feeds, and a school with two hundred families on plans would otherwise make
 * two hundred round trips to draw it.
 */
async function activePlans({ schoolId, studentIds, academicYear = null }) {
  if (!studentIds?.length) return new Map();

  const filter = {
    schoolId,
    studentId: { $in: studentIds },
    status:    "active",
    deletedAt: null,
  };
  if (academicYear) filter.academicYear = academicYear;

  const plans = await PaymentPlan.find(filter).lean();
  return new Map(plans.map((p) => [String(p.studentId), p]));
}

// ─────────────────────────────────────────────────────────────────────────────
// WHO OWES, AND WHEN IT WAS DUE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Students who owe, for one academic year, with how much of it is overdue.
 *
 * `balance` is everything owed that year; `overdue` the part past its due date.
 * The date a row quotes is the first unpaid due date that has passed (or, for
 * a family not yet late, the next one coming) — the one a reminder names.
 *
 * @param {object}  p
 * @param {string}  p.schoolId
 * @param {string} [p.academicYear] default: the school's current year
 * @param {string} [p.classId]
 * @param {"overdue"|"dueSoon"|"all"} [p.mode]
 * @param {Date}   [p.asOf] for testing; defaults to now
 */
async function candidates({
  schoolId, academicYear = null, classId = null, mode = "overdue", asOf = new Date(),
  onlyStudentIds = null,
}) {
  if (!schoolId) throw fail("schoolId is required", "BAD_REQUEST");

  // Who owes, and how much of it is late: the one definition every screen
  // reads (arrears.service / shared/arrears). This used to be worked out
  // here on its own, and the bell that read it summed whole balances —
  // next term's fees included — as if they were overdue.
  const { rows: owing } = await arrearsFor({ schoolId, academicYear, classId, onlyStudentIds, asOf });
  if (!owing.length) return [];

  const ids = owing.map((r) => r.studentId);
  const [students, school] = await Promise.all([
    Student.find({ _id: { $in: ids }, schoolId, deletedAt: null })
      .select("_id studentName name firstName lastName enrollmentNo classId " +
              "guardianName guardianPhone guardianEmail email phone")
      .lean(),
    School.findById(schoolId).lean().catch(() => null),
  ]);
  // How this school sends, so "reachable" below answers the same question
  // the notification pipeline will ask rather than a more generous one.
  const channel = await Promise.resolve().then(() => notify.resolveChannel(school)).catch(() => "email");

  const byId = new Map(students.map((s) => [String(s._id), s]));
  const today = startOfDay(asOf);
  const soonCutoff = new Date(today.getTime() + DUE_SOON_DAYS * 86_400_000);

  const rows = [];

  for (const r of owing) {
    const student = byId.get(r.studentId);
    if (!student) continue;

    const isOverdue = r.isOverdue;
    // The date to quote: when they fell behind, else the next one coming.
    const due       = isOverdue ? r.overdueSince : r.nextDue;
    const isDueSoon = !isOverdue && Boolean(due) && due <= soonCutoff;

    if (mode === "overdue" && !isOverdue) continue;
    if (mode === "dueSoon" && !isDueSoon) continue;

    rows.push({
      studentId:    r.studentId,
      name:         displayName(student) ?? null,
      enrollmentNo: student.enrollmentNo ?? null,
      classId:      student.classId ?? null,
      guardianName: student.guardianName ?? null,
      /** Everything owed this year, due or not. */
      balance:  r.owed,
      /** The part of `balance` past its due date. */
      overdue:  r.overdue,
      charged:  r.charged,
      paid:     r.paid,
      earliestDue: due ?? null,
      latestDue:   r.latestDue,
      datedCharges:   r.datedCharges,
      undatedCharges: r.undatedCharges,
      totalCharges:   r.datedCharges + r.undatedCharges,
      isOverdue,
      daysOverdue: isOverdue && due ? daysBetween(asOf, due) : (isOverdue && !due ? 1 : 0),

      // The plan, when there is one. Reported rather than folded into
      // `balance`: what a family owes and what they were meant to have paid by
      // now are two different numbers, and a screen that conflates them cannot
      // explain either.
      onPlan:       r.onPlan,
      planBehindBy: r.plan?.behindBy ?? 0,
      planNextDue:  r.plan?.nextDue ?? null,
      planDueByNow: r.plan?.dueByNow ?? 0,
      /**
       * Whether a message can actually reach this family, asked ON THE
       * CHANNEL THE SCHOOL ACTUALLY USES. Reported rather than filtered on:
       * "we owe 40,000 and have no phone number for them" is the single most
       * useful line on an arrears screen.
       */
      reachable: Boolean(notify.resolveRecipient(student, channel).to),
    });
  }

  // Worst first: most overdue, then largest balance. A bursar works down this
  // list and should not have to sort it.
  rows.sort((a, b) =>
    b.daysOverdue - a.daysOverdue || b.balance - a.balance
  );

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// REMINDING
// ─────────────────────────────────────────────────────────────────────────────

/** Students already reminded within the cooldown. */
async function recentlyReminded(schoolId, studentIds, asOf = new Date()) {
  if (!studentIds.length) return new Set();

  const since = new Date(asOf.getTime() - REMINDER_COOLDOWN_DAYS * 86_400_000);

  const rows = await Notification.find({
    schoolId,
    kind:      "fee.reminder",
    studentId: { $in: studentIds },
    createdAt: { $gte: since },
    // A reminder that failed to send is not a reminder. Only sent and pending
    // count against the cooldown — a failed one should be retried, not
    // suppressed for a week.
    status:    { $in: ["sent", "pending"] },
  }).select("studentId").lean();

  return new Set(rows.map((r) => String(r.studentId)));
}

/**
 * Queue a fee reminder for each named student.
 *
 * Enqueues onto the existing notification pipeline — which resolves the
 * guardian's address, renders in the family's language, and retries with
 * backoff — rather than sending anything itself. Nothing here talks to email.
 *
 * @returns {Promise<{queued: number, skippedRecent: number, skippedUnreachable: number, rows: object[]}>}
 */
async function sendReminders({
  schoolId, studentIds = null, academicYear = null, classId = null,
  mode = "overdue", force = false, requestedBy = null, asOf = new Date(),
}) {
  if (!schoolId) throw fail("schoolId is required", "BAD_REQUEST");

  const all = await candidates({ schoolId, academicYear, classId, mode, asOf });

  // An explicit list narrows the computed set rather than replacing it: a
  // client cannot ask us to remind a family who does not owe anything, or whose
  // bill is not yet due.
  const wanted = Array.isArray(studentIds) && studentIds.length
    ? new Set(studentIds.map(String))
    : null;

  const chosen = wanted ? all.filter((r) => wanted.has(r.studentId)) : all;

  const recent = force
    ? new Set()
    : await recentlyReminded(schoolId, chosen.map((r) => r.studentId), asOf);

  let queued = 0, skippedRecent = 0, skippedUnreachable = 0, failed = 0;
  const rows = [];
  const unreachable = [];

  for (const r of chosen) {
    if (recent.has(r.studentId)) { skippedRecent++; continue; }
    if (!r.reachable)            {
      skippedUnreachable++;
      unreachable.push({ studentId: r.studentId, name: r.name, reason: "No address on file" });
      continue;
    }

    try {
      const note = await notify.enqueue({
        schoolId,
        kind:      "fee.reminder",
        studentId: r.studentId,
        createdBy: requestedBy,
        data: {
          balance:     r.balance,
          dueDate:     r.earliestDue,
          isOverdue:   r.isOverdue,
          daysOverdue: r.daysOverdue,
          // Only for a family on a plan, so the template can quote the
          // arrangement instead of the original bill.
          onPlan:       r.onPlan,
          planBehindBy: r.planBehindBy,
          planNextDue:  r.planNextDue,
        },
      });
      // What enqueue DID, not that it returned.
      //
      // It resolves successfully whether it wrote a message to send or a row
      // recording that it could not. Counting every resolution as queued told
      // the bursar "3 reminders queued" when three families had no address the
      // configured channel could use and nothing would ever be sent — and
      // since the cooldown counts only sent and pending, pressing send again
      // reported another three, indefinitely, with the same result. Its own
      // doc comment asks the caller to read the status rather than assume.
      if (note?.status === "skipped") {
        skippedUnreachable++;
        unreachable.push({
          studentId: r.studentId, name: r.name,
          reason: note.skipReason ?? "No address on file",
        });
      } else if (note?.status === "failed") {
        failed++;
      } else {
        queued++;
        rows.push({ studentId: r.studentId, name: r.name, balance: r.balance });
      }
    } catch (err) {
      // One family's bad address must not stop the rest of the list.
      console.warn(`[feeReminders] could not queue for ${r.studentId}: ${err.message}`);
      failed++;
    }
  }

  console.log(
    `📨 fee reminders for ${schoolId}: ${queued} queued, ` +
    `${skippedRecent} recently reminded, ${skippedUnreachable} unreachable, ` +
    `${failed} failed`
  );

  // unreachable is named, not just counted: "nothing was sent" is a question a
  // bursar has to be able to answer with WHO, or the number is just a mystery.
  return { queued, skippedRecent, skippedUnreachable, failed, rows, unreachable };
}

// ─────────────────────────────────────────────────────────────────────────────
// PENALTIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The code every late fee is raised under.
 *
 * Fixed, and that is what makes applying penalties idempotent: FeeCharge has a
 * unique index on (studentId, structureId, code, term), so a second run can
 * only ever collide with the row the first run wrote. The database enforces
 * "once per student per structure per term" and no code here has to remember to.
 */
const PENALTY_CODE = "LATE";

const penaltyFor = (structure, outstanding) => {
  const p = structure.penalty ?? {};
  const amount = whole(p.amount) ?? 0;
  if (p.mode === "fixed")   return amount;
  if (p.mode === "percent") return Math.round((outstanding * amount) / 100);
  return 0;
};

/**
 * Who has earned a late fee, and how much.
 *
 * Per structure rather than per student, because the penalty rule lives on the
 * structure — two classes on different price lists can have different late fees
 * and different grace periods, and a school-wide figure would be wrong for one
 * of them.
 */
async function penaltyPreview({ schoolId, academicYear = null, structureId = null, asOf = new Date() }) {
  if (!schoolId) throw fail("schoolId is required", "BAD_REQUEST");

  const filter = {
    schoolId, deletedAt: null, isActive: true,
    dueDate: { $ne: null },
    "penalty.mode": { $ne: "none" },
  };
  if (academicYear) filter.academicYear = academicYear;
  if (structureId)  filter._id          = structureId;

  const structures = (await FeeStructure.find(filter).lean())
    .filter((s) => Number(s.penalty?.amount) > 0);

  const out = [];

  for (const structure of structures) {
    const grace = Number(structure.penalty?.graceDays ?? 0);
    const chargeableFrom = new Date(
      endOfDay(structure.dueDate).getTime() + grace * 86_400_000
    );

    // Still inside the grace period: nothing to raise yet.
    if (asOf <= chargeableFrom) continue;

    // Everybody this structure billed, minus anybody who already has the
    // penalty. The exclusion is belt-and-braces — the unique index would refuse
    // the insert anyway — but a preview that lists families who will not
    // actually be charged is a preview nobody can trust.
    const [billed, already] = await Promise.all([
      FeeCharge.distinct("studentId", {
        schoolId, structureId: String(structure._id),
        code: { $ne: PENALTY_CODE }, deletedAt: null, voidedAt: null,
      }),
      FeeCharge.distinct("studentId", {
        schoolId, structureId: String(structure._id),
        code: PENALTY_CODE, deletedAt: null,
      }),
    ]);

    const done = new Set(already.map(String));
    const ids  = billed.map(String).filter((id) => !done.has(id));
    if (!ids.length) continue;

    const [students, balances, plans] = await Promise.all([
      Student.find({ _id: { $in: ids }, schoolId, deletedAt: null })
        .select("_id studentName name firstName lastName enrollmentNo classId")
        .lean(),
      balancesFor({ schoolId, studentIds: ids, academicYear: structure.academicYear }),
      activePlans({ schoolId, studentIds: ids, academicYear: structure.academicYear }),
    ]);

    const byId = new Map(students.map((s) => [String(s._id), s]));

    for (const id of ids) {
      const student = byId.get(id);
      if (!student) continue;

      const totals      = balances.get(id);
      const outstanding = totals?.balance ?? 0;
      // Paid up. A family that settled during the grace period owes no penalty,
      // which is the whole point of having one.
      if (outstanding <= 0) continue;

      // ── An agreed plan, being kept to, is an exemption ─────────────────
      //
      // A late fee for missing a deadline the school itself replaced would make
      // the arrangement worthless. So a family on an active plan is charged
      // only if they are behind on THAT schedule.
      //
      // Not a blanket exemption: a plan-holder who has paid nothing is behind
      // from the first date, and is penalised like anybody else. If a school
      // wants to stop honouring an arrangement entirely it cancels the plan,
      // which is a deliberate act with a reason attached.
      const plan = plans.get(id);
      if (plan) {
        const status = planStatus(plan, totals?.paid ?? 0, asOf);
        if (!status.isBehind) continue;
      }

      const amount = penaltyFor(structure, outstanding);
      if (amount <= 0) continue;

      out.push({
        studentId:   id,
        name:        displayName(student) ?? null,
        enrollmentNo: student.enrollmentNo ?? null,
        classId:     student.classId ?? null,
        structureId: String(structure._id),
        academicYear: structure.academicYear,
        term:        structure.term ?? null,
        dueDate:     structure.dueDate,
        graceDays:   grace,
        daysOverdue: daysBetween(asOf, structure.dueDate),
        outstanding,
        mode:        structure.penalty.mode,
        rate:        structure.penalty.amount,
        amount,
        /** So a preview can say why a plan-holder is on the list. */
        onPlan:      Boolean(plan),
      });
    }
  }

  out.sort((a, b) => b.amount - a.amount || b.daysOverdue - a.daysOverdue);
  return out;
}

/**
 * Raise the late fees from a preview.
 *
 * Recomputes the preview rather than trusting a list from the client: the
 * amounts are derived from what is outstanding right now, and a percentage
 * penalty calculated in the browser five minutes ago is not a figure to write
 * into a ledger.
 *
 * @returns {Promise<{raised: number, total: number, skipped: number, rows: object[]}>}
 */
async function applyPenalties({
  schoolId, academicYear = null, structureId = null, studentIds = null,
  raisedBy = null, asOf = new Date(),
}) {
  const preview = await penaltyPreview({ schoolId, academicYear, structureId, asOf });

  const wanted = Array.isArray(studentIds) && studentIds.length
    ? new Set(studentIds.map(String))
    : null;

  const chosen = wanted ? preview.filter((r) => wanted.has(r.studentId)) : preview;
  if (!chosen.length) return { raised: 0, total: 0, skipped: 0, rows: [] };

  const rows = chosen.map((r) => ({
    schoolId,
    studentId:    r.studentId,
    academicYear: r.academicYear,
    term:         r.term,
    structureId:  r.structureId,
    classId:      r.classId,
    code:         PENALTY_CODE,
    label:        "Late payment penalty",
    amount:       r.amount,
    // A penalty has no deadline of its own. Giving it one would make it
    // eligible for a penalty of its own later, which is how a late fee turns
    // into compound interest nobody agreed to.
    dueDate:      null,
    raisedBy,
  }));

  try {
    const inserted = await FeeCharge.insertMany(rows, { ordered: false });
    const total = inserted.reduce((s, r) => s + r.amount, 0);
    console.log(
      `⚠️  ${inserted.length} late fees raised for ${schoolId}, total ${total} XAF`
    );
    return {
      raised:  inserted.length,
      total,
      skipped: rows.length - inserted.length,
      rows:    inserted.map((r) => ({
        studentId: r.studentId, amount: r.amount, term: r.term,
      })),
    };
  } catch (err) {
    // A duplicate here means somebody applied the same penalties a moment ago —
    // the expected outcome of a double-click, not a failure.
    if (err?.code === 11000 || err?.writeErrors) {
      const raised = err.result?.nInserted ?? err.insertedDocs?.length ?? 0;
      return {
        raised,
        total:   0,
        skipped: rows.length - raised,
        rows:    [],
      };
    }
    throw err;
  }
}

module.exports = {
  planStatus,
  activePlans,
  REMINDER_COOLDOWN_DAYS,
  DUE_SOON_DAYS,
  PENALTY_CODE,
  candidates,
  recentlyReminded,
  sendReminders,
  penaltyPreview,
  applyPenalties,
  // Exported for the check script.
  endOfDay,
  firstUnpaid,
  penaltyFor,
};
