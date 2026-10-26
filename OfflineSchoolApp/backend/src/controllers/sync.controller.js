// backend/controllers/sync.controller.js
"use strict";

const crypto  = require("crypto");
const mongoose = require("mongoose");

const bcrypt         = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");

const Class             = require("../db/models/Class");
const User              = require("../db/models/User");
const Subject           = require("../db/models/Subject");
const Period            = require("../db/models/Period");
const TeacherAssignment = require("../db/models/TeacherAssignment");
const SyncTombstone     = require("../db/models/SyncTombstone");

// ── Optional models ───────────────────────────────────────────────────────────

let Student = null;
try {
  Student = require("../db/models/Student");
} catch {
  console.warn("[sync] ⚠️  Student model not found — students will be omitted from pull");
}

// One generator for every admission path (services/admissionNumber.service.js).
const { nextAdmissionNo } = require("../services/admissionNumber.service");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a Mongoose updatedAt filter.
 * If lastSyncDate is in the future we clamp to epoch so the filter
 * is always present and we never accidentally return every record.
 *
 * ── Why this is $gte and not $gt ──────────────────────────────────────────
 *
 * The cursor handed back to the client is stamped BEFORE these queries run, so
 * that a row written while they are in flight is re-sent next time rather than
 * skipped. That reasoning is right and it had an off-by-one-millisecond hole
 * left in it, because the filter was exclusive.
 *
 * Take a cursor stamped at T. The queries begin in that same millisecond. A row
 * written at exactly T, after its collection's query has already run, is not in
 * the reply — and the next pull asks for updatedAt > T, which excludes it. That
 * row is never offered to that device again. Not a delay: a permanent hole, one
 * millisecond wide, in the collection somebody happened to be writing to.
 *
 * Inclusive closes it. The cost is that rows stamped exactly on the cursor come
 * back once more, which is what the client already tolerates — every pull
 * applies as an upsert, and the comment on pulledAt already accepts re-sending
 * as the safe direction. Skipping is the unsafe one.
 *
 * The desktop feed does not need this: its cursor is the pair (updatedAt, _id),
 * which is a total order, so it can be exclusive without a boundary at all.
 */
const sinceFilter = (lastSyncDate) => {
  const now = new Date();

  if (lastSyncDate > now) {
    console.warn(
      `[sync] ⚠️  lastSync (${lastSyncDate.toISOString()}) is in the future — ` +
      "clamping to epoch"
    );
    return { updatedAt: { $gt: new Date(0) } };
  }

  return { updatedAt: { $gte: lastSyncDate } };
};

/** Excludes soft-deleted documents from any query. */
const NOT_DELETED = {
  $or: [
    { deletedAt: { $exists: false } },
    { deletedAt: null               },
  ],
};

/**
 * Normalises a raw Student document into a stable, canonical shape.
 * Aliases are kept to a minimum — one resolved value per logical field.
 */
const normaliseStudentForSync = (s) => {
  if (!s) return null;

  const id          = String(s._id || s.id || "");
  const firstName   = s.firstName  || null;
  const lastName    = s.lastName   || null;
  const name        = [firstName, lastName].filter(Boolean).join(" ").trim()
                      || s.studentName || s.name || "Unknown";

  const classId    = s.classId   || s.class_id  || null;
  const enrollment = s.enrollmentNo || s.enrollment_no
                     || s.admissionNo || s.admissionNumber || null;

  return {
    id,
    _id:          id,
    name,
    firstName,
    lastName,
    studentName:  s.studentName || name,
    email:        (s.email || s.studentEmail || s.parentEmail || "").toLowerCase().trim(),
    phone:        s.phone || s.phoneNumber || s.guardianPhone || null,
    guardianName: s.guardianName || s.parentName  || null,
    guardianPhone:s.guardianPhone|| s.parentPhone || null,
    enrollmentNo: enrollment,
    admissionNo:  s.admissionNo  || enrollment,
    classId,
    className:    s.className    || s.class_name || null,
    status:       s.status       || "approved",
    isActive:     s.isActive     ?? true,
    schoolId:     s.schoolId     || null,
    userId:       s.userId       || null,
    approvedAt:   s.approvedAt   || null,
    createdAt:    s.createdAt    || null,
    updatedAt:    s.updatedAt    || null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// PULL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /sync/pull?schoolId=&lastSync=
 *
 * Returns all entities that have changed since `lastSync` for the given school.
 * The caller must belong to the same school (enforced below).
 */
exports.pullChanges = async (req, res) => {
  try {
    const { schoolId, lastSync } = req.query;

    // ── Validate schoolId ────────────────────────────────────────────────
    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId is required" });
    }

    // ── Ownership guard — caller must belong to the requested school ─────
    const callerSchool = req.user?.schoolId?.toString();
    if (callerSchool !== schoolId.toString()) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    // ── Parse lastSync date ──────────────────────────────────────────────
    const parsedDate    = lastSync ? new Date(lastSync) : new Date(0);
    const effectiveDate = isNaN(parsedDate.getTime()) ? new Date(0) : parsedDate;

    console.log(`📥 Pull requested for school ${schoolId} since ${effectiveDate.toISOString()}`);

    // The cursor the client will send back as `lastSync` next time, taken
    // BEFORE the queries below run. Taken after them, any record written
    // while they were in flight would carry an updatedAt earlier than the
    // returned timestamp, so the next pull's `since` filter would never
    // match it and the client would miss that row permanently. Taken
    // first, the worst case is re-sending a row the client already has.
    const pulledAt = new Date().toISOString();

    const since = sinceFilter(effectiveDate);

    // ── Who is asking ────────────────────────────────────────────────────
    //
    // This route scoped hard by TENANT and not at all by ROLE, so a pupil's
    // phone received the same payload as the head teacher's: every approved
    // student's name, email, phone, GUARDIAN NAME and GUARDIAN PHONE, plus
    // every teacher's email and account state.
    //
    // The tenancy guard above is untouched — it was always right. What is added
    // is a narrower slice for a student caller. Narrowed rather than refused,
    // because the student app is built on this payload and blocking the route
    // would take every student device offline permanently.
    const role       = req.user?.role ?? null;
    const isStudent  = role === "student";
    const callerId   = String(req.user?._id ?? req.user?.id ?? "");

    // A student keeps teacher NAMES — the timetable shows who teaches each
    // period and is unreadable without them — and loses everything else. An
    // email address and a mustResetPassword flag together tell a pupil which
    // staff accounts have never been signed into.
    // deletedAt for a student too: it is how a deleted teacher leaves the
    // timetable on their device, and it says nothing about the account.
    const teacherFields = isStudent
      ? "name role schoolId deletedAt createdAt updatedAt"
      : "name email role schoolId isActive mustResetPassword enrollmentNo deletedAt createdAt updatedAt";

    // ── Removals: how a deletion reaches a device ────────────────────────
    //
    // The contract is the one the desktop feed already keeps and every apply
    // function on the phone already reads: a row that arrives with deletedAt
    // set is marked deleted locally (syncManager syncClasses … syncStudents).
    // This route never sent one. Each query excluded soft-deleted rows, so a
    // deletion moved the row's updatedAt and then hid it; hard deletes
    // (subjects, assignments, students) left no row at all; and deletedItems
    // was always []. A device kept every deleted record for good.
    //
    // On an INCREMENTAL pull (a cursor was sent), so, three kinds of removal:
    //   - soft-deleted rows changed since the cursor, sent as they are;
    //   - students who left the roster this pull serves (no longer approved
    //     and active), sent as { _id, deletedAt };
    //   - hard deletes, from their tombstones (models/SyncTombstone.js),
    //     sent the same way — except where the row still exists (a delete
    //     that failed after its tombstone was written).
    // A FIRST pull (no cursor) is unchanged: the device has nothing to remove.
    // The cursor contract is unchanged too: the same inclusive `since`, so a
    // removal stamped on the cursor is sent twice rather than never, and
    // applying one twice is a no-op.
    const incremental = Boolean(lastSync) && effectiveDate.getTime() > 0;
    const live = incremental ? {} : NOT_DELETED;

    // A student caller gets their own row and nobody else's. Matched on either
    // key because the link between a User and a Student is recorded as userId
    // on most rows and as the shared _id on older ones. Under $and: spread
    // beside NOT_DELETED, whose key is also $or, this filter was overwritten,
    // and a student's token received every pupil in the school with their
    // guardians' names and phone numbers.
    const ownStudent = isStudent ? { $or: [{ userId: callerId }, { _id: callerId }] } : null;
    const studentFilter = {
      schoolId,
      ...since,
      ...(incremental ? {} : { status: "approved", isActive: true }),
      $and: [ownStudent, incremental ? null : NOT_DELETED].filter(Boolean),
    };
    if (!studentFilter.$and.length) delete studentFilter.$and;

    // ── Fetch all entity types in parallel ───────────────────────────────
    const [classes, teachers, subjects, periods, assignments, rawStudents, tombstones] =
      await Promise.all([
        Class.find({ schoolId, ...since, ...live }).lean(),

        User.find({ schoolId, role: "teacher", ...since })
          .select(teacherFields)
          .lean(),

        Subject.find({ schoolId, ...since, ...live }).lean(),

        Period.find({ schoolId, ...since, ...live }).lean(),

        TeacherAssignment.find({ schoolId, ...since, ...live })
          // Name only for a student: teacherFields above keeps staff emails
          // off a pupil's device, and this join handed them back.
          .populate("teacher", isStudent ? "name" : "name email")
          .populate("class",   "name")
          .populate("subject", "name")
          .lean(),

        // Their own row is still sent to a student rather than dropped,
        // because the local students table is what several student screens
        // read their class and admission number from.
        Student ? Student.find(studentFilter).lean() : Promise.resolve([]),

        incremental
          // The same bound as every row above (sinceFilter: a cursor from the
          // future reads from the beginning), on the deletion's own time.
          ? SyncTombstone.find({ schoolId: String(schoolId), deletedAt: since.updatedAt }).lean()
          : Promise.resolve([]),
      ]);

    // Students: on the roster → the full row; off it → a removal.
    const onRoster = (s) => s.status === "approved" && s.isActive === true && !s.deletedAt;
    const removal  = (id, sid, at) => ({ _id: String(id), id: String(id), schoolId: sid ?? null, deletedAt: at });
    const students = [];
    for (const s of rawStudents) {
      if (onRoster(s)) {
        const row = normaliseStudentForSync(s);
        if (row) students.push(row);
      } else {
        students.push(removal(s._id, s.schoolId, s.deletedAt || s.updatedAt || pulledAt));
      }
    }

    // Hard deletes. A student caller hears only of their own record.
    const stoneFor = { subject: subjects, teacherAssignment: assignments, student: students };
    const stoneModel = { subject: Subject, teacherAssignment: TeacherAssignment, student: Student };
    const relevant = tombstones.filter((t) => stoneFor[t.entity] && (!isStudent || t.entity !== "student" || t.docId === callerId));
    for (const entity of Object.keys(stoneFor)) {
      const ids = relevant.filter((t) => t.entity === entity).map((t) => t.docId);
      if (!ids.length || !stoneModel[entity]) continue;
      const stillThere = new Set((await stoneModel[entity].find({ _id: { $in: ids } }).distinct("_id")).map(String));
      const already = new Set(stoneFor[entity].map((r) => String(r._id)));
      for (const t of relevant) {
        if (t.entity !== entity || stillThere.has(t.docId) || already.has(t.docId)) continue;
        stoneFor[entity].push(removal(t.docId, t.schoolId, t.deletedAt));
      }
    }

    // The same removals, listed: informational, for a client that wants
    // them in one place. The rows above are what the phone applies.
    const deletedItems = [];
    for (const [collection, rows] of Object.entries({ classes, teachers, subjects, periods, assignments, students })) {
      for (const r of rows) {
        if (r.deletedAt) deletedItems.push({ collection, id: String(r._id), deletedAt: r.deletedAt });
      }
    }

    console.log(
      `📦 Pull results (${role ?? "unknown"}) — classes: ${classes.length}, ` +
      `teachers: ${teachers.length}, subjects: ${subjects.length}, ` +
      `periods: ${periods.length}, assignments: ${assignments.length}, ` +
      `students: ${students.length}`
    );

    return res.json({
      success: true,
      data: {
        classes,
        teachers,
        subjects,
        periods,
        assignments,
        students,
        deletedItems,
      },
      timestamp: pulledAt,
    });

  } catch (err) {
    console.error("[sync] Pull changes error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch sync data" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUSH — PERIODS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /sync/periods
 *
 * Accepts an array of period change operations (create / update / delete).
 * Client-supplied _id values are validated; dangerous fields are stripped.
 */
exports.pushPeriodChanges = async (req, res) => {
  try {
    const { schoolId, changes } = req.body;

    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId is required" });
    }

    const callerSchool = req.user?.schoolId?.toString();
    if (callerSchool !== schoolId.toString()) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const results = { created: [], updated: [], failed: [] };

    if (!changes?.periods?.length) {
      return res.json({ success: true, results, serverTime: new Date().toISOString() });
    }

    for (const item of changes.periods) {
      const { _id, operation, data } = item;

      try {
        if (operation === "create") {
          // ── Strip fields the client must not control ──────────────────
          const {
            _id:      clientId,
            schoolId: _s,
            assignedBy: _a,
            ...safeData
          } = data || {};

          // Accept the client id only if it is a valid ObjectId
          const isValidId = mongoose.isValidObjectId(clientId);
          const docId     = isValidId
            ? clientId
            : new mongoose.Types.ObjectId();

          const existing = await Period.findOne({
            schoolId,
            _id: docId,
            ...NOT_DELETED,
          });

          if (existing) {
            results.updated.push({ _id: existing._id, status: "exists" });
            continue;
          }

          const created = await Period.create({
            ...safeData,
            _id:        docId,
            schoolId,
            assignedBy: req.user?._id,
          });
          results.created.push(created._id);

        } else if (operation === "update") {
          const { schoolId: _s, assignedBy: _a, ...safeData } = data || {};

          const updated = await Period.findOneAndUpdate(
            { _id, schoolId, ...NOT_DELETED },
            { ...safeData, $inc: { version: 1 } },
            { returnDocument: 'after', timestamps: true }
          );

          if (updated) results.updated.push(_id);
          else         results.failed.push({ _id, reason: "Not found" });

        } else if (operation === "delete") {
          await Period.findOneAndUpdate(
            { _id, schoolId },
            { deletedAt: new Date() },
            { timestamps: true }
          );
          results.updated.push(_id);

        } else {
          results.failed.push({ _id, reason: `Unknown operation: ${operation}` });
        }

      } catch (itemErr) {
        console.error("[sync] Period item failed:", itemErr);
        results.failed.push({ _id: item._id, reason: itemErr.message });
      }
    }

    console.log(
      `📤 Period push — created: ${results.created.length}, ` +
      `updated: ${results.updated.length}, failed: ${results.failed.length}`
    );

    return res.json({ success: true, results, serverTime: new Date().toISOString() });

  } catch (err) {
    console.error("[sync] pushPeriodChanges error:", err);
    return res.status(500).json({ success: false, message: "Failed to process period sync" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUSH — STUDENT DECISIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /sync/student-decisions
 *
 * Approves or rejects pending student registrations.
 * On approval a linked User account is created (or updated) atomically
 * inside a Mongoose session so a failed student.save() cannot leave an
 * orphaned User document.
 *
 * A random temporary password is generated (NOT the enrollment number)
 * and returned once in the response so the admin can communicate it.
 */
exports.pushStudentDecisions = async (req, res) => {
  try {
    if (!Student) {
      return res.status(501).json({
        success: false,
        message: "Student model is not available on this server",
      });
    }

    const { schoolId, changes } = req.body;

    if (!schoolId) {
      return res.status(400).json({ success: false, message: "schoolId is required" });
    }

    const callerSchool = req.user?.schoolId?.toString();
    if (callerSchool !== schoolId.toString()) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const results = { synced: [], failed: [] };

    if (!changes?.studentDecisions?.length) {
      return res.json({ success: true, results, serverTime: new Date().toISOString() });
    }

    for (const decision of changes.studentDecisions) {
      const { studentId, status, classId, reason } = decision;

      // ── Basic payload validation ────────────────────────────────────────
      if (!studentId || !["approved", "rejected"].includes(status)) {
        results.failed.push({ studentId, reason: "Invalid decision payload" });
        continue;
      }

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const student = await Student.findOne({ _id: studentId, schoolId }).session(session);

        if (!student) {
          await session.abortTransaction();
          results.failed.push({ studentId, reason: "Not found" });
          continue;
        }

        if (student.status !== "pending") {
          await session.abortTransaction();
          results.synced.push({
            studentId,
            status:  student.status,
            note:    "Already reviewed on server",
          });
          continue;
        }

        // ── APPROVE ────────────────────────────────────────────────────────
        if (status === "approved") {
          if (!classId) {
            await session.abortTransaction();
            results.failed.push({ studentId, reason: "classId is required for approval" });
            continue;
          }

          // Resolve display name and email
          const displayName =
            [student.firstName, student.lastName].filter(Boolean).join(" ").trim()
            || student.name || "Student";

          const email =
            (student.email || student.studentEmail || student.parentEmail || "")
              .toLowerCase()
              .trim() || undefined;

          // Resolve or generate enrollment number
          let enrollmentNo =
            student.admissionNo || student.enrollmentNo || null;

          if (!enrollmentNo) {
            enrollmentNo = await nextAdmissionNo(schoolId);
          }

          // Generate a cryptographically random temporary password
          const tempPassword = crypto.randomBytes(16).toString("hex");
          const hashedPass   = await bcrypt.hash(tempPassword, 12);

          // Upsert the linked User document inside the transaction
          let userDoc = email
            ? await User.findOne({ email, role: "student" }).session(session)
            : null;

          if (userDoc) {
            userDoc.name             = displayName;
            userDoc.isActive         = true;
            userDoc.schoolId         = schoolId;
            userDoc.enrollmentNo     = enrollmentNo;
            userDoc.mustResetPassword= true;
            // Rotate password on re-approval so stale credentials are invalidated
            userDoc.password         = hashedPass;
            await userDoc.save({ session });
          } else {
            [userDoc] = await User.create(
              [{
                _id:              uuidv4(),
                name:             displayName,
                email,
                role:             "student",
                schoolId,
                isActive:         true,
                enrollmentNo,
                password:         hashedPass,
                mustResetPassword: true,
              }],
              { session }
            );
          }

          // Update the Student document atomically in the same session
          student.status       = "approved";
          student.classId      = classId;
          student.userId       = userDoc._id;
          student.admissionNo  = enrollmentNo;
          student.enrollmentNo = enrollmentNo;
          student.reviewedAt   = new Date();
          student.approvedAt   = new Date();
          await student.save({ session });

          await session.commitTransaction();

          // Approved into a class is joining its fees, as on every other
          // approve route. After the commit: billing never throws and must
          // not decide whether the approval stands.
          await require("../services/fees.service").applyActiveStructuresForStudent({
            schoolId,
            student:  { _id: student._id, classId },
            raisedBy: req.user?._id ? String(req.user._id) : null,
          });

          // tempPassword is intentionally surfaced once so the admin
          // can communicate initial credentials to the student.
          results.synced.push({
            studentId,
            status:       "approved",
            enrollmentNo,
            tempPassword,           // present only at approval time
          });

        // ── REJECT ─────────────────────────────────────────────────────────
        } else if (status === "rejected") {
          student.status          = "rejected";
          student.rejectionReason = reason?.trim() || null;
          student.isActive        = false;
          student.reviewedAt      = new Date();
          student.rejectedAt      = new Date();
          await student.save({ session });

          await session.commitTransaction();
          results.synced.push({ studentId, status: "rejected" });
        }

      } catch (decisionErr) {
        await session.abortTransaction();
        console.error("[sync] Student decision failed:", decisionErr);
        results.failed.push({ studentId, reason: decisionErr.message });
      } finally {
        session.endSession();
      }
    }

    console.log(
      `📤 Student decisions — synced: ${results.synced.length}, failed: ${results.failed.length}`
    );

    return res.json({ success: true, results, serverTime: new Date().toISOString() });

  } catch (err) {
    console.error("[sync] pushStudentDecisions error:", err);
    return res.status(500).json({ success: false, message: "Failed to process student decisions" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY PUSH (backwards-compat wrapper)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /sync/push
 *
 * Retained for older clients that POST both periods and studentDecisions
 * in a single request.  Delegates to the focused handlers above and merges
 * their results so the response shape is unchanged.
 */
exports.pushChanges = async (req, res) => {
  // Synthesise sub-requests that share the same body/user context
  const makeSubReq = (extraBody) => ({
    ...req,
    body: { ...req.body, ...extraBody },
  });

  const periodResults  = { created: [], updated: [], failed: [] };
  const studentResults = { synced: [],  failed:  []            };

  // Collect period results via the focused handler ─────────────────────────
  if (req.body?.changes?.periods?.length) {
    await new Promise((resolve) => {
      const fakeRes = {
        status: () => fakeRes,
        json:   (payload) => {
          if (payload?.results) Object.assign(periodResults, payload.results);
          resolve();
        },
      };
      exports.pushPeriodChanges(makeSubReq({}), fakeRes);
    });
  }

  // Collect student results via the focused handler ────────────────────────
  if (req.body?.changes?.studentDecisions?.length) {
    await new Promise((resolve) => {
      const fakeRes = {
        status: () => fakeRes,
        json:   (payload) => {
          if (payload?.results) Object.assign(studentResults, payload.results);
          resolve();
        },
      };
      exports.pushStudentDecisions(makeSubReq({}), fakeRes);
    });
  }

  console.log(
    `📤 Push (legacy) — ` +
    `periods: created ${periodResults.created.length}, updated ${periodResults.updated.length}, failed ${periodResults.failed.length} | ` +
    `students: synced ${studentResults.synced.length}, failed ${studentResults.failed.length}`
  );

  return res.json({
    success: true,
    results: {
      periods:  periodResults,
      students: studentResults,
    },
    serverTime: new Date().toISOString(),
  });
};