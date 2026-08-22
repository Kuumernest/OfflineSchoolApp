// backend/src/services/notification/index.js
"use strict";

const Notification = require("../../db/models/Notification");
const School       = require("../../db/models/School");
const Student      = require("../../db/models/Student");
const { displayName } = require("../../utils/studentName");
const { render }      = require("./templates");
const { getChannel, availableChannels } = require("./channels");

/**
 * The notification queue.
 *
 * Two operations, deliberately separate:
 *
 *   enqueue()  — record that somebody is owed a message. Never sends, never
 *                throws for a delivery reason, never blocks the caller. Taking
 *                a fee payment must not fail because a mail server is down.
 *
 *   dispatch() — drain what is due. Runs on a timer and on demand.
 *
 * Keeping them apart is what makes the whole thing offline-tolerant: the school
 * can work all day with no connectivity and the queue simply drains when the
 * line comes back, in the order things happened.
 */

// A failed send is retried on a widening delay. Six attempts spans roughly a
// day, which covers an overnight outage without filling the queue with retries.
const BACKOFF_MINUTES = [1, 5, 20, 60, 240, 720];
const MAX_ATTEMPTS    = BACKOFF_MINUTES.length;

/**
 * Where a message about this student should go.
 *
 * Guardian first, student second. Right now no student in this school has a
 * guardian email and all have their own, so these messages reach the CHILD, not
 * the parent — which is worth knowing before relying on fee reminders landing
 * with someone who can pay. `toSource` records which was used so that question
 * can be answered from the data rather than guessed at.
 */
const resolveRecipient = (student, channel) => {
  if (channel === "whatsapp" || channel === "sms") {
    if (student.guardianPhone) return { to: student.guardianPhone, source: "guardianPhone" };
    if (student.phone)         return { to: student.phone,         source: "studentPhone" };
    return { to: null, source: null };
  }

  if (student.guardianEmail) return { to: student.guardianEmail, source: "guardianEmail" };
  if (student.email)         return { to: student.email,         source: "studentEmail" };
  return { to: null, source: null };
};

/**
 * The channel a school wants, falling back to one that works.
 *
 * A school with WhatsApp switched on but no credentials configured must not
 * silently send nothing — it falls back to email and the notification records
 * which channel actually carried it.
 */
const resolveChannel = (school) => {
  const preferred = school?.settings?.notificationChannel ?? "email";
  const channel   = getChannel(preferred);

  if (channel?.isConfigured()) return preferred;
  if (getChannel("email")?.isConfigured()) return "email";
  return "log";
};

/**
 * Queue a message about a student.
 *
 * Returns the notification, including when it was skipped — a caller that wants
 * to tell the user "no email on file for this child" can read skipReason rather
 * than assuming it went.
 */
const enqueue = async ({ schoolId, kind, studentId, data = {}, lang, createdBy }) => {
  const school = await School.findById(schoolId).lean().catch(() => null);
  const channel = resolveChannel(school);

  const language = lang ?? school?.settings?.defaultLanguage ?? "en";
  const schoolName = school?.name ?? "School";

  let student = null;
  if (studentId) {
    student = await Student.findOne({ _id: studentId, schoolId, deletedAt: null })
      .select("studentName name firstName lastName guardianEmail email guardianPhone phone")
      .lean();
  }

  const { to, source } = student
    ? resolveRecipient(student, channel)
    : { to: data.to ?? null, source: data.toSource ?? "explicit" };

  const payload = {
    ...data,
    schoolName,
    studentName: data.studentName ?? (student ? displayName(student) : null),
  };

  let subject = null, body = null, text = null;
  try {
    const rendered = render(kind, payload, language);
    subject = rendered.subject;
    body    = rendered.html;
    text    = rendered.text;
  } catch (err) {
    // A template that will not render is a programming error, not a delivery
    // one. Recorded as failed so it is visible rather than thrown into the
    // caller's face mid-payment.
    return Notification.create({
      schoolId, kind, studentId: studentId ?? null,
      to: to ?? "unknown", channel, status: "failed",
      error: err.message, data: payload, createdBy: createdBy ?? null,
    });
  }

  // No address is a SKIP, not a failure: nothing was attempted and retrying
  // will not help until somebody enters an email.
  if (!to) {
    return Notification.create({
      schoolId, kind, studentId: studentId ?? null,
      to: "—", toSource: null, channel,
      subject, body, data: { ...payload, text },
      status: "skipped",
      skipReason: `No ${channel === "email" ? "email address" : "phone number"} on file`,
      createdBy: createdBy ?? null,
    });
  }

  return Notification.create({
    schoolId, kind, studentId: studentId ?? null,
    to, toSource: source, channel,
    subject, body, data: { ...payload, text },
    status: "pending",
    createdBy: createdBy ?? null,
  });
};

/**
 * Send everything that is due.
 *
 * @returns {Promise<{sent:number, failed:number, skipped:number, remaining:number}>}
 */
const dispatch = async ({ limit = 25, schoolId } = {}) => {
  const filter = {
    status: "pending",
    nextAttemptAt: { $lte: new Date() },
    deletedAt: null,
  };
  if (schoolId) filter.schoolId = schoolId;

  const due = await Notification.find(filter)
    .sort({ createdAt: 1 })
    .limit(limit);

  const summary = { sent: 0, failed: 0, skipped: 0, remaining: 0 };

  for (const n of due) {
    const channel = getChannel(n.channel);

    if (!channel) {
      n.status = "failed";
      n.error  = `Unknown channel "${n.channel}"`;
      await n.save();
      summary.failed += 1;
      continue;
    }

    if (!channel.accepts(n.to)) {
      // Malformed address: retrying cannot fix it, so it is skipped rather
      // than burning six attempts on a typo.
      n.status     = "skipped";
      n.skipReason = `"${n.to}" is not a valid ${n.channel} address`;
      await n.save();
      summary.skipped += 1;
      continue;
    }

    n.attempts      += 1;
    n.lastAttemptAt  = new Date();

    try {
      await channel.send({
        to:       n.to,
        subject:  n.subject,
        text:     n.data?.text ?? "",
        html:     n.body,
        fromName: n.data?.schoolName,
      });

      n.status = "sent";
      n.sentAt = new Date();
      n.error  = null;
      await n.save();
      summary.sent += 1;
    } catch (err) {
      // A channel that is not configured will never succeed on retry, so it is
      // skipped immediately instead of consuming the whole backoff schedule.
      if (err.code === "CHANNEL_NOT_CONFIGURED") {
        n.status     = "skipped";
        n.skipReason = err.message;
        await n.save();
        summary.skipped += 1;
        continue;
      }

      n.error = err.message;

      if (n.attempts >= MAX_ATTEMPTS) {
        n.status = "failed";
        summary.failed += 1;
      } else {
        const wait = BACKOFF_MINUTES[n.attempts - 1] ?? 720;
        n.nextAttemptAt = new Date(Date.now() + wait * 60_000);
      }
      await n.save();
    }
  }

  summary.remaining = await Notification.countDocuments({
    status: "pending", nextAttemptAt: { $lte: new Date() }, deletedAt: null,
    ...(schoolId ? { schoolId } : {}),
  });

  return summary;
};

/** Put a failed notification back in the queue, attempts reset. */
const retry = async (id) => {
  const n = await Notification.findById(id);
  if (!n) return null;

  n.status        = "pending";
  n.attempts      = 0;
  n.error         = null;
  n.skipReason    = null;
  n.nextAttemptAt = new Date();
  await n.save();
  return n;
};

module.exports = {
  enqueue, dispatch, retry,
  resolveRecipient, resolveChannel, availableChannels,
  MAX_ATTEMPTS, BACKOFF_MINUTES,
};
