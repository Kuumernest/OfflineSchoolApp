// backend/engine/placeholder.engine.js
"use strict";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PLACEHOLDER ENGINE — CommonJS (Server-Side)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The placeholder engine. Used by the template preview route and by
 * reportHtml.service.js to render templates server-side.
 *
 * This is the only copy. The mobile app mirrored it while report cards were
 * generated on-device; that path was removed once printing moved here.
 *
 * Supports:
 *   {{variable}}              Simple variable substitution
 *   {{#variable}}             Raw (unescaped) output
 *   {{if condition}}          Conditional block
 *   {{else}}                  Else branch
 *   {{endif}}                 End conditional
 *   {{each items}}            Loop over array
 *   {{/each}}                 End loop
 *   {{subjects_table}}        Auto-generated subjects HTML table
 *   {{attendance_table}}      Auto-generated attendance HTML table
 *   {{student_photo}}         Student photo img tag
 *   {{school_logo}}           School logo img tag
 *   {{qr_code}}               QR code placeholder
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── HTML Escape ───────────────────────────────────────────────────────────

const escapeHtml = (str) => {
  if (str == null) return "";
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;");
};

// ── Tokenizer ─────────────────────────────────────────────────────────────

const TOKEN_RE =
  /\{\{(\/?)(?:(#)(\w[\w.]*)|if\s+([\w.]+)|each\s+([\w.]+)|(else)|(endif)|(\w[\w.]*))\}\}/g;

function tokenize(template) {
  const tokens = [];
  let   last   = 0;
  let   match;

  TOKEN_RE.lastIndex = 0;

  while ((match = TOKEN_RE.exec(template)) !== null) {
    if (match.index > last) {
      tokens.push({ type: "text", value: template.slice(last, match.index) });
    }

    const [
      full, slash, hash, hashName,
      ifCond, eachVar, isElse, isEndif, varName,
    ] = match;

    if (slash && hashName)     tokens.push({ type: "endeach" });
    else if (isElse)           tokens.push({ type: "else" });
    else if (isEndif)          tokens.push({ type: "endif" });
    else if (ifCond)           tokens.push({ type: "if",   condition: ifCond  });
    else if (eachVar)          tokens.push({ type: "each", variable: eachVar  });
    else if (hash && hashName) tokens.push({ type: "var",  name: hashName, raw: true  });
    else if (varName)          tokens.push({ type: "var",  name: varName,  raw: false });

    last = match.index + full.length;
  }

  if (last < template.length) {
    tokens.push({ type: "text", value: template.slice(last) });
  }

  return tokens;
}

// ── Parser ────────────────────────────────────────────────────────────────

function parse(tokens) {
  const root  = { type: "root", children: [] };
  const stack = [root];
  const top   = () => stack[stack.length - 1];

  for (const token of tokens) {
    switch (token.type) {

      case "text":
      case "var":
        top().children.push(token);
        break;

      case "if": {
        const node = {
          type:      "if",
          condition: token.condition,
          children:  [],
          inElse:    false,
        };
        top().children.push(node);
        stack.push(node);
        break;
      }

      case "else":
        if (top().type !== "if") throw new Error("{{else}} without {{if}}");
        top().children.push({ _isElseMarker: true });
        break;

      case "endif": {
        const node = top();
        if (node.type !== "if") throw new Error("{{endif}} without {{if}}");
        const all = node.children;
        node.thenBody = [];
        node.elseBody = [];
        let inElse = false;
        for (const child of all) {
          if (child._isElseMarker) { inElse = true; continue; }
          if (inElse) node.elseBody.push(child);
          else        node.thenBody.push(child);
        }
        delete node.children;
        delete node.inElse;
        stack.pop();
        break;
      }

      case "each": {
        const node = {
          type:     "each",
          variable: token.variable,
          children: [],
        };
        top().children.push(node);
        stack.push(node);
        break;
      }

      case "endeach":
        if (top().type !== "each") throw new Error("{{/each}} without {{each}}");
        stack.pop();
        break;

      default:
        break;
    }
  }

  if (stack.length > 1) {
    throw new Error(
      `Unclosed ${top().type === "if" ? "{{if}}" : "{{each}}"} block`
    );
  }

  return root;
}

// ── Resolver ──────────────────────────────────────────────────────────────

function resolve(data, path) {
  const parts = path.split(".");
  let   node  = data;
  for (const part of parts) {
    if (node == null || typeof node !== "object") {
      return { value: undefined, found: false };
    }
    node = node[part];
  }
  return { value: node, found: true };
}

function evaluateCondition(data, condition) {
  const { value, found } = resolve(data, condition);
  if (!found || value == null)         return false;
  if (typeof value === "boolean")      return value;
  if (typeof value === "number")       return value !== 0;
  if (typeof value === "string")       return value.trim().length > 0;
  if (Array.isArray(value))            return value.length > 0;
  if (typeof value === "object")       return true;
  return false;
}

// ── Evaluator ─────────────────────────────────────────────────────────────

function evaluate(node, data) {
  switch (node.type) {

    case "root":
      return node.children.map((c) => evaluate(c, data)).join("");

    case "text":
      return node.value;

    case "var": {
      const { value, found } = resolve(data, node.name);
      if (!found || value == null) return `{{${node.name}}}`;
      const str = String(value);
      return node.raw ? str : escapeHtml(str);
    }

    case "if": {
      const pass = evaluateCondition(data, node.condition);
      const body = pass ? (node.thenBody || []) : (node.elseBody || []);
      return body.map((c) => evaluate(c, data)).join("");
    }

    case "each": {
      const { value, found } = resolve(data, node.variable);
      if (!found || !Array.isArray(value)) {
        return `{{each ${node.variable}}}(not found){{/each}}`;
      }
      const singular = node.variable.replace(/s$/, "");
      return value.map((item, index) => {
        const loopData = {
          ...data,
          [singular]: item,
          item,
          index,
          first: index === 0,
          last:  index === value.length - 1,
        };
        return node.children.map((c) => evaluate(c, loopData)).join("");
      }).join("");
    }

    default:
      return "";
  }
}

// ── Template Runner ───────────────────────────────────────────────────────

function renderTemplate(html, data) {
  try {
    const tokens = tokenize(html);
    const ast    = parse(tokens);
    return evaluate(ast, data);
  } catch (err) {
    console.error("[TemplateEngine] render error:", err.message);
    return `<!-- Template Engine Error: ${escapeHtml(err.message)} -->${html}`;
  }
}

// ── Formatters ────────────────────────────────────────────────────────────

function formatPosition(pos) {
  if (pos == null || pos === "") return "—";
  const n   = Number(pos);
  if (isNaN(n)) return "—";
  const mod = n % 100;
  const sfx = ["th", "st", "nd", "rd"];
  return `${n}${mod >= 11 && mod <= 13 ? "th" : sfx[n % 10 < 4 ? n % 10 : 0]}`;
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d  = new Date(dateStr);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${d.getFullYear()}`;
  } catch {
    return "";
  }
}

function formatAttendance(attendance) {
  const { daysPresent = 0, daysOpen = 0 } = attendance || {};
  if (!daysOpen) return "0.0%";
  return `${((daysPresent / daysOpen) * 100).toFixed(1)}%`;
}

// ── Data Builder ─────────────────────────────────────────────────────────

function buildReplacementMap(data) {
  const {
    student     = {},
    school      = {},
    attendance  = {},
    performance = {},
  } = data;

  return {
    // Student
    student_name:       student.fullName          || "",
    student_id:         student.studentId         || "",
    admission_number:   student.admissionNumber   || "",
    gender:             student.gender            || "",
    date_of_birth:      formatDate(student.dateOfBirth),

    // Academic context
    class:              data.className            || "",
    stream:             data.stream               || "",
    term:               data.term                 || "",
    academic_year:      data.academicYear         || "",

    // Attendance
    days_present:       String(attendance.daysPresent ?? 0),
    days_absent:        String(attendance.daysAbsent  ?? 0),
    days_open:          String(attendance.daysOpen    ?? 0),
    attendance_percent: formatAttendance(attendance),

    // Performance
    average:            Number(performance.average ?? 0).toFixed(1),
    position:           formatPosition(performance.position),
    total_students:     String(performance.totalStudents ?? 0),
    grade:              performance.grade            || "",
    remark:             performance.remark           || "",
    promotion_status:   performance.promotionStatus  || "",

    // Term results
    term_average:           performance.termAverage != null
                              ? Number(performance.termAverage).toFixed(1)
                              : "",
    term_grade:             performance.termGrade            || "",
    term_remark:            performance.termRemark           || "",
    term_class_position:    performance.termClassPosition != null
                              ? formatPosition(performance.termClassPosition)
                              : "",
    term_total_in_class:    String(performance.termTotalInClass ?? ""),
    sequence_1_average:     performance.sequence1Average != null
                              ? Number(performance.sequence1Average).toFixed(1)
                              : "",
    sequence_2_average:     performance.sequence2Average != null
                              ? Number(performance.sequence2Average).toFixed(1)
                              : "",
    sequence_3_average:     performance.sequence3Average != null
                              ? Number(performance.sequence3Average).toFixed(1)
                              : "",
    sequence_4_average:     performance.sequence4Average != null
                              ? Number(performance.sequence4Average).toFixed(1)
                              : "",
    sequence_5_average:     performance.sequence5Average != null
                              ? Number(performance.sequence5Average).toFixed(1)
                              : "",
    sequence_6_average:     performance.sequence6Average != null
                              ? Number(performance.sequence6Average).toFixed(1)
                              : "",

    // Annual results
    annual_average:         performance.annualAverage != null
                              ? Number(performance.annualAverage).toFixed(1)
                              : "",
    annual_grade:           performance.annualGrade            || "",
    annual_remark:          performance.annualRemark           || "",
    annual_class_position:  performance.annualClassPosition != null
                              ? formatPosition(performance.annualClassPosition)
                              : "",
    annual_total_in_class:  String(performance.annualTotalInClass ?? ""),
    term_1_average:         performance.term1Average != null
                              ? Number(performance.term1Average).toFixed(1)
                              : "",
    term_2_average:         performance.term2Average != null
                              ? Number(performance.term2Average).toFixed(1)
                              : "",
    term_3_average:         performance.term3Average != null
                              ? Number(performance.term3Average).toFixed(1)
                              : "",

    // School
    school_name:        school.name           || "",
    school_motto:       school.motto          || "",
    school_address:     school.address        || "",
    school_phone:       school.phone          || "",
    principal_name:     school.principalName  || "",

    // Staff / remarks
    class_teacher:      data.classTeacher     || "",
    teacher_comment:    data.teacherComment   || "",
    principal_comment:  data.principalComment || "",

    // Dates
    report_date:        formatDate(new Date().toISOString()),
    next_term_date:     data.nextTermDate
                          ? formatDate(data.nextTermDate)
                          : "To be announced",

    // Booleans for conditionals
    isPassing:          (performance.average ?? 0) >= 10,

    // Which of the three cards this is, so a template can gate on it.
    // The seeded layout printed "PROMOTED" whenever a pupil was passing,
    // which put a promotion on sequence and term cards alike — a decision
    // nobody had taken yet, on paper a family keeps. A template needs a
    // flag it can ask about, and isPassing was the only one there was.
    is_annual:          data.reportType === "annual",
    is_term:            data.reportType === "term",
    is_sequence:        data.reportType === "sequence",
    isRepeating:        performance.promotionStatus === "Repeated",

    // Exam / aggregate context
    exam_name:          data.examName                    || "",
    percentage:         performance.percentage != null
                          ? Number(performance.percentage).toFixed(1)
                          : "",
    total_score:        performance.totalScore != null
                          ? String(performance.totalScore)
                          : "",
    subjects_passed:    String(performance.subjectsPassed ?? 0),
    subjects_failed:    String(performance.subjectsFailed ?? 0),

    // Coefficient-aware figures
    total_coefficients: performance.totalCoefficients != null
                          ? String(performance.totalCoefficients)
                          : "",
    weighted_average:   Number(performance.average ?? 0).toFixed(2),

    // Array for each loops
    subjects:           data.subjects || [],
  };
}

// ── Composite Resolvers ───────────────────────────────────────────────────

function resolveSubjectsTable(html, data) {
  if (!html.includes("{{subjects_table}}")) return html;

  const rows = (data.subjects || []).map((s) => {
    const absent = s.isAbsent || s.isExempt;
    const flag   = s.isAbsent ? "ABS" : s.isExempt ? "EXEMPT" : "";
    return `
    <tr>
      <td>${escapeHtml(s.subjectName || s.name || "")}</td>
      <td style="text-align:center">${s.caScore   != null ? s.caScore   : "—"}</td>
      <td style="text-align:center">${s.examScore != null ? s.examScore : "—"}</td>
      <td style="text-align:center"><strong>${
        absent ? flag : s.total != null ? s.total : "—"
      }</strong></td>
      <td style="text-align:center">${
        s.normalizedMark != null && !absent
          ? Number(s.normalizedMark).toFixed(2)
          : "—"
      }</td>
      <td style="text-align:center">${s.coefficient != null ? s.coefficient : 1}</td>
      <td style="text-align:center">${escapeHtml(s.grade  || "—")}</td>
      <td style="text-align:center">${escapeHtml(s.remark || "—")}</td>
      <td style="text-align:center">${formatPosition(s.position)}</td>
    </tr>
  `;
  }).join("");

  const table = `
    <table class="subjects-table" style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th style="text-align:left">Subject</th>
          <th style="text-align:center">CA</th>
          <th style="text-align:center">Exam</th>
          <th style="text-align:center">Total</th>
          <th style="text-align:center">/20</th>
          <th style="text-align:center">Coeff</th>
          <th style="text-align:center">Grade</th>
          <th style="text-align:center">Remark</th>
          <th style="text-align:center">Position</th>
        </tr>
      </thead>
      <tbody>
        ${rows || "<tr><td colspan='9' style='text-align:center'>No subjects</td></tr>"}
      </tbody>
    </table>
  `;

  return html.split("{{subjects_table}}").join(table);
}

function resolveAttendanceTable(html, data) {
  if (!html.includes("{{attendance_table}}")) return html;

  const months = data.attendance?.monthly || [];

  if (!months.length) {
    return html.split("{{attendance_table}}").join(
      "<p><em>No monthly attendance data available.</em></p>"
    );
  }

  const rows = months.map((m) => `
    <tr>
      <td>${escapeHtml(m.month || "")}</td>
      <td style="text-align:center">${m.daysOpen    ?? 0}</td>
      <td style="text-align:center">${m.daysPresent ?? 0}</td>
      <td style="text-align:center">${m.daysAbsent  ?? 0}</td>
    </tr>
  `).join("");

  const table = `
    <table class="attendance-table" style="width:100%;border-collapse:collapse">
      <thead>
        <tr>
          <th>Month</th>
          <th style="text-align:center">Days Open</th>
          <th style="text-align:center">Present</th>
          <th style="text-align:center">Absent</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  return html.split("{{attendance_table}}").join(table);
}

function resolveStudentPhoto(html, data) {
  if (!html.includes("{{student_photo}}")) return html;

  const photoHtml = data.student?.photoBase64
    ? `<img
         src="data:image/jpeg;base64,${data.student.photoBase64}"
         class="student-photo"
         alt="Student Photo"
         style="width:80px;height:100px;object-fit:cover;border:1px solid #ccc"
       />`
    : `<div
         class="student-photo-placeholder"
         style="width:80px;height:100px;border:1px dashed #ccc;
                display:flex;align-items:center;justify-content:center;
                font-size:10px;color:#999"
       >No Photo</div>`;

  return html.split("{{student_photo}}").join(photoHtml);
}

function resolveSchoolLogo(html, data) {
  if (!html.includes("{{school_logo}}")) return html;

  // The logo arrives in one of three shapes and only one of them is base64.
  // This wrapped every one of them in a data:image/png;base64, prefix, so a
  // school whose logo is a stored file — which is what the School model holds,
  // "/uploads/logos/<file>.jpg" — got
  //   src="data:image/png;base64,/uploads/logos/x.jpg"
  // which no browser will load. The card printed with no logo and nothing
  // said why. The web console had already learned this and has a helper for
  // it; the engine had not.
  const raw = data.school?.logoUrl || data.school?.logoBase64 || null;
  const src = !raw ? null
    : /^(https?:|data:|\/)/i.test(String(raw))
      ? String(raw)                                   // a URL or a served path
      : `data:image/png;base64,${raw}`;               // a bare base64 payload

  const logoHtml = src
    ? `<img
         src="${escapeHtml(src)}"
         class="school-logo"
         alt="${escapeHtml(data.school.name || "School Logo")}"
         style="max-height:80px;max-width:200px"
       />`
    : "";

  return html.split("{{school_logo}}").join(logoHtml);
}

function resolveQrCode(html, data) {
  if (!html.includes("{{qr_code}}")) return html;

  // A real verification QR when the caller passed one (the report card route
  // does), otherwise the inert placeholder box so a template preview still
  // shows where the code will sit.
  const qrHtml = data.verify?.qrSvg
    ? `<div class="qr-code" style="width:64px;height:64px">${data.verify.qrSvg}</div>`
    : `
    <div
      class="qr-placeholder"
      data-value="${escapeHtml(data.reportId || "")}"
      style="width:60px;height:60px;border:1px solid #ccc;
             display:flex;align-items:center;justify-content:center;
             font-size:9px;color:#999"
    >QR</div>
  `;

  return html.split("{{qr_code}}").join(qrHtml);
}

// ── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Resolve all placeholders in an HTML template string.
 *
 * @param {string} html  Raw template HTML with {{placeholders}}
 * @param {object} data  Variable data object (see buildReplacementMap)
 * @returns {string}     Fully rendered HTML
 */
function resolvePlaceholders(html, data) {
  // 1. Build the flat replacement map
  const engineData = buildReplacementMap(data);

  // 2. Run the template engine (handles if/each/variables)
  let result = renderTemplate(html, engineData);

  // 3. Handle composite placeholders (tables, images, QR)
  result = resolveSubjectsTable(result, data);
  result = resolveAttendanceTable(result, data);
  result = resolveStudentPhoto(result, data);
  result = resolveSchoolLogo(result, data);
  result = resolveQrCode(result, data);

  return result;
}

/**
 * Scan an HTML string and return every {{placeholder}} found.
 *
 * @param {string} html
 * @returns {string[]}
 */
function scanVariables(html) {
  const found = new Set();
  const re    = /\{\{[\w\s./]+\}\}/g;
  let   match;
  while ((match = re.exec(html)) !== null) {
    found.add(match[0].trim());
  }
  return [...found];
}

// ── Exports ───────────────────────────────────────────────────────────────

/**
 * Every token this engine knows how to resolve.
 *
 * Imports from shared/reportTokens.js so both backend and desktop share
 * one canonical vocabulary.
 *
 * @returns {string[]} bare token names, e.g. ["student_name", "average", …]
 */
function knownTokens() {
  const { knownTokens: sharedKnownTokens } = require("../../shared/reportTokens");
  return sharedKnownTokens();
}

/**
 * Tokens in `html` that this engine does not know.
 *
 * Ignores block forms — {{if x}}, {{each xs}}, {{/each}}, {{#raw}} — and
 * reports only plain {{name}} tokens that would render as literal braces.
 *
 * @param {string} html
 * @returns {string[]} unknown bare names
 */
function unknownTokens(html) {
  const { unknownTokens: sharedUnknownTokens } = require("../../shared/reportTokens");
  return sharedUnknownTokens(html);
}

module.exports = {
  knownTokens,
  unknownTokens,
  resolvePlaceholders,
  scanVariables,
  renderTemplate,
  buildReplacementMap,
  formatDate,
  formatPosition,
  formatAttendance,
  escapeHtml,
};