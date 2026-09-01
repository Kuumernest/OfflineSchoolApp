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
 *   A charge with no due date is invisible to both jobs. That is the correct
 *   reading of a bill with no deadline — there is nothing to be late for — and
 *   it is what every charge raised before this feature existed looks like. No
 *   school gets a surprise batch of reminders for last year on upgrade day.
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
const endOfDay = (d) => {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
};

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

/**
 * Where a family stands against an instalment plan.
 *
 * The one piece of arithmetic both jobs share, and the reason it is a function
 * rather than two similar loops: reminders decide who to write to and late fees
 * decide who to charge, and those two must never disagree about whether a family
 * is keeping to its arrangement.
 *
 * CUMULATIVE, not per instalment. By the third date a family should have paid
 * the first three instalments in total — so somebody who paid double on the
 * first and nothing on the second is exactly on track. Checking instalments one
 * by one would flag them as behind, which is wrong and is precisely the kind of
 * wrong that makes a bursar stop trusting the list.
 *
 * @param {{instalments: Array<{seq:number,amount:number,dueDate:Date}>}} plan
 * @param {number} paid  what the family has actually paid, from the ledger
 * @param {Date}   asOf
 * @returns {{
 *   dueByNow: number, behindBy: number, isBehind: boolean,
 *   nextDue: Date|null, nextAmount: number, missedSince: Date|null, settled: boolean
 * }}
 */
function planStatus(plan, paid, asOf = new Date()) {
  const schedule = [...(plan?.instalments ?? [])].sort((a, b) => a.seq - b.seq);

  let dueByNow    = 0;
  let nextDue     = null;
  let nextAmount  = 0;
  let missedSince = null;
  let running     = 0;

  for (const inst of schedule) {
    running += inst.amount;

    // Due if its day has ended. endOfDay for the same reason as everywhere
    // else: an instalment due on the 15th is not late on the 15th.
    if (endOfDay(inst.dueDate) < asOf) {
      dueByNow = running;
      // The earliest date by which the family had fallen short. Walking
      // forwards means the FIRST shortfall wins, which is the date a reminder
      // should quote — not the most recent one.
      if (missedSince === null && paid < running) missedSince = inst.dueDate;
    } else if (nextDue === null) {
      nextDue    = inst.dueDate;
      nextAmount = inst.amount;
    }
  }

  const behindBy = Math.max(0, dueByNow - paid);

  return {
    dueByNow,
    behindBy,
    isBehind: behindBy > 0,
    nextDue,
    nextAmount,
    missedSince,
    /** Every instalment covered, whether or not the dates have passed. */
    settled: paid >= running,
  };
}

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
 * Students with an outstanding balance on a dated charge.
 *
 * The balance is per student per year — what a family actually owes — while the
 * due date is per charge. So a student's "deadline" here is the EARLIEST due
 * date among their unpaid charges: that is the one that has already passed, and
 * the one a reminder should quote.
 *
 * @param {object}  p
 * @param {string}  p.schoolId
 * @param {string} [p.academicYear]
 * @param {string} [p.classId]
 * @param {"overdue"|"dueSoon"|"all"} [p.mode]
 * @param {Date}   [p.asOf] for testing; defaults to now
 */
async function candidates({
  schoolId, academicYear = null, classId = null, mode = "overdue", asOf = new Date(),
}) {
  if (!schoolId) throw fail("schoolId is required", "BAD_REQUEST");

  const chargeFilter = {
    schoolId,
    deletedAt: null,
    voidedAt:  null,
  };
  if (academicYear) chargeFilter.academicYear = academicYear;
  if (classId)      chargeFilter.classId      = classId;

  // Two groups: charges with a due date (which have a deadline) and charges
  // without one (which have no grace period — they are overdue immediately).
  const [dated, undated] = await Promise.all([
    // Dated charges: earliest/latest due date per student.
    FeeCharge.aggregate([
      { $match: { ...chargeFilter, dueDate: { $ne: null } } },
      {
        $group: {
          _id:         "$studentId",
          earliestDue: { $min: "$dueDate" },
          latestDue:   { $max: "$dueDate" },
          datedCharges: { $sum: 1 },
        },
      },
    ]),
    // Undated charges: count per student, no deadline to compute.
    FeeCharge.aggregate([
      { $match: { ...chargeFilter, dueDate: null } },
      {
        $group: {
          _id:           "$studentId",
          undatedCharges: { $sum: 1 },
        },
      },
    ]),
  ]);

  // Merge the two groups into one map keyed by studentId.
  const merged = new Map();
  for (const d of dated) {
    merged.set(String(d._id), {
      studentId:    String(d._id),
      earliestDue:  d.earliestDue,
      latestDue:    d.latestDue,
      datedCharges: d.datedCharges,
      undatedCharges: 0,
    });
  }
  for (const u of undated) {
    const id = String(u._id);
    if (merged.has(id)) {
      merged.get(id).undatedCharges = u.undatedCharges;
    } else {
      merged.set(id, {
        studentId:    id,
        earliestDue:  null,
        latestDue:    null,
        datedCharges: 0,
        undatedCharges: u.undatedCharges,
      });
    }
  }

  if (!merged.size) return [];

  const studentIds = [...merged.keys()];

  const [students, balances, plans, channel] = await Promise.all([
    Student.find({ _id: { $in: studentIds }, schoolId, deletedAt: null })
      .select("_id studentName name firstName lastName enrollmentNo classId " +
              "guardianName guardianPhone guardianEmail email phone")
      .lean(),
    balancesFor({ schoolId, studentIds, academicYear }),
    activePlans({ schoolId, studentIds, academicYear }),
    // How this school sends, so "reachable" below answers the same question
    // the notification pipeline will ask rather than a more generous one.
    School.findById(schoolId).lean().then(notify.resolveChannel).catch(() => "email"),
  ]);

  const byId = new Map(students.map((s) => [String(s._id), s]));
  const today = startOfDay(asOf);
  const soonCutoff = new Date(today.getTime() + DUE_SOON_DAYS * 86_400_000);

  const rows = [];

  for (const [id, group] of merged) {
    const student = byId.get(id);
    if (!student) continue;

    const totals  = balances.get(id);
    const balance = totals?.balance ?? 0;
    if (balance <= 0) continue;

    const plan   = plans.get(id);
    const status = plan ? planStatus(plan, totals?.paid ?? 0, asOf) : null;

    let due, isOverdue, isDueSoon, hasUndated = group.undatedCharges > 0;

    if (status) {
      isOverdue = status.isBehind;
      due       = status.isBehind ? status.missedSince : status.nextDue;
      if (!due && !hasUndated) continue;
      isDueSoon = !isOverdue && due && due <= soonCutoff;
    } else if (group.earliestDue) {
      due       = group.earliestDue;
      isOverdue = endOfDay(due) < asOf;
      isDueSoon = !isOverdue && due <= soonCutoff;
    } else if (hasUndated) {
      // No due date on any charge — treat as overdue immediately (no grace
      // period). This covers pre-feature charges and manually created bills.
      due       = null;
      isOverdue = true;
      isDueSoon = false;
    } else {
      continue;
    }

    if (mode === "overdue" && !isOverdue) continue;
    if (mode === "dueSoon" && !isDueSoon) continue;

    const totalCharges = group.datedCharges + group.undatedCharges;

    rows.push({
      studentId:    id,
      name:         displayName(student) ?? null,
      enrollmentNo: student.enrollmentNo ?? null,
      classId:      student.classId ?? null,
      guardianName: student.guardianName ?? null,
      balance,
      charged: totals?.charged ?? 0,
      paid:    totals?.paid    ?? 0,
      earliestDue: due,
      latestDue:   group.latestDue,
      datedCharges: group.datedCharges,
      undatedCharges: group.undatedCharges,
      totalCharges,
      isOverdue,
      daysOverdue: isOverdue && due ? daysBetween(asOf, due) : (isOverdue && !due ? 1 : 0),

      // The plan, when there is one. Reported rather than folded into
      // `balance`: what a family owes and what they were meant to have paid by
      // now are two different numbers, and a screen that conflates them cannot
      // explain either.
      onPlan:       Boolean(status),
      planBehindBy: status?.behindBy ?? 0,
      planNextDue:  status?.nextDue ?? null,
      planDueByNow: status?.dueByNow ?? 0,
      /**
       * Whether a message can actually reach this family.
       *
       * Reported rather than filtered on, because "we owe 40,000 and have no
       * phone number for them" is the single most useful line on an arrears
       * screen — and silently dropping those rows would hide it.
       *
       * Asked ON THE CHANNEL THE SCHOOL ACTUALLY USES. It used to be "any
       * contact detail at all", which is a different question from the one the
       * notification pipeline asks: a school on email needs an email address,
       * and a phone number does not substitute. Every family in a school that
       * records phone numbers and sends by email therefore read as reachable
       * here and was skipped for want of an address one layer down.
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
  penaltyFor,
};
