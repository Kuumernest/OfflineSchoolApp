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

  /* ── School header ─────────────────────────────────── */
  .school-header {
    text-align:     center;
    margin-bottom:  16px;
    padding-bottom: 12px;
    border-bottom:  2px solid #2563EB;
  }

  .school-name {
    font-size:   20px;
    font-weight: bold;
    color:       #1e40af;
    margin:      8px 0 4px;
  }

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

  /* ── Print ─────────────────────────────────────────── */
  @media print {
    body { padding: 0; }
    .report-wrapper { border: 1px solid #ccc; padding: 16px; }
  }
`;

const DEFAULT_TEMPLATE_HTML = `<div class="report-wrapper">

  <!-- School header -->
  <div class="school-header">
    {{school_logo}}
    <div class="school-name">{{school_name}}</div>
    <div class="school-motto">{{school_motto}}</div>
    <div class="school-contact">{{school_address}} | {{school_phone}}</div>
  </div>

  <div class="report-title">ACADEMIC REPORT CARD</div>
  <p style="text-align:center;margin-bottom:12px;font-size:13px;color:#374151">
    {{term}} &mdash; {{academic_year}}
  </p>

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
    <div class="pass-banner pass">
      ✓ PASSED &mdash; {{remark}}
    </div>
  {{else}}
    <div class="pass-banner fail">
      ✗ NOT PASSED &mdash; {{remark}}
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
    <div>{{qr_code}}</div>
    <div style="text-align:right">
      <p>Next Term Begins: <strong>{{next_term_date}}</strong></p>
      <p style="margin-top:4px">Report Generated: {{report_date}}</p>
      <p style="margin-top:4px">{{school_name}} &mdash; Official Academic Record</p>
    </div>
  </div>

</div>
`;

module.exports = { DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS };
