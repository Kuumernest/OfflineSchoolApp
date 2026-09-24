// backend/src/services/intelligence/learningEvidence.service.js
"use strict";

/**
 * The learning-evidence layer, loaded and served.
 *
 * ── What this file does ───────────────────────────────────────────────────
 *
 * Reads the four sources the audit found — homework with the pupil's
 * submission, quiz attempts with their quiz, subject scores with their exam,
 * attendance — reduces each to the plain rows the pure layer accepts (ids,
 * dates, scores, states; no name, no note), and hands them to
 * shared/learningEvidence. Records snapshots; compares readings. Joins
 * identity nowhere: the router does that after authorisation.
 *
 * ── The projection is one function ────────────────────────────────────────
 *
 * `reduceSources` is the projection from documents to rows. The live path
 * gives it Mongoose lean documents; the offline path gives it the same
 * documents round-tripped through JSON, as a mirror would hold them — dates
 * as strings, no ObjectId wrappers. The pure layer reads both the same way,
 * and the consistency check diffs the two readings. Transport is the only
 * thing allowed to differ, and the layer's own date parsing is what
 * normalises it.
 */

const crypto = require("crypto");
const Student            = require("../../db/models/Student");
const Homework           = require("../../db/models/Homework");
const StudentScore       = require("../../db/models/StudentScore");
const Exam               = require("../../db/models/Exam");
const { StudentAttendance } = require("../../db/models/Attendance");
const { Quiz, QuizAttempt } = require("../../db/models/QuizModule");
const LearningEvidenceSnapshot = require("../../db/models/LearningEvidenceSnapshot");
const le = require("../../../../shared/learningEvidence");

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

/** The recency clock: the start of today (UTC), the same on every road in one request. */
const startOfToday = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENTS
// ─────────────────────────────────────────────────────────────────────────────

/** Every source document the reading needs, for one pupil. */
const loadDocuments = async ({ schoolId, studentId }) => {
  const student = await Student.findOne({ _id: String(studentId), schoolId, deletedAt: null }).select("_id classId userId").lean();
  if (!student) return null;
  const classId = student.classId ? String(student.classId) : null;
  const [homework, scores, attendance, attempts] = await Promise.all([
    classId ? Homework.find({ schoolId, classId, deletedAt: null }).select("_id subjectId classId dueDate maxScore allowLate isPublished createdAt version submissions").lean() : [],
    StudentScore.find({ schoolId, studentId: String(student._id), deletedAt: null }).select("_id examId subjectId classId score maxScore isAbsent isExempt version").lean(),
    StudentAttendance.find({ schoolId, studentId: String(student._id) }).select("_id date status subjectId classId periodId").lean(),
    student.userId ? QuizAttempt.find({ user_id: String(student.userId), ...(schoolId ? { $or: [{ schoolId }, { schoolId: null }] } : {}) }).select("_id quiz_id user_id status raw_score max_score submitted_at started_at attempt_number").lean() : [],
  ]);
  const examIds = [...new Set(scores.map((s) => String(s.examId)))];
  const quizIds = [...new Set(attempts.map((a) => String(a.quiz_id)))];
  const [exams, quizzes] = await Promise.all([
    examIds.length ? Exam.find({ _id: { $in: examIds } }).select("_id type academicYear term sequenceNumber startDate resultsPublished").lean() : [],
    quizIds.length ? Quiz.find({ _id: { $in: quizIds } }).select("_id subject_id class_id is_published").lean() : [],
  ]);
  return { student: { _id: String(student._id), classId }, homework, scores, exams, attendance, attempts, quizzes };
};

// ─────────────────────────────────────────────────────────────────────────────
// THE PROJECTION
// ─────────────────────────────────────────────────────────────────────────────

/** Documents → the reduced rows the pure layer accepts. Identity never enters. */
const reduceSources = (docs) => {
  const studentId = docs.student._id;
  const examById = new Map(docs.exams.map((e) => [String(e._id), e]));
  const quizById = new Map(docs.quizzes.map((q) => [String(q._id), q]));
  return {
    homework: docs.homework.map((h) => {
      const sub = (h.submissions ?? []).find((s) => String(s.studentId) === studentId) ?? null;
      return { _id: String(h._id), subjectId: h.subjectId ?? null, classId: h.classId ?? null, dueDate: h.dueDate ?? null, maxScore: h.maxScore ?? null,
        allowLate: h.allowLate ?? null, isPublished: h.isPublished !== false, createdAt: h.createdAt ?? null, version: h.version ?? null,
        submission: sub ? { submittedAt: sub.submittedAt ?? null, score: sub.score ?? null, gradedAt: sub.gradedAt ?? null } : null };
    }),
    quizAttempts: docs.attempts.map((a) => {
      const q = quizById.get(String(a.quiz_id));
      return { _id: String(a._id), quizId: String(a.quiz_id), subjectId: q?.subject_id ? String(q.subject_id) : null, classId: q?.class_id ? String(q.class_id) : null,
        isPublished: q ? q.is_published !== false : true, status: a.status, rawScore: a.raw_score ?? null, maxScore: a.max_score ?? null,
        submittedAt: a.submitted_at ?? null, startedAt: a.started_at ?? null, attemptNumber: a.attempt_number ?? 1 };
    }),
    scores: docs.scores.map((s) => {
      const e = examById.get(String(s.examId));
      return { _id: String(s._id), examId: String(s.examId), subjectId: String(s.subjectId), classId: s.classId ? String(s.classId) : null,
        examType: e?.type ?? null, academicYear: e?.academicYear ?? null, term: e?.term ?? null, sequenceNumber: e?.sequenceNumber ?? null, startDate: e?.startDate ?? null,
        resultsPublished: Boolean(e?.resultsPublished), score: s.score ?? null, maxScore: s.maxScore ?? null, isAbsent: Boolean(s.isAbsent), isExempt: Boolean(s.isExempt), version: s.version ?? null };
    }),
    attendance: docs.attendance.map((r) => ({ _id: String(r._id), date: r.date, status: r.status, subjectId: r.subjectId ?? null, classId: r.classId ?? null, periodId: r.periodId ?? null })),
  };
};

/** The live reading. */
const readingFor = async ({ schoolId, studentId, asOf = null }) => {
  const docs = await loadDocuments({ schoolId, studentId });
  if (!docs) return null;
  return le.buildLearningEvidence({ pupilId: docs.student._id, schoolId, sources: reduceSources(docs), asOf: asOf ?? startOfToday() });
};

/** The same reading from the documents as a mirror would hold them. */
const offlineReadingFor = async ({ schoolId, studentId, asOf = null }) => {
  const docs = await loadDocuments({ schoolId, studentId });
  if (!docs) return null;
  const mirrored = JSON.parse(JSON.stringify(docs));
  return le.buildLearningEvidence({ pupilId: mirrored.student._id, schoolId, sources: reduceSources(mirrored), asOf: asOf ?? startOfToday() });
};

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOTS
// ─────────────────────────────────────────────────────────────────────────────

/** The reading without its events. */
const summaryOf = (r) => ({
  learningEvidenceVersion: r.learningEvidenceVersion, asOf: r.asOf, counts: r.counts, rejected: r.rejected.length,
  patterns: r.patterns, quality: r.quality, signals: r.signals, integration: r.integration, concise: r.concise, notInferred: r.notInferred,
});

const boundaryOf = (r) => {
  const ids = r.events.map((e) => `${e.learningEventId}@${e.provenance.sourceVersion ?? ""}:${e.observations.map((o) => `${o.kind}=${o.state}:${o.normalizedValue ?? ""}`).join(",")}`).sort();
  const hash = crypto.createHash("sha1").update(JSON.stringify({ ids, v: r.learningEvidenceVersion })).digest("hex");
  const dates = r.events.map((e) => e.occurredAt).filter(Boolean).sort();
  return { events: ids.length, latestEventAt: dates.length ? new Date(dates[dates.length - 1]) : null, hash };
};

const latestSnapshot = ({ schoolId, studentId }) =>
  LearningEvidenceSnapshot.findOne({ schoolId, studentId: String(studentId), deletedAt: null }).sort({ snapshotNumber: -1 }).lean();

/** Idempotent on the boundary: unchanged evidence returns the snapshot that covers it. Old snapshots untouched. */
const rebuild = async ({ schoolId, studentId, classId, actor }) => {
  const r = await readingFor({ schoolId, studentId });
  if (!r) throw fail(404, "NO_PUPIL", "No such pupil");
  const boundary = boundaryOf(r);
  const last = await latestSnapshot({ schoolId, studentId });
  if (last?.evidenceBoundary?.hash === boundary.hash && last.learningEvidenceVersion === r.learningEvidenceVersion) return { snapshot: last, created: false };
  const created = await LearningEvidenceSnapshot.create({
    schoolId, studentId: String(studentId), classId: classId ?? null, snapshotNumber: (last?.snapshotNumber ?? 0) + 1,
    learningEvidenceVersion: r.learningEvidenceVersion, asOf: r.asOf ? new Date(r.asOf) : null, evidenceBoundary: boundary,
    reading: summaryOf(r), generatedAt: new Date(), recordedBy: actor,
  });
  return { snapshot: created, created: true };
};

const history = ({ schoolId, studentId }) =>
  LearningEvidenceSnapshot.find({ schoolId, studentId: String(studentId), deletedAt: null }).sort({ snapshotNumber: 1 }).lean();

/** What changed since the last snapshot. */
const changesSince = async ({ schoolId, studentId }) => {
  const [r, last] = await Promise.all([readingFor({ schoolId, studentId }), latestSnapshot({ schoolId, studentId })]);
  if (!r) return null;
  return {
    previous: last ? { snapshotId: String(last._id), snapshotNumber: last.snapshotNumber, generatedAt: last.generatedAt, learningEvidenceVersion: last.learningEvidenceVersion } : null,
    current: { learningEvidenceVersion: r.learningEvidenceVersion, asOf: r.asOf, events: r.counts.events },
    newEvents: last ? r.events.filter((e) => e.occurredAt && new Date(e.occurredAt) > new Date(last.generatedAt)).length : r.counts.events,
    comparison: le.compareReadings(last?.reading ?? null, r),
    pendingSnapshot: !last || last.evidenceBoundary?.hash !== boundaryOf(r).hash || last.learningEvidenceVersion !== r.learningEvidenceVersion,
  };
};

/** The guardian's plain view: patterns and coverage, no events, no notes. */
const forGuardian = (r) => (r ? {
  learningEvidenceVersion: r.learningEvidenceVersion,
  subjects: Object.values(r.patterns.bySubject).filter((s) => s.subjectId).map((s) => ({
    subjectId: s.subjectId,
    formal: s.formal.pattern, continuous: s.continuous.pattern, practical: s.practical.pattern, quiz: s.quiz.pattern,
    homework: { pattern: s.homework.pattern, completed: s.homework.completed, assigned: s.homework.assigned },
    coverage: r.quality.subjects[s.subjectId]?.level ?? "NO_DATA",
  })),
  attendance: { pattern: r.patterns.attendance.overall.pattern, present: r.patterns.attendance.overall.present, absent: r.patterns.attendance.overall.absent, late: r.patterns.attendance.overall.late, excused: r.patterns.attendance.overall.excused },
  concise: r.concise,
  notInferred: r.notInferred,
} : null);

module.exports = { startOfToday, loadDocuments, reduceSources, readingFor, offlineReadingFor, summaryOf, boundaryOf, latestSnapshot, rebuild, history, changesSince, forGuardian };
