// backend/src/services/reportHtml.service.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REPORT CARD HTML RENDERER — the single rendering engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 consolidation: this replaces the four hardcoded client-side
 * builders that had drifted apart and printed blank marks when their data
 * fetch silently failed:
 *
 *   1. web/src/pages/exams/reports/index.tsx   buildReportHtml  (window.print)
 *   2. mobile app/admin/exams/reports/generate buildReportHtml  (expo-print)
 *   3. mobile app/admin/reports/generate       buildReportHtml  (expo-print)
 *   4. mobile app/admin/components/ReportCard  buildPdfHtml     (print/share)
 *
 * Every platform now fetches the SAME html string from
 * GET /results/:examId/student/:studentId/reportcard/html and hands it to
 * its own printing mechanism. One layout to fix, one to translate.
 *
 * The 4th copy (ReportCard buildPdfHtml) is retained only as an offline
 * fallback inside that component when the identifiers/network are
 * unavailable — online it is never used.
 *
 * Input is the report card payload produced by
 * results.controller.buildStudentReportCardData():
 * { studentName, admissionNo, className, examName, academicYear, term,
 *   subjects: [...], summary: {...}|null, computed: {...} }
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { officialHeader, reportTitle } = require("../../../shared/officialHeader");
const { periodName }                  = require("../../../shared/reportCard");

const LABELS = {
  en: {
    title:        "ACADEMIC REPORT CARD",
    noLogo:       "NO LOGO",
    subject:      "Subject",
    score:        "Score",
    outOf20:      "/20",
    coeff:        "Coeff",
    grade:        "Grade",
    result:       "Result",
    pass:         "Pass",
    fail:         "Fail",
    absent:       "ABS",
    exempt:       "EXEMPT",
    studentName:  "Student Name",
    admissionNo:  "Admission No (Matricule)",
    classLabel:   "Class",
    gender:       "Gender",
    dob:          "Date of Birth",
    academicYear: "Academic Year",
    examLabel:    "Examination",
    average:      "Average",
    percentage:   "Percentage",
    overallGrade: "Overall Grade",
    classPos:     "Class Position",
    remarkCol:    "Remark",
    positionCol:  "Position",
    passed:       "PASSED",
    failed:       "FAILED",
    remark:       "Teacher's Remark",
    // Promotion decision — the final annual report card only.
    decision:     "Council Decision",
    promotedTo:   "PROMOTED",
    repeated:     "REPEATED",
    graduated:    "GRADUATED",
    generatedOn:  "Generated on",
    official:     "Official Academic Report",
    noScores:     "No scores recorded for this student.",
    verifyTitle:  "Verify this document",
    verifyHint:   "Scan the code, or enter",
    locale:       "en-GB",
  },
  fr: {
    title:        "BULLETIN DE NOTES",
    noLogo:       "SANS LOGO",
    subject:      "Matière",
    score:        "Note",
    outOf20:      "/20",
    coeff:        "Coef",
    grade:        "Mention",
    result:       "Résultat",
    pass:         "Admis",
    fail:         "Ajourné",
    absent:       "ABS",
    exempt:       "DISP",
    studentName:  "Nom de l'élève",
    admissionNo:  "Matricule",
    classLabel:   "Classe",
    gender:       "Sexe",
    dob:          "Date de naissance",
    academicYear: "Année académique",
    examLabel:    "Examen",
    average:      "Moyenne",
    percentage:   "Pourcentage",
    overallGrade: "Mention générale",
    classPos:     "Rang",
    remarkCol:    "Observation",
    positionCol:  "Rang",
    passed:       "ADMIS(E)",
    failed:       "AJOURNÉ(E)",
    remark:       "Observation du professeur",
    // Décision du conseil — bulletin annuel uniquement.
    decision:     "Décision du Conseil",
    promotedTo:   "ADMIS(E) EN",
    repeated:     "REDOUBLANT",
    graduated:    "DIPLOMÉ(E)",
    generatedOn:  "Généré le",
    official:     "Bulletin officiel",
    noScores:     "Aucune note enregistrée pour cet élève.",
    verifyTitle:  "Vérifier ce document",
    verifyHint:   "Scannez le code, ou saisissez",
    locale:       "fr-FR",
  },
};

/**
 * The /20 average, resolved identically for both render paths.
 *
 * computed.weightedAverage is already coefficient-weighted and on the /20
 * scale. summary.average is the GPA-points mean (0-4), so x5 converts it
 * back. Both paths call this so a school's own template can never disagree
 * with the built-in layout about the headline number.
 */
// The engine prefixes this to its output when a template fails to parse,
// instead of throwing. Kept in one place because it is a cross-module
// contract with engine/placeholder.engine.js.
const ENGINE_ERROR_MARKER = "<!-- Template Engine Error:";

/**
 * The /20 average this card headlines.
 *
 * ── Why the ×5 is conditional ─────────────────────────────────────────────
 *
 * It was not, and that is the bug. A sequence card's summary.average is GPA
 * points on a /4 scale, so ×5 is how it becomes a mark out of 20. A term or
 * annual card's summary.average is the termAverage or annualAverage, which is
 * ALREADY out of 20 — multiplying it printed a term average of 13.2 as "66.0"
 * on a tile labelled "Average /20", beside an overall grade of C+ that had
 * been read from the stored record and was right. The card contradicted itself
 * in two adjacent boxes.
 *
 * The same distinction cardVerification() makes for the verification page,
 * which is how the two came to disagree: that one was corrected and this one
 * was not, so the page said 15.00 where the paper said 75.00.
 */
function resolveAverage20(payload) {
  const computed = payload.computed || {};
  const summary  = payload.summary  || null;
  if (computed.weightedAverage != null) return Number(computed.weightedAverage);
  if (summary?.average == null) return null;

  const stored = Number(summary.average);
  return payload.reportType === "term" || payload.reportType === "annual"
    ? stored
    : Math.round(stored * 5 * 100) / 100;
}

const esc = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Render the canonical printable report card.
 *
 * @param {object} payload  Report card payload (see header comment)
 * @param {object} [opts]
 * @param {string} [opts.lang]       "en" | "fr"  (default "en")
 * @param {string} [opts.schoolName]
 * @returns {string} Complete standalone HTML document
 */
function renderReportCardHtml(payload, opts = {}) {
  const lang = opts.lang === "fr" ? "fr" : "en";
  const t    = LABELS[lang];
  // Both spellings, because toTemplateData() below already accepts both and a
  // caller that passes only `school` — the object the logo and motto come from
  // — would otherwise print the word "School" as the school's name.
  const schoolName = opts.schoolName || opts.school?.name || "School";

  const subjects = Array.isArray(payload.subjects) ? payload.subjects : [];
  const summary  = payload.summary || null;
  const computed = payload.computed || {};

  // ── Feature switches ─────────────────────────────────────────────────────
  // showGrades comes from the school's grading settings (GradingConfig) and
  // rides on the payload; when OFF the Grade column disappears entirely.
  const showGrades = opts.showGrades ?? payload.showGrades ?? true;
  const school     = opts.school || {};

  // The remark in the reader's language. The band carries both; a teacher's own
  // remark carries one, in whichever language they wrote it, and is not
  // translated. Until this existed a French card printed "Observation" over a
  // column of English remarks, which is the half-translated document that makes
  // a school stop trusting the language switch.
  const remarkOf = (row) =>
    (lang === "fr" ? (row?.remarkFr || row?.remark) : row?.remark) || null;

  const overallRemarkText = remarkOf({
    remark:   summary?.overallRemark,
    remarkFr: summary?.overallRemarkFr,
  });

  // 2nd / 35 — language-aware ordinal for subject and class positions.
  const ordinal = (n) => {
    if (n == null) return "—";
    if (lang === "fr") return `${n}ᵉ`;
    const j = n % 10, k = n % 100;
    if (j === 1 && k !== 11) return `${n}st`;
    if (j === 2 && k !== 12) return `${n}nd`;
    if (j === 3 && k !== 13) return `${n}rd`;
    return `${n}th`;
  };

  // ── Subject rows ──────────────────────────────────────────────────────────
  const rows = subjects.map((s) => {
    const absent = s.isAbsent || s.isExempt;
    const flag   = s.isAbsent ? t.absent : s.isExempt ? t.exempt : "";
    const color  = absent ? "#9CA3AF"
                 : s.isPassing === false ? "#DC2626"
                 : "#059669";
    const norm = s.normalizedMark != null && !absent
      ? Number(s.normalizedMark).toFixed(2)
      : "—";
    const scoreCell = absent
      ? flag
      : `${s.score ?? "—"} / ${s.maxScore ?? 100}`;

    // "2nd / 35" — the student's rank in this subject, over the number of
    // students who actually sat the subject (computed in the controller).
    const posCell = (s) => {
      if (s.subjectPosition == null) return "—";
      const total = s.subjectTotal != null ? ` / ${s.subjectTotal}` : "";
      return `${ordinal(s.subjectPosition)}${total}`;
    };

    return `
      <tr>
        <td>${esc(s.subjectName || "—")}
          ${s.teacherName ? `<div class="teacher">${esc(s.teacherName)}</div>` : ""}
        </td>
        <td style="text-align:center;color:${color}">${esc(scoreCell)}</td>
        <td style="text-align:center;color:${color}">${norm}</td>
        <td style="text-align:center">${s.coefficient ?? 1}</td>
        ${showGrades
          ? `<td style="text-align:center;font-weight:bold;color:${color}">
               ${absent ? flag : esc(s.grade || "—")}
             </td>`
          : ""}
        <td style="text-align:center;color:${absent ? "#9CA3AF" : "#374151"}">
          ${absent ? flag : esc(remarkOf(s) || "—")}
        </td>
        <td style="text-align:center">${absent ? "—" : posCell(s)}</td>
        <td style="text-align:center;color:${color}">
          ${absent ? "—" : s.isPassing ? t.pass : t.fail}
        </td>
      </tr>`;
  }).join("");

  // ── Averages ──────────────────────────────────────────────────────────────
  const avg20 = resolveAverage20(payload);
  const pct   = summary?.percentage;

  const isPassing = summary?.isPassing ?? (avg20 != null ? avg20 >= 10 : null);

  // ── Summary boxes ─────────────────────────────────────────────────────────
  const boxes = [];
  if (avg20 != null) {
    boxes.push(`<div class="box"><div class="box-val">${avg20.toFixed(2)}</div><div class="box-lbl">${t.average} ${t.outOf20}</div></div>`);
  }
  if (pct != null) {
    boxes.push(`<div class="box"><div class="box-val">${Number(pct).toFixed(1)}%</div><div class="box-lbl">${t.percentage}</div></div>`);
  }
  if (summary?.overallGrade) {
    boxes.push(`<div class="box"><div class="box-val">${esc(summary.overallGrade)}</div><div class="box-lbl">${t.overallGrade}</div></div>`);
  }
  if (summary?.classPosition != null) {
    const total = summary.totalInClass != null ? ` / ${summary.totalInClass}` : "";
    boxes.push(`<div class="box"><div class="box-val">${summary.classPosition}${total}</div><div class="box-lbl">${t.classPos}</div></div>`);
  }

  // The promotion decision appears ONLY on the final annual report card —
  // never on sequence or intermediate term reports (see requirements §8).
  const isAnnual   = payload.reportType === "annual";
  const promoStatus = isAnnual ? summary?.promotionStatus || null : null;

  // School branding pulled from the school's settings, never hard-coded.
  const schoolLogo = school.logo || null;
  const schoolMotto = school.motto || null;

  // ── The official header ──────────────────────────────────────────────────
  //
  // Both margin columns are rendered on every card, in both languages, because
  // that is what the document is: a Cameroonian report card carries the
  // ministry and the delegations in English on one side and French on the
  // other regardless of which language the reader chose. Only the title under
  // the rule follows `lang`.
  const headers = officialHeader(school);

  const ministryColumn = (col) => {
    const h = headers[col];
    const sep = `<p>${headers.separator}</p>`;
    return [
      `<div class="ministry-column${col === "fr" ? " french" : ""}">`,
      `<p class="country">${esc(h.country)}</p>`,
      `<p class="peace">${esc(h.peace)}</p>`,
      sep,
      `<p class="ministry">${esc(h.ministry)}</p>`,
      // A delegation with nothing to name is left out rather than printed as a
      // label trailing into nothing; its separator goes with it.
      ...(h.regional   ? [sep, `<p class="delegation">${esc(h.regional)}</p>`]       : []),
      ...(h.divisional ? [sep, `<p class="sub-delegation">${esc(h.divisional)}</p>`] : []),
      ...(h.schoolType ? [`<p class="school-type">${esc(h.schoolType)}</p>`]         : []),
      `</div>`,
    ].join("");
  };

  // "First Sequence Progress Record" — the period named, not numbered, and in
  // the reader's language. payload.term is the English label the payload has
  // always carried, and is the fallback for a caller that predates `period`.
  const reportTitleText = reportTitle(
    periodName({ ...(payload.period || {}), reportType: payload.reportType }, lang)
      || payload.term
      || null,
    lang
  );

  // Student info — payload first (controller enriches it), opts.student as
  // the caller-supplied fallback.
  const stu        = opts.student || {};
  const genderVal  = payload.gender      || stu.gender      || "";
  const dobVal     = payload.dateOfBirth || stu.dateOfBirth || null;
  // ISO (YYYY-MM-DD) — unambiguous on a printable document, regardless of locale.
  const dobDisplay = dobVal
    ? (typeof dobVal === "string" && /^\d{4}-\d{2}-\d{2}/.test(dobVal)
        ? dobVal.slice(0, 10)
        : new Date(dobVal).toISOString().slice(0, 10))
    : "—";

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>${t.title} — ${esc(payload.studentName || "")}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12px;
           color: #111827; padding: 24px; max-width: 800px; margin: 0 auto; }
    /* ── The official header ───────────────────────────────────────────
       Ministry and delegations in English down the left, the school in the
       middle, the same in French down the right. Both languages on every
       card: that is the Cameroonian format, not a translation setting. */
    .report-header { border-bottom: 1px solid #e5e5e5; padding-bottom: 14px;
                     margin-bottom: 16px; font-family: "Times New Roman", Times, serif; }
    .report-header-top { display: grid; grid-template-columns: 1fr 1.2fr 1fr;
                         align-items: start; gap: 16px; }
    .ministry-column { text-align: center; color: #2e3440; font-size: 10px;
                       line-height: 1.35; }
    .ministry-column p { margin: 0 0 3px; }
    .ministry-column .country { font-weight: bold; text-transform: uppercase;
                                text-decoration: underline; }
    .ministry-column .peace { font-style: italic; font-weight: bold; }
    .ministry-column .ministry { margin-top: 8px; text-transform: uppercase;
                                 text-decoration: underline; }
    .ministry-column .delegation,
    .ministry-column .sub-delegation { margin-top: 8px; font-weight: bold;
                                       text-transform: uppercase;
                                       text-decoration: underline; }
    .ministry-column .school-type { margin-top: 6px; font-weight: bold;
                                    text-transform: uppercase; }
    /* French does not underline its own column on a real card. */
    .ministry-column.french .country,
    .ministry-column.french .ministry,
    .ministry-column.french .delegation,
    .ministry-column.french .sub-delegation { text-decoration: none; }
    .school-head { text-align: center; padding: 0 8px; }
    .school-head img { max-height: 78px; max-width: 78px; object-fit: contain;
                       margin: 0 auto 6px; display: block; }
    .school-logo-placeholder { width: 78px; height: 78px; margin: 0 auto 6px;
                               display: flex; align-items: center;
                               justify-content: center; border: 1px solid #d5d5d5;
                               border-radius: 50%; color: #9ca3af;
                               font-family: Arial, sans-serif; font-size: 9px; }
    h1 { font-size: 17px; color: #1f2933; text-align: center;
         font-family: Arial, Helvetica, sans-serif; text-transform: uppercase;
         line-height: 1.25; }
    .motto { text-align: center; font-style: italic; color: #555;
             font-size: 11px; margin-top: 4px;
             font-family: Arial, Helvetica, sans-serif; }
    .report-title { margin-top: 16px; padding-top: 12px;
                    border-top: 1px solid #eeeeee; text-align: center;
                    color: #30343b; font-family: Arial, Helvetica, sans-serif;
                    font-size: 14px; font-weight: bold; text-transform: uppercase;
                    letter-spacing: .3px; }
    .subtitle { text-align: center; color: #6b7280; margin-bottom: 18px;
                font-size: 11px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px 20px;
                 background: #f0f4ff; padding: 12px; border-radius: 8px; margin-bottom: 14px; }
    .lbl { font-weight: bold; font-size: 10px; color: #374151; text-transform: uppercase; }
    .val { font-size: 13px; font-weight: bold; color: #111827; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; }
    thead th { background: #2563eb; color: #fff; font-size: 11px; }
    tr:nth-child(even) td { background: #f9fafb; }
    .teacher { font-size: 10px; color: #9ca3af; }
    /* The outcome card: figures left, verdict right, one panel. */
    .outcome { display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
               background: #f0f4ff; border: 1px solid #e0e6f8;
               border-radius: 8px; padding: 10px; margin-bottom: 12px; }
    .outcome-verdict { display: flex; align-items: center; gap: 10px;
                       flex: 1 1 230px; padding-left: 14px;
                       border-left: 1px solid #d7ddf0; }
    .boxes { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;
             flex: 1 1 320px; }
    .box { flex: 1; min-width: 110px; max-width: 170px; text-align: center;
           border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 4px; }
    .box-val { font-size: 18px; font-weight: 800; color: #111827; }
    .box-lbl { font-size: 10px; color: #6b7280; margin-top: 2px; }
    .banner { text-align: center; padding: 10px; border-radius: 8px;
              font-weight: bold; font-size: 15px; margin-bottom: 12px; }
    .pass-banner { background: #d1fae5; color: #059669; }
    .fail-banner { background: #fee2e2; color: #dc2626; }

    /* The verdict and the remark share one row.
       They were two full-width blocks stacked, each with its own margin — a
       one-word verdict taking a whole band across the page and the remark
       taking another. Together with the boxes above them that was enough
       vertical space to push the verification block, and the code a registrar
       types to check the document, off the foot of the page. */
    .verdict { display: flex; align-items: center; gap: 10px;
               margin-bottom: 12px; flex-wrap: wrap; }
    .verdict-pill { flex: none; padding: 6px 12px; border-radius: 999px;
                    font-weight: bold; font-size: 12px; white-space: nowrap; }
    .verdict-remark { flex: 1; min-width: 220px; font-style: italic;
                      font-size: 11px; color: #4b5563; line-height: 1.5; }
    /* Kept for a school template that still says {{remark}} on its own. */
    .remark { font-style: italic; color: #4b5563; line-height: 1.6;
              margin-bottom: 12px; }
    .verify { display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
              border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 10px;
              background: #f9fafb; page-break-inside: avoid; }
    .verify-qr { width: 64px; height: 64px; flex: none; }
    .verify-qr svg { width: 100%; height: 100%; display: block; }
    .verify-title { font-size: 10px; font-weight: bold; text-transform: uppercase;
                    letter-spacing: .06em; color: #374151; }
    .verify-text { font-size: 10px; color: #6b7280; margin-top: 2px; }
    .verify-code { font-family: Consolas, Menlo, monospace; font-weight: bold;
                   color: #111827; letter-spacing: .04em; }
    .footer { text-align: center; font-size: 10px; color: #9ca3af;
              border-top: 1px solid #e5e7eb; padding-top: 10px; }

    /* ── Fitting one A4 sheet ──────────────────────────────────────────
       The card is a one-page document and it ran onto two — not from
       carrying too much, but from a screen-comfortable gap under every one
       of a dozen blocks. Nothing is dropped; every gap and step of type
       comes down a notch for paper.

       The break rules are the other half: a block split down the fold is
       how a signature ends up alone at the top of a second sheet. */
    @page { size: A4; margin: 9mm; }

    @media print {
      body { padding: 0; font-size: 10.5px; max-width: none; }

      .report-header     { margin-bottom: 8px; padding-bottom: 6px; }
      .report-header-top { gap: 10px; }
      .ministry-column   { font-size: 8px; line-height: 1.25; }
      .ministry-column p { margin: 0 0 1px; }
      h1                 { font-size: 14px; }
      .motto             { font-size: 9px; }
      .report-title      { font-size: 12px; margin-top: 8px; padding-top: 6px; }
      .subtitle          { margin-bottom: 8px; font-size: 9.5px; }

      .info-grid         { padding: 7px; margin-bottom: 8px; gap: 2px 12px; }
      .lbl               { font-size: 8px; }
      .val               { font-size: 10px; }

      table              { margin-bottom: 8px; }
      th, td             { padding: 3px 6px; }
      thead th           { font-size: 9.5px; }

      .outcome           { padding: 6px; margin-bottom: 8px; gap: 10px; }
      .outcome-verdict   { padding-left: 10px; gap: 8px; }
      .boxes             { gap: 6px; }
      .box               { padding: 5px 3px; }
      .box-val           { font-size: 14px; }
      .box-lbl           { font-size: 8px; }

      .banner            { padding: 6px; font-size: 12px; margin-bottom: 8px; }
      .verdict           { margin-bottom: 8px; gap: 8px; }
      .verdict-pill      { padding: 3px 9px; font-size: 10px; }
      .verdict-remark    { font-size: 9.5px; min-width: 160px; }

      .verify            { margin-bottom: 8px; padding: 6px 8px; gap: 7px; }
      .verify-qr         { width: 52px; height: 52px; }
      .verify-title,
      .verify-text       { font-size: 8px; }
      .footer            { padding-top: 7px; font-size: 8.5px; }

      .report-header,
      .info-grid,
      .outcome,
      .boxes,
      .verdict,
      .banner,
      .verify,
      .footer            { break-inside: avoid; page-break-inside: avoid; }
      thead              { display: table-header-group; }
      tr                 { break-inside: avoid; page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <header class="report-header">
    <div class="report-header-top">
      ${ministryColumn("en")}

      <div class="school-head">
        ${schoolLogo
          ? `<img src="${esc(schoolLogo)}" alt="">`
          : `<div class="school-logo-placeholder">${t.noLogo}</div>`}
        <h1>${esc(schoolName)}</h1>
        ${schoolMotto ? `<div class="motto">${esc(schoolMotto)}</div>` : ""}
      </div>

      ${ministryColumn("fr")}
    </div>

    <div class="report-title">${esc(reportTitleText)}</div>
  </header>

  <p class="subtitle">
    ${payload.examName ? esc(payload.examName) : ""}
    ${payload.academicYear
      ? `${payload.examName ? " · " : ""}${esc(payload.academicYear)}`
      : ""}
  </p>

  <div class="info-grid">
    <div><div class="lbl">${t.studentName}</div><div class="val">${esc(payload.studentName || "—")}</div></div>
    <div><div class="lbl">${t.admissionNo}</div><div class="val">${payload.admissionNo ? "#" + esc(payload.admissionNo) : "—"}</div></div>
    <div><div class="lbl">${t.gender}</div><div class="val">${genderVal ? esc(genderVal) : "—"}</div></div>
    <div><div class="lbl">${t.dob}</div><div class="val">${dobDisplay}</div></div>
    <div><div class="lbl">${t.classLabel}</div><div class="val">${esc(payload.className || "—")}</div></div>
    <div><div class="lbl">${t.academicYear}</div><div class="val">${esc(payload.academicYear || "—")}</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>${t.subject}</th>
        <th style="text-align:center">${t.score}</th>
        <th style="text-align:center">${t.outOf20}</th>
        <th style="text-align:center">${t.coeff}</th>
        ${showGrades ? `<th style="text-align:center">${t.grade}</th>` : ""}
        <th style="text-align:center">${t.remarkCol}</th>
        <th style="text-align:center">${t.positionCol}</th>
        <th style="text-align:center">${t.result}</th>
      </tr>
    </thead>
    <tbody>${rows ||
      `<tr><td colspan="${showGrades ? 8 : 7}" style="text-align:center;color:#9ca3af;padding:16px">${t.noScores}</td></tr>`}</tbody>
  </table>

  ${(avg20 != null || pct != null || summary?.overallGrade || summary?.classPosition != null)
    || isPassing != null || overallRemarkText
    /*
     * One card for the outcome.
     *
     * Average, position, grade, class size and the verdict all answer the same
     * question — how did this pupil do — and they sat in two blocks with a gap
     * between them, reading as two unrelated things and costing a band of the
     * page. The verdict is now to the right of the figures it summarises,
     * separated by a rule rather than by whitespace.
     */
    ? `<div class="outcome">
         ${boxes.length ? `<div class="boxes">${boxes.join("")}</div>` : ""}
         ${(isPassing != null || overallRemarkText)
           ? `<div class="outcome-verdict">
                ${isPassing != null
                  ? `<div class="verdict-pill ${isPassing ? "pass-banner" : "fail-banner"}">
                       ${isPassing ? `✔ ${t.passed}` : `✘ ${t.failed}`}
                     </div>`
                  : ""}
                ${overallRemarkText
                  ? `<div class="verdict-remark">
                       <strong>${t.remark}:</strong> ${esc(overallRemarkText)}
                     </div>`
                  : ""}
              </div>`
           : ""}
       </div>`
    : ""}

  ${
    // §8: the promotion decision is rendered ONLY here, and only when the
    // controller has marked this as the final annual report.
    promoStatus
      ? `<div class="banner ${summary.isPassing === false ? "fail-banner" : "pass-banner"}">
           ${esc(promoStatus)}
         </div>`
      : ""
  }

  ${opts.verify
    ? `<div class="verify">
         <div class="verify-qr">${opts.verify.qrSvg ?? ""}</div>
         <div>
           <div class="verify-title">${t.verifyTitle}</div>
           <div class="verify-text">
             ${t.verifyHint}
             <span class="verify-code">${esc(opts.verify.code)}</span>
             — ${esc(opts.verify.url)}
           </div>
         </div>
       </div>`
    : ""}

  <div class="footer">
    ${t.generatedOn}
    ${new Date().toLocaleDateString(t.locale, { day: "numeric", month: "long", year: "numeric" })}
    &nbsp;·&nbsp; ${esc(schoolName)} — ${t.official}
  </div>
</body>
</html>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// PER-SCHOOL TEMPLATE PATH
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Adapt the flat report card payload into the NESTED shape the placeholder
 * engine expects (data.student.fullName, data.school.name, …).
 *
 * The two shapes exist because the engine was written against a nested
 * document while the result pipeline produces a flat one; this is the single
 * seam between them, so a template author sees one documented contract.
 *
 * @param {object} payload  Report card payload from buildStudentReportCardData
 * @param {object} [opts]   Same opts as renderReportCard
 */
function toTemplateData(payload, opts = {}) {
  const summary  = payload.summary  || null;
  const computed = payload.computed || {};
  const school   = opts.school      || {};
  const student  = opts.student     || {};
  // Present on a term or annual card, absent on a sequence one. Deliberately
  // NOT payload.term — that is the term's name, printed in the subtitle, and
  // one key meaning two things is how a subtitle ends up reading "[object
  // Object]".
  const term   = payload.termResult   || null;
  const annual = payload.annualResult || null;

  // A school's own template renders in the reader's language too, so the remark
  // it substitutes has to be picked the same way the built-in layout picks it.
  const lang     = opts.lang === "fr" ? "fr" : "en";
  const remarkOf = (row) =>
    (lang === "fr" ? (row?.remarkFr || row?.remark) : row?.remark) || "";

  const avg20 = resolveAverage20(payload);

  return {
    reportId: `${payload.studentId || ""}_${payload.examId || ""}`,

    // Which of the three cards this is. The engine turns it into the
    // {{if is_annual}} / {{if is_term}} / {{if is_sequence}} flags a school's
    // template gates on — without it the seeded layout had nothing to ask
    // about but isPassing, and printed a promotion on every passing pupil's
    // card whatever kind of card it was.
    reportType: payload.reportType || "term",

    // The official header, resolved the same way the built-in layout resolves
    // it, so a school's own template cannot end up with a different ministry
    // in its French column than in its English one. Both languages, always.
    header: officialHeader(school),

    // "First Sequence Progress Record", in the reader's language.
    reportTitle: reportTitle(
      periodName({ ...(payload.period || {}), reportType: payload.reportType }, lang)
        || payload.term
        || null,
      lang
    ),

    student: {
      fullName:        payload.studentName || "",
      studentId:       payload.studentId   || "",
      admissionNumber: payload.admissionNo || "",
      // The PAYLOAD first, then opts.student. The controller enriches the
      // payload with gender and date of birth from the Student document; this
      // read only opts.student, which the routes do not pass — so both fields
      // came out blank on every school template, while the built-in layout
      // (which does check the payload) showed them. Same order as there.
      gender:          payload.gender      || student.gender      || "",
      dateOfBirth:     payload.dateOfBirth || student.dateOfBirth || null,
      photoBase64:     student.photoBase64 || null,
      // The payload first, then opts.student — the same order gender and date
      // of birth needed, and for the same reason: the routes populate the
      // payload and pass no `student`. {{student_photo}} read only the base64
      // field, which nothing writes, so every card printed "No Photo".
      photoUrl:        payload.photoUrl || student.photoUrl || null,
    },

    school: {
      name:          opts.schoolName      || school.name || "",
      motto:         school.motto         || "",
      address:       school.address       || "",
      phone:         school.phone         || "",
      principalName: school.principalName || "",
      // Two keys, because they mean different things and the engine now tells
      // them apart. `logo` is a URL or a served path and goes straight into the
      // src; logoBase64 is a raw payload the engine has to wrap. Putting a path
      // in logoBase64 — which this did — produced
      // "data:image/png;base64,/uploads/logos/x.jpg".
      logoUrl:       school.logo          || null,
      logoBase64:    school.logoBase64    || null,
    },

    className:    payload.className    || "",
    stream:       opts.stream          || "",
    examName:     payload.examName     || "",
    term:         payload.term         || "",
    academicYear: payload.academicYear || "",

    // Attendance is not part of the result payload; a caller that has it can
    // pass it in, otherwise the tokens render as zeros rather than breaking.
    attendance: opts.attendance || { daysPresent: 0, daysAbsent: 0, daysOpen: 0 },

    performance: {
      // Engine tokens {{average}} / {{weighted_average}} and its {{if
      // isPassing}} test both read this, and it must be /20.
      average:           avg20 ?? 0,
      percentage:        summary?.percentage      ?? null,
      totalScore:        summary?.totalScore      ?? null,
      position:          summary?.classPosition   ?? null,
      totalStudents:     summary?.totalInClass    ?? null,
      grade:             summary?.overallGrade    || "",
      remark:            remarkOf({
        remark:   summary?.overallRemark,
        remarkFr: summary?.overallRemarkFr,
      }),
      // §8: promotion only exists on the final annual report — never leaked
      // onto sequence or term templates regardless of what the payload holds.
      promotionStatus:   payload.reportType === "annual"
        ? (summary?.promotionStatus || "")
        : "",
      subjectsPassed:    summary?.subjectsPassed  ?? 0,
      subjectsFailed:    summary?.subjectsFailed  ?? 0,
      totalCoefficients: computed.totalCoefficients ?? null,

      // ── Term, sequence and annual figures ────────────────────────────────
      //
      // The engine has always mapped {{term_average}}, {{annual_class_position}},
      // {{sequence_3_average}} and the rest off this object, and shared/
      // reportTokens.js offers every one of them in the template builder's
      // variable picker — but nothing populated them, so a school that put
      // {{annual_average}} on its layout got a silent blank. They are filled
      // from the term and annual cards; a sequence card leaves them null and
      // the engine renders "".
      termAverage:         term?.average        ?? null,
      termGrade:           term?.grade          ?? null,
      termRemark:          remarkOf(term)        || null,
      termClassPosition:   term?.classPosition  ?? null,
      termTotalInClass:    term?.totalInClass   ?? null,

      // sequence1Average … sequence6Average, from the term card's per-sequence
      // breakdown. Spread rather than written out six times so a school running
      // four sequences leaves the other two empty rather than at zero.
      ...Object.fromEntries(
        (payload.sequenceAverages || []).flatMap((s) =>
          s && s.sequence >= 1 && s.sequence <= 6
            ? [[`sequence${s.sequence}Average`, s.average ?? null]]
            : []
        )
      ),

      annualAverage:       annual?.average       ?? null,
      annualGrade:         annual?.grade         ?? null,
      annualRemark:        remarkOf(annual)      || null,
      annualClassPosition: annual?.classPosition ?? null,
      annualTotalInClass:  annual?.totalInClass  ?? null,

      // term1Average … term3Average, from the annual card's per-term breakdown.
      ...Object.fromEntries(
        (payload.termAverages || []).flatMap((tm) =>
          tm && tm.term >= 1 && tm.term <= 3
            ? [[`term${tm.term}Average`, tm.average ?? null]]
            : []
        )
      ),
    },

    // Field names here are the engine's, not the pipeline's: {{subjects_table}}
    // and {{each subjects}} read subjectName / total / coefficient.
    subjects: (payload.subjects || []).map((r) => ({
      subjectName:    r.subjectName || "",
      teacherName:    r.teacherName || null,
      caScore:        null,
      examScore:      r.score          ?? null,
      total:          r.score          ?? null,
      maxScore:       r.maxScore       ?? 100,
      normalizedMark: r.normalizedMark ?? null,
      weightedScore:  r.weightedScore  ?? null,
      coefficient:    r.coefficient    ?? 1,
      grade:          r.grade          || "",
      // The controller now emits the remark at `remark` (school-configured
      // remark system); teacherRemark remains the legacy fallback.
      remark:         remarkOf(r) || r.teacherRemark || "",
      // Per-subject rank over students who actually sat the subject
      // (§5). `position` keeps the legacy token name working.
      position:       r.subjectPosition ?? r.position ?? null,
      subjectTotal:   r.subjectTotal   ?? null,
      isPassing:      r.isPassing      ?? false,
      isAbsent:       r.isAbsent       ?? false,
      isExempt:       r.isExempt       ?? false,
    })),

    // The payload first, then opts — the same order the gender, the photo and
    // the delegations all needed, and for the same reason: the routes fill the
    // payload and pass no opts for these. Both of these tokens have existed
    // since the engine did, and neither had a source, so every card printed an
    // empty signature box and "To be announced".
    classTeacher:     payload.classTeacher   || opts.classTeacher || "",
    teacherComment:   opts.teacherComment   || summary?.overallRemark || "",
    principalComment: opts.principalComment || "",
    nextTermDate:     payload.nextTermDate  || school.nextTermResumption ||
                      opts.nextTermDate     || null,

    // Lets {{qr_code}} emit the real verification QR instead of a placeholder.
    verify: opts.verify || null,
  };
}

/**
 * Wrap a rendered template fragment into a standalone printable document.
 * The template's own CSS goes last so it can override these defaults.
 */
function wrapTemplateHtml(body, css, { lang, title }) {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>${esc(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12px;
           color: #111827; padding: 24px; max-width: 800px; margin: 0 auto; }
    .subjects-table { width: 100%; border-collapse: collapse; margin: 10px 0; }
    .subjects-table th, .subjects-table td { border: 1px solid #333; padding: 6px 8px; }
    .subjects-table th { background: #f0f0f0; font-weight: bold; }
    .student-photo { width: 80px; height: 100px; object-fit: cover; }
    .school-logo { max-height: 80px; max-width: 200px; }

    /* A4 and a tight margin for a school template too. This is a default:
       the template's own CSS goes in below, and one that carries its own
       @page rule — the seeded template now does — overrides it. A
       template that predates it still gets a sheet-sized page rather than
       the browser default with 12mm of padding inside it. */
    @page { size: A4; margin: 9mm; }
    @media print {
      body { padding: 0; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; page-break-inside: avoid; }
    }
    ${css || ""}
  </style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * Render a report card, preferring the school's own template.
 *
 * When opts.template carries html, that template drives the layout and the
 * placeholder engine fills it. Otherwise — and if the template throws — the
 * built-in layout is used, so a school with no template, or a broken one,
 * still gets a printable report card instead of an error page.
 *
 * @param {object} payload
 * @param {object} [opts]
 * @param {string} [opts.lang]                "en" | "fr"
 * @param {string} [opts.schoolName]
 * @param {{html:string, css?:string, name?:string}} [opts.template]
 * @returns {{ html: string, source: "template"|"builtin", error?: string }}
 */
function renderReportCard(payload, opts = {}) {
  const lang = opts.lang === "fr" ? "fr" : "en";
  const tpl  = opts.template;

  if (tpl?.html) {
    try {
      // Required lazily: the engine lives outside src/, and the built-in path
      // must keep working even if that file is missing.
      const { resolvePlaceholders } = require("../../engine/placeholder.engine");
      const data = toTemplateData(payload, opts);
      const body = resolvePlaceholders(tpl.html, data);

      // The engine swallows its own syntax errors and hands back the RAW
      // template with this marker prepended, so a malformed template would
      // otherwise print a page of literal {{tokens}} to a parent. Treat that
      // as a failure and use the built-in layout instead.
      const marker = body.indexOf(ENGINE_ERROR_MARKER);
      if (marker !== -1) {
        const detail = body
          .slice(marker + ENGINE_ERROR_MARKER.length)
          .split("-->")[0]
          .trim();
        throw new Error(detail || "template failed to parse");
      }

      const html = wrapTemplateHtml(body, tpl.css, {
        lang,
        title: `${LABELS[lang].title} — ${payload.studentName || ""}`,
      });

      // Tokens the engine did not recognise survive as literal text. The
      // template still renders — one typo should not cost the school its
      // layout — but the caller is told so it can warn the admin.
      const unknown = [...new Set(html.match(/\{\{[^{}]+\}\}/g) || [])];

      return {
        html,
        source: "template",
        ...(unknown.length ? { unknownTokens: unknown } : {}),
      };
    } catch (err) {
      // A school's template must never be able to deny them a report card.
      console.error(
        `[reportHtml] template "${tpl.name || tpl.id || "?"}" failed to render, ` +
        `falling back to the built-in layout: ${err.message}`
      );
      return {
        html:   renderReportCardHtml(payload, opts),
        source: "builtin",
        error:  err.message,
      };
    }
  }

  return { html: renderReportCardHtml(payload, opts), source: "builtin" };
}

module.exports = { renderReportCardHtml, renderReportCard, toTemplateData };
