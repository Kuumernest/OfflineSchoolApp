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
    admissionNo:  "Admission No",
    classLabel:   "Class",
    average:      "Average",
    percentage:   "Percentage",
    overallGrade: "Overall Grade",
    classPos:     "Class Position",
    passed:       "PASSED",
    failed:       "FAILED",
    remark:       "Teacher's Remark",
    generatedOn:  "Generated on",
    official:     "Official Academic Report",
    noScores:     "No scores recorded for this student.",
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
    average:      "Moyenne",
    percentage:   "Pourcentage",
    overallGrade: "Mention générale",
    classPos:     "Rang",
    passed:       "ADMIS(E)",
    failed:       "AJOURNÉ(E)",
    remark:       "Observation du professeur",
    generatedOn:  "Généré le",
    official:     "Bulletin officiel",
    noScores:     "Aucune note enregistrée pour cet élève.",
    locale:       "fr-FR",
  },
};

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
  const schoolName = opts.schoolName || "School";

  const subjects = Array.isArray(payload.subjects) ? payload.subjects : [];
  const summary  = payload.summary || null;
  const computed = payload.computed || {};

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

    return `
      <tr>
        <td>${esc(s.subjectName || "—")}
          ${s.teacherName ? `<div class="teacher">${esc(s.teacherName)}</div>` : ""}
        </td>
        <td style="text-align:center;color:${color}">${esc(scoreCell)}</td>
        <td style="text-align:center;color:${color}">${norm}</td>
        <td style="text-align:center">${s.coefficient ?? 1}</td>
        <td style="text-align:center;font-weight:bold;color:${color}">
          ${absent ? flag : esc(s.grade || "—")}
        </td>
        <td style="text-align:center;color:${color}">
          ${absent ? "—" : s.isPassing ? t.pass : t.fail}
        </td>
      </tr>`;
  }).join("");

  // ── Averages ──────────────────────────────────────────────────────────────
  // computed.weightedAverage is already on the /20 scale. summary.average is
  // the GPA-points mean (0–4); ×5 converts it back to /20.
  const avg20 = computed.weightedAverage != null
    ? Number(computed.weightedAverage)
    : summary?.average != null
      ? Math.round(Number(summary.average) * 5 * 100) / 100
      : null;
  const pct = summary?.percentage;

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

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>${t.title} — ${esc(payload.studentName || "")}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12px;
           color: #111827; padding: 24px; max-width: 800px; margin: 0 auto; }
    h1 { font-size: 20px; color: #1e40af; text-align: center; }
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
    .footer { text-align: center; font-size: 10px; color: #9ca3af;
              border-top: 1px solid #e5e7eb; padding-top: 10px; }
    @media print { body { padding: 12px; } }
  </style>
</head>
<body>
  <h1>${esc(schoolName)}</h1>
  <p class="subtitle">
    ${t.title}${payload.examName ? ` · ${esc(payload.examName)}` : ""}
    ${payload.term || payload.academicYear
      ? ` · ${esc(payload.term || "")} ${esc(payload.academicYear || "")}`
      : ""}
  </p>

  <div class="info-grid">
    <div><div class="lbl">${t.studentName}</div><div class="val">${esc(payload.studentName || "—")}</div></div>
    <div><div class="lbl">${t.admissionNo}</div><div class="val">${payload.admissionNo ? "#" + esc(payload.admissionNo) : "—"}</div></div>
    <div><div class="lbl">${t.classLabel}</div><div class="val">${esc(payload.className || "—")}</div></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>${t.subject}</th>
        <th style="text-align:center">${t.score}</th>
        <th style="text-align:center">${t.outOf20}</th>
        <th style="text-align:center">${t.coeff}</th>
        <th style="text-align:center">${t.grade}</th>
        <th style="text-align:center">${t.result}</th>
      </tr>
    </thead>
    <tbody>${rows ||
      `<tr><td colspan="6" style="text-align:center;color:#9ca3af;padding:16px">${t.noScores}</td></tr>`}</tbody>
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

  ${summary?.overallRemark
    ? `<div class="remark"><strong>${t.remark}:</strong> ${esc(summary.overallRemark)}</div>`
    : ""}

  <div class="footer">
    ${t.generatedOn}
    ${new Date().toLocaleDateString(t.locale, { day: "numeric", month: "long", year: "numeric" })}
    &nbsp;·&nbsp; ${esc(schoolName)} — ${t.official}
  </div>
</body>
</html>`;
}

module.exports = { renderReportCardHtml };
