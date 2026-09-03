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
const School            = require("../db/models/School");
const Class             = require("../db/models/Class");
const docVerify         = require("./documentVerify.service");

const { subjectRanking, periodName } = require("../../../shared/reportCard");
const { coefficientFromWeight } =
  require("./subjectCoefficient.service");

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
      // Both, so the renderer can pick by the reader's language.
      remarkFr:        band?.remarkFr || band?.remark || null,
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

/**
 * The class as it should be printed.
 *
 * TermResult.className is written from Student.className, which is not a field
 * every pupil carries — the class is held as classId. So the stored name was
 * usually null and the card printed an empty Class row. Looked up here instead,
 * with the stored value still preferred: a pupil who has since moved class
 * should print the class the result was earned in.
 */
async function classNameFor(classId, stored) {
  if (stored) return stored;
  if (!classId) return null;
  const cls = await Class.findOne({ _id: String(classId) })
    .select("name").lean().catch(() => null);
  return cls?.name || null;
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
    className:    await classNameFor(classId, record.className),
    academicYear,
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
    subjects:     subjectRowsFor(studentId, byStudent, grading.bands, grading.showGrades),
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
    className:    await classNameFor(classId, record.className),
    academicYear,
    term:         null,
    examName:     periodName({ reportType: "annual" }, "en"),
    period:       { reportType: "annual" },
    gender:       student?.gender      || null,
    dateOfBirth:  student?.dateOfBirth || null,
    showGrades:   grading.showGrades,
    subjects:     subjectRowsFor(studentId, byStudent, grading.bands, grading.showGrades),
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
                "address phone")
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
    : data.summary?.average == null
      ? null
      : data.reportType === "sequence"
        ? Math.round(Number(data.summary.average) * 5 * 100) / 100
        : Number(data.summary.average);

  const isPassing = data.summary?.isPassing ?? (avg20 != null ? avg20 >= 10 : null);
  const position  = data.summary?.classPosition;

  const origin = (() => {
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
  cardVerification,
  periodDocumentKey,
  loadSchoolForCard,
  buildTermCard,
  buildAnnualCard,
  promotionLabel,
  loadReportTemplate,
  absoluteLogoUrl,
};
