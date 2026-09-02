// backend/src/print/defaultReportTemplate.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DEFAULT REPORT CARD TEMPLATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The starting point a school forks when it wants its own report card
 * layout. POST /api/templates/seed-default writes this into a ReportTemplate
 * row that the school can then edit in the builder.
 *
 * This is NOT the fallback used when a school has no template — that is the
 * built-in layout in services/reportHtml.service.js, which needs no template
 * row to exist. This file only seeds an editable starting template.
 *
 * Every {{token}} here is resolved by engine/placeholder.engine.js. Keep them
 * to tokens that engine actually knows, or a seeded school starts with
 * literal braces printed on its report cards.
 *
 * This is the only copy. A mirror used to live in the mobile app for an
 * on-device generator; that path was removed once printing moved server-side.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The official header, kept apart because two things need the identical copy:
 * this template, and the repair that puts it into the templates schools saved
 * before it existed. A second hand-written copy in the repair script is how
 * the two would drift.
 */
const OFFICIAL_HEADER_CSS = `  /* ── The official header ───────────────────────────────
     Ministry and delegations in English down the left margin, the school in
     the middle, the same in French down the right. Both languages on every
     card: that is the Cameroonian format, not a translation setting. */
  .school-header {
    text-align:     center;
    margin-bottom:  16px;
    padding-bottom: 12px;
    border-bottom:  1px solid #e5e5e5;
    font-family:    "Times New Roman", Times, serif;
  }

  .report-header-top {
    display:               grid;
    grid-template-columns: 1fr 1.2fr 1fr;
    align-items:           start;
    gap:                   16px;
  }

  .ministry-column {
    text-align:  center;
    color:       #2e3440;
    font-size:   10px;
    line-height: 1.35;
  }

  .ministry-column p { margin: 0 0 3px; }

  .ministry-column .country {
    font-weight:     bold;
    text-transform:  uppercase;
    text-decoration: underline;
  }

  .ministry-column .peace { font-style: italic; font-weight: bold; }

  .ministry-column .ministry {
    margin-top:      8px;
    text-transform:  uppercase;
    text-decoration: underline;
  }

  .ministry-column .delegation,
  .ministry-column .sub-delegation {
    margin-top:      8px;
    font-weight:     bold;
    text-transform:  uppercase;
    text-decoration: underline;
  }

  .ministry-column .school-type {
    margin-top:     6px;
    font-weight:    bold;
    text-transform: uppercase;
  }

  /* A real card does not underline its French column. */
  .ministry-column.french .country,
  .ministry-column.french .ministry,
  .ministry-column.french .delegation,
  .ministry-column.french .sub-delegation { text-decoration: none; }

  .school-identity { padding: 0 8px; }

  .school-name {
    font-size:      17px;
    font-weight:    bold;
    color:          #1f2933;
    font-family:    Arial, Helvetica, sans-serif;
    text-transform: uppercase;
    line-height:    1.25;
    margin:         6px 0 4px;
  }
`;

/**
 * The verification strip: the square, the code, and where to type it.
 *
 * {{qr_code}} alone was all a template had, so a school card carried the
 * square and nothing else — and a registrar with the paper in front of them
 * and no scanner to hand had no way to check it. Gated, because a card printed
 * without verification should show no label rather than an empty one.
 */
const VERIFY_BLOCK_HTML = `<div class="verify-strip">
      {{qr_code}}
      {{if verification_code}}
        <div class="verify-words">
          <div class="verify-title">Verify this document</div>
          <div class="verify-text">
            Scan the code, or enter
            <span class="verify-code">{{verification_code}}</span>
            {{if verification_url}}&mdash; {{verification_url}}{{endif}}
          </div>
        </div>
      {{endif}}
    </div>`;

const VERIFY_BLOCK_CSS = `
  /* ── Verification strip ────────────────────────────────
     The square beside the code a registrar types, rather than the square on
     its own. */
  .verify-strip {
    display:     flex;
    align-items: center;
    gap:         10px;
  }

  .verify-words { line-height: 1.4; }

  .verify-title {
    font-size:       9px;
    font-weight:     bold;
    text-transform:  uppercase;
    letter-spacing:  .06em;
    color:           #374151;
  }

  .verify-text { font-size: 9px; color: #6b7280; }

  .verify-code {
    font-family:    Consolas, Menlo, monospace;
    font-weight:    bold;
    color:          #111827;
    letter-spacing: .04em;
  }
`;

const OFFICIAL_HEADER_HTML = `  <!-- The official header: English margin, school, French margin. -->
  <div class="school-header">
    <div class="report-header-top">

      <div class="ministry-column">
        <p class="country">{{header_country_en}}</p>
        <p class="peace">{{header_peace_en}}</p>
        <p>{{header_separator}}</p>
        <p class="ministry">{{header_ministry_en}}</p>
        {{if header_regional_en}}
          <p>{{header_separator}}</p>
          <p class="delegation">{{header_regional_en}}</p>
        {{endif}}
        {{if header_divisional_en}}
          <p>{{header_separator}}</p>
          <p class="sub-delegation">{{header_divisional_en}}</p>
        {{endif}}
        {{if header_type_en}}
          <p class="school-type">{{header_type_en}}</p>
        {{endif}}
      </div>

      <div class="school-identity">
        {{school_logo}}
        <div class="school-name">{{school_name}}</div>
        <div class="school-motto">{{school_motto}}</div>
        {{if school_address}}
          <div class="school-contact">{{school_address}}</div>
        {{endif}}
        {{if school_phone}}
          <div class="school-contact">{{school_phone}}</div>
        {{endif}}
      </div>

      <div class="ministry-column french">
        <p class="country">{{header_country_fr}}</p>
        <p class="peace">{{header_peace_fr}}</p>
        <p>{{header_separator}}</p>
        <p class="ministry">{{header_ministry_fr}}</p>
        {{if header_regional_fr}}
          <p>{{header_separator}}</p>
          <p class="delegation">{{header_regional_fr}}</p>
        {{endif}}
        {{if header_divisional_fr}}
          <p>{{header_separator}}</p>
          <p class="sub-delegation">{{header_divisional_fr}}</p>
        {{endif}}
        {{if header_type_fr}}
          <p class="school-type">{{header_type_fr}}</p>
        {{endif}}
      </div>

    </div>
  </div>

  <!-- The period this card is for, named rather than numbered. -->
  <div class="report-title">{{report_title}}</div>
  <p style="text-align:center;margin-bottom:12px;font-size:13px;color:#374151">
    {{academic_year}}
  </p>`;

const DEFAULT_TEMPLATE_CSS = `  * {
    box-sizing: border-box;
    margin:     0;
    padding:    0;
  }

  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size:   12px;
    color:       #111;
    background:  #fff;
  }

  .report-wrapper {
    max-width:  800px;
    margin:     0 auto;
    padding:    24px;
    border:     2px solid #2563EB;
    border-radius: 8px;
  }

${OFFICIAL_HEADER_CSS}

  .school-motto {
    font-size:   11px;
    color:       #555;
    font-style:  italic;
  }

  .school-contact {
    font-size: 10px;
    color:     #6b7280;
    margin-top: 4px;
  }

  .report-title {
    font-size:       15px;
    font-weight:     bold;
    text-align:      center;
    background:      #2563EB;
    color:           #fff;
    padding:         8px;
    margin:          12px 0;
    letter-spacing:  1px;
  }

  /* ── Student info grid ─────────────────────────────── */
  .student-info-grid {
    display:               grid;
    grid-template-columns: 1fr 1fr;
    gap:                   4px 16px;
    margin-bottom:         16px;
    background:            #f0f4ff;
    padding:               12px;
    border-radius:         6px;
  }

  .info-row {
    display:   flex;
    gap:       6px;
    font-size: 12px;
  }

  .info-lbl {
    font-weight: bold;
    min-width:   110px;
    color:       #374151;
  }

  .info-val {
    color: #111;
  }

  /* ── Subjects table ────────────────────────────────── */
  .subjects-table {
    width:           100%;
    border-collapse: collapse;
    margin-bottom:   16px;
  }

  .subjects-table th,
  .subjects-table td {
    border:  1px solid #e5e7eb;
    padding: 6px 8px;
  }

  .subjects-table thead {
    background: #2563EB;
    color:      #fff;
    font-size:  11px;
  }

  .subjects-table tr:nth-child(even) {
    background: #f9fafb;
  }

  /* ── Summary boxes ─────────────────────────────────── */
  .summary-section {
    display:               grid;
    grid-template-columns: repeat(4, 1fr);
    text-align:            center;
    background:            #f0f4ff;
    border-radius:         6px;
    padding:               10px;
    gap:                   8px;
    margin-bottom:         16px;
  }

  .summary-item .val {
    font-size:   20px;
    font-weight: bold;
    color:       #2563EB;
  }

  .summary-item .lbl {
    font-size:  10px;
    color:      #6b7280;
    margin-top: 2px;
  }

  /* ── Pass / fail banner ────────────────────────────── */
  .pass-banner {
    text-align:    center;
    font-size:     16px;
    font-weight:   bold;
    padding:       10px;
    border-radius: 6px;
    margin-bottom: 14px;
  }

  .pass-banner.pass {
    background: #d1fae5;
    color:      #059669;
  }

  .pass-banner.fail {
    background: #fee2e2;
    color:      #dc2626;
  }

  /* ── Verdict and remark, on one row ────────────────────
     The verdict used to be a full-width band with the remark inside it, which
     wrapped to two and three lines on any remark longer than a few words. That
     block plus the summary boxes above it was enough height to push the
     verification block, and the code a registrar types to check the card, off
     the foot of the page. A short pill and the remark beside it says the same
     thing in one line. */
  .verdict {
    display:       flex;
    align-items:   center;
    gap:           10px;
    flex-wrap:     wrap;
    margin-bottom: 12px;
  }

  .verdict-pill {
    flex:          none;
    padding:       6px 12px;
    border-radius: 999px;
    font-size:     12px;
    font-weight:   bold;
    white-space:   nowrap;
  }

  .verdict-pill.pass { background: #d1fae5; color: #059669; }
  .verdict-pill.fail { background: #fee2e2; color: #dc2626; }

  .verdict-remark {
    flex:        1;
    min-width:   220px;
    font-size:   11px;
    font-style:  italic;
    color:       #4b5563;
    line-height: 1.5;
  }

  /* ── Remarks sections ──────────────────────────────── */
  .remarks-section {
    border:        1px solid #e5e7eb;
    border-radius: 6px;
    padding:       12px;
    margin-bottom: 12px;
  }

  .remarks-section h4 {
    margin:    0 0 6px;
    font-size: 12px;
    color:     #374151;
  }

  .remarks-section p {
    font-size:   12px;
    color:       #374151;
    line-height: 1.5;
  }

  .signature-line {
    margin-top:  20px;
    border-top:  1px solid #333;
    padding-top: 4px;
    font-size:   10px;
    color:       #9ca3af;
    display:     inline-block;
  }

  /* ── Attendance table ──────────────────────────────── */
  .attendance-table {
    width:           100%;
    border-collapse: collapse;
    margin-bottom:   16px;
    font-size:       11px;
  }

  .attendance-table th,
  .attendance-table td {
    border:      1px solid #e5e7eb;
    padding:     5px 8px;
    text-align:  center;
  }

  .attendance-table thead {
    background: #f3f4f6;
    font-weight: bold;
  }

  /* ── Footer ────────────────────────────────────────── */
  .footer {
    display:         flex;
    justify-content: space-between;
    align-items:     flex-end;
    border-top:      1px solid #e5e7eb;
    padding-top:     12px;
    margin-top:      8px;
    font-size:       10px;
    color:           #9ca3af;
  }

  ${VERIFY_BLOCK_CSS}
  /* ── Print ─────────────────────────────────────────── */
  @media print {
    body { padding: 0; }
    .report-wrapper { border: 1px solid #ccc; padding: 16px; }
  }
`;

const DEFAULT_TEMPLATE_HTML = `<div class="report-wrapper">

${OFFICIAL_HEADER_HTML}
  <!-- Student information -->
  <div class="student-info-grid">
    <div class="info-row">
      <span class="info-lbl">Student Name:</span>
      <span class="info-val">{{student_name}}</span>
    </div>
    <div class="info-row">
      <span class="info-lbl">Admission No:</span>
      <span class="info-val">{{admission_number}}</span>
    </div>
    <div class="info-row">
      <span class="info-lbl">Class:</span>
      <span class="info-val">{{class}} {{stream}}</span>
    </div>
    <div class="info-row">
      <span class="info-lbl">Gender:</span>
      <span class="info-val">{{gender}}</span>
    </div>
    <div class="info-row">
      <span class="info-lbl">Class Teacher:</span>
      <span class="info-val">{{class_teacher}}</span>
    </div>
    <div class="info-row">
      <span class="info-lbl">Date of Birth:</span>
      <span class="info-val">{{date_of_birth}}</span>
    </div>
  </div>

  <!-- Student photo -->
  <div style="float:right;margin:-120px 0 12px 12px">
    {{student_photo}}
  </div>

  <!-- Academic performance -->
  <h3 style="font-size:13px;border-bottom:1px solid #e5e7eb;
             padding-bottom:4px;margin-bottom:8px">
    Academic Performance
  </h3>

  {{subjects_table}}

  <!-- Summary stats -->
  <div class="summary-section">
    <div class="summary-item">
      <div class="val">{{average}}</div>
      <div class="lbl">Average /20</div>
    </div>
    <div class="summary-item">
      <div class="val">{{position}}</div>
      <div class="lbl">Position</div>
    </div>
    <div class="summary-item">
      <div class="val">{{grade}}</div>
      <div class="lbl">Grade</div>
    </div>
    <div class="summary-item">
      <div class="val">{{total_students}}</div>
      <div class="lbl">In Class</div>
    </div>
  </div>

  <!-- Pass / fail. NOT a promotion: a pupil passing this exam has not been
       promoted, and saying so on a sequence card tells a family something no
       council has decided. The promotion decision has its own block below and
       appears on the annual card alone. -->
  {{if isPassing}}
    <div class="verdict">
      <div class="verdict-pill pass">✓ PASSED</div>
      {{if remark}}<div class="verdict-remark">{{remark}}</div>{{endif}}
    </div>
  {{else}}
    <div class="verdict">
      <div class="verdict-pill fail">✗ NOT PASSED</div>
      {{if remark}}<div class="verdict-remark">{{remark}}</div>{{endif}}
    </div>
  {{endif}}

  <!-- The promotion decision: the final annual report card only. -->
  {{if is_annual}}
    {{if promotion_status}}
      <div class="pass-banner pass">
        {{promotion_status}}
      </div>
    {{endif}}
  {{endif}}

  <!-- Attendance -->
  <h3 style="font-size:13px;border-bottom:1px solid #e5e7eb;
             padding-bottom:4px;margin:16px 0 8px">
    Attendance
  </h3>

  <div style="display:flex;gap:12px;margin-bottom:16px">
    <div style="flex:1;background:#f9fafb;border-radius:6px;
                padding:8px 12px;font-size:12px">
      Days Open: <strong>{{days_open}}</strong>
    </div>
    <div style="flex:1;background:#f9fafb;border-radius:6px;
                padding:8px 12px;font-size:12px">
      Present: <strong>{{days_present}}</strong>
    </div>
    <div style="flex:1;background:#f9fafb;border-radius:6px;
                padding:8px 12px;font-size:12px">
      Absent: <strong>{{days_absent}}</strong>
    </div>
    <div style="flex:1;background:#f9fafb;border-radius:6px;
                padding:8px 12px;font-size:12px">
      Rate: <strong>{{attendance_percent}}</strong>
    </div>
  </div>

  {{attendance_table}}

  <!-- Remarks -->
  <div style="display:flex;gap:16px;margin-bottom:16px">
    <div class="remarks-section" style="flex:1">
      <h4>CLASS TEACHER'S REMARK</h4>
      <p>{{teacher_comment}}</p>
      <div style="margin-top:24px">
        <span class="signature-line">{{class_teacher}}</span>
      </div>
    </div>
    <div class="remarks-section" style="flex:1">
      <h4>PRINCIPAL'S REMARK</h4>
      <p>{{principal_comment}}</p>
      <div style="margin-top:24px">
        <span class="signature-line">{{principal_name}}</span>
      </div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    ${VERIFY_BLOCK_HTML}
    <div style="text-align:right">
      <p>Next Term Begins: <strong>{{next_term_date}}</strong></p>
      <p style="margin-top:4px">Report Generated: {{report_date}}</p>
      <p style="margin-top:4px">{{school_name}} &mdash; Official Academic Record</p>
    </div>
  </div>

</div>
`;

module.exports = {
  DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS,
  OFFICIAL_HEADER_HTML, OFFICIAL_HEADER_CSS,
  VERIFY_BLOCK_HTML, VERIFY_BLOCK_CSS,
};
