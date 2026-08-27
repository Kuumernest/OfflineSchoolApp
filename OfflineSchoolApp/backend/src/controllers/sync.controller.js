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

// ── Optional models ───────────────────────────────────────────────────────────

let Student = null;
try {
  Student = require("../db/models/Student");
} catch {
  console.warn("[sync] ⚠️  Student model not found — students will be omitted from pull");
}

let School = null;
try {
  School = require("../db/models/School");
} catch {
  console.warn("[sync] ⚠️  School model not found — enrollment codes will use fallback");
}

let Counter = null;
try {
  Counter = require("../db/models/Counter");
} catch {
  console.warn("[sync] ⚠️  Counter model not found — enrollment number generation may race");
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a Mongoose updatedAt filter.
 * If lastSyncDate is in the future we clamp to epoch so the filter
 * is always present and we never accidentally return every record.
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

  return { updatedAt: { $gt: lastSyncDate } };
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

/**
 * Atomically generates the next sequential enrollment number for a school/year.
 * Falls back to a timestamp-based suffix when the Counter model is unavailable
 * so we never silently duplicate numbers.
 */
const generateEnrollmentNo = async (schoolId, prefix) => {
  if (Counter) {
    const counter = await Counter.findOneAndUpdate(
      { _id: `enrollmentNo:${schoolId}:${prefix}` },
      { $inc: { seq: 1 } },
      { upsert: true, new: true }
    );
    return `${prefix}-${String(counter.seq).padStart(4, "0")}`;
  }

  // Graceful degradation — still sequential per process but safe across restarts
  // because we sort descending and parse the last known value.
  const last = await User.findOne(
    { enrollmentNo: { $regex: `^${prefix}-` }, role: "student" },
    { enrollmentNo: 1 },
    { sort: { enrollmentNo: -1 } }
  ).lean();

  let nextNum = 1;
  if (last?.enrollmentNo) {
    const parts = last.enrollmentNo.split("-");
    const seq   = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(seq)) nextNum = seq + 1;
  }

  return `${prefix}-${String(nextNum).padStart(4, "0")}`;
};

/**
 * Resolves a short school code used in enrollment number prefixes.
 * Returns a safe uppercase string regardless of model availability.
 */
const resolveSchoolCode = async (schoolId) => {
  if (School) {
    try {
      const school = await School.findById(schoolId).select("code").lean();
      if (school?.code) return school.code.trim().toUpperCase().slice(0, 5);
    } catch (err) {
      console.warn("[sync] Could not load School for code:", err.message);
    }
  }
  return String(schoolId).replace(/[^A-Z0-9]/gi, "").slice(0, 3).toUpperCase() || "SCH";
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
    const teacherFields = isStudent
      ? "name role schoolId createdAt updatedAt"
      : "name email role schoolId isActive mustResetPassword enrollmentNo createdAt updatedAt";

    // ── Fetch all entity types in parallel ───────────────────────────────
    const [classes, teachers, subjects, periods, assignments, rawStudents] =
      await Promise.all([
        Class.find({ schoolId, ...since, ...NOT_DELETED }).lean(),

        User.find({ schoolId, role: "teacher", ...since })
          .select(teacherFields)
          .lean(),

        Subject.find({ schoolId, ...since, ...NOT_DELETED }).lean(),

        Period.find({ schoolId, ...since, ...NOT_DELETED }).lean(),

        TeacherAssignment.find({ schoolId, ...since, ...NOT_DELETED })
          .populate("teacher", "name email")
          .populate("class",   "name")
          .populate("subject", "name")
          .lean(),

        Student
          ? Student.find({
              schoolId,
              status:   "approved",
              isActive: true,
              // A student gets their own row and nobody else's. Their own is
              // still sent rather than dropped, because the local students
              // table is what several student screens read their class and
              // admission number from — an empty table would break them.
              //
              // Matched on either key because the link between a User and a
              // Student is recorded as userId on most rows and as the shared
              // _id on older ones.
              ...(isStudent
                ? { $or: [{ userId: callerId }, { _id: callerId }] }
                : {}),
              ...since,
              ...NOT_DELETED,
            }).lean()
          : Promise.resolve([]),
      ]);

    const students = rawStudents.map(normaliseStudentForSync).filter(Boolean);

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
        deletedItems: [],
      },
      timestamp: new Date().toISOString(),
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
            { new: true, timestamps: true }
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
            const schoolCode = await resolveSchoolCode(schoolId);
            const year       = new Date().getFullYear();
            const prefix     = `${schoolCode}-${year}`;
            enrollmentNo     = await generateEnrollmentNo(schoolId, prefix);
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