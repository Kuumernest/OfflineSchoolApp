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
const classStats        = require("./classStats.service");
const TeacherAssignment = require("../db/models/TeacherAssignment");
const User              = require("../db/models/User");
const StudentScore      = require("../db/models/StudentScore");
const ExamSubject       = require("../db/models/ExamSubject");
const TermResult        = require("../db/models/TermResult");
const AnnualResult      = require("../db/models/AnnualResult");
const AcademicStructure = require("../db/models/AcademicStructure");
const GradingConfig     = require("../db/models/GradingConfig");
const Student           = require("../db/models/Student");
const School            = require("../db/models/School");
const Class             = require("../db/models/Class");
const docVerify         = require("./documentVerify.service");

const { subjectRanking, periodName, averageOutOf20 } =
  require("../../../shared/reportCard");
const { coefficientFromWeight } =
  require("./subjectCoefficient.service");
const sequenceAssessment = require("./sequenceAssessment.service");

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
      // weight, not coefficient: ExamSubject stores the percentage-style
      // weight and has no `coefficient` field at all, so reading one gave
      // undefined and every subject on a term or annual card printed ×1.
      .select("_id examId subjectId subjectName weight maxScore")
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
        coefficient: coefficientFromWeight(es.weight),
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
    bySubject.get(subject).push({
      mark, weight: weightOf(String(sc.examId)), examId: String(sc.examId),
    });
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
        // The marks this one was combined from, each with the weight it
        // carried and the exam it came from. A term card prints its two
        // sequences from these rather than recombining anything: the
        // hierarchy is CA and paper into a sequence, sequences into a term,
        // and a card must show the level it is for without re-deriving the
        // level below it by a different route.
        parts:       list.map((part) => ({ ...part })),
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
/**
 * What the table's last row states: the coefficients it carries and the marks
 * weighted by them.
 *
 * The same definition the sequence card has always used for its average —
 * sum of (mark x coefficient) over the subjects a pupil actually sat, and the
 * sum of those coefficients. It is not a second average: the average on each
 * card stays whatever that card's own record says it is.
 *
 * A subject with no mark counts for neither, which is the existing rule: an
 * absence is not a zero, and its coefficient must not dilute the average of
 * the papers the pupil did sit.
 */
function rowTotals(rows) {
  const counted = (rows || []).filter(
    (r) => !r.isAbsent && !r.isExempt && r.score != null && Number.isFinite(Number(r.score))
  );
  const totalCoefficients = counted.reduce((s, r) => s + Number(r.coefficient ?? 0), 0);
  const totalWeighted = counted.reduce(
    (s, r) => s + Number(r.score) * Number(r.coefficient ?? 0), 0
  );
  return {
    totalCoefficients,
    totalWeighted: Math.round(totalWeighted * 100) / 100,
  };
}

function subjectRowsFor(studentId, byStudent, bands, showGrades, passMark = 10) {
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
      // Both, so the renderer can pick by the reader's language.
      remarkFr:        band?.remarkFr || band?.remark || null,
      subjectPosition: place.position,
      subjectTotal:    place.total,
      /*
       * Passed this subject, or not.
       *
       * The school's pass mark, which is what a sequence card uses one level
       * down: the marks pipeline writes isPassing onto every StudentScore
       * from the exam's pass mark, and a term card asking a different
       * question — "is the grade band F?" — printed a 9/20 in green because
       * the band for 9 is D. Same threshold at every level, so a subject
       * that fails on a sequence card does not pass on the term's.
       */
      isPassing:       row.mark == null ? null : Number(row.mark) >= Number(passMark),
      parts:           row.parts || [],
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
    // The mark a subject has to reach. The school's own, defaulting to the
    // 10/20 the model defaults to; a sequence card reads the same decision
    // from each StudentScore, which the marks pipeline writes with it.
    passMark:   cfg?.passMark ?? 10,
  };
}

/**
 * The class as it should be printed.
 *
 * TermResult.className is written from Student.className, which is not a field
 * every pupil carries — the class is held as classId. So the stored name was
 * usually null and the card printed an empty Class row. Looked up here instead,
 * with the stored value still preferred: a pupil who has since moved class
 * should print the class the result was earned in.
 */
/**
 * Who teaches each subject to this class.
 *
 * TeacherAssignment is the source of truth for that — the same rows the
 * permission layer reads when it decides whether a teacher may enter marks
 * for a class (see utils/teacherScope.js). The class teacher is a different
 * person and a different question; a report card that printed them against
 * every subject would be stating something false about most of them.
 *
 * Two queries for the whole card, never one per row: the assignments for
 * this class, then the names behind them.
 *
 * A subject nobody is assigned to comes back absent from the map, and the
 * renderer prints the card's own dash rather than inventing a name.
 *
 * @param {object} args
 * @param {string} args.schoolId
 * @param {string} args.classId
 * @param {string[]} args.subjectIds
 * @returns {Promise<Map<string, string>>} subjectId → one name, or several
 *   joined by a comma where a school really has assigned more than one.
 */
async function subjectTeachers({ schoolId, classId, subjectIds }) {
  const out = new Map();
  const ids = [...new Set((subjectIds || []).map(String).filter(Boolean))];
  if (!schoolId || !classId || !ids.length) return out;

  const rows = await TeacherAssignment.find({
    schoolId: String(schoolId),
    class:    String(classId),
    subject:  { $in: ids },
    isActive: true,
  }).select("teacher subject").lean().catch(() => []);
  if (!rows.length) return out;

  const teachers = await User.find({
    _id: { $in: [...new Set(rows.map((r) => String(r.teacher)))] },
  }).select("name").lean().catch(() => []);
  const nameOf = new Map(teachers.map((t) => [String(t._id), t.name]));

  // Several teachers on one subject is allowed by the model (the unique
  // index is on teacher+class+subject), and both names belong on the row
  // rather than on two rows for the same subject. Sorted, because two
  // printings of the same card must not disagree about the order of names —
  // the database returns them in whatever order it finds them.
  const namesBySubject = new Map();
  for (const r of rows) {
    const name = nameOf.get(String(r.teacher));
    if (!name) continue;
    const key = String(r.subject);
    if (!namesBySubject.has(key)) namesBySubject.set(key, []);
    namesBySubject.get(key).push(name);
  }
  for (const [subject, names] of namesBySubject) {
    out.set(subject, [...new Set(names)].sort((a, b) => a.localeCompare(b)).join(", "));
  }
  return out;
}

async function classInfoFor(classId, storedName) {
  if (!classId) return { name: storedName || null, teacherName: null };
  const cls = await Class.findOne({ _id: String(classId) })
    .select("name classTeacherName").lean().catch(() => null);
  return {
    // A stored name still wins: a pupil who has moved class should print the
    // class the result was earned in.
    name:        storedName || cls?.name || null,
    /*
     * The form master, for the signature line at the foot of the card.
     *
     * Read from the class rather than looked up through the teacher's User row,
     * because the class carries the name denormalised on purpose — a teacher
     * who leaves has their account deactivated, and a card reprinted a year
     * later must still name the person who signed it.
     */
    teacherName: cls?.classTeacherName || null,
  };
}

async function studentIdentity(studentId) {
  return Student.findOne({ _id: String(studentId) })
    .select("gender dateOfBirth studentName enrollmentNo admissionNo photoUrl")
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
  // startDate/endDate: the term's days, for the register. They are the only
  // dates a period has — AcademicStructure defines the terms but carries no
  // calendar — so the term is the span of the exams that make it up.
  }).select("_id sequenceNumber term type parentExamId startDate endDate").lean();

  const weightBySeq = new Map(
    (termConfig?.sequences || []).map((s) => [s.number, s.weight ?? 50])
  );

  /*
   * A sequence's share, split between its two assessments.
   *
   * The exams above now include the continuous assessments, and a term card
   * combines per-subject marks across exams by weight. Giving a CA the
   * sequence's whole share would count it as a third sequence; splitting the
   * share by the school's CA/Test percentages gives the same subject mark the
   * sequence card prints, one level up. weightedMark() below already drops the
   * parts a pupil has no mark for and renormalises over the rest, so a pupil
   * with no CA is graded on the paper rather than on 60 % of it.
   */
  const caSettings   = await sequenceAssessment.loadCaSettings(schoolId);
  const weightByExam = sequenceAssessment.weightsWithCa(
    exams, (e) => weightBySeq.get(e.sequenceNumber) ?? 50, caSettings
  );

  const { byStudent } = await subjectMarksAcross(
    exams, (examId) => weightByExam.get(examId) ?? 50
  );

  const classInfo = await classInfoFor(classId, record.className);

  const cardClassStats = await classStats.termClassStats({ schoolId, academicYear, term, classId });

  const rows     = subjectRowsFor(studentId, byStudent, grading.bands, grading.showGrades,
                                  grading.passMark);
  const teachers = await subjectTeachers({
    schoolId, classId, subjectIds: rows.map((r) => r.subjectId),
  });
  for (const r of rows) r.teacherName = teachers.get(String(r.subjectId)) || null;

  /*
   * A term card is not a sequence card with more marks in it.
   *
   * Its subject columns are the term's sequences and the result they
   * combine to, not the CA and the paper that made each sequence: those
   * belong one level down, on the sequence card. The sequence figures here
   * are the same marks the combination above used, grouped by the sequence
   * their exam belongs to and combined by the same weighted rule — never a
   * second formula over the raw assessments.
   */
  const sequenceOfExam = new Map(exams.map((e) => [String(e._id), e.sequenceNumber]));
  const sequenceColumns = (termConfig?.sequences || []).map((sq) => ({
    number: sq.number,
    name:   sq.name || `Sequence ${sq.number}`,
  }));
  for (const r of rows) {
    r.sequenceMarks = sequenceColumns.map((col) => {
      const mine = (r.parts || []).filter(
        (part) => sequenceOfExam.get(String(part.examId)) === col.number
      );
      const mark = mine.length ? weightedMark(mine) : null;
      return { number: col.number, mark: mark == null ? null : round2(mark) };
    });
    delete r.parts;
  }

  return {
    reportType:   "term",
    // The columns this card's table is built from, named as the school's
    // own academic structure names them.
    sequenceColumns,
    studentId:    String(studentId),
    studentName:  record.studentName || student?.studentName || null,
    admissionNo:  record.admissionNo || student?.enrollmentNo || student?.admissionNo || null,
    className:    classInfo.name,
    // The form master, printed over the signature rule. Nothing populated this
    // before — the class had no teacher field at all — so every card issued
    // carried an empty box with a rule under it.
    classTeacher: classInfo.teacherName,
    academicYear,
    // The stored path. The route makes it absolute, where the request is.
    photoUrl:     student?.photoUrl || null,
    term:         periodName({ reportType: "term", term: Number(term),
                                name: termConfig?.name || null }, "en"),
    // What this card is OF. The sequence card carries its exam's name here and
    // a template prints it as {{exam_name}}; a term card carried nothing, so
    // that field came out blank on every one of them.
    examName:     periodName({ reportType: "term", term: Number(term),
                                name: termConfig?.name || null }, "en"),
    // The facts, so the header can name the term in the reader's language.
    period:       { reportType: "term", term: Number(term),
                    name: termConfig?.name || null },
    gender:       student?.gender      || null,
    dateOfBirth:  student?.dateOfBirth || null,
    showGrades:   grading.showGrades,
    subjects:     rows,
    summary: {
      average:        record.termAverage,
      overallGrade:   grading.showGrades ? record.overallGrade : null,
      overallRemark:  record.overallRemark,
      overallRemarkFr: GradingConfig.bandRemark(
        GradingConfig.findGradeBand(record.termAverage ?? record.annualAverage, grading.bands),
        "fr") || record.overallRemark,
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
    // Out of twenty, like the term averages they summarise.
    classStats: cardClassStats,
    // The table's own totals, from the same marks and coefficients the rows
    // print. The term average stays the stored one — these are the figures
    // under it, not a second way of computing it.
    computed: { outOf: 20, ...rowTotals(rows) },
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
  // startDate/endDate: the year's days, for the register — see buildTermCard.
  }).select("_id term sequenceNumber type parentExamId startDate endDate").lean();

  // The same split the term card makes, applied to the annual share: a
  // sequence's slice of the year, divided between its CA and its paper.
  const caSettings = await sequenceAssessment.loadCaSettings(schoolId);
  const shareOf = (e) => {
    const termConfig = structure?.terms?.find((t) => t.number === e.term);
    const seqConfig  = termConfig?.sequences?.find((s) => s.number === e.sequenceNumber);
    const termShare  = (termConfig?.weight ?? 100 / 3) / 100;
    const seqShare   = (seqConfig?.weight ?? 50) / 100;
    return termShare * seqShare * 100;
  };
  const weightByExam = sequenceAssessment.weightsWithCa(exams, shareOf, caSettings);

  const { byStudent } = await subjectMarksAcross(
    exams, (examId) => weightByExam.get(examId) ?? 1
  );

  const classInfo = await classInfoFor(classId, record.className);

  const cardClassStats = await classStats.annualClassStats({ schoolId, academicYear, classId });

  const rows     = subjectRowsFor(studentId, byStudent, grading.bands, grading.showGrades,
                                  grading.passMark);
  const teachers = await subjectTeachers({
    schoolId, classId, subjectIds: rows.map((r) => r.subjectId),
  });
  for (const r of rows) {
    r.teacherName = teachers.get(String(r.subjectId)) || null;
    // The annual card's structure is unchanged: one subject result for the
    // year, from the annual aggregation the application already does.
    delete r.parts;
  }

  return {
    reportType:   "annual",
    studentId:    String(studentId),
    studentName:  record.studentName || student?.studentName || null,
    admissionNo:  record.admissionNo || student?.enrollmentNo || student?.admissionNo || null,
    className:    classInfo.name,
    classTeacher: classInfo.teacherName,
    academicYear,
    photoUrl:     student?.photoUrl || null,
    term:         null,
    examName:     periodName({ reportType: "annual" }, "en"),
    period:       { reportType: "annual" },
    gender:       student?.gender      || null,
    dateOfBirth:  student?.dateOfBirth || null,
    showGrades:   grading.showGrades,
    subjects:     rows,
    summary: {
      average:        record.annualAverage,
      overallGrade:   grading.showGrades ? record.overallGrade : null,
      overallRemark:  record.overallRemark,
      overallRemarkFr: GradingConfig.bandRemark(
        GradingConfig.findGradeBand(record.termAverage ?? record.annualAverage, grading.bands),
        "fr") || record.overallRemark,
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
    // Out of twenty, like the annual averages they summarise.
    classStats: cardClassStats,
    computed: { outOf: 20, ...rowTotals(rows) },
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

/**
 * The school's logo as something an <img> can actually load.
 *
 * School.logo holds a server-relative path — "/uploads/logos/<file>.jpg". The
 * report card is printed by writing the HTML into a new window, whose document
 * is about:blank, so a relative src has no origin to resolve against. Behind a
 * single reverse proxy it happens to work; in development, where the console is
 * on one port and the API on another, it silently 404s and the card prints with
 * no logo at all.
 *
 * Absolute, from the request, so the document carries its own answer.
 *
 * @param {string|null} logo  the stored value; a data: or http(s): URL is
 *                            already usable and passes through untouched
 * @param {object} req        to read the protocol and host, honouring the
 *                            forwarded headers a proxy sets
 */
function absoluteLogoUrl(logo, req) {
  if (!logo) return null;
  if (/^(https?:|data:)/i.test(logo)) return logo;

  const proto = String(req?.headers?.["x-forwarded-proto"] || req?.protocol || "http")
    .split(",")[0].trim();
  const host  = String(req?.headers?.["x-forwarded-host"] || req?.get?.("host") || "")
    .split(",")[0].trim();
  if (!host) return logo;

  return `${proto}://${host}${logo.startsWith("/") ? "" : "/"}${logo}`;
}

/**
 * The school's letterhead, loaded once and the same for all three cards.
 *
 * Every card route used to do this itself, and all three selected exactly
 * "name logo motto" — so the official header's ministry and delegations, which
 * live on the same document, arrived empty no matter what a school had typed
 * into its settings. Three copies of a field list is how the payload came to
 * disagree with itself about gender and date of birth, and this is the same
 * shape of bug waiting to happen again.
 *
 * The logo comes back absolute, since that is what every caller then did to it.
 *
 * @param {string|null} schoolId
 * @param {object}      req  for the absolute logo URL
 * @returns {{ doc: object|null, school: object }}  `school` is renderer-ready
 */
async function loadSchoolForCard(schoolId, req) {
  // .catch: a schoolId that does not cast to an ObjectId throws, and losing a
  // whole report card because its letterhead could not be looked up is the
  // wrong trade — the renderer falls back to the name it was given.
  const doc = schoolId
    ? await School.findOne({ _id: String(schoolId) })
        .select("name logo motto region division state city schoolType " +
                "address phone nextTermResumption")
        .lean().catch(() => null)
    : null;

  return {
    doc,
    school: {
      name:       doc?.name  || "",
      logo:       absoluteLogoUrl(doc?.logo, req),
      motto:      doc?.motto || null,
      // The seeded template prints these under the school's name; nothing
      // selected them, so it printed the separator between two blanks.
      address:    doc?.address   || null,
      phone:      doc?.phone     || null,
      // §2 of the header: the delegations and the ministry they imply.
      region:     doc?.region     || null,
      division:   doc?.division   || null,
      state:      doc?.state      || null,
      city:       doc?.city       || null,
      schoolType: doc?.schoolType || null,
      // Printed at the foot of the card. The engine has always had a
      // {{next_term_date}} token and there was never anywhere to set it, so
      // every card said "To be announced".
      nextTermResumption: doc?.nextTermResumption || null,
    },
  };
}

/**
 * The verification strip for any of the three cards.
 *
 * ── Why it is here and not in the sequence controller ─────────────────────
 *
 * It was in the controller, so only the sequence card had one. A term or annual
 * card rendered {{qr_code}} with nothing behind it, which the engine turns into
 * the inert placeholder box — a card printed with a grey square where its QR
 * belongs, and no code beneath it. The document that is hardest to check by eye,
 * because its marks are combined from several exams and stored nowhere a
 * registrar can see, was the one with no way to check it.
 *
 * ── The document key ──────────────────────────────────────────────────────
 *
 * The verification row is unique per (school, kind, pupil, examId), and a term
 * card has no exam. Passing nothing would collapse every term of every year for
 * one pupil onto a single code, so each card names its own period as the key:
 * `term:2026/2027:1`, `annual:2026/2027`. A real examId is a uuid, so these
 * cannot collide with one.
 *
 * @param {object} p
 * @param {object} p.data       the card payload
 * @param {string} p.schoolId
 * @param {string} p.studentId
 * @param {string} p.documentKey  what stands in for the exam id
 * @param {object} p.req        for the origin the QR points at
 * @returns {Promise<{code, url, qrSvg}|null>} null if a code cannot be issued —
 *   a document that cannot get its QR is still a valid document
 */
async function cardVerification({ data, schoolId, studentId, documentKey, req }) {
  if (!schoolId) return null;

  /*
   * The average as /20, which is what the page must agree with the paper about.
   *
   * A sequence card's summary.average is GPA points, which the renderer shows
   * as ×5; a term or annual card's is already the /20 average it was computed
   * as. Reading them the same way would print a mark on the verification page
   * that the card beside it contradicts.
   */
  const avg20 = data.computed?.weightedAverage != null
    ? Number(data.computed.weightedAverage)
    : averageOutOf20(data.summary?.average, data.reportType);

  const isPassing = data.summary?.isPassing ?? (avg20 != null ? avg20 >= 10 : null);
  const position  = data.summary?.classPosition;

  /*
   * Where the code can be checked.
   *
   * BASE_URL when the deployment sets one — the same variable the uploads
   * links use — so a card printed from behind a proxy, a worker or a queue
   * carries the address a parent can actually reach. The request is the
   * fallback, which is right in development and for a single-origin
   * deployment, and nothing is hard-coded either way: with neither, no
   * strip is printed rather than a wrong address.
   */
  const origin = (() => {
    const configured = String(process.env.BASE_URL || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    const proto = req?.headers?.["x-forwarded-proto"] || req?.protocol || "http";
    const host  = req?.headers?.["x-forwarded-host"]  || req?.get?.("host");
    return host ? `${proto}://${host}` : null;
  })();

  return docVerify.printableBlock({
    schoolId: String(schoolId),
    kind:     "report_card",
    studentId: String(studentId),
    examId:   String(documentKey),
    origin,
    snapshot: {
      facts: [
        { label: { en: "Student", fr: "Élève" },           value: data.studentName },
        { label: { en: "Admission no.", fr: "Matricule" }, value: data.admissionNo },
        { label: { en: "Class", fr: "Classe" },            value: data.className },
        { label: { en: "Exam", fr: "Examen" },             value: data.examName },
        { label: { en: "Term / year", fr: "Trimestre / année" },
          value: [data.term, data.academicYear].filter(Boolean).join(" · ") || "—" },
        { label: { en: "Average /20", fr: "Moyenne /20" },
          value: avg20 != null ? avg20.toFixed(2) : "—" },
        { label: { en: "Overall grade", fr: "Mention" },
          value: data.summary?.overallGrade ?? "—" },
        { label: { en: "Class position", fr: "Rang" },
          value: position != null
            ? `${position}${data.summary?.totalInClass != null ? ` / ${data.summary.totalInClass}` : ""}`
            : "—" },
        { label: { en: "Decision", fr: "Décision" },
          value: isPassing == null ? "—" : isPassing ? "Passed / Admis(e)" : "Failed / Ajourné(e)" },
      ],
    },
  });
}

/** The document key for a card with no exam behind it. */
const periodDocumentKey = (data) =>
  data.reportType === "annual"
    ? `annual:${data.academicYear}`
    : `term:${data.academicYear}:${data.period?.term ?? data.term}`;

module.exports = {
  subjectTeachers,
  cardVerification,
  periodDocumentKey,
  loadSchoolForCard,
  buildTermCard,
  buildAnnualCard,
  promotionLabel,
  loadReportTemplate,
  absoluteLogoUrl,
};
