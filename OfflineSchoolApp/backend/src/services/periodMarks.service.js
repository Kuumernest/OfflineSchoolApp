// backend/src/services/periodMarks.service.js
"use strict";

/**
 * A class's per-subject marks for a term or a year — fetched once, for the
 * stored averages and the report cards alike.
 *
 * The term and annual averages (termGrading, annualGrading) and the cards that
 * print them (reportCardData) used to reach their figures by two routes, and
 * the two disagreed (14.5 above a table totalling 14.42). Both now read the
 * marks from here and count them with shared/averages.js.
 *
 * Two queries for the marks, whatever the class size, plus one for the
 * deleted pupils among them.
 */

const Exam         = require("../db/models/Exam");
const StudentScore = require("../db/models/StudentScore");
const ExamSubject  = require("../db/models/ExamSubject");
const Student      = require("../db/models/Student");

const { subjectMarksByStudent } = require("../../../shared/averages");
const { coefficientFromWeight } = require("./subjectCoefficient.service");
const sequenceAssessment        = require("./sequenceAssessment.service");

const EXAM_FIELDS = "_id sequenceNumber term type parentExamId startDate endDate";

/**
 * Where each exam sits: its share of its sequence (paper or CA, by the
 * school's CA/Test split; a CA counts 0 with CA off), and its sequence and
 * term. A CA takes its paper's sequence and term.
 */
function placesOf(exams, settings, { sequenceWeight, termWeight }) {
  // weightsWithCa with every sequence weighing 1 is each exam's share of its
  // own sequence.
  const inSequence = sequenceAssessment.weightsWithCa(exams, () => 1, settings);
  const byId = new Map(exams.map((e) => [String(e._id), e]));
  const places = new Map();
  for (const e of exams) {
    const paper = e.parentExamId ? byId.get(String(e.parentExamId)) || e : e;
    const term = Number(paper.term ?? e.term);
    const sequence = paper.sequenceNumber ?? e.sequenceNumber;
    places.set(String(e._id), {
      inSequence:     inSequence.get(String(e._id)) ?? 1,
      sequence:       `${term}:${sequence}`,
      sequenceWeight: sequenceWeight(term, sequence),
      term,
      termWeight:     termWeight(term),
    });
  }
  return (examId) => places.get(String(examId)) ||
    { inSequence: 1, sequence: examId, sequenceWeight: 1, term: 0, termWeight: 1 };
}

/**
 * Per-subject marks of a class over a set of exams.
 *
 * Scoped to the class: a term's exams are the school's, sat by every class.
 * A deleted pupil's marks are left out — no ranking counts them.
 */
async function marksAcross(exams, placeOf, classId) {
  const examIds = exams.map((e) => String(e._id));
  if (examIds.length === 0) return { byStudent: new Map(), subjects: new Map() };

  const [scores, examSubjects] = await Promise.all([
    StudentScore.find({
      examId: { $in: examIds }, deletedAt: null,
      ...(classId ? { classId: String(classId) } : {}),
    })
      .select("studentId examId examSubjectId subjectId score maxScore isAbsent isExempt")
      .lean(),
    ExamSubject.find({ examId: { $in: examIds }, deletedAt: null })
      // weight, not coefficient: ExamSubject stores the percentage-style
      // weight and has no `coefficient` field at all.
      .select("_id examId subjectId subjectName weight maxScore")
      .lean(),
  ]);

  const deleted = new Set((await Student.find({
    _id: { $in: [...new Set(scores.map((sc) => String(sc.studentId)))] },
    deletedAt: { $ne: null },
  }).select("_id").lean()).map((s) => String(s._id)));

  return subjectMarksByStudent({
    scores,
    examSubjects,
    placeOf,
    coefficientOf: (es) => coefficientFromWeight(es.weight),
    skipStudent:   (sid) => deleted.has(sid),
  });
}

/**
 * A term's marks for a class.
 *
 * @param {object} p
 * @param {object} p.termConfig  { number, sequences: [{ number, weight }] }
 * @param {object} [p.caSettings] loaded when not given
 * @returns {Promise<{ exams, byStudent, subjects }>}
 */
async function termMarks({ schoolId, academicYear, term, classId, termConfig, caSettings = null }) {
  const seqNumbers = termConfig?.sequences?.map((s) => s.number) || [];
  const exams = await Exam.find({
    schoolId: String(schoolId), academicYear, term: Number(term),
    ...(seqNumbers.length ? { sequenceNumber: { $in: seqNumbers } } : {}),
    deletedAt: null,
  }).select(EXAM_FIELDS).lean();

  const weightBySeq = new Map((termConfig?.sequences || []).map((s) => [s.number, s.weight ?? 50]));
  const settings = caSettings || await sequenceAssessment.loadCaSettings(schoolId);
  const placeOf = placesOf(exams, settings, {
    sequenceWeight: (_t, seq) => weightBySeq.get(seq) ?? 50,
    termWeight:     () => 1,
  });

  const { byStudent, subjects } = await marksAcross(exams, placeOf, classId);
  return { exams, byStudent, subjects };
}

/**
 * A year's marks for a class: every exam, by its sequence's share of its term
 * and its term's share of the year.
 *
 * @param {object} p
 * @param {Array}  p.terms  [{ number, weight, sequences: [{ number, weight }] }]
 */
async function annualMarks({ schoolId, academicYear, classId, terms, caSettings = null }) {
  const exams = await Exam.find({
    schoolId: String(schoolId), academicYear, deletedAt: null,
  }).select(EXAM_FIELDS).lean();

  const settings = caSettings || await sequenceAssessment.loadCaSettings(schoolId);
  const termOf = (t) => (terms || []).find((x) => x.number === t);
  const placeOf = placesOf(exams, settings, {
    sequenceWeight: (t, seq) => termOf(t)?.sequences?.find((s) => s.number === seq)?.weight ?? 50,
    termWeight:     (t) => termOf(t)?.weight ?? 100 / 3,
  });

  const { byStudent, subjects } = await marksAcross(exams, placeOf, classId);
  return { exams, byStudent, subjects };
}

module.exports = { termMarks, annualMarks, marksAcross };
