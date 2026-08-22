// backend/src/routes/documents.routes.js
"use strict";

const express = require("express");
const router  = express.Router();

const { authorize } = require("../../middleware/auth");

const School        = require("../db/models/School");
const Student       = require("../db/models/Student");
const Class         = require("../db/models/Class");
const Enrollment    = require("../db/models/Enrollment");
const ResultSummary = require("../db/models/ResultSummary");

const { buildClassListHtml }  = require("../print/classList");
const { buildTranscriptHtml } = require("../print/transcript");
const { buildIdCardsHtml }    = require("../print/idCard");
const { labelsFor, formatPrintDate } = require("../print/labels");
const portal = require("../services/portal.service");
const GuardianAccess = require("../db/models/GuardianAccess");
const photoStorage   = require("../utils/photoStorage");
const { displayName, byName } = require("../utils/studentName");

/**
 * Data for the things a school prints.
 *
 * These endpoints assemble documents, not records: each returns everything one
 * sheet of paper needs — school heading included — in a single call. A printed
 * page with a missing logo or a blank school name is worthless, and stitching
 * four requests together in the client is how that happens.
 *
 * Rendering lives in the clients, because both already own a print path: the
 * browser prints HTML, and the phone turns the same HTML into a PDF through
 * expo-print. Adding a server-side PDF engine would buy a third rendering of
 * the same documents and a new set of fonts to go wrong.
 */

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const resolveSchoolId = (req, provided) => {
  if (req.user?.role === "super_admin" && provided) return String(provided).trim();
  return req.user?.schoolId;
};

const bad = (res, message, code) =>
  res.status(400).json({ success: false, code: code ?? "BAD_REQUEST", message });

/**
 * Where the school's own uploads live, so a logo path resolves on a page that
 * has no base URL of its own — a print blob in the browser, or a PDF engine on
 * a phone. Behind a proxy, x-forwarded-* is the only honest source.
 */
const originOf = (req) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return host ? `${proto}://${host}` : null;
};

/**
 * Answers either the data or the finished sheet, from one route.
 *
 * `?format=html` exists so both clients print the SAME document: the browser
 * puts this string in an iframe, the phone hands it to expo-print. Keeping the
 * template here rather than in each client is what stops the two drifting.
 */
const respond = (req, res, { data, html }) => {
  if (String(req.query.format || "").toLowerCase() === "html") {
    res.type("html");
    return res.send(html());
  }
  return res.json({ success: true, data });
};

/** The heading every printed document carries. */
const schoolHeading = async (schoolId) => {
  const school = await School.findOne({ _id: schoolId }).lean();
  return {
    name:    school?.name ?? null,
    logo:    school?.logo ?? school?.logoUrl ?? null,
    address: school?.address ?? null,
    phone:   school?.phone ?? null,
    email:   school?.email ?? null,
    motto:   school?.motto ?? null,
    academicYear: school?.settings?.academicYear ?? null,
    currentTerm:  school?.settings?.currentTerm ?? null,
  };
};

// Printing a register or a transcript is staff work. Teachers need class lists,
// so they are included here — unlike the finance and rollover routers.
router.use(authorize("admin", "school_admin", "super_admin", "teacher"));

/**
 * The office, not the staffroom.
 *
 * This router is deliberately open to teachers so they can print their own
 * registers — but that is a READ permission. The routes below change a student
 * record or hand out a guardian's credentials, so they carry their own narrower
 * guard rather than inheriting the permissive one above.
 */
const officeOnly = authorize("admin", "school_admin", "super_admin");

// ═════════════════════════════════════════════════════════════════════════════
// CLASS LIST
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A class roster, ready to print.
 *
 * Sorted by name rather than by when each student was added, because the sheet
 * is read down the page by a person looking for one child.
 */
router.get("/class-list/:classId", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const klass = await Class.findOne({
    _id: req.params.classId, schoolId, deletedAt: null,
  }).select("name level section").lean();
  if (!klass) {
    return res.status(404).json({ success: false, message: "Class not found" });
  }

  const students = await Student.find({
    schoolId, classId: req.params.classId, status: "approved", deletedAt: null,
  })
    .select("studentName name firstName lastName enrollmentNo gender dateOfBirth guardianName guardianPhone")
    .lean();

  const rows = students
    .map((s) => ({
      _id:           String(s._id),
      name:          displayName(s) || null,
      enrollmentNo:  s.enrollmentNo ?? null,
      gender:        s.gender ?? null,
      dateOfBirth:   s.dateOfBirth ?? null,
      guardianName:  s.guardianName ?? null,
      guardianPhone: s.guardianPhone ?? null,
    }))
    // Unnamed rows sort LAST — see utils/studentName.
    .sort(byName);

  const data = {
      school:  await schoolHeading(schoolId),
      class:   { _id: String(klass._id), name: klass.name, level: klass.level ?? null,
                 section: klass.section ?? null },
      students: rows,
      // `unspecified` is reported rather than left implicit: without it, male
      // and female do not add up to the total on a sheet where some records
      // have no gender, and a total that does not reconcile looks like a bug in
      // the register rather than a gap in the data.
      counts: (() => {
        const male   = rows.filter((s) => String(s.gender).toLowerCase().startsWith("m")).length;
        const female = rows.filter((s) => String(s.gender).toLowerCase().startsWith("f")).length;
        return { total: rows.length, male, female, unspecified: rows.length - male - female };
      })(),
  };

  const lang = req.query.lang;
  return respond(req, res, {
    data,
    html: () => buildClassListHtml({
      data,
      variant:   req.query.variant,
      labels:    labelsFor(lang),
      printedOn: formatPrintDate(new Date(), lang),
      origin:    originOf(req),
    }),
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// ID CARDS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Identity cards for a class, ten to an A4 sheet.
 *
 * A class at a time, because that is the actual job — nobody prints one card.
 * `?studentId=` narrows it to one for a replacement, which is the other half of
 * the job and the only other quantity anyone asks for.
 *
 * Students with no admission number are EXCLUDED rather than printed blank. The
 * number is the card's whole purpose as an identifier, and a card carrying an
 * empty field looks like a printing fault rather than a data gap — it would be
 * laminated and handed to a child before anyone noticed.
 */
router.get("/id-cards/:classId", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const klass = await Class.findOne({
    _id: req.params.classId, schoolId, deletedAt: null,
  }).select("name").lean();
  if (!klass) {
    return res.status(404).json({ success: false, message: "Class not found" });
  }

  const filter = {
    schoolId, classId: req.params.classId, status: "approved", deletedAt: null,
  };
  if (req.query.studentId) filter._id = String(req.query.studentId);

  const rows = await Student.find(filter)
    .select("studentName name firstName lastName enrollmentNo photoUrl guardianPhone")
    .lean();

  const school = await schoolHeading(schoolId);

  const students = rows
    .map((s) => ({
      _id:           String(s._id),
      name:          displayName(s) || null,
      enrollmentNo:  s.enrollmentNo ?? null,
      className:     klass.name,
      photoUrl:      s.photoUrl ?? null,
      guardianPhone: s.guardianPhone ?? null,
    }))
    .filter((s) => s.enrollmentNo)
    .sort(byName);

  const skipped = rows.length - students.length;

  /**
   * The end of the academic year the school is currently in.
   *
   * Cameroonian school years run September to July, so a card printed in
   * October and one printed the following May must expire on the same date —
   * taking "a year from today" would give two children in the same class cards
   * that expire seven months apart.
   */
  const yearLabel = school.academicYear;
  const endYear = (() => {
    const match = /(\d{4})\s*[/-]\s*(\d{4})/.exec(String(yearLabel ?? ""));
    if (match) return Number(match[2]);
    const now = new Date();
    return now.getUTCMonth() >= 8 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  })();

  const lang = req.query.lang;
  const data = {
    school,
    class: { _id: String(klass._id), name: klass.name },
    students,
    validUntil: formatPrintDate(new Date(Date.UTC(endYear, 7, 31)), lang),
  };

  return respond(req, res, {
    data: { ...data, skippedWithoutAdmissionNo: skipped },
    html: () => buildIdCardsHtml({
      data,
      labels:    labelsFor(lang),
      printedOn: formatPrintDate(new Date(), lang),
      origin:    originOf(req),
    }),
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// TRANSCRIPT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One student's record across every year they have been here.
 *
 * Built on Enrollment, which is why that collection exists: `student.classId`
 * only says where they are now, so without the year-by-year history a transcript
 * could only ever show the current class beside every past result.
 *
 * Only published summaries are included. A transcript is an outward-facing
 * document, and putting unpublished marks on one hands out figures nobody has
 * signed off.
 */
router.get("/transcript/:studentId", asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const student = await Student.findOne({
    _id: req.params.studentId, schoolId, deletedAt: null,
  })
    .select("studentName name firstName lastName enrollmentNo gender dateOfBirth classId status")
    .lean();
  if (!student) {
    return res.status(404).json({ success: false, message: "Student not found" });
  }

  const [enrollments, summaries] = await Promise.all([
    Enrollment.find({ schoolId, studentId: req.params.studentId, deletedAt: null })
      .sort({ academicYear: 1 }).lean(),
    ResultSummary.find({
      schoolId, studentId: req.params.studentId, isPublished: true, deletedAt: null,
    }).sort({ academicYear: 1, term: 1 }).lean(),
  ]);

  // Group results under the year they belong to. Years come from BOTH sources:
  // a year with enrollment but no published results still belongs on the record
  // (the student was here), and a result whose year predates the enrollment
  // history — everything before the first rollover — must not vanish.
  const years = new Map();

  const ensureYear = (year) => {
    if (!years.has(year)) {
      years.set(year, { academicYear: year, className: null, outcome: null, terms: [] });
    }
    return years.get(year);
  };

  for (const e of enrollments) {
    const y = ensureYear(e.academicYear);
    y.className = e.className ?? null;
    y.outcome   = e.outcome ?? null;
  }

  for (const s of summaries) {
    const year = s.academicYear ?? "—";
    const y = ensureYear(year);
    // Falls back to the result's own class for years the history predates.
    if (!y.className) y.className = s.className ?? null;
    y.terms.push({
      term:          s.term ?? null,
      examId:        s.examId,
      average:       s.average ?? null,
      percentage:    s.percentage ?? null,
      overallGrade:  s.overallGrade ?? null,
      classPosition: s.classPosition ?? null,
      totalInClass:  s.totalInClass ?? null,
      isPassing:     Boolean(s.isPassing),
      subjects:      (s.subjectBreakdown ?? []).map((b) => ({
        subjectName:    b.subjectName ?? null,
        normalizedMark: b.normalizedMark ?? null,
        grade:          b.grade ?? null,
        isPassing:      Boolean(b.isPassing),
      })),
    });
  }

  const record = [...years.values()].sort((a, b) =>
    String(a.academicYear).localeCompare(String(b.academicYear))
  );

  // Averaged across terms, not across subjects — a term already is a subject
  // average, and averaging subject rows again would weight a term with more
  // subjects more heavily than one with fewer.
  const termAverages = record
    .flatMap((y) => y.terms.map((tm) => tm.average))
    .filter((v) => typeof v === "number");

  const data = {
      school:  await schoolHeading(schoolId),
      student: {
        _id:          String(student._id),
        name:         displayName(student) || null,
        enrollmentNo: student.enrollmentNo ?? null,
        gender:       student.gender ?? null,
        dateOfBirth:  student.dateOfBirth ?? null,
        status:       student.status,
      },
      years: record,
      overall: {
        yearsOnRecord: record.length,
        termsOnRecord: termAverages.length,
        average: termAverages.length
          ? Math.round((termAverages.reduce((a, b) => a + b, 0) / termAverages.length) * 10) / 10
          : null,
      },
  };

  const lang = req.query.lang;
  return respond(req, res, {
    data,
    html: () => buildTranscriptHtml({
      data,
      labels:    labelsFor(lang),
      printedOn: formatPrintDate(new Date(), lang),
      origin:    originOf(req),
    }),
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// STUDENT PHOTOS (office side)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Set a student's photo from the office.
 *
 * The student can set their own from their profile, but most cannot: a young
 * child has no account they use, and the photo is usually taken at the desk
 * during enrolment. Without this, the ID card's photo box could only ever be
 * filled by students old enough to sign in themselves.
 */
router.put("/student-photo/:studentId", officeOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const student = await Student.findOne({
    _id: req.params.studentId, schoolId, deletedAt: null,
  }).select("photoUrl").lean();
  if (!student) {
    return res.status(404).json({ success: false, message: "Student not found" });
  }

  const { photoBase64 } = req.body;
  if (!photoBase64) return bad(res, "photoBase64 is required");

  let saved;
  try {
    saved = photoStorage.savePhotoFromBase64(req.params.studentId, photoBase64);
  } catch (err) {
    return bad(res, err.message, "BAD_PHOTO");
  }

  await Student.updateOne({ _id: req.params.studentId }, { photoUrl: saved.publicPath });

  // Old file removed only after the new path is stored, so a failure cannot
  // leave the student with neither.
  if (student.photoUrl && student.photoUrl !== saved.publicPath) {
    photoStorage.deletePhotoFile(student.photoUrl);
  }

  return res.json({ success: true, photoUrl: saved.publicPath, bytes: saved.bytes });
}));

router.delete("/student-photo/:studentId", officeOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const student = await Student.findOne({
    _id: req.params.studentId, schoolId, deletedAt: null,
  }).select("photoUrl").lean();
  if (!student) {
    return res.status(404).json({ success: false, message: "Student not found" });
  }

  if (student.photoUrl) photoStorage.deletePhotoFile(student.photoUrl);
  await Student.updateOne({ _id: req.params.studentId }, { photoUrl: null });

  return res.json({ success: true, photoUrl: null });
}));

// ═════════════════════════════════════════════════════════════════════════════
// GUARDIAN PORTAL ACCESS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every guardian access in the school, with the children each one opens.
 *
 * The children are listed, not just counted: the office is about to hand a code
 * to a person, and "this code shows Ade, Bola and Chidi" is the thing they need
 * to check before doing so. Only the code's last two characters are returned —
 * the system cannot reproduce a code it has issued.
 */
router.get("/guardian-access", officeOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  const rows = await GuardianAccess.find({ schoolId, deletedAt: null })
    .sort({ createdAt: -1 }).lean();

  const ids = [...new Set(rows.flatMap((r) => r.studentIds ?? []))];
  const students = await Student.find({ _id: { $in: ids }, schoolId, deletedAt: null })
    .select("studentName name firstName lastName enrollmentNo").lean();
  const byId = new Map(students.map((s) => [String(s._id), s]));

  return res.json({
    success: true,
    count: rows.length,
    data: rows.map((r) => ({
      _id:       String(r._id),
      label:     r.label ?? null,
      hasCode:   Boolean(r.codeHash),
      hint:      r.codeHint ?? null,
      issuedAt:  r.codeSetAt ?? null,
      revokedAt: r.revokedAt ?? null,
      lastSeenAt: r.lastSeenAt ?? null,
      children: (r.studentIds ?? [])
        .map((id) => byId.get(String(id)))
        .filter(Boolean)
        .map((s) => ({
          _id: String(s._id),
          name: displayName(s) || null,
          enrollmentNo: s.enrollmentNo ?? null,
        })),
    })),
  });
}));

/**
 * Issue a code. The plain code comes back ONCE, in this response.
 *
 * Send `studentIds` to create a new access, or `accessId` to re-issue for the
 * same children — which is what "the parent lost the slip" needs. Nothing logs
 * the code and nothing stores it; only its hash is kept.
 */
router.post("/guardian-access", officeOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  try {
    const result = await portal.issueAccess({
      schoolId,
      accessId:   req.body.accessId,
      studentIds: req.body.studentIds,
      label:      req.body.label,
      createdBy:  req.user?._id ? String(req.user._id) : null,
    });
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      success: false, code: err.code ?? "ERROR", message: err.message,
    });
  }
}));

/** Change which children an access covers, without changing the code. */
router.put("/guardian-access/:accessId", officeOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.body.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  try {
    const access = await portal.setChildren({
      schoolId, accessId: req.params.accessId, studentIds: req.body.studentIds,
    });
    return res.json({ success: true, data: { _id: String(access._id), studentIds: access.studentIds } });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      success: false, code: err.code ?? "ERROR", message: err.message,
    });
  }
}));

router.delete("/guardian-access/:accessId", officeOnly, asyncHandler(async (req, res) => {
  const schoolId = resolveSchoolId(req, req.query.schoolId);
  if (!schoolId) return bad(res, "schoolId is required");

  try {
    const result = await portal.revokeAccess({ schoolId, accessId: req.params.accessId });
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(err.status ?? 500).json({
      success: false, code: err.code ?? "ERROR", message: err.message,
    });
  }
}));

module.exports = router;
