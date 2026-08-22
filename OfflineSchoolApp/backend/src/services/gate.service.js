// backend/src/services/gate.service.js
"use strict";

const crypto = require("crypto");

const Student   = require("../db/models/Student");
const School    = require("../db/models/School");
const GateEvent = require("../db/models/GateEvent");
const notify    = require("./notification");
const { displayName } = require("../utils/studentName");

/**
 * Sign-in and sign-out by scanning the QR code on a student's ID card.
 *
 * What this is: a fast lookup at a staffed gate. A scan takes a second where
 * finding a name in a paper register takes twenty, and it timestamps arrival
 * accurately rather than approximately.
 *
 * What this is NOT: authentication. The QR is printed on a card anyone can see
 * and photograph, so it identifies a student and nothing more. The safeguard is
 * procedural — the scanner is operated by staff at the gate, and the person is
 * the check. A self-service scanner would let one student sign in three absent
 * friends, and no amount of cryptography on the card would prevent it.
 */

// A second scan of the same card inside this window is the same arrival —
// a card held a moment too long, or a scanner that beeps twice.
const DEBOUNCE_SECONDS = 90;

const TOKEN_BYTES = 12;

/** YYYY-MM-DD in the school's own day, not UTC. */
const dayKey = (d = new Date()) => {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

/**
 * Issue (or reissue) a student's gate token.
 *
 * Reissuing invalidates the previous card immediately, which is the point: a
 * lost card is cancelled by printing a replacement.
 */
const issueToken = async ({ schoolId, studentId }) => {
  const exists = await Student.exists({ _id: studentId, schoolId, deletedAt: null });
  if (!exists) {
    const err = new Error("Student not found");
    err.status = 404;
    throw err;
  }

  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");

  // updateOne, not save(). save() revalidates the WHOLE document, and this
  // roster carries records from earlier versions of the schema — an approved
  // student with no userId, for instance, which today's validator rejects.
  // Minting a gate token would then fail for exactly the legacy students most
  // likely to need a card, and it would surface as "User ID is required"
  // during card printing, which points nowhere near the real cause.
  await Student.updateOne({ _id: studentId, schoolId }, { gateToken: token });

  return token;
};

/** The token for a student, minting one on first use so printing never fails. */
const tokenFor = async ({ schoolId, studentId }) => {
  const student = await Student.findOne({ _id: studentId, schoolId, deletedAt: null })
    .select("gateToken").lean();
  if (!student) return null;
  if (student.gateToken) return student.gateToken;
  return issueToken({ schoolId, studentId });
};

/** Minutes past midnight for "07:45", or null when unset or malformed. */
const minutesOf = (hhmm) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Whether this particular scan is worth telling a parent about.
 *
 * The default is "exceptions", and the reasoning is worth stating: a school of
 * 500 scanning twice a day is 20,000 messages a month. After the first week
 * "arrived 07:42" is noise a parent stops opening — which is worse than
 * silence, because the message that mattered is then buried in it. A late
 * arrival or a child leaving at 11am is the message somebody acts on.
 *
 * @returns {{ notify: boolean, reason: string }}
 */
const shouldNotify = ({ school, direction, at }) => {
  const mode = school?.settings?.gateNotify ?? "exceptions";

  if (mode === "off") return { notify: false, reason: "gate notifications are off" };
  if (mode === "all") return { notify: true,  reason: "every scan" };

  const when = at instanceof Date ? at : new Date(at);
  const mins = when.getHours() * 60 + when.getMinutes();

  if (direction === "in") {
    const late = minutesOf(school?.settings?.gateLateAfter) ?? minutesOf("07:45");
    return mins > late
      ? { notify: true,  reason: "arrived late" }
      : { notify: false, reason: "arrived on time" };
  }

  const early = minutesOf(school?.settings?.gateEarlyBefore) ?? minutesOf("14:00");
  return mins < early
    ? { notify: true,  reason: "left early" }
    : { notify: false, reason: "left at the normal time" };
};

/**
 * Record a scan.
 *
 * Direction is derived from the student's last scan today rather than chosen by
 * the operator: at a gate nobody has a spare hand to press "in" or "out", and
 * an operator who picks wrongly produces a record that reads as a child who
 * never left.
 *
 * @param {object} opts
 * @param {string} opts.token      the value read from the QR code
 * @param {Date}   [opts.at]       when the device recorded it — may be in the past
 * @returns {Promise<{event, student, direction, duplicate, notification}>}
 */
const scan = async ({
  schoolId, token, at, scannedBy, station,
  direction: given, notifyGuardian = true,
}) => {
  const value = String(token ?? "").trim();
  if (!value) {
    const err = new Error("No code was scanned");
    err.status = 400;
    err.code = "NO_TOKEN";
    throw err;
  }

  const student = await Student.findOne({
    gateToken: value, schoolId, deletedAt: null,
  }).select("studentName name firstName lastName enrollmentNo classId status").lean();

  if (!student) {
    const err = new Error("That card is not recognised");
    err.status = 404;
    err.code = "UNKNOWN_CARD";
    throw err;
  }

  // A card belonging to somebody who has left should not open the gate, and
  // saying so is more useful at the gate than a silent success.
  if (student.status !== "approved") {
    const err = new Error(`${displayName(student) || "That student"} is not on the current register`);
    err.status = 409;
    err.code = "NOT_ENROLLED";
    throw err;
  }

  const when = at ? new Date(at) : new Date();
  const date = dayKey(when);

  const last = await GateEvent.findOne({
    schoolId, studentId: String(student._id), date, voidedAt: null, deletedAt: null,
  }).sort({ at: -1 }).lean();

  // Debounce before deciding direction, so a double beep does not read as an
  // arrival immediately followed by a departure.
  if (last && Math.abs(when - new Date(last.at)) < DEBOUNCE_SECONDS * 1000) {
    return {
      event: last,
      student,
      direction: last.direction,
      duplicate: true,
      notification: null,
    };
  }

  /**
   * A device that scanned offline already decided this, from the scans it holds
   * — the server could not have known them. Its answer is trusted for that
   * reason; deriving here from a partial view would flip a queued departure
   * into a second arrival the moment it synced.
   *
   * Only "in" and "out" are accepted, so a malformed payload cannot write a
   * third state into the log.
   */
  const direction =
    given === "in" || given === "out"
      ? given
      : (last?.direction === "in" ? "out" : "in");

  const event = await GateEvent.create({
    schoolId,
    studentId: String(student._id),
    direction,
    date,
    at: when,
    scannedBy: scannedBy ?? null,
    station: station ?? null,
  });

  const school = await School.findById(schoolId).lean().catch(() => null);
  const policy = shouldNotify({ school, direction, at: when });

  let notification = null;
  if (notifyGuardian && policy.notify) {
    // Queued, never sent inline. A gate with no connectivity must still let a
    // queue of children through at the same speed.
    notification = await notify.enqueue({
      schoolId,
      kind: direction === "in" ? "gate.arrival" : "gate.departure",
      studentId: String(student._id),
      data: { at: when, reason: policy.reason },
    });

    await GateEvent.updateOne(
      { _id: event._id },
      { notificationId: String(notification._id) }
    );
  }

  return {
    event, student, direction, duplicate: false, notification,
    // Returned so the gate screen can say "not notified — on time" rather than
    // leaving the operator wondering whether the message failed.
    notifyPolicy: policy,
  };
};

/** Everyone scanned today, newest first — what the gate screen shows. */
const today = async ({ schoolId, date }) => {
  const key = date ?? dayKey();

  const events = await GateEvent.find({
    schoolId, date: key, voidedAt: null, deletedAt: null,
  }).sort({ at: -1 }).lean();

  const ids = [...new Set(events.map((e) => e.studentId))];
  const students = await Student.find({ _id: { $in: ids } })
    .select("studentName name firstName lastName enrollmentNo").lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));

  return {
    date: key,
    events: events.map((e) => ({
      _id: e._id,
      studentId: e.studentId,
      studentName: displayName(byId.get(e.studentId)) || null,
      enrollmentNo: byId.get(e.studentId)?.enrollmentNo ?? null,
      direction: e.direction,
      at: e.at,
      station: e.station,
    })),
    // Who is currently on site: last event of the day was an arrival.
    onSite: ids.filter((id) => {
      const forStudent = events.filter((e) => e.studentId === id);
      return forStudent[0]?.direction === "in";
    }).length,
  };
};

module.exports = {
  issueToken, tokenFor, scan, today, dayKey,
  shouldNotify, DEBOUNCE_SECONDS,
};
