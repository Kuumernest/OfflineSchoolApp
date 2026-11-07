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

const classStats        = require("./classStats.service");
const { teachersFor }   = require("./classSubjectTeacher.service");
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
// The terms and sequences, from the period tree (docs/39 Phase 3).
const { legacyTermsOf } = require("../../../shared/academicPolicy");

// The marks and the average: one loader and one rule, shared with the stored
// term and annual averages (periodMarks.service, shared/averages.js), so the
// card's TOTAL row and its average cannot disagree.
const periodMarks = require("./periodMarks.service");
const { round2, combineMarks, coefficientAverage } = require("../../../shared/averages");

/**
 * What the table's last row states: the coefficients it carries and the marks
 * weighted by them — sum(mark x coefficient) / sum(coefficients) over the
 * subjects the pupil has a mark in. The same figure as the stored average.
 */
function rowTotals(rows) {
  const { totalCoefficients, totalWeighted } = coefficientAverage(rows);
  return { totalCoefficients, totalWeighted };
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
  // The class-subject assignment, read the one way every screen reads it
  // (services/classSubjectTeacher.service.js, A8): active assignments of this
  // class and subject, names sorted, two teachers joined with ", ".
  const out = new Map();
  const ids = [...new Set((subjectIds || []).map(String).filter(Boolean))];
  if (!schoolId || !classId || !ids.length) return out;
  const lookup = await teachersFor({ schoolId, classIds: [classId], subjectIds: ids });
  for (const id of ids) {
    const t = lookup(classId, id);
    if (t?.teacherName) out.set(id, t.teacherName);
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

  const termConfig = legacyTermsOf(structure).find((t) => t.number === Number(term)) || null;
  // The term's exams (their dates make the register's span) and every pupil's
  // subject marks across them, by the same loader the stored term average
  // reads — a sequence's share split between its paper and its CA.
  const { exams, byStudent } = await periodMarks.termMarks({
    schoolId, academicYear, term, classId, termConfig,
  });

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
      const mark = mine.length ? combineMarks(mine) : null;
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
      gradePosition:  record.gradePosition  ?? null,
      totalInGrade:   record.totalInGrade   ?? null,
      schoolPosition: record.schoolPosition ?? null,
      totalInSchool:  record.totalInSchool  ?? null,
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
  // and its sequence's share of the term — the loader the stored annual
  // average reads too.
  const { byStudent } = await periodMarks.annualMarks({
    schoolId, academicYear, classId, terms: legacyTermsOf(structure),
  });

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
      // The year's own average. This read `record.termAverage ?? …`, copied
      // from the term card: an annual row carrying a stray termAverage
      // printed that figure's French remark beside the year's (docs/39 §4.6h).
      overallRemarkFr: GradingConfig.bandRemark(
        GradingConfig.findGradeBand(record.annualAverage, grading.bands),
        "fr") || record.overallRemark,
      classPosition:  record.classPosition,
      totalInClass:   record.totalInClass,
      gradePosition:  record.gradePosition  ?? null,
      totalInGrade:   record.totalInGrade   ?? null,
      schoolPosition: record.schoolPosition ?? null,
      totalInSchool:  record.totalInSchool  ?? null,
      isPassing:      record.isPassing,
      isPublished:    record.isPublished ?? false,
      promotionStatus: promotionLabel(record),
      // The machine value and the destination, so a French card can print
      // the decision in French (reportHtml promotionText); the English
      // sentence above is unchanged.
      promotionCode:      record.promotionStatus || null,
      promotionNextClass: record.nextClassName || record.promotedToClassName || null,
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
const { resolveImageSrc, originOf } = require("../print/imageSource");

function absoluteLogoUrl(logo, req) {
  // print/imageSource.js, as a link: a published card is stored whole, and an
  // embedded logo and photo in every stored card would cost the database the
  // size of both, per card. It also turns the legacy inline base64 logo into a
  // data URI rather than gluing the host onto it.
  return resolveImageSrc(logo, { origin: originOf(req) });
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
                "address phone nextTermResumption defaultLanguage")
        .lean().catch(() => null)
    : null;

  return {
    doc,
    // The language every report card of the school prints in, whoever views
    // it (decided 2026-10-16, docs/41 §7): School.defaultLanguage. No class
    // or section carries a language of its own in the data model.
    language: doc?.defaultLanguage === "fr" ? "fr" : "en",
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
 * @param {boolean} [p.count]   false for a preview: show the code, count no print
 * @returns {Promise<{code, url, qrSvg}|null>} null if a code cannot be issued —
 *   a document that cannot get its QR is still a valid document
 */
async function cardVerification({ data, schoolId, studentId, documentKey, req, count = true }) {
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
    : averageOutOf20(data.summary?.average, data.reportType, data.summary?.calcVersion);

  const isPassing = data.summary?.isPassing ?? (avg20 != null ? avg20 >= 10 : null);
  const position  = data.summary?.classPosition;

  // Where the code can be checked: documentVerify.verifyBase — the app's own
  // domain unless PUBLIC_VERIFY_BASE_URL says otherwise.
  return docVerify.printableBlock({
    count,
    schoolId: String(schoolId),
    kind:     "report_card",
    studentId: String(studentId),
    examId:   String(documentKey),
    req,
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
