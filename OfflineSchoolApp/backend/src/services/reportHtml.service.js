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
const { periodName, averageOutOf20 }  = require("../../../shared/reportCard");

const LABELS = {
  en: {
    title:        "ACADEMIC REPORT CARD",
    noLogo:       "NO LOGO",
    subject:      "Subject",
    score:        "Score",
    // Continuous assessment and the sequence paper, the two halves a sequence
    // is marked in. Short in the header because they are two extra columns on
    // a page that is already full; the long form is on the note beneath.
    caCol:        "CA",
    testCol:      "Test",
    caFull:       "Continuous Assessment",
    caNote:       "Sequence mark = CA x {ca}% + Test x {test}%",
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
    // ── The information panel under the marks ────────────────────────────
    // The sections of the printed form this card follows: what the pupil
    // did, what the class did, how much school they missed, and the conduct
    // the class teacher fills in by hand.
    teacherCol:   "Teacher",
    sequenceResult: "Sequence Result",
    termResult:   "Term Result",
    annualResult: "Annual Result",
    totalRow:     "TOTAL",
    totalMarks:   "Total Marks",
    status:       "Status",
    principalRemark: "Principal's Remark",
    perfPanel:    "Student Performance",
    classPanel:   "Class Profile",
    attendPanel:  "Attendance",
    conductPanel: "Conduct",
    rank:         "Rank",
    termAverage:  "Term Average",
    annualAverage: "Annual Average",
    classAverage: "Class Average",
    best:         "Best",
    lowest:       "Lowest",
    absences:     "Absences",
    excused:      "Excused",
    unexcused:    "Unexcused",
    lateComing:   "Late Coming",
    work:         "Work",
    behaviour:    "Behaviour",
    observation:  "Observation",
    fillByHand:   "To be completed by the classmaster",
    notRecorded:  "—",
    verifyTitle:  "Verify this document",
    verifyHint:   "Scan the code, or enter",
    locale:       "en-GB",
  },
  fr: {
    title:        "BULLETIN DE NOTES",
    noLogo:       "SANS LOGO",
    subject:      "Matière",
    score:        "Note",
    caCol:        "CC",
    testCol:      "Épreuve",
    caFull:       "Contrôle Continu",
    caNote:       "Note de séquence = CC x {ca}% + Épreuve x {test}%",
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
    // ── Le tableau sous les notes ────────────────────────────────────────
    teacherCol:   "Enseignant",
    sequenceResult: "Résultat de la séquence",
    termResult:   "Résultat du trimestre",
    annualResult: "Résultat annuel",
    totalRow:     "TOTAL",
    totalMarks:   "Total des points",
    status:       "Décision",
    principalRemark: "Observation du chef d'établissement",
    perfPanel:    "Performance de l'élève",
    classPanel:   "Profil de la classe",
    attendPanel:  "Assiduité",
    conductPanel: "Conduite",
    rank:         "Rang",
    termAverage:  "Moyenne du trimestre",
    annualAverage: "Moyenne annuelle",
    classAverage: "Moyenne de la classe",
    best:         "Plus forte moyenne",
    lowest:       "Plus faible moyenne",
    absences:     "Absences",
    excused:      "Excusées",
    unexcused:    "Non excusées",
    lateComing:   "Retards",
    work:         "Travail",
    behaviour:    "Comportement",
    observation:  "Observation",
    fillByHand:   "À remplir par le professeur principal",
    notRecorded:  "—",
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

  // The one rule, in shared/reportCard.js: a sequence average is GPA points
  // and a term or annual average is already out of twenty.
  return averageOutOf20(summary.average, payload.reportType);
}

const esc = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The school's logo, faint and centred, behind everything on the page.
 *
 * ── What it is ─────────────────────────────────────────────────────────────
 *
 * A report card is a document a family keeps and a school is asked to vouch
 * for years later. Its crest behind the marks is the same thing a letterhead
 * does: it says whose paper this is at a glance, and it makes a card that was
 * simply photocopied off another look like what it is. The header already
 * carries the logo at full strength; this is the second, quiet impression of
 * the same image, and nothing else — no second field, no second upload. It
 * reads the logo the header reads.
 *
 * ── Why it is drawn this way ───────────────────────────────────────────────
 *
 *   An <img>, not a CSS background. Browsers drop background images when
 *   they print unless the reader finds the "background graphics" checkbox,
 *   and the card is printed far more often than it is looked at on a screen.
 *   An image element prints.
 *
 *   position: fixed, so it sits in the middle of the sheet — and of every
 *   sheet, should a card ever run to two — rather than in the middle of a
 *   scrolling document. z-index: -1 puts it under the flow of the page; the
 *   canvas is white beneath it, so it shows through the paper and not through
 *   the marks. pointer-events: none so a reader's cursor never lands on it.
 *
 *   object-fit: contain inside a box that is a fraction of the page: a
 *   square crest and a wide banner both scale to fit without either being
 *   stretched. The opacity is low enough that a figure printed over it is as
 *   legible as one printed over blank paper.
 *
 * A school with no logo gets an empty string, not a placeholder: the header
 * already says NO LOGO once, and a broken image behind the marks would say it
 * a second time, worse.
 *
 * The same rules serve the built-in layout and a school's own template. The
 * template's CSS is appended after these, so a school that wants its mark
 * larger, fainter or gone can say so in its own stylesheet.
 *
 * @param {object} school  The school as loadSchoolForCard shapes it: `logo` is
 *                         an absolute URL or a data URI; `logoBase64` a bare
 *                         payload, which the template preview path may send.
 * @returns {{ css: string, html: string }}
 */
function schoolWatermark(school) {
  const raw = school?.logo || school?.logoBase64 || null;
  const src = !raw ? null
    : /^(https?:|data:|\/)/i.test(String(raw))
      ? String(raw)
      : `data:image/png;base64,${raw}`;

  const css = `
    /* ── The school's mark behind the page ─────────────────────────────
       An image element, not a background, because backgrounds do not
       print by default and this card is printed. Fixed and centred so
       it is in the middle of the sheet; z-index -1 so it is under the
       marks; object-fit so a crest of any shape keeps its shape. */
    .school-watermark { position: fixed; inset: 0; z-index: -1;
                        display: flex; align-items: center;
                        justify-content: center; overflow: hidden;
                        pointer-events: none; }
    .school-watermark img { width: 60%; max-width: 420px; max-height: 60%;
                            height: auto; object-fit: contain;
                            opacity: 0.07; display: block; }
    @media print {
      .school-watermark { position: fixed; }
    }`;

  const html = src
    ? `<div class="school-watermark" aria-hidden="true"><img src="${esc(src)}" alt=""></div>`
    : "";

  return { css, html };
}

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

  /*
   * The CA columns (§5 of the CA rules).
   *
   * On when the payload says this card's sequence was assessed both ways. Off
   * for a school that does not use continuous assessment, and off for a term
   * or annual card, whose subject marks are already combined across several
   * sequences and have no single CA to name.
   *
   * Two columns, in the order a sequence is actually marked: CA, then the
   * paper, then the mark they make. A card that printed only the combined mark
   * would give a parent no way to see where it came from.
   */
  const showCa = (payload.caEnabled === true) && payload.reportType === "sequence";
  const caWeight   = payload.caWeight;
  const testWeight = payload.testWeight;

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

  /*
   * How the sequence mark was arrived at, under the table.
   *
   * "CA x 40% + Test x 60%" is the difference between a parent who can check
   * the 15.2 and a parent who has to take it on trust. Only printed when there
   * is a split to name — a card with no CA columns needs no explanation of
   * them.
   */
  const caNote = showCa && caWeight != null && testWeight != null
    ? `<p class="ca-note">${esc(
        t.caNote.replace("{ca}", String(caWeight)).replace("{test}", String(testWeight))
      )} &nbsp;·&nbsp; ${esc(t.caCol)} = ${esc(t.caFull)}</p>`
    : "";

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

  /*
   * The columns this card's table has, which depend on what it is a card OF.
   *
   *   sequence  CA and the paper it was marked from, then the mark they
   *             combine to — the level below is what a sequence is made of.
   *   term      the term's sequences, then the result they combine to. Not
   *             CA and paper: those belong to the sequence card, and a term
   *             card repeating them states the same marks one level too low.
   *   annual    the year's result for each subject, as the annual
   *             aggregation already computes it.
   *
   * The mark itself is /20 on every card; only a sequence card also shows
   * the raw score out of whatever the paper was marked over.
   */
  const sequenceColumns = payload.reportType === "term"
    ? (payload.sequenceColumns || []) : [];
  const showRawScore    = payload.reportType === "sequence";
  const resultHeading   = payload.reportType === "term"   ? t.termResult
                        : payload.reportType === "annual" ? t.annualResult
                        : t.outOf20;

  /** One cell per sequence of the term, in the order the school defines. */
  const sequenceCells = (s, absent, flag) =>
    sequenceColumns.map((col) => {
      const got = (s.sequenceMarks || []).find((m) => m.number === col.number);
      const mark = got?.mark;
      return `<td style="text-align:center;color:${absent ? "#9CA3AF" : "#374151"}">` +
             `${absent ? flag : mark == null ? "—" : Number(mark).toFixed(2)}</td>`;
    }).join("");

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

    /*
     * A part of the sequence, or a dash.
     *
     * A dash for a CA that was never recorded, never a 0. They are different
     * facts — one says the pupil was not assessed, the other says they scored
     * nothing — and the second one is a thing a school would have to answer
     * for. The whole feature turns on this cell.
     */
    const partCell = (score, max) =>
      score == null ? "—" : `${score} / ${max ?? s.maxScore ?? 20}`;

    const caCells = showCa
      ? `<td style="text-align:center;color:${absent ? "#9CA3AF" : "#374151"}">
           ${absent ? flag : esc(partCell(s.caScore, s.caMaxScore))}
         </td>
         <td style="text-align:center;color:${absent ? "#9CA3AF" : "#374151"}">
           ${absent ? flag : esc(partCell(s.testScore, s.testMaxScore))}
         </td>`
      : "";

    // "2nd / 35" — the student's rank in this subject, over the number of
    // students who actually sat the subject (computed in the controller).
    const posCell = (s) => {
      if (s.subjectPosition == null) return "—";
      const total = s.subjectTotal != null ? ` / ${s.subjectTotal}` : "";
      return `${ordinal(s.subjectPosition)}${total}`;
    };

    return `
      <tr>
        <td>${esc(s.subjectName || "—")}</td>
        <td class="teacher-cell">${s.teacherName ? esc(s.teacherName) : "—"}</td>
        ${caCells}
        ${sequenceCells(s, absent, flag)}
        ${showRawScore ? `<td style="text-align:center;color:${color}">${esc(scoreCell)}</td>` : ""}
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

  // The promotion decision appears ONLY on the final annual report card —
  // never on sequence or intermediate term reports (see requirements section 8).
  const isAnnual    = payload.reportType === "annual";
  const promoStatus = isAnnual ? summary?.promotionStatus || null : null;

  /*
   * The table's last two rows.
   *
   * The totals are the ones the card already computed to get its average —
   * exposed rather than added up again here, so the row under the marks and
   * the average beside them cannot disagree. A subject the pupil did not sit
   * is in neither, which is the existing rule: an absence is not a zero.
   *
   * The decision is the stored one. Nothing here decides whether a pupil
   * passed; `summary.isPassing` does, wherever it was written, and the
   * promotion decision keeps its own line on the annual card because passing
   * an exam and being promoted are different things a council decides.
   */
  const columnCount = 7 + (showRawScore ? 1 : 0) + (showGrades ? 1 : 0) +
                      (showCa ? 2 : 0) + sequenceColumns.length;
  const totalCoeff  = computed.totalCoefficients;
  const totalMarks  = computed.totalWeighted;
  const hasTotals   = subjects.length > 0 &&
    (totalCoeff != null || totalMarks != null);

  // The foot carries whichever of the two it has. A card with no marks still
  // states the decision the results pipeline stored for it, and a card with
  // marks but no decision still totals them.
  const totalRow = (hasTotals || isPassing != null || promoStatus) ? `
    <tfoot>
      ${!hasTotals ? "" : `<tr class="total-row">
        <td colspan="${2 + (showRawScore ? 1 : 0) + (showCa ? 2 : 0) + sequenceColumns.length}">${t.totalRow}</td>
        <td style="text-align:center">${totalMarks != null ? Number(totalMarks).toFixed(2) : "—"}</td>
        <td style="text-align:center">${totalCoeff != null ? Number(totalCoeff) : "—"}</td>
        <td colspan="${3 + (showGrades ? 1 : 0)}"></td>
      </tr>`}
      ${isPassing == null ? "" : `
      <tr class="status-row">
        <td colspan="${columnCount - 1}">${t.status}</td>
        <td class="${isPassing ? "status-pass" : "status-fail"}" style="text-align:center">
          ${isPassing ? t.passed : t.failed}
        </td>
      </tr>`}
      ${promoStatus ? `
      <tr class="status-row">
        <td colspan="${columnCount - 1}">${t.decision}</td>
        <td class="status-pass" style="text-align:center">${esc(promoStatus)}</td>
      </tr>` : ""}
    </tfoot>` : "";
  const statusRow = "";

  /*
   * What the staff wrote, at the foot of the document where it is signed.
   *
   * The teacher's line falls back to the grading band's remark, which is the
   * convention the school templates have always used for {{teacher_comment}};
   * the head's is left blank to be written on, with a rule under each for the
   * signature. Nothing is generated and nothing is invented.
   */
  const remarkBox = (heading, text, signature) => `
      <div class="remark-box">
        <div class="remark-head">${heading}</div>
        <div class="remark-body">${text ? esc(text) : ""}</div>
        <div class="remark-sign">${signature ? esc(signature) : ""}</div>
      </div>`;
  const remarksBlock = `<div class="remarks">
      ${remarkBox(t.remark, opts.teacherComment || overallRemarkText, payload.classTeacher)}
      ${remarkBox(t.principalRemark, opts.principalComment, school.principalName)}
    </div>`;

  // ── The information panel ────────────────────────────────────────────────
  //
  // The block the printed form carries under the marks: what the pupil did,
  // what the class did, how much school the pupil missed, and the conduct the
  // class teacher writes in by hand. Every figure comes from the payload —
  // the class ones from the same function the statistics page answers with,
  // the register from the pupil's own attendance over this period's days.
  const stats  = payload.classStats || null;
  const row    = (label, value) =>
    `<div class="panel-row"><span class="panel-lbl">${label}</span>` +
    `<span class="panel-val">${value}</span></div>`;
  const writeIn = (label) =>
    `<div class="panel-row"><span class="panel-lbl">${label}</span>` +
    `<span class="panel-write"></span></div>`;

  // "Term average" on a term card, "Annual average" on an annual one, and
  // plain "Average" on a sequence card, which is neither.
  const averageLabel = payload.reportType === "term"   ? t.termAverage
                     : payload.reportType === "annual" ? t.annualAverage
                     : t.average;

  const perfRows = [
    summary?.classPosition != null
      ? row(t.rank, `${summary.classPosition}${summary.totalInClass != null ? ` / ${summary.totalInClass}` : ""}`)
      : "",
    avg20 != null ? row(averageLabel, `${avg20.toFixed(2)} ${t.outOf20}`) : "",
    summary?.overallGrade ? row(t.overallGrade, esc(summary.overallGrade)) : "",
    // The council's decision belongs to the annual card alone (§8); promoStatus
    // is already null on every other kind.
    promoStatus ? row(t.decision, esc(promoStatus)) : "",
  ].filter(Boolean).join("");

  const classRows = [
    row(t.classAverage, classFigure(stats?.average, stats?.scale, t)),
    row(t.best,         classFigure(stats?.highest, stats?.scale, t)),
    row(t.lowest,       classFigure(stats?.lowest,  stats?.scale, t)),
  ].join("");

  const conductRows = [writeIn(t.work), writeIn(t.behaviour), writeIn(t.observation)].join("");

  const infoPanel = `<div class="info-panel">
    <div class="panel-col">
      <div class="panel-head">${t.perfPanel}</div>
      ${perfRows}
    </div>
    <div class="panel-col">
      <div class="panel-head">${t.classPanel}</div>
      ${classRows}
    </div>
    <div class="panel-col">
      <div class="panel-head">${t.conductPanel}</div>
      ${conductRows}
      <div class="panel-note">${t.fillByHand}</div>
    </div>
  </div>`;

  // School branding pulled from the school's settings, never hard-coded.
  const schoolLogo = school.logo || null;
  const schoolMotto = school.motto || null;
  // The same logo a second time, faint, behind the whole card.
  const watermark = schoolWatermark(school);

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
    /* How the sequence mark was made. Small, under the table, and
       printed only when the school marks a sequence both ways. */
    .ca-note { font-size: 9.5px; color: #6b7280; margin: 4px 0 0; text-align: right; }
    /* The teacher of each subject, in its own column: a name, or the card's
       dash. Allowed to wrap — some are long — while the marks beside them
       stay on one line. */
    .teacher-cell { color: #4b5563; font-size: 10.5px; }

    /* The table's last rows. A tfoot so a table that breaks across two
       sheets carries its totals on the sheet its last subject is on. */
    tfoot td { border-top: 1px solid #d1d5db; background: #f9fafb;
               font-weight: bold; padding: 6px 8px; }
    .total-row td { font-size: 11px; }
    .status-row td { font-size: 11px; font-weight: bold; }
    .status-pass { color: #059669; }
    .status-fail { color: #dc2626; }

    /* ── The remarks, above the verification strip ──────────────────────
       Two boxes on one row, each with a rule to sign on. Deliberately not
       tall: a box a teacher can write two lines in, not a page of empty
       paper between the marks and the code that proves them. */
    .remarks { display: flex; gap: 10px; margin-bottom: 12px;
               page-break-inside: avoid; break-inside: avoid; }
    .remark-box { flex: 1 1 0; min-width: 0; border: 1px solid #e5e7eb;
                  border-radius: 8px; padding: 8px 10px; }
    .remark-head { font-size: 9.5px; font-weight: bold; text-transform: uppercase;
                   letter-spacing: .04em; color: #374151; margin-bottom: 4px; }
    .remark-body { font-size: 10.5px; color: #374151; line-height: 1.45;
                   min-height: 30px; }
    .remark-sign { margin-top: 10px; border-top: 1px solid #d1d5db; padding-top: 3px;
                   font-size: 9px; color: #9ca3af; }

    @media screen and (max-width: 560px) {
      .remarks { flex-direction: column; }
    }

    /* ── The information panel ─────────────────────────────────────────
       The four sections of the printed form, in the card's own border and
       type. A grid rather than a table so a long French label wraps inside
       its own cell instead of widening the column and pushing the panel
       past the sheet. */
    .info-panel { display: grid; grid-template-columns: repeat(3, 1fr);
                  gap: 0; border: 1px solid #e5e7eb; border-radius: 8px;
                  overflow: hidden; margin-bottom: 14px;
                  page-break-inside: avoid; break-inside: avoid; }
    .panel-col { border-right: 1px solid #e5e7eb; padding: 8px 10px; min-width: 0; }
    .panel-col:last-child { border-right: 0; }
    .panel-head { font-size: 9.5px; font-weight: bold; text-transform: uppercase;
                 letter-spacing: .04em; color: #374151; text-align: center;
                 border-bottom: 1px solid #e5e7eb; padding-bottom: 4px;
                 margin-bottom: 6px; }
    .panel-row { display: flex; align-items: baseline; justify-content: space-between;
                gap: 8px; font-size: 10px; line-height: 1.45; }
    .panel-row + .panel-row { margin-top: 3px; }
    .panel-lbl { color: #6b7280; min-width: 0; }
    .panel-val { color: #111827; font-weight: bold; white-space: nowrap; }
    /* The conduct rows are filled in by hand on the printed card. An empty
       ruled box, the size of a tick, rather than a blank that reads as
       missing data. */
    .panel-write { flex: none; width: 34px; height: 13px; border: 1px solid #9ca3af;
                  border-radius: 2px; background: #fff; }
    .panel-note { margin-top: 6px; font-size: 8px; color: #9ca3af;
                 font-style: italic; line-height: 1.3; }

    @media screen and (max-width: 560px) {
      .info-panel { grid-template-columns: 1fr; }
      .panel-col { border-right: 0; border-bottom: 1px solid #e5e7eb; }
      .panel-col:last-child { border-bottom: 0; }
    }

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
${watermark.css}

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

      .teacher-cell      { font-size: 9px; }
      tfoot td           { padding: 3px 6px; }
      .total-row td,
      .status-row td     { font-size: 9.5px; }
      .remarks           { gap: 8px; margin-bottom: 8px; }
      .remark-box        { padding: 6px 8px; }
      .remark-head       { font-size: 8px; margin-bottom: 3px; }
      .remark-body       { font-size: 9.5px; min-height: 24px; line-height: 1.35; }
      .remark-sign       { margin-top: 8px; font-size: 8px; }

      .info-panel        { margin-bottom: 8px; }
      .panel-col          { padding: 5px 7px; }
      .panel-head         { font-size: 8px; padding-bottom: 3px; margin-bottom: 4px; }
      .panel-row          { font-size: 8.5px; line-height: 1.3; }
      .panel-note         { font-size: 7px; }

      .verify            { margin-bottom: 8px; padding: 6px 8px; gap: 7px; }
      .verify-qr         { width: 52px; height: 52px; }
      .verify-title,
      .verify-text       { font-size: 8px; }
      .footer            { padding-top: 7px; font-size: 8.5px; }

      .report-header,
      .info-grid,
      .info-panel,
      .remarks,
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
  ${watermark.html}
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
        <th>${t.teacherCol}</th>
        ${showCa ? `<th style="text-align:center">${t.caCol}</th>
        <th style="text-align:center">${t.testCol}</th>` : ""}
        ${sequenceColumns.map((c) => `<th style="text-align:center">${esc(c.name)}</th>`).join("")}
        ${showRawScore ? `<th style="text-align:center">${t.score}</th>` : ""}
        <th style="text-align:center">${resultHeading}</th>
        <th style="text-align:center">${t.coeff}</th>
        ${showGrades ? `<th style="text-align:center">${t.grade}</th>` : ""}
        <th style="text-align:center">${t.remarkCol}</th>
        <th style="text-align:center">${t.positionCol}</th>
        <th style="text-align:center">${t.result}</th>
      </tr>
    </thead>
    <tbody>${rows ||
      `<tr><td colspan="${columnCount}" style="text-align:center;color:#9ca3af;padding:16px">${t.noScores}</td></tr>`}</tbody>
    ${totalRow}${statusRow}
  </table>
  ${caNote}

  ${infoPanel}

  ${remarksBlock}

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
  // The same label table the built-in layout reads. A school's template gets
  // the panel's wording through {{label_*}} tokens rather than in English.
  const t        = LABELS[lang];
  const remarkOf = (row) =>
    (lang === "fr" ? (row?.remarkFr || row?.remark) : row?.remark) || "";

  const avg20 = resolveAverage20(payload);

  return {
    // The language the card is printed in: the labels above are resolved
    // already, and this lets the engine format its ordinals to match.
    lang,

    /*
     * The level this card is for, so the table the engine draws has the
     * same columns the built-in layout gives it: a sequence's raw score
     * beside its /20, a term's two sequences and the result they combine
     * to, a year's own result. See the built-in renderer for why.
     */
    sequenceColumns: payload.reportType === "term" ? (payload.sequenceColumns || []) : [],
    showRawScore:    payload.reportType === "sequence",
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

    // Attendance is not part of a report card any more. The tokens stay for
    // a template that still prints them and a caller that still has the
    // figures; nothing on the card path fills them in.
    attendance: opts.attendance || { daysPresent: 0, daysAbsent: null, daysOpen: 0 },

    // What the class did, ready to print: "59.30%" for a sequence card, whose
    // statistics are percentages, "11.87 /20" for a term or annual one, whose
    // records are out of twenty. The dash where there is nothing to report.
    classStats: {
      available: Boolean(payload.classStats?.count),
      count:     payload.classStats?.count ?? 0,
      average:   classFigure(payload.classStats?.average, payload.classStats?.scale, t),
      best:      classFigure(payload.classStats?.highest, payload.classStats?.scale, t),
      lowest:    classFigure(payload.classStats?.lowest,  payload.classStats?.scale, t),
    },

    // The panel's own wording, in the reader's language. A school template
    // prints {{label_rank}} rather than the word "Rank", exactly as its
    // header prints {{header_ministry_fr}} rather than the ministry's name:
    // one card, two languages, no second template to keep in step.
    labels: {
      perfPanel:    t.perfPanel,
      classPanel:   t.classPanel,
      attendPanel:  t.attendPanel,
      conductPanel: t.conductPanel,
      rank:         t.rank,
      average:      payload.reportType === "term"   ? t.termAverage
                  : payload.reportType === "annual" ? t.annualAverage
                  : t.average,
      grade:        t.overallGrade,
      decision:     t.decision,
      classAverage: t.classAverage,
      best:         t.best,
      lowest:       t.lowest,
      absences:     t.absences,
      excused:      t.excused,
      unexcused:    t.unexcused,
      lateComing:   t.lateComing,
      // The engine draws the subject table itself; these are its headings.
      subject:      t.subject,
      result:       payload.reportType === "term"   ? t.termResult
                  : payload.reportType === "annual" ? t.annualResult
                  : t.outOf20,
      score:        t.score,
      outOf20:      t.outOf20,
      coeff:        t.coeff,
      gradeCol:     t.grade,
      remarkCol:    t.remarkCol,
      positionCol:  t.positionCol,
      teacher:      t.teacherCol,
      total:        t.totalRow,
      status:       t.status,
      passed:       t.passed,
      failed:       t.failed,
      teacherRemark:   t.remark,
      principalRemark: t.principalRemark,
      work:         t.work,
      behaviour:    t.behaviour,
      observation:  t.observation,
      fillByHand:   t.fillByHand,
    },

    performance: {
      // Engine tokens {{average}} / {{weighted_average}} and its {{if
      // isPassing}} test both read this, and it must be /20.
      average:           avg20 ?? 0,
      percentage:        summary?.percentage      ?? null,
      totalScore:        summary?.totalScore      ?? null,
      // The stored decision, never a threshold applied here. The engine's
      // own `average >= 10` stays as the fallback for a payload that has no
      // flag, which is what it was before anything stored one.
      isPassing:         summary?.isPassing       ?? null,
      // What the table's last row states: the coefficients the card counted
      // and the marks weighted by them, as the card computed them.
      totalCoefficients: computed.totalCoefficients ?? null,
      totalWeighted:     computed.totalWeighted     ?? null,
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

      // Whether this card's sequence was marked both ways, and by what split,
      // so a school's own layout can decide to show a CA column at all.
      caEnabled:         payload.caEnabled === true,
      caWeight:          payload.caWeight   ?? null,
      testWeight:        payload.testWeight ?? null,

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
      /*
       * The engine has offered subject.caScore and subject.examScore since it
       * existed and nothing ever filled the first of them — a school template
       * addressing {{caScore}} got a blank, because there was no continuous
       * assessment to put there. Now there is.
       *
       * null, not 0, when no CA was recorded: the engine renders null as an
       * empty cell, and an empty cell is the truthful rendering of a mark
       * nobody entered.
       */
      caScore:        r.caScore        ?? null,
      caMaxScore:     r.caMaxScore     ?? null,
      // The paper alone when a sequence has both halves; the exam mark as
      // before on every card that does not.
      examScore:      r.testScore      ?? r.score ?? null,
      examMaxScore:   r.testMaxScore   ?? r.maxScore ?? null,
      // The two combined — which is what `total` has always meant.
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
      // A term card's per-sequence marks, in the order the school's academic
      // structure defines them.
      sequenceMarks:  r.sequenceMarks   || [],
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
 * A class figure, on the scale its own records are kept in.
 *
 * The exam statistics are percentages and the term and annual results are out
 * of twenty (see services/classStats.service.js). Rather than convert one
 * into the other — which would state a number no record holds — each prints
 * with the unit it is in, beside the pupil's own figure on the same scale.
 *
 * Nothing to report prints the card's own "not recorded" mark, never 0.00:
 * a class with no published results has no average, and a zero there says
 * something false about every pupil in it.
 */
function classFigure(value, scale, t) {
  if (value == null || !Number.isFinite(Number(value))) return t.notRecorded;
  // Marks, on the scale the rest of the card is marked in. A percentage
  // here would be a second scale on one document and nothing to compare the
  // pupil's own average against.
  return `${Number(value).toFixed(2)} ${t.outOf20}`;
}

/**
 * A register count, or the "not recorded" mark when there was no period to
 * count over. Zero is a real answer here — a pupil who missed nothing — and
 * is printed as 0, which is why the unavailable case has to be its own.
 */
function attendanceFigure(value, t) {
  return value == null || !Number.isFinite(Number(value))
    ? t.notRecorded
    : String(Number(value));
}

/**
 * Wrap a rendered template fragment into a standalone printable document.
 * The template's own CSS goes last so it can override these defaults.
 *
 * The school's logo goes behind the template too, on the same terms as the
 * built-in layout — see schoolWatermark. A template author who does not want
 * it hides .school-watermark in their own CSS, which is appended after it.
 */
function wrapTemplateHtml(body, css, { lang, title, school }) {
  const watermark = schoolWatermark(school);
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
    /* The default head tint goes on the row group, not the cells: a th
       background paints over a thead background whatever the order of the
       sheets, so with it on the cells a template that coloured its thead
       (the seeded one does, blue with white text) got white text on this
       grey — an invisible header. */
    .subjects-table th { font-weight: bold; }
    .subjects-table thead { background: #f0f0f0; }
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
${watermark.css}
    ${css || ""}
  </style>
</head>
<body>${watermark.html}${body}</body>
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
        title:  `${LABELS[lang].title} — ${payload.studentName || ""}`,
        school: opts.school,
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
