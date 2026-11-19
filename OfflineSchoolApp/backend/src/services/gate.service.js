// backend/src/services/gate.service.js
"use strict";

const crypto = require("crypto");

const Student   = require("../db/models/Student");
const School    = require("../db/models/School");
const GateEvent = require("../db/models/GateEvent");
const GateAuthorization = require("../db/models/GateAuthorization");
const Class     = require("../db/models/Class");
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
 * Whether this particular scan is worth SENDING a parent a message about.
 *
 * The default is "exceptions", and the reasoning is worth stating: a school of
 * 500 scanning twice a day is 20,000 messages a month. After the first week
 * "arrived 07:42" is noise a parent stops opening — which is worse than
 * silence, because the message that mattered is then buried in it. A late
 * arrival or a child leaving at 11am is the message somebody acts on.
 *
 * That is a decision about DELIVERY, and it used to be implemented as a
 * decision about whether to remember: `notify: false` meant enqueue was never
 * called, so an on-time arrival left no notification anywhere and a parent
 * opening the portal to see what time their child came through found nothing.
 * The two are now separate — every scan is recorded, this governs only what
 * leaves the building — and the default is deliberately unchanged.
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
/**
 * The parts of a compliance result worth keeping on a gate event — the
 * figures and flags the operator acted on, not the whole schedule.
 */
const verificationSummary = (v, { computedOn }) => {
  if (!v || typeof v !== "object") return null;
  const num = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : null);
  const status = ["compliant", "due", "non_compliant", "authorized"].includes(v.status) ? v.status : null;
  if (!status) return null;
  return {
    status,
    computedOn,
    amountDue:        num(v.amountDue),
    totalPaid:        num(v.totalPaid),
    outstandingDue:   num(v.outstandingDue),
    remainingBalance: num(v.remainingBalance),
    arrangement:      v.arrangement === "agreement" ? "agreement" : "standard",
    agreementState:   typeof v.agreementState === "string" ? v.agreementState.slice(0, 40) : null,
    dependsOnPending: Boolean(v.dependsOnPending),
    pendingAmount:    num(v.pending?.amount ?? v.pendingAmount) ?? 0,
    stale:            Boolean(v.stale),
    dataAsOf:         v.dataAsOf ? new Date(v.dataAsOf) : null,
    authorizationId:  v.authorization?._id ? String(v.authorization._id) : null,
  };
};

const STUDENT_FIELDS = "studentName name firstName lastName enrollmentNo classId status photoUrl";

/** What the gate screen shows of a pupil, besides the fees. */
const studentCard = async (student) => {
  if (!student) return null;
  const cls = student.classId
    ? await Class.findOne({ _id: student.classId }).select("name").lean().catch(() => null)
    : null;
  return {
    _id:          String(student._id),
    name:         displayName(student) || null,
    enrollmentNo: student.enrollmentNo ?? null,
    classId:      student.classId ? String(student.classId) : null,
    className:    cls?.name ?? null,
    photoUrl:     student.photoUrl ?? null,
  };
};

const scan = async ({
  schoolId, id = null, token, studentId: givenStudentId = null, at, scannedBy, station,
  direction: given, notifyGuardian = true,
  verification: deviceVerification = null, verify = false,
}) => {
  // ── A replay is the event it already made ──────────────────────────────
  //
  // Offline devices queue a scan with the id they stored and retry it until
  // they hear back. If the first attempt was recorded and the answer lost,
  // the retry must not become a second event: the guardian would be told
  // twice, and the register would show the child leaving twice. An id that
  // is already this school's event answers with that event; an id that
  // belongs to another school's event is refused rather than reused.
  if (id) {
    const prior = await GateEvent.findOne({ _id: id }).lean();
    if (prior) {
      if (String(prior.schoolId) !== String(schoolId)) {
        const err = new Error("That scan id already belongs to another school");
        err.status = 409;
        err.code = "SCAN_ID_TAKEN";
        throw err;
      }
      const student = await Student.findOne({ _id: prior.studentId, schoolId })
        .select(STUDENT_FIELDS)
        .lean();
      return { replay: true, duplicate: true, event: prior, student: student ?? { _id: prior.studentId }, direction: prior.direction, notification: null, notifyPolicy: null };
    }
  }

  // A card, or — for a pupil who forgot theirs — the pupil the operator
  // found by name (method "manual"). Either way the same checks follow.
  const value  = String(token ?? "").trim();
  const manual = !value && givenStudentId ? String(givenStudentId).trim() : null;
  if (!value && !manual) {
    const err = new Error("No code was scanned");
    err.status = 400;
    err.code = "NO_TOKEN";
    throw err;
  }

  const student = await Student.findOne(
    manual ? { _id: manual, schoolId, deletedAt: null } : { gateToken: value, schoolId, deletedAt: null }
  ).select(STUDENT_FIELDS).lean();

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

  // The server's own verification, computed now — beside whatever the device
  // showed (which may have been offline, stale, or counting a payment that
  // was never confirmed). Never allowed to stop the scan being recorded.
  let compliance = null;
  if (verify) {
    try {
      compliance = await require("./compliance.service").complianceFor({ schoolId, studentId: String(student._id) });
    } catch (err) {
      console.error(`[gate] compliance for ${student._id} failed: ${err.message}`);
    }
  }

  const event = await GateEvent.create({
    ...(id ? { _id: id } : {}),
    schoolId,
    studentId: String(student._id),
    direction,
    date,
    at: when,
    scannedBy: scannedBy ?? null,
    station: station ?? null,
    method: manual ? "manual" : "card",
    verification:       verificationSummary(deviceVerification, { computedOn: "device" }),
    serverVerification: verificationSummary(compliance, { computedOn: "server" }),
  });

  const school = await School.findById(schoolId).lean().catch(() => null);
  const policy = shouldNotify({ school, direction, at: when });

  let notification = null;
  if (notifyGuardian) {
    // EVERY scan is recorded; `deliver` is where the policy applies. Queued,
    // never sent inline — a gate with no connectivity must still let a queue of
    // children through at the same speed.
    //
    // And never allowed to undo the scan. The register is the thing that has to
    // survive: a child walked through the gate whatever the notification
    // pipeline thinks about it, so a failure here is caught and logged and the
    // arrival stands. This is the one place in the flow where that ordering
    // matters, because the event is already written by the time we get here.
    try {
      notification = await notify.enqueue({
        schoolId,
        kind: direction === "in" ? "gate.arrival" : "gate.departure",
        studentId: String(student._id),
        data: { at: when, reason: policy.reason },
        deliver: policy.notify,
        deliverReason: policy.reason,
      });

      await GateEvent.updateOne(
        { _id: event._id },
        { notificationId: String(notification._id) }
      );
    } catch (err) {
      console.error(
        `[gate] scan recorded for ${student._id} but the notification failed: ${err.message}`
      );
    }
  }

  return {
    event, student, direction, duplicate: false, notification,
    // Returned so the gate screen can say "not notified — on time" rather than
    // leaving the operator wondering whether the message failed.
    notifyPolicy: policy,
    compliance,
  };
};

/**
 * What a gate device holds to verify pupils with no connection: every pupil on
 * the register (with or without a card — a forgotten card is looked up by
 * name), their photo path, class, and the minimal fee facts the compliance
 * engine reads. Amounts and dates only: no receipt numbers, methods,
 * references, cashiers, notes or agreement reasons.
 *
 * Replaced whole on each pull, and stamped with when it was made, so the
 * device can say how old its answer is.
 */
const snapshot = async ({ schoolId, asOf = new Date() }) => {
  const rows = await Student.find({ schoolId, status: "approved", deletedAt: null })
    .select("studentName name firstName lastName enrollmentNo classId gateToken photoUrl").lean();
  const classes = await Class.find({ schoolId, deletedAt: null }).select("name").lean();
  const className = new Map(classes.map((c) => [String(c._id), c.name]));

  const { factsFor } = require("./compliance.service");
  const { academicYear, facts } = await factsFor({ schoolId, studentIds: rows.map((s) => String(s._id)), asOf });

  return {
    generatedAt: new Date(),
    academicYear,
    students: rows.map((s) => {
      const id = String(s._id);
      return {
        studentId:    id,
        token:        s.gateToken ?? null,
        name:         displayName(s) || null,
        enrollmentNo: s.enrollmentNo ?? null,
        classId:      s.classId ? String(s.classId) : null,
        className:    s.classId ? (className.get(String(s.classId)) ?? null) : null,
        photoUrl:     s.photoUrl ?? null,
        ...facts.get(id),
      };
    }),
  };
};

/** One pupil, for a manual lookup at the gate: the card and the compliance. */
const verifyStudent = async ({ schoolId, studentId }) => {
  const student = await Student.findOne({ _id: studentId, schoolId, deletedAt: null })
    .select(STUDENT_FIELDS).lean();
  if (!student) {
    const err = new Error("Student not found");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  const { complianceFor } = require("./compliance.service");
  return {
    student: { ...(await studentCard(student)), status: student.status },
    compliance: await complianceFor({ schoolId, studentId: String(student._id) }),
  };
};

/** Name / admission-number search for the gate's manual lookup. */
const search = async ({ schoolId, q, limit = 20 }) => {
  const text = String(q ?? "").trim();
  if (text.length < 2) return [];
  const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const rows = await Student.find({
    schoolId, status: "approved", deletedAt: null,
    $or: [{ studentName: rx }, { name: rx }, { firstName: rx }, { lastName: rx }, { enrollmentNo: rx }, { admissionNo: rx }],
  }).select(STUDENT_FIELDS).limit(Math.min(50, Math.max(1, Number(limit) || 20))).lean();
  return Promise.all(rows.map(studentCard));
};

/**
 * Recent verifications: the gate events with the fee status each one showed.
 * Newest first; one pupil's when studentId is given.
 */
const history = async ({ schoolId, studentId = null, limit = 50 }) => {
  const filter = { schoolId, deletedAt: null };
  if (studentId) filter.studentId = String(studentId);
  const events = await GateEvent.find(filter).sort({ at: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50))).lean();
  const ids = [...new Set(events.map((e) => e.studentId))];
  const students = await Student.find({ _id: { $in: ids } })
    .select("studentName name firstName lastName enrollmentNo").lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));
  return events.map((e) => ({
    _id: e._id,
    studentId: e.studentId,
    studentName: displayName(byId.get(e.studentId)) || null,
    enrollmentNo: byId.get(e.studentId)?.enrollmentNo ?? null,
    direction: e.direction,
    method: e.method ?? "card",
    at: e.at,
    receivedAt: e.receivedAt,
    scannedBy: e.scannedBy,
    station: e.station,
    voided: Boolean(e.voidedAt),
    verification: e.verification ?? null,
    serverVerification: e.serverVerification ?? null,
  }));
};

// ── Gate authorizations (shared/compliance.js "Authorized") ────────────────

const authFail = (message, code, status = 400) => {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
};

const authorize = async ({ schoolId, studentId, validFrom, validUntil, reason, grantedBy }) => {
  const { asDueDate } = require("../../../shared/feeStructures");
  const why = String(reason ?? "").trim();
  if (!why) throw authFail("A reason is required", "REASON_REQUIRED");
  const until = asDueDate(validUntil);
  if (!until) throw authFail("An authorization needs an end date like 2026-12-15", "INVALID_DATE");
  const from = validFrom ? asDueDate(validFrom) : new Date(new Date().toISOString().slice(0, 10));
  if (!from) throw authFail("The start date needs to look like 2026-12-01", "INVALID_DATE");
  if (until < from) throw authFail("The authorization ends before it starts", "INVALID_DATE");
  // A pass is a short decision, not a standing exemption.
  if (until - from > 366 * 86_400_000) throw authFail("An authorization can last at most a year", "TOO_LONG");

  const exists = await Student.exists({ _id: studentId, schoolId, deletedAt: null });
  if (!exists) throw authFail("Student not found", "NOT_FOUND", 404);

  return (await GateAuthorization.create({
    schoolId, studentId: String(studentId), validFrom: from, validUntil: until,
    reason: why, grantedBy: grantedBy ?? null,
  })).toObject();
};

const revokeAuthorization = async ({ schoolId, id, revokedBy, reason }) => {
  const why = String(reason ?? "").trim();
  if (!why) throw authFail("A reason is required", "REASON_REQUIRED");
  const a = await GateAuthorization.findOne({ _id: id, schoolId, deletedAt: null });
  if (!a) throw authFail("Authorization not found", "NOT_FOUND", 404);
  if (a.revokedAt) throw authFail("This authorization was already revoked", "ALREADY_REVOKED", 409);
  a.revokedAt = new Date();
  a.revokedBy = revokedBy ?? null;
  a.revokeReason = why;
  await a.save();
  return a.toObject();
};

const listAuthorizations = async ({ schoolId, studentId = null, current = false }) => {
  const filter = { schoolId, deletedAt: null };
  if (studentId) filter.studentId = String(studentId);
  if (current) {
    filter.revokedAt = null;
    filter.validUntil = { $gte: new Date(Date.now() - 86_400_000) };
  }
  return GateAuthorization.find(filter).sort({ validUntil: -1 }).limit(500).lean();
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
  snapshot, verifyStudent, search, history, studentCard, verificationSummary,
  authorize, revokeAuthorization, listAuthorizations,
};
