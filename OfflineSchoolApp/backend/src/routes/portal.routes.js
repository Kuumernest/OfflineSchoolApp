// backend/src/routes/portal.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const School        = require("../db/models/School");
const Class         = require("../db/models/Class");
// Needed by /announcements, to read the class of every child on the access
// rather than only the one the token resolved.
const Student       = require("../db/models/Student");
// Written by /notifications to remember when the parent last looked.
const GuardianAccess = require("../db/models/GuardianAccess");
const Period        = require("../db/models/Period");
const Subject       = require("../db/models/Subject");
const FeeCharge     = require("../db/models/FeeCharge");
const FeePayment    = require("../db/models/FeePayment");
const PaymentPlan   = require("../db/models/PaymentPlan");
const Notification  = require("../db/models/Notification");
const ResultSummary = require("../db/models/ResultSummary");
const GeneratedReport = require("../db/models/GeneratedReport");
const Conversation  = require("../db/models/Conversation");
const commsPolicy   = require("../services/communication/policy.service");
const comms         = require("../services/communication/conversation.service");
// Attendance.js exports TWO models. Importing the module as one silently
// yields an object with no .find, which fails only when the route is called.
const { StudentAttendance } = require("../db/models/Attendance");
const Announcement  = require("../db/models/Announcement");

const portal = require("../services/portal.service");
const { buildReceiptHtml } = require("../print/receipt");
const { labelsFor, formatPrintDate } = require("../print/labels");
const { displayName } = require("../utils/studentName");
const GateEvent = require("../db/models/GateEvent");

/**
 * The guardian portal.
 *
 * Every route here is READ-ONLY, and every one of them reads the student id
 * from the verified token rather than from the request. A guardian cannot ask
 * for another child by changing a parameter, because no route accepts a student
 * id at all.
 *
 * What is exposed is what a parent is already entitled to know about their own
 * child: what has been charged and paid, published results, attendance, and
 * announcements. Nothing about other students, staff, or the school's finances.
 */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const fail = (res, err) =>
  res.status(err.status ?? 500).json({
    success: false,
    code:    err.code ?? "ERROR",
    message: err.message,
    ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
  });

const originOf = (req) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return host ? `${proto}://${host}` : null;
};

const schoolHeading = async (schoolId) => {
  const school = await School.findOne({ _id: schoolId }).lean();
  return {
    name:    school?.name ?? null,
    logo:    school?.logo ?? null,
    address: school?.address ?? null,
    phone:   school?.phone ?? null,
    email:   school?.email ?? null,
    motto:   school?.motto ?? null,
    academicYear: school?.settings?.academicYear ?? null,
    currentTerm:  school?.settings?.currentTerm ?? null,
  };
};

/**
 * Which school a public visitor is signing in to.
 *
 * A guardian standing at a login form does not know a school id, and asking for
 * one would be asking them to read a UUID off a slip. Where the deployment
 * serves a single school — which this one does — that is resolved here. A
 * multi-school deployment must send `schoolId`, and gets a clear error rather
 * than being silently signed in to whichever school happened to be first.
 */
const resolvePublicSchool = async (provided) => {
  if (provided) return String(provided).trim();

  const schools = await School.find({ deletedAt: null }).select("_id").limit(2).lean();
  if (schools.length === 1) return String(schools[0]._id);

  const err = new Error("A school must be specified");
  err.status = 400;
  err.code   = "SCHOOL_REQUIRED";
  throw err;
};

// ═════════════════════════════════════════════════════════════════════════════
// SIGN IN  (public)
// ═════════════════════════════════════════════════════════════════════════════

router.post("/login", asyncHandler(async (req, res) => {
  try {
    const schoolId = await resolvePublicSchool(req.body.schoolId);
    const result = await portal.login({
      schoolId,
      admissionNo: req.body.admissionNo,
      code:        req.body.code,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    return fail(res, err);
  }
}));

// ═════════════════════════════════════════════════════════════════════════════
// Everything below needs a portal token
// ═════════════════════════════════════════════════════════════════════════════

router.use(portal.portalAuth);

// ── Which notification kinds a guardian may see ─────────────────────────────
//
// Module scope, because two routes need it: /notifications lists them and /me
// counts the unseen ones for the tab badge. One allowlist, read from one place.
//
// An ALLOW-list, deliberately, and not to be turned into a blocklist.
//
// `body` below is the rendered message the pipeline sent, and that is why
// config/syncFeed.js refuses to mirror this collection at all: for an admin
// welcome or a password reset the body contains a temporary password. None
// of those kinds are listed here and none may be added. Anything new is
// opted in by name after somebody has looked at what its body holds.
//
// Until now the list was fee reminders and payments only, so a parent could
// see what they owed and never that their child had been marked absent,
// scanned through the gate, or that a term's results had been published —
// messages the school had already sent them by email or SMS.
/**
 * The notices one guardian may see, and which of them they have not read.
 *
 * Both routes need the same two filters and they must not drift: /me counts
 * the unread for the tab badge and /notifications lists them and says which
 * is which. A badge that disagrees with the list under it is worse than no
 * badge.
 */
const noticeFilters = ({ schoolId, studentIds, accessId, noticesSeenAt }) => {
  const all = {
    schoolId,
    studentId: { $in: (studentIds ?? []).map(String) },
    kind: { $in: GUARDIAN_NOTICE_KINDS },
    deletedAt: null,
    // Rendered. A template that would not render is stored `failed` so it is
    // visible to us, and has nothing to show a parent.
    subject: { $ne: null },
  };

  const unread = {
    ...all,
    // No receipt from THIS guardian. Two parents on one child read the same
    // notice separately.
    readBy: { $not: { $elemMatch: { accessId: String(accessId) } } },
  };
  // Everything from before the old whole-tab marker counts as read, so the
  // switch to per-notice receipts does not light up a term of history.
  if (noticesSeenAt) unread.createdAt = { $gt: noticesSeenAt };

  return { all, unread };
};

const GUARDIAN_NOTICE_KINDS = [
  "fee.reminder",
  "fee.payment",
  "attendance.absent",
  "gate.arrival",
  "gate.departure",
  "result.published",
  "announcement",
];

/**
 * The school heading, EVERY child this code covers, and which one is selected.
 *
 * All of them, not just the selected one: a parent with three at the school
 * needs to switch between them, and a screen that has to fetch the list
 * separately shows an empty switcher on first paint.
 */
router.get("/me", asyncHandler(async (req, res) => {
  const { student, schoolId, studentIds } = req.portal;

  const children = await portal.childrenOf(schoolId, studentIds);

  const classIds = children.map((c) => c.classId).filter(Boolean);
  const classes  = await Class.find({ _id: { $in: classIds }, schoolId })
    .select("name").lean();
  const className = new Map(classes.map((c) => [String(c._id), c.name]));

  // How many unread messages are waiting.
  //
  // Here rather than only on /notifications because this is the one endpoint
  // every screen loads, whatever tab it is showing — and a badge that needs a
  // second request to a tab the parent has not opened is a badge no client
  // draws. A parent had no indication anywhere that a message had arrived; the
  // count existed and nothing carried it to a place it could be seen.
  //
  // Read-only and best-effort: a messaging fault must not take out the screen
  // that shows a child's fees.
  const unreadMessages = await (async () => {
    try {
      const me      = comms.principalFromRequest(req);
      const threads = await comms.listFor(me, { limit: 50 });
      return threads.reduce((total, c) => {
        const mine = (c.participants || []).find(
          (p) => p.kind === "guardian" && String(p.id) === String(me.id)
        );
        return total + Math.max(0, (c.lastMessageSeq || 0) - (mine?.lastReadSeq || 0));
      }, 0);
    } catch {
      return 0;
    }
  })();

  // School notices that arrived since this parent last opened the tab. Same
  // reasoning as unreadMessages: it rides on the one request every screen
  // makes, because a badge that needs a request to the tab it is about is a
  // badge nobody can draw before the parent has already gone there.
  const unreadNotices = await (async () => {
    try {
      const { unread } = noticeFilters({
        schoolId, studentIds,
        accessId:      req.portal.accessId,
        noticesSeenAt: req.portal.noticesSeenAt,
      });
      return await Notification.countDocuments(unread);
    } catch {
      return 0;
    }
  })();

  return res.json({
    success: true,
    data: {
      school: await schoolHeading(schoolId),
      children: children.map((c) => ({
        ...c,
        className: c.classId ? (className.get(String(c.classId)) ?? null) : null,
      })),
      selectedId: String(student._id),
      unreadMessages,
      unreadNotices,
      student: {
        _id:          String(student._id),
        name:         displayName(student) || null,
        enrollmentNo: student.enrollmentNo ?? null,
        className:    student.classId
          ? (className.get(String(student.classId)) ?? null)
          : null,
        status:       student.status,
      },
    },
  });
}));

/** The fee account: what was charged, what has been paid, what is left. */
router.get("/fees", asyncHandler(async (req, res) => {
  const { studentId, schoolId } = req.portal;
  const filter = { schoolId, studentId, deletedAt: null };
  if (req.query.academicYear) filter.academicYear = req.query.academicYear;

  const [charges, payments] = await Promise.all([
    FeeCharge.find({ ...filter, voidedAt: null }).sort({ createdAt: 1 }).lean(),
    FeePayment.find(filter).sort({ receivedAt: 1 }).lean(),
  ]);

  const charged = charges.reduce((s, c) => s + (c.amount ?? 0), 0);
  const waived  = charges.reduce((s, c) => s + (c.waivedAmount ?? 0), 0);
  // Reversals are negative rows, so a plain sum is already net of them.
  const paid    = payments.reduce((s, p) => s + (p.amount ?? 0), 0);

  return res.json({
    success: true,
    data: {
      charges: charges.map((c) => ({
        _id: c._id, label: c.label, code: c.code,
        amount: c.amount, waivedAmount: c.waivedAmount,
        academicYear: c.academicYear, term: c.term,
      })),
      payments: payments.map((p) => ({
        _id: p._id, receiptNo: p.receiptNo, amount: p.amount,
        method: p.method, reference: p.reference, receivedAt: p.receivedAt,
        academicYear: p.academicYear,
        isReversal: Boolean(p.reversesId) || (p.amount ?? 0) < 0,
      })),
      totals: { charged, waived, paid, balance: charged - waived - paid },
    },
  });
}));

/**
 * Fee reminders — what this child owes, with due dates and status.
 *
 * This is the in-app alternative to email reminders: a guardian can see
 * exactly what is outstanding, when it is due, and whether it is late.
 * The school does not need to send an email — the parent checks the portal.
 */
router.get("/fees/reminders", asyncHandler(async (req, res) => {
  const { studentId, schoolId } = req.portal;

  const charges = await FeeCharge.find({
    schoolId, studentId, deletedAt: null, voidedAt: null,
  }).sort({ dueDate: 1, createdAt: 1 }).lean();

  const payments = await FeePayment.find({
    schoolId, studentId, deletedAt: null,
  }).lean();

  const totalPaid = payments.reduce((s, p) => s + (p.amount ?? 0), 0);
  const totalCharged = charges.reduce((s, c) => s + (c.amount ?? 0), 0);
  const totalWaived = charges.reduce((s, c) => s + (c.waivedAmount ?? 0), 0);
  const balance = totalCharged - totalWaived - totalPaid;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Check for an active payment plan
  const plan = await PaymentPlan.findOne({
    schoolId, studentId, status: "active", deletedAt: null,
  }).lean();

  // Build reminders from undischarged charges with due dates
  const reminders = charges
    .filter((c) => c.dueDate && !c.voidedAt)
    .map((c) => {
      const dueDate = new Date(c.dueDate);
      const isOverdue = dueDate < today;
      const daysOverdue = isOverdue
        ? Math.floor((today - dueDate) / 86_400_000)
        : 0;
      const isDueSoon = !isOverdue &&
        dueDate <= new Date(today.getTime() + 14 * 86_400_000);

      return {
        chargeId:    c._id,
        code:        c.code,
        label:       c.label,
        amount:      c.amount,
        waivedAmount: c.waivedAmount ?? 0,
        netAmount:   c.amount - (c.waivedAmount ?? 0),
        dueDate:     c.dueDate,
        isOverdue,
        isDueSoon,
        daysOverdue,
        academicYear: c.academicYear,
        term:        c.term,
      };
    });

  return res.json({
    success: true,
    data: {
      balance,
      totalCharged,
      totalWaived,
      totalPaid,
      reminders,
      hasPlan: Boolean(plan),
      plan: plan ? {
        _id:         plan._id,
        reason:      plan.reason,
        instalments: plan.instalments ?? [],
      } : null,
    },
  });
}));

/**
 * Fee-related notifications (reminders, payment confirmations, etc.)
 *
 * This is the in-app alternative to email: the parent sees every reminder the
 * school sent, right here in the portal. The notification record already exists
 * from the email/SMS pipeline — this endpoint just surfaces it.
 */
router.get("/notifications", asyncHandler(async (req, res) => {
  const { studentId, studentIds, schoolId, accessId } = req.portal;


  // Filtered on what RENDERED, not on what was delivered.
  //
  // This was `status: { $ne: "skipped" }`, and that one clause is most of the
  // reported bug. A notification is skipped when nothing was attempted and
  // retrying cannot help — overwhelmingly because the family has no email
  // address on file, which is the ordinary state of the school that reported
  // this. So the surface that needs no address at all was the one hiding the
  // record, and a gate scan that had been dutifully written down was invisible
  // to the only person it was for.
  //
  // `subject: { $ne: null }` replaces it. That excludes the one row that has
  // nothing to show — a template that would not render, stored as `failed` so
  // it is visible to us rather than thrown at a bursar mid-payment — while a
  // skipped row, which rendered fully and then found nowhere to go, is exactly
  // what a parent should see.
  // Every child on the access, not only the one on screen.
  //
  // Fees, results and attendance are per-child because the thing itself is: a
  // balance, a report card, a register. A notice is an event — "Mark arrived at
  // 07:42", "Constance was not recorded at school today" — and a parent wants
  // all of them in one place. Scoping this to the selected child is how a
  // parent looking at their eldest never learns the younger one was absent,
  // which is the same mistake /announcements was making and the same fix.
  //
  // Each row carries the child it concerns so the card can say whose it is.
  const forChildren = (studentIds ?? [studentId]).map(String);

  const { all: notificationFilter, unread: unreadFilter } = noticeFilters({
    schoolId, studentIds: forChildren, accessId,
    noticesSeenAt: req.portal.noticesSeenAt,
  });

  const notifications = await Notification.find(notificationFilter)
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  // ── Unread threads, as notices ───────────────────────────────────────────
  //
  // A message to a parent raised no notification anywhere. It should not raise
  // a row in the collection above: that is a delivery queue with a channel and
  // a retry backoff, so a row in it is an email or an SMS actually going out,
  // and one per message on a live thread is the noise problem all over again.
  //
  // Derived here instead, from conversations that are already stored — so it
  // survives a reload, a new session and a dead transport for the same reason
  // everything else here does. One entry per thread, not per message: a thread
  // with nine unread is one thing to go and read.
  //
  // This was being assembled on the phone. Moving it here means every client
  // gets it, the ordering is decided once, and the unread total below exists
  // at all — a client cannot badge a tab it has to fetch two endpoints to
  // count.
  const me       = comms.principalFromRequest(req);
  const threads  = await comms.listFor(me, { limit: 50 }).catch(() => []);

  const messageNotices = threads
    .map((c) => {
      const mine = (c.participants || []).find(
        (p) => p.kind === "guardian" && String(p.id) === String(me.id)
      );
      const unread = Math.max(0, (c.lastMessageSeq || 0) - (mine?.lastReadSeq || 0));
      if (unread < 1) return null;

      const others = (c.participants || []).filter(
        (p) => !(p.kind === "guardian" && String(p.id) === String(me.id))
      );

      return {
        // Prefixed, so it cannot collide with a Notification id and a client
        // keying a list by _id has one namespace.
        _id:     `message-${c._id}`,
        kind:    "message",
        subject: c.title || others.map((p) => p.name).filter(Boolean).join(", ") || null,
        body:    c.lastMessagePreview || null,
        text:    c.lastMessagePreview || null,
        // Nothing was queued, so nothing can be pending or failed. Without
        // this the card prints a delivery status for a delivery that never
        // happened.
        status:  "sent",
        sentAt:  c.lastMessageAt,
        createdAt: c.lastMessageAt,
        conversationId: c._id,
        unread,
        // The other side, structured, so a client names the thread in its own
        // language rather than reading the server's English back out.
        otherParticipants: others.map((p) => ({
          kind: p.kind, id: p.id, name: p.name, role: p.role,
          childNames: p.childNames ?? [], officeLabel: p.officeLabel ?? null,
        })),
      };
    })
    .filter(Boolean);

  // Counted against the marker rather than a flag per row: a notice has no
  // per-guardian read state, and giving it one would mean a write for every
  // card a parent scrolls past.
  const unreadNotices = await Notification.countDocuments(unreadFilter);

  // Which of the listed rows this guardian has read, so the card can show it.
  // Computed against the same floor the count uses, or a card could look
  // unread while contributing nothing to the badge.
  const seenAt = req.portal.noticesSeenAt ?? null;
  const isRead = (n) =>
    (seenAt && n.createdAt && new Date(n.createdAt) <= new Date(seenAt)) ||
    (n.readBy ?? []).some((r) => String(r.accessId) === String(accessId));

  const rows = [
    ...messageNotices,
    ...notifications.map((n) => ({
      _id:       n._id,
      kind:      n.kind,
      studentId: n.studentId ?? null,
      read:      isRead(n),
      subject:   n.subject,
      // `text` is the displayable form. `body` is the channel's payload, and
      // for email that is a whole HTML document — which a phone put straight
      // into a Text node, showing the reader the markup. Falls back to
      // data.text for rows written before `text` was a field, then to body,
      // because something legible beats nothing.
      body:      n.text ?? n.data?.text ?? n.body,
      html:      n.body,
      data:      n.data,
      status:    n.status,
      skipReason: n.skipReason ?? null,
      sentAt:    n.sentAt,
      createdAt: n.createdAt,
    })),
  ].sort((a, b) =>
    String(b.sentAt || b.createdAt || "").localeCompare(String(a.sentAt || a.createdAt || ""))
  );

  // Nothing is marked read here any more.
  //
  // This used to stamp noticesSeenAt and clear the whole tab the moment the
  // list loaded, which is not what "read" means when four notices arrived and
  // the parent looked at one. Each card is marked by being opened — see
  // POST /notifications/:id/read below — and noticesSeenAt stays frozen as the
  // floor for everything cleared under the old behaviour.

  return res.json({
    success: true,
    // What a badge needs, counted once on the side that can count it.
    unread: messageNotices.reduce((n, m) => n + m.unread, 0),
    // School notices that arrived since this parent last opened the tab, which
    // is what the tab's own badge counts. Deliberately NOT including the
    // unread-thread rows above: those are counted by the Messages badge, and a
    // number that appears in two places at once is a number nobody trusts.
    unreadNotices,
    data: rows,
  });
}));

/**
 * Mark every unread notice read.
 *
 * Per-card receipts are right for a parent who opens the tab daily and wrong
 * for one coming back after a week of gate scans, who otherwise faces a dozen
 * taps to clear a badge. This is the companion to the endpoint below, not a
 * replacement for it.
 *
 * The filter is the same `unread` one the count uses, so this clears exactly
 * what the badge was counting — no more, and nothing belonging to another
 * family or another child. Rows already read are excluded by that filter, so
 * their original readAt stands.
 */
router.post("/notifications/read-all", asyncHandler(async (req, res) => {
  const { schoolId, studentIds, accessId } = req.portal;

  const { unread } = noticeFilters({
    schoolId, studentIds, accessId, noticesSeenAt: req.portal.noticesSeenAt,
  });

  const result = await Notification.updateMany(
    unread,
    { $addToSet: { readBy: { accessId: String(accessId), readAt: new Date() } } }
  );

  return res.json({
    success: true,
    marked: result.modifiedCount ?? 0,
    // Zero by construction, and sent anyway so the client settles on the
    // server's number rather than assuming.
    unreadNotices: await Notification.countDocuments(unread),
  });
}));

/**
 * Mark one notice read.
 *
 * The filter is the caller's own scope — their school, their children, and a
 * kind on the allowlist — so a guardian cannot stamp a receipt onto a row
 * belonging to somebody else's child, and cannot use this to discover that one
 * exists: an id outside their scope is a 404 whether or not it is real.
 *
 * $addToSet, so the same card tapped twice is one receipt and the first
 * readAt stands. Idempotent by construction, which matters because the phone
 * marks optimistically and retries nothing.
 */
router.post("/notifications/:id/read", asyncHandler(async (req, res) => {
  const { schoolId, studentIds, accessId } = req.portal;

  const result = await Notification.updateOne(
    {
      _id: String(req.params.id),
      schoolId,
      studentId: { $in: (studentIds ?? []).map(String) },
      kind: { $in: GUARDIAN_NOTICE_KINDS },
      deletedAt: null,
      readBy: { $not: { $elemMatch: { accessId: String(accessId) } } },
    },
    { $addToSet: { readBy: { accessId: String(accessId), readAt: new Date() } } }
  );

  // Nothing matched means either "already read" or "not yours". Those are the
  // same answer to the caller: it is read now either way, and saying which
  // would tell a guardian whether a notice they cannot see exists.
  if (!result.matchedCount) {
    const exists = await Notification.countDocuments({
      _id: String(req.params.id),
      schoolId,
      studentId: { $in: (studentIds ?? []).map(String) },
      deletedAt: null,
    });
    if (!exists) return res.status(404).json({ success: false, message: "Not found" });
  }

  const { unread } = noticeFilters({
    schoolId, studentIds, accessId, noticesSeenAt: req.portal.noticesSeenAt,
  });

  // The new count comes back with the acknowledgement, so a client that marked
  // optimistically can settle onto the server's number without another round
  // trip to /me.
  return res.json({
    success: true,
    unreadNotices: await Notification.countDocuments(unread),
  });
}));

/**
 * A printable receipt for one payment.
 *
 * The payment is looked up with the token's student id in the filter, so a
 * guardian who edits the id in the URL gets a 404 rather than someone else's
 * receipt.
 */
router.get("/receipt/:paymentId", asyncHandler(async (req, res) => {
  const { studentId, schoolId, student } = req.portal;

  const payment = await FeePayment.findOne({
    _id: req.params.paymentId, studentId, schoolId, deletedAt: null,
  }).lean();

  if (!payment) {
    return res.status(404).json({ success: false, message: "Receipt not found" });
  }

  const [charges, payments, klass] = await Promise.all([
    FeeCharge.find({ schoolId, studentId, deletedAt: null, voidedAt: null }).lean(),
    FeePayment.find({ schoolId, studentId, deletedAt: null }).lean(),
    student.classId
      ? Class.findOne({ _id: student.classId, schoolId }).select("name").lean()
      : null,
  ]);

  const charged = charges.reduce((s, c) => s + (c.amount ?? 0), 0);
  const waived  = charges.reduce((s, c) => s + (c.waivedAmount ?? 0), 0);
  const paid    = payments.reduce((s, p) => s + (p.amount ?? 0), 0);

  const data = {
    school: await schoolHeading(schoolId),
    student: {
      name: displayName(student) || null,
      enrollmentNo: student.enrollmentNo ?? null,
      className: klass?.name ?? null,
    },
    payment,
    totals: { charged, waived, paid, balance: charged - waived - paid },
  };

  const lang = req.query.lang;
  const html = buildReceiptHtml({
    data,
    labels:    labelsFor(lang),
    lang,
    // The date the money changed hands, not today — a receipt reprinted in
    // March for a payment made in October is still October's receipt.
    printedOn: formatPrintDate(new Date(payment.receivedAt ?? Date.now()), lang),
    origin:    originOf(req),
  });

  res.type("html");
  return res.send(html);
}));

/** Published results only — a draft is a teacher's working copy. */
router.get("/results", asyncHandler(async (req, res) => {
  const { studentId, schoolId } = req.portal;

  const rows = await ResultSummary.find({
    schoolId, studentId, isPublished: true, deletedAt: null,
  }).sort({ academicYear: -1, term: -1 }).lean();

  return res.json({
    success: true,
    data: rows.map((r) => ({
      _id: r._id, academicYear: r.academicYear, term: r.term,
      className: r.className, average: r.average, percentage: r.percentage,
      overallGrade: r.overallGrade, classPosition: r.classPosition,
      totalInClass: r.totalInClass, isPassing: r.isPassing,
      // Summary aggregates — the same figures the report card prints, so the
      // portal can mirror the issued card instead of showing a bare average.
      totalScore: r.totalScore, maxTotalScore: r.maxTotalScore,
      gpa: r.gpa, overallRemark: r.overallRemark,
      principalRemark: r.principalRemark, promotionStatus: r.promotionStatus,
      subjectsPassed: r.subjectsPassed, subjectsFailed: r.subjectsFailed,
      subjectsTotal: r.subjectsTotal, isPartial: r.isPartial,
      issuedAt: r.publishedAt,
      subjects: (r.subjectBreakdown ?? []).map((s) => ({
        subjectId: s.subjectId, subjectName: s.subjectName,
        score: s.score, maxScore: s.maxScore,
        normalizedMark: s.normalizedMark, coefficient: s.coefficient,
        weightedMark: s.weightedMark, grade: s.grade, remark: s.remark,
        isPassing: s.isPassing, isAbsent: s.isAbsent,
      })),
    })),
  });
}));

/**
 * GET /api/portal/results/:summaryId/report-card
 *
 * The printable card for one published result.
 *
 * Serves the FROZEN copy the school issued, never a re-render. A parent
 * opening this two years from now must see the card as issued, even after the
 * school has edited its template or corrected another student's marks — which
 * is the whole reason GeneratedReport stores renderedHtml.
 *
 * Scoped to this guardian's own student and to published results, so the
 * summary id alone cannot be used to read another child's card.
 */
router.get("/results/:summaryId/report-card", asyncHandler(async (req, res) => {
  const { studentId, schoolId } = req.portal;

  const summary = await ResultSummary.findOne({
    _id:         req.params.summaryId,
    studentId,
    schoolId,
    isPublished: true,
    deletedAt:   null,
  }).select("examId term academicYear").lean();

  if (!summary) {
    return res.status(404).json({
      success: false,
      error:   "Result not found",
    });
  }

  const report = await GeneratedReport.findOne({
    examId:    summary.examId,
    studentId,
    deletedAt: null,
  }).select("renderedHtml templateVersion updatedAt").lean();

  if (!report?.renderedHtml) {
    // Published marks but no issued card: the school has not printed one yet.
    // Say so plainly rather than inventing a layout the school never approved.
    return res.status(404).json({
      success: false,
      error:   "No report card has been issued for this result yet",
      code:    "NOT_ISSUED",
    });
  }

  return res.json({
    success: true,
    data: {
      html:         report.renderedHtml,
      term:         summary.term,
      academicYear: summary.academicYear,
      issuedAt:     report.updatedAt,
    },
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGING — the guardian side
//
// Guardians are not Users, so they cannot use /api/messages, which sits
// behind the staff authenticate(). These four routes give them the same
// conversations through their own token, and defer every question of who
// they may talk to to the same policy module the staff routes use.
// ─────────────────────────────────────────────────────────────────────────────

/** Conversations this guardian is part of. */
router.get("/messages/conversations", asyncHandler(async (req, res) => {
  const me   = comms.principalFromRequest(req);
  const rows = await comms.listFor(me, { limit: req.query.limit });

  return res.json({
    success: true,
    data: rows.map((c) => {
      const mine = (c.participants || []).find(
        (p) => p.kind === "guardian" && String(p.id) === String(me.id)
      );

      // Everyone on the thread except this guardian.
      //
      // A direct thread carries no title — it is named for the other person,
      // the same convention the staff app uses. The portal had no way to apply
      // it, because naming the other side means knowing which participant is
      // you, and only the server does. So it joined every participant instead
      // and showed a parent their own name over a message from a teacher, or
      // fell through to the word "Conversation" when the names were absent.
      // Either way the one thing a parent needs — who wrote to me — was the
      // thing missing.
      const others = (c.participants || []).filter(
        (p) => !(p.kind === "guardian" && String(p.id) === String(me.id))
      );

      return {
        _id:                c._id,
        kind:               c.kind,
        title:              c.title,
        participants:       c.participants,
        otherParticipants:  others.map((p) => ({
          kind: p.kind, id: p.id, name: p.name, role: p.role,
          // labelGuardians has already put these on the participant; passing
          // them through is what lets the row name an unnamed guardian in the
          // reader's language instead of the server's.
          childNames: p.childNames ?? [], officeLabel: p.officeLabel ?? null,
        })),
        lastMessageAt:      c.lastMessageAt,
        lastMessagePreview: c.lastMessagePreview,
        isArchived:         c.isArchived,
        unread: Math.max(0, (c.lastMessageSeq || 0) - (mine?.lastReadSeq || 0)),
      };
    }),
  });
}));

/**
 * Who this guardian may write to.
 *
 * Same gate as the staff route: candidates are narrowed by a query and then
 * decided by canMessage(), so the picker can never offer somebody the send
 * path will refuse.
 */
router.get("/messages/recipients", asyncHandler(async (req, res) => {
  const me       = comms.principalFromRequest(req);
  const settings = await comms.loadSettings(me.schoolId);

  const candidates = await comms.findCandidateRecipients(me, settings, {
    q:     String(req.query.q || ""),
    limit: Number(req.query.limit) || 40,
  });

  const allowed = candidates
    .filter((c) => commsPolicy.canMessage(me, c, settings).allowed)
    .map((c) => ({
      kind:     c.kind,
      id:       c.id,
      name:     c.name,
      role:     c.kind === "guardian" ? "guardian" : c.role,
      subtitle: c.subtitle ?? null,
      // See the same projection in messages.routes.js: `name` has English
      // baked in for an unnamed guardian, and these two are what let the
      // phone write the label in the language the phone is set to.
      childNames:  c.childNames  ?? [],
      officeLabel: c.officeLabel ?? null,
    }));

  return res.json({ success: true, data: allowed });
}));

/** Open, or reuse, a thread with a teacher, an administrator, or own child. */
router.post("/messages/conversations", asyncHandler(async (req, res) => {
  const me = comms.principalFromRequest(req);
  const { kind = "user", id } = req.body || {};

  if (!id) {
    return res.status(400).json({ success: false, message: "id is required" });
  }

  const target = await comms.resolveTargetPrincipal(me.schoolId, kind, id);
  if (!target) {
    return res.status(404).json({ success: false, message: "Recipient not found" });
  }

  const settings = await comms.loadSettings(me.schoolId);
  const verdict  = commsPolicy.canMessage(me, target, settings);

  if (!verdict.allowed) {
    return res.status(403).json({ success: false, message: verdict.reason });
  }

  const conversation = await comms.openDirect(me, target);
  return res.status(201).json({ success: true, data: conversation });
}));

/** Read a thread. Guardians never audit — membership or nothing. */
router.get("/messages/conversations/:id", asyncHandler(async (req, res) => {
  const me = comms.principalFromRequest(req);

  const conversation = await Conversation.findOne({
    _id: String(req.params.id), schoolId: me.schoolId, deletedAt: null,
  }).lean();

  if (!conversation || !commsPolicy.isParticipant(me, conversation)) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const docs = await comms.listMessages(conversation._id, {
    limit:     req.query.limit,
    beforeSeq: req.query.beforeSeq,
  });

  const messages = docs.map((m) => m.toClientJSON());

  // The parent sees their own name here too, and "Parent/Guardian" is not a
  // name. Their children are what the school knows them by.
  await comms.labelGuardians(conversation.schoolId, {
    conversations: [conversation],
    messages,
  });

  const participantReads = (conversation.participants || []).map((p) => ({
    kind:             p.kind,
    id:               p.id,
    lastReadSeq:      p.lastReadSeq      || 0,
    lastDeliveredSeq: p.lastDeliveredSeq || 0,
  }));

  return res.json({
    success: true,
    data: {
      conversation,
      messages,
      participantReads,

      // Who is asking. The portal has no other way to know: a guardian is
      // identified by their GuardianAccess row and /portal/me does not carry
      // it, so the thread screen could not tell the parent's own messages from
      // the school's — every bubble looked the same, and a read receipt has
      // nothing to attach itself to without this.
      me: { kind: me.kind, id: String(me.id) },
    },
  });
}));

/** Post into a thread. */
router.post("/messages/conversations/:id", asyncHandler(async (req, res) => {
  const me = comms.principalFromRequest(req);

  const conversation = await Conversation.findOne({
    _id: String(req.params.id), schoolId: me.schoolId, deletedAt: null,
  });

  if (!conversation) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const verdict = commsPolicy.canPostToConversation(me, conversation);
  if (!verdict.allowed) {
    return res.status(403).json({ success: false, message: verdict.reason });
  }

  const { body, attachments = [], replyTo = null,
          clientId = null, deviceCreatedAt = null } = req.body || {};

  const { message, duplicate } = await comms.postMessage({
    conversation, principal: me,
    body, attachments, replyTo, clientId, deviceCreatedAt,
  });

  return res.status(duplicate ? 200 : 201).json({
    success: true, duplicate, data: message.toClientJSON(),
  });
}));

/** Move the read marker. */
router.post("/messages/conversations/:id/read", asyncHandler(async (req, res) => {
  const me  = comms.principalFromRequest(req);
  const seq = req.body?.seq;

  if (seq == null) {
    return res.status(400).json({ success: false, message: "seq is required" });
  }

  const conversation = await Conversation.findOne({
    _id: String(req.params.id), schoolId: me.schoolId, deletedAt: null,
  }).lean();

  if (!conversation || !commsPolicy.isParticipant(me, conversation)) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  await comms.markRead(conversation._id, me, seq);
  return res.json({ success: true });
}));

/** Attendance, period-by-period. A parent wants to know exactly which lessons their child attended. */
router.get("/attendance", asyncHandler(async (req, res) => {
  const { studentId, schoolId } = req.portal;

  const filter = { schoolId, studentId };
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = String(req.query.from);
    if (req.query.to)   filter.date.$lte = String(req.query.to);
  }

  const rows = await StudentAttendance.find(filter).sort({ date: -1, periodId: 1 }).limit(500).lean();

  // ── The gate, over the same window ────────────────────────────────────
  //
  // A parent could not see what time their child reached school. The scan
  // does notify them, but only through the exceptions policy — a late
  // arrival or an early departure — and that policy is right: "arrived
  // 07:42" pushed to a phone every morning is noise somebody stops opening,
  // and then the message that mattered is buried in it.
  //
  // A portal is not a push. Nobody is interrupted by a page they chose to
  // open, so the times belong here in full, and the notification policy is
  // left exactly as it was. On-time arrivals now have somewhere to be seen
  // without becoming something a parent has to be told.
  const gateFilter = { schoolId, studentId, voidedAt: null, deletedAt: null };
  if (filter.date) gateFilter.date = filter.date;

  const gateRows = await GateEvent
    .find(gateFilter)
    .sort({ date: -1, at: 1 })
    .limit(500)
    .lean()
    .catch(() => []);

  // One row per day: first way in, last way out. A child signed out for a
  // dentist and back again has two of each, and the day still reads as the
  // morning they arrived and the afternoon they finally left.
  const gateByDate = new Map();
  for (const g of gateRows) {
    if (!gateByDate.has(g.date)) {
      gateByDate.set(g.date, { date: g.date, arrivedAt: null, departedAt: null, scans: 0 });
    }
    const day = gateByDate.get(g.date);
    day.scans += 1;
    const at = g.at ? new Date(g.at).toISOString() : null;
    if (!at) continue;
    if (g.direction === "in") {
      if (!day.arrivedAt || at < day.arrivedAt) day.arrivedAt = at;
    } else {
      if (!day.departedAt || at > day.departedAt) day.departedAt = at;
    }
  }

  // Resolve names for periods and subjects referenced in the records
  const periodIds  = [...new Set(rows.map((r) => r.periodId).filter(Boolean))];
  const subjectIds = [...new Set(rows.map((r) => r.subjectId).filter(Boolean))];

  const [periodDocs, subjectDocs] = await Promise.all([
    periodIds.length
      ? Period.find({ _id: { $in: periodIds }, schoolId, deletedAt: null })
          .select("_id name startTime endTime sortOrder").lean()
      : [],
    subjectIds.length
      ? Subject.find({ _id: { $in: subjectIds }, schoolId, deletedAt: null })
          .select("_id name code").lean()
      : [],
  ]);

  const periodMap  = new Map(periodDocs.map((p) => [String(p._id), p]));
  const subjectMap = new Map(subjectDocs.map((s) => [String(s._id), s]));

  // Tally by status
  const tally = rows.reduce((acc, r) => {
    const k = String(r.status ?? "unknown");
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  const present = tally.present ?? 0;
  const total   = rows.length;

  // Daily summary — group records by date, compute per-day status
  const byDate = {};
  for (const r of rows) {
    if (!byDate[r.date]) byDate[r.date] = { date: r.date, records: [], present: 0, absent: 0, late: 0, excused: 0, total: 0 };
    byDate[r.date].total += 1;
    if (r.status in byDate[r.date]) byDate[r.date][r.status] += 1;
    byDate[r.date].records.push(r);
  }

  // Daily summary status: all present → Present, some absent → Partial, etc.
  const dailySummaries = Object.values(byDate).map((day) => {
    let dailyStatus;
    if (day.total === day.present) dailyStatus = "Present";
    else if (day.total === day.absent) dailyStatus = "Absent";
    else if (day.absent >= day.total / 2) dailyStatus = "Partial absence";
    else dailyStatus = "Present with partial absence";

    const gate = gateByDate.get(day.date) ?? null;

    return {
      date:    day.date,
      status:  dailyStatus,
      arrivedAt:  gate?.arrivedAt  ?? null,
      departedAt: gate?.departedAt ?? null,
      present: day.present,
      absent:  day.absent,
      late:    day.late,
      excused: day.excused,
      total:   day.total,
      periods: day.records.map((r) => ({
        date:        r.date,
        status:      r.status,
        periodId:    r.periodId ?? null,
        periodName:  r.periodId ? (periodMap.get(String(r.periodId))?.name ?? null) : null,
        periodTime:  r.periodId ? (periodMap.get(String(r.periodId))?.startTime ?? null) : null,
        subjectId:   r.subjectId ?? null,
        subjectName: r.subjectId ? (subjectMap.get(String(r.subjectId))?.name ?? null) : null,
        note:        r.note ?? null,
      })),
    };
  });

  // Per-subject summary
  const subjectSummary = {};
  for (const r of rows) {
    const sid = r.subjectId || "__no_subject";
    if (!subjectSummary[sid]) subjectSummary[sid] = { subjectId: r.subjectId, subjectName: subjectMap.get(String(r.subjectId))?.name ?? null, present: 0, absent: 0, late: 0, excused: 0, total: 0 };
    subjectSummary[sid].total += 1;
    if (r.status in subjectSummary[sid]) subjectSummary[sid][r.status] += 1;
  }

  return res.json({
    success: true,
    data: {
      tally,
      total,
      rate: total > 0 ? Math.round((present / total) * 100) : null,
      lateCount:    tally.late ?? 0,
      excusedCount: tally.excused ?? 0,
  
      // Newest first, matching `recent` above. A day the register never
      // covered — a Saturday club, a public holiday the gate was open — still
      // appears here, which is why this is its own list and not folded into
      // the register days only.
      gate: [...gateByDate.values()]
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .slice(0, 60),
      recent: rows.slice(0, 30).map((r) => ({
        date:        r.date,
        status:      r.status,
        periodId:    r.periodId ?? null,
        periodName:  r.periodId ? (periodMap.get(String(r.periodId))?.name ?? null) : null,
        periodTime:  r.periodId ? (periodMap.get(String(r.periodId))?.startTime ?? null) : null,
        subjectId:   r.subjectId ?? null,
        subjectName: r.subjectId ? (subjectMap.get(String(r.subjectId))?.name ?? null) : null,
        note:        r.note ?? null,
      })),
      dailySummaries: dailySummaries.slice(0, 30),
      subjectSummary: Object.values(subjectSummary),
    },
  });
}));

/** School announcements a parent should see. */
router.get("/announcements", asyncHandler(async (req, res) => {
  const { schoolId, studentIds } = req.portal;

  // ── Every child's class, and only what concerns them ─────────────────────
  //
  // This query was hand-written instead of calling audienceMatch(), and it did
  // not so much filter as wave everything through. Measured against twelve
  // notices, a parent saw eleven — including one archived, one expired, one
  // not yet published, a staff-only one, one for a class neither of their
  // children is in, and one about somebody else's child.
  //
  //   { classId: student.classId }
  //         Announcement has no `classId`. The field is `targetClasses`, an
  //         array. So the branch meant to admit class notices could not match
  //         a document in any school, ever — it was doing nothing at all.
  //
  //   audience: { $in: ["all", "parents", "students"] }
  //         Which left this branch deciding everything. `audience` carries a
  //         schema default of "all", so it caught almost every row whatever it
  //         was scoped to — and the one shape it could NOT catch is
  //         audience:"class", because "class" is not in that list and the
  //         field exists so the $exists branch missed it too.
  //
  //         That is the reported failure exactly: a notice aimed at a class
  //         through the single-select picker was the one kind of notice a
  //         parent could not see, while notices aimed at other people's
  //         children were the ones they could.
  //
  //   student.classId
  //         One child — whichever the token resolved first, or whichever was
  //         selected. Harmless only because the field it was compared against
  //         does not exist; correct now, and a parent with children in 5A, 5B
  //         and 5C gets all three.
  //
  //   no `audiences` guard, no lifecycle
  //         audiences:["teachers"] still has audience:"all" sitting under it,
  //         so a staff-only notice reached parents. audienceMatch() exists to
  //         prevent precisely that and says so in its own comments. And
  //         nothing checked isActive, publishAt or expiresAt, which the
  //         student feed has always checked.
  const children = await Student.find({
    _id: { $in: studentIds }, schoolId, deletedAt: null,
  }).select("_id classId").lean();

  const classIds = [...new Set(children.map((c) => c.classId).filter(Boolean).map(String))];
  const childIds = children.map((c) => String(c._id));

  const now = new Date();
  const rows = await Announcement.find({
    schoolId,
    isActive:  { $ne: false },
    deletedAt: null,
    $or: Announcement.audienceMatch({
      audience: "parents",
      classIds,
      studentIds: childIds,
    }),
    $and: [
      { $or: [{ publishAt: null }, { publishAt: { $exists: false } }, { publishAt: { $lte: now } }] },
      { $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gte: now } }] },
    ],
  }).sort({ isPinned: -1, createdAt: -1 }).limit(30).lean();

  return res.json({
    success: true,
    data: rows.map((a) => ({
      _id: a._id, title: a.title, body: a.body ?? a.message ?? null,
      createdAt: a.createdAt, priority: a.priority ?? null,
      isPinned: a.isPinned ?? false,
      // Which of this parent's children the notice concerns, when it names
      // any. A parent with three children reading "bring PE kit on Thursday"
      // needs to know which of them it is about.
      forStudents: (a.targetStudents ?? []).filter((id) => childIds.includes(String(id))),
    })),
  });
}));

module.exports = router;
