// backend/src/services/reportCardData.service.js
"use strict";

/**
 * The term and annual report cards.
 *
 * ── Why these are not just "the sequence card again" ──────────────────────
 *
 * A sequence card reads one exam: the marks are already there, and a pupil's
 * place in a subject is a comparison against the classmates who sat that same
 * paper. A term card has no paper. Its subject marks are the pupil's marks
 * across the sequences the term contains, combined by the weights the school
 * configured — and a pupil's place in a subject is a comparison against the
 * classmates' equally-combined marks, which nothing stores. So both have to be
 * built here before anything can be ranked.
 *
 * The annual card does the same again, one level up: term averages per subject,
 * combined by the term weights.
 *
 * TermResult and AnnualResult already hold the averages, grades and positions
 * that go in the boxes. What they do not hold is a subject breakdown, which is
 * the entire body of the page.
 *
 * ── What stays the school's decision ──────────────────────────────────────
 *
 * The weights come from AcademicStructure and the grade bands from
 * GradingConfig. Neither is written down here: a school that runs three
 * sequences a term, or grades on its own scale, gets its own arithmetic.
 */

const Exam              = require("../db/models/Exam");
const StudentScore      = require("../db/models/StudentScore");
const ExamSubject       = require("../db/models/ExamSubject");
const TermResult        = require("../db/models/TermResult");
const AnnualResult      = require("../db/models/AnnualResult");
const AcademicStructure = require("../db/models/AcademicStructure");
const GradingConfig     = require("../db/models/GradingConfig");
const Student           = require("../db/models/Student");

const { subjectRanking } = require("../../../shared/reportCard");

/** A score as a mark out of 20, or null when the pupil did not sit it. */
const outOf20 = (score, maxScore) => {
  if (!score || score.isAbsent || score.isExempt || score.score == null) return null;
  const max = Number(maxScore ?? score.maxScore ?? 20);
  const raw = Number(score.score);
  if (!Number.isFinite(raw) || !Number.isFinite(max) || max <= 0) return null;
  return (raw / max) * 20;
};

const round2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

/**
 * Combine a pupil's marks for one subject into a single /20, by weight.
 *
 * Missing parts are dropped and the weights renormalised over what is there —
 * a pupil who missed the second sequence is graded on the first rather than on
 * half of it. Falls back to a plain mean when the school has set no weights.
 */
const weightedMark = (parts) => {
  const present = parts.filter((p) => p.mark != null);
  if (present.length === 0) return null;
  const totalWeight = present.reduce((s, p) => s + (Number(p.weight) || 0), 0);
  if (totalWeight <= 0) {
    return present.reduce((s, p) => s + p.mark, 0) / present.length;
  }
  return present.reduce((s, p) => s + p.mark * (Number(p.weight) || 0), 0) / totalWeight;
};

/**
 * Per-subject marks for every pupil in a class, over a set of exams.
 *
 * @returns {Map<studentId, Map<subjectKey, {subjectName, mark, coefficient}>>}
 */
async function subjectMarksAcross(exams, weightOf) {
  const examIds = exams.map((e) => String(e._id));
  if (examIds.length === 0) return { byStudent: new Map(), subjects: new Map() };

  const [scores, examSubjects] = await Promise.all([
    StudentScore.find({ examId: { $in: examIds }, deletedAt: null })
      .select("studentId examId examSubjectId subjectId score maxScore isAbsent isExempt")
      .lean(),
    ExamSubject.find({ examId: { $in: examIds }, deletedAt: null })
      .select("_id examId subjectId subjectName coefficient maxScore")
      .lean(),
  ]);

  // examSubjectId → the subject it belongs to. The subject, not the paper, is
  // what a mark is aggregated under: the same subject is a different
  // ExamSubject row in each sequence.
  const esById = new Map(examSubjects.map((es) => [String(es._id), es]));

  /** subjectId → { name, coefficient } */
  const subjects = new Map();
  for (const es of examSubjects) {
    const key = String(es.subjectId);
    if (!subjects.has(key)) {
      subjects.set(key, {
        subjectName: es.subjectName || key,
        coefficient: es.coefficient ?? 1,
      });
    }
  }

  /** studentId → subjectId → [{ mark, weight }] */
  const parts = new Map();
  for (const sc of scores) {
    const es      = sc.examSubjectId ? esById.get(String(sc.examSubjectId)) : null;
    const subject = String(es?.subjectId ?? sc.subjectId ?? "");
    if (!subject) continue;
    const mark = outOf20(sc, es?.maxScore);
    if (mark == null) continue;

    const sid = String(sc.studentId);
    if (!parts.has(sid)) parts.set(sid, new Map());
    const bySubject = parts.get(sid);
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push({ mark, weight: weightOf(String(sc.examId)) });
  }

  const byStudent = new Map();
  for (const [sid, bySubject] of parts) {
    const combined = new Map();
    for (const [subject, list] of bySubject) {
      const mark = weightedMark(list);
      if (mark == null) continue;
      combined.set(subject, {
        subjectName: subjects.get(subject)?.subjectName || subject,
        coefficient: subjects.get(subject)?.coefficient ?? 1,
        mark:        round2(mark),
      });
    }
    byStudent.set(sid, combined);
  }

  return { byStudent, subjects };
}

/**
 * Turn the whole class's per-subject marks into this pupil's subject rows,
 * each with its place among the pupils who have a mark in that subject.
 */
function subjectRowsFor(studentId, byStudent, bands, showGrades) {
  const mine = byStudent.get(String(studentId));
  if (!mine || mine.size === 0) return [];

  // One synthetic "score" per pupil per subject, which is what the shared
  // ranking rule takes — the same rule the sequence card ranks with, so a
  // tie means the same thing on all three cards.
  const flat = [];
  for (const [sid, bySubject] of byStudent) {
    for (const [subject, row] of bySubject) {
      flat.push({ studentId: sid, subjectId: subject, score: row.mark });
    }
  }
  const ranking = subjectRanking(flat);

  return [...mine.entries()].map(([subject, row]) => {
    const probe = { studentId: String(studentId), subjectId: subject, score: row.mark };
    const place = ranking.positionOf(probe);
    const band  = GradingConfig.findGradeBand(row.mark, bands);
    return {
      subjectId:       subject,
      subjectName:     row.subjectName,
      score:           row.mark,
      maxScore:        20,
      normalizedMark:  row.mark,
      coefficient:     row.coefficient,
      grade:           showGrades ? (band?.grade || null) : null,
      remark:          band?.remark || null,
      subjectPosition: place.position,
      subjectTotal:    place.total,
      isPassing:       band ? band.grade !== "F" : null,
    };
  }).sort((a, b) => String(a.subjectName).localeCompare(String(b.subjectName)));
}

/** The school's grade bands and grades-on-or-off, or the shipped defaults. */
async function gradingFor(schoolId) {
  const cfg = await GradingConfig.findOne({ schoolId: String(schoolId) })
    .lean()
    .catch(() => null);
  return {
    bands:      Array.isArray(cfg?.grades) ? cfg.grades : null,
    showGrades: cfg?.showGrades ?? true,
  };
}

async function studentIdentity(studentId) {
  return Student.findOne({ _id: String(studentId) })
    .select("gender dateOfBirth studentName enrollmentNo admissionNo")
    .lean()
    .catch(() => null);
}

/**
 * The term report card (§7). Carries the term average, the term position and
 * the per-sequence breakdown — and never a promotion decision.
 */
async function buildTermCard({ schoolId, academicYear, term, classId, studentId }) {
  const [record, structure, grading, student] = await Promise.all([
    TermResult.findOne({
      schoolId: String(schoolId), academicYear, term: Number(term),
      classId: String(classId), studentId: String(studentId),
    }).lean(),
    AcademicStructure.findOne({ schoolId: String(schoolId), academicYear }).lean(),
    gradingFor(schoolId),
    studentIdentity(studentId),
  ]);
  if (!record) return null;

  const termConfig = structure?.terms?.find((t) => t.number === Number(term)) || null;
  const seqNumbers = termConfig?.sequences?.map((s) => s.number) || [];

  const exams = await Exam.find({
    schoolId: String(schoolId), academicYear, term: Number(term),
    ...(seqNumbers.length ? { sequenceNumber: { $in: seqNumbers } } : {}),
    deletedAt: null,
  }).select("_id sequenceNumber").lean();

  const weightBySeq = new Map(
    (termConfig?.sequences || []).map((s) => [s.number, s.weight ?? 50])
  );
  const weightByExam = new Map(
    exams.map((e) => [String(e._id), weightBySeq.get(e.sequenceNumber) ?? 50])
  );

  const { byStudent } = await subjectMarksAcross(
    exams, (examId) => weightByExam.get(examId) ?? 50
  );

  return {
    reportType:   "term",
    studentId:    String(studentId),
    studentName:  record.studentName || student?.studentName || null,
    admissionNo:  record.admissionNo || student?.enrollmentNo || student?.admissionNo || null,
    className:    record.className   || null,
    academicYear,
    term:         termConfig?.name || `Term ${term}`,
    gender:       student?.gender      || null,
    dateOfBirth:  student?.dateOfBirth || null,
    showGrades:   grading.showGrades,
    subjects:     subjectRowsFor(studentId, byStudent, grading.bands, grading.showGrades),
    summary: {
      average:        record.termAverage,
      overallGrade:   grading.showGrades ? record.overallGrade : null,
      overallRemark:  record.overallRemark,
      classPosition:  record.classPosition,
      totalInClass:   record.totalInClass,
      isPassing:      record.isPassing,
      isPublished:    record.isPublished ?? false,
      // §8. Stated rather than omitted: a term card must not carry one even if
      // something upstream starts attaching it.
      promotionStatus: null,
    },
    termResult: {
      average:       record.termAverage,
      grade:         grading.showGrades ? record.overallGrade : null,
      remark:        record.overallRemark,
      classPosition: record.classPosition,
      totalInClass:  record.totalInClass,
    },
    sequenceAverages: (record.sequenceAverages || []).map((s) => ({
      sequence: s.sequence, average: s.average,
    })),
    computed: { outOf: 20 },
  };
}

/**
 * The final annual report card (§7). The only card that carries a promotion
 * decision (§8), alongside the annual average and the annual position.
 */
async function buildAnnualCard({ schoolId, academicYear, classId, studentId }) {
  const [record, structure, grading, student] = await Promise.all([
    AnnualResult.findOne({
      schoolId: String(schoolId), academicYear,
      classId: String(classId), studentId: String(studentId),
    }).lean(),
    AcademicStructure.findOne({ schoolId: String(schoolId), academicYear }).lean(),
    gradingFor(schoolId),
    studentIdentity(studentId),
  ]);
  if (!record) return null;

  // Every exam of the year, weighted by its term's share of the annual average
  // and its sequence's share of the term — so a subject mark on this card is
  // the same arithmetic as on the three term cards, carried one level up.
  const exams = await Exam.find({
    schoolId: String(schoolId), academicYear, deletedAt: null,
  }).select("_id term sequenceNumber").lean();

  const weightByExam = new Map();
  for (const e of exams) {
    const termConfig = structure?.terms?.find((t) => t.number === e.term);
    const seqConfig  = termConfig?.sequences?.find((s) => s.number === e.sequenceNumber);
    const termShare  = (termConfig?.weight ?? 100 / 3) / 100;
    const seqShare   = (seqConfig?.weight ?? 50) / 100;
    weightByExam.set(String(e._id), termShare * seqShare * 100);
  }

  const { byStudent } = await subjectMarksAcross(
    exams, (examId) => weightByExam.get(examId) ?? 1
  );

  return {
    reportType:   "annual",
    studentId:    String(studentId),
    studentName:  record.studentName || student?.studentName || null,
    admissionNo:  record.admissionNo || student?.enrollmentNo || student?.admissionNo || null,
    className:    record.className   || null,
    academicYear,
    term:         null,
    gender:       student?.gender      || null,
    dateOfBirth:  student?.dateOfBirth || null,
    showGrades:   grading.showGrades,
    subjects:     subjectRowsFor(studentId, byStudent, grading.bands, grading.showGrades),
    summary: {
      average:        record.annualAverage,
      overallGrade:   grading.showGrades ? record.overallGrade : null,
      overallRemark:  record.overallRemark,
      classPosition:  record.classPosition,
      totalInClass:   record.totalInClass,
      isPassing:      record.isPassing,
      isPublished:    record.isPublished ?? false,
      promotionStatus: promotionLabel(record),
    },
    annualResult: {
      average:       record.annualAverage,
      grade:         grading.showGrades ? record.overallGrade : null,
      remark:        record.overallRemark,
      classPosition: record.classPosition,
      totalInClass:  record.totalInClass,
    },
    termAverages: (record.termAverages || []).map((t) => ({
      term: t.term, average: t.average,
    })),
    computed: { outOf: 20 },
  };
}

/**
 * The promotion decision as it should read on paper.
 *
 * The model stores a machine value; a parent reads a sentence. "promoted" with
 * a destination class names it, because "PROMOTED" alone leaves the one
 * question the family actually has unanswered.
 */
function promotionLabel(record) {
  const status = record?.promotionStatus || null;
  if (!status || status === "pending") return null;
  const next = record.nextClassName || record.promotedToClassName || null;
  switch (status) {
    case "promoted":
      return next ? `PROMOTED TO ${String(next).toUpperCase()}` : "PROMOTED TO THE NEXT CLASS";
    case "repeated":    return "REPEATED";
    case "graduated":   return "GRADUATED";
    case "conditional": return "CONDITIONAL PROMOTION";
    default:            return String(status).toUpperCase();
  }
}

/**
 * The school's own report-card layout, or null for the built-in one.
 *
 * Lives here rather than in results.controller.js because all three cards need
 * it and a second copy is how the sequence card and the term card end up
 * printing on different paper.
 *
 * @param {string} schoolId
 * @param {string} [templateId]  a specific template, or "builtin" to force the
 *                               built-in layout; the school's default otherwise
 */
async function loadReportTemplate(schoolId, templateId) {
  if (!schoolId || templateId === "builtin") return null;
  try {
    const ReportTemplate = require("../db/models/ReportTemplate");
    const query = { schoolId: String(schoolId), deletedAt: null };
    if (templateId) query._id = String(templateId);
    else            query.isDefault = true;

    const tpl = await ReportTemplate.findOne(query)
      .select("_id name html css version")
      .lean();

    return tpl?.html ? tpl : null;
  } catch (err) {
    console.error("[reportcard] template lookup failed:", err.message);
    return null;
  }
}

module.exports = {
  buildTermCard,
  buildAnnualCard,
  promotionLabel,
  loadReportTemplate,
};
