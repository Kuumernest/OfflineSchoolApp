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

const LABELS = {
  en: {
    title:        "ACADEMIC REPORT CARD",
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

function resolveAverage20(payload) {
  const computed = payload.computed || {};
  const summary  = payload.summary  || null;
  if (computed.weightedAverage != null) return Number(computed.weightedAverage);
  if (summary?.average != null) {
    return Math.round(Number(summary.average) * 5 * 100) / 100;
  }
  return null;
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
    .school-head { display: flex; align-items: center; gap: 14px;
                   justify-content: center; margin-bottom: 4px; }
    .school-head img { max-height: 70px; max-width: 70px; object-fit: contain; }
    .school-head-text { text-align: center; }
    h1 { font-size: 20px; color: #1e40af; text-align: center; }
    .motto { text-align: center; font-style: italic; color: #6b7280;
             font-size: 11px; }
    .subtitle { text-align: center; color: #6b7280; margin-bottom: 18px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px 20px;
                 background: #f0f4ff; padding: 12px; border-radius: 8px; margin-bottom: 14px; }
    .lbl { font-weight: bold; font-size: 10px; color: #374151; text-transform: uppercase; }
    .val { font-size: 13px; font-weight: bold; color: #111827; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; }
    thead th { background: #2563eb; color: #fff; font-size: 11px; }
    tr:nth-child(even) td { background: #f9fafb; }
    .teacher { font-size: 10px; color: #9ca3af; }
    .boxes { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-bottom: 14px; }
    .box { flex: 1; min-width: 110px; max-width: 170px; text-align: center;
           border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 4px; }
    .box-val { font-size: 18px; font-weight: 800; color: #111827; }
    .box-lbl { font-size: 10px; color: #6b7280; margin-top: 2px; }
    .banner { text-align: center; padding: 12px; border-radius: 8px;
              font-weight: bold; font-size: 16px; margin-bottom: 14px; }
    .pass-banner { background: #d1fae5; color: #059669; }
    .fail-banner { background: #fee2e2; color: #dc2626; }
    .remark { font-style: italic; color: #4b5563; line-height: 1.6;
              margin-bottom: 14px; }
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
    @media print { body { padding: 12px; } }
  </style>
</head>
<body>
  <div class="school-head">
    ${schoolLogo ? `<img src="${esc(schoolLogo)}" alt="">` : ""}
    <div class="school-head-text">
      <h1>${esc(schoolName)}</h1>
      ${schoolMotto ? `<div class="motto">${esc(schoolMotto)}</div>` : ""}
    </div>
  </div>
  <p class="subtitle">
    ${t.title}${payload.examName ? ` · ${esc(payload.examName)}` : ""}
    ${payload.term || payload.academicYear
      ? ` · ${esc(payload.term || "")} ${esc(payload.academicYear || "")}`
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
    ? `<div class="boxes">${boxes.join("")}</div>` : ""}

  ${
    isPassing != null
      ? `<div class="banner ${isPassing ? "pass-banner" : "fail-banner"}">
           ${isPassing ? `✔ ${t.passed}` : `✘ ${t.failed}`}
           ${summary?.overallGrade ? ` · ${t.overallGrade}: ${esc(summary.overallGrade)}` : ""}
         </div>`
      : ""
  }

  ${
    // §8: the promotion decision is rendered ONLY here, and only when the
    // controller has marked this as the final annual report.
    promoStatus
      ? `<div class="banner ${summary.isPassing === false ? "fail-banner" : "pass-banner"}">
           ${esc(promoStatus)}
         </div>`
      : ""
  }

  ${overallRemarkText
    ? `<div class="remark"><strong>${t.remark}:</strong> ${esc(overallRemarkText)}</div>`
    : ""}

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

    classTeacher:     opts.classTeacher     || "",
    teacherComment:   opts.teacherComment   || summary?.overallRemark || "",
    principalComment: opts.principalComment || "",
    nextTermDate:     opts.nextTermDate     || null,

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
    @media print { body { padding: 12px; } }
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
