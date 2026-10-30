// backend/src/print/transcript.js
"use strict";

/**
 * A student's full academic record, year by year.
 *
 * This is the document the Enrollment history exists for. `student.classId`
 * says only where a student is now, so before that history was captured a
 * transcript would print the current class beside a result from three years
 * ago and look entirely plausible.
 *
 * A year with no published results still prints, showing the class and the
 * outcome. Dropping it would leave a hole in the record that reads as "this
 * student was not here" — a different and worse claim than "no marks were
 * published that year".
 */

const {
  buildDocument, renderHeading, renderFacts, renderSignatures, renderVerify,
  esc, orDash,
} = require("./document");

const num = (v) =>
  v === null || v === undefined ? "—" : String(Math.round(v * 10) / 10);

/** 02/04/2011 — DD/MM/YYYY, as every date in the app is written (shared/dateFormat). */
const dayOf = (value) => {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

/** A stored value as a word: "female" → "Female" / "Féminin"; unknown values capitalised. */
const wordFor = (map, value) => {
  if (value === null || value === undefined || value === "") return "";
  return map?.[value] ?? String(value).charAt(0).toUpperCase() + String(value).slice(1);
};

/**
 * "1st Term · Sequence 1". A year holds one row per sequence, and two rows
 * that both said "Term 1" left the reader to guess which was which.
 */
const periodLabel = (tm, labels) => {
  const n = Number(String(tm.term ?? "").replace(/\D/g, ""));
  const term = labels.termNames?.[n - 1] ?? (tm.term != null ? String(tm.term) : null);
  const seq  = tm.sequenceNumber != null ? `${labels.sequenceWord} ${tm.sequenceNumber}` : null;
  return [term, seq].filter(Boolean).join(" · ") || "—";
};

const yearBlock = (y, labels) => {
  const heading = `
    <div class="section__title">
      ${esc(y.academicYear)}
      ${y.className ? ` &nbsp;·&nbsp; ${esc(y.className)}` : ""}
      ${y.outcome ? ` &nbsp;·&nbsp; ${esc(wordFor(labels.outcomeValues, y.outcome))}` : ""}
    </div>
  `;

  if (!y.terms || !y.terms.length) {
    return `<div class="section">${heading}<p class="muted">${esc(labels.noResults)}</p></div>`;
  }

  const termRows = y.terms.map((tm) => `
    <tr>
      <td>${esc(periodLabel(tm, labels))}</td>
      <td class="num">${num(tm.average)}</td>
      <td class="num ${tm.isPassing ? "pass" : "fail"}">${orDash(tm.overallGrade)}</td>
      <td class="num">${
        tm.classPosition
          ? `${esc(tm.classPosition)}${tm.totalInClass ? ` / ${esc(tm.totalInClass)}` : ""}`
          : "—"
      }</td>
    </tr>
  `).join("");

  // Subjects come from the LAST term of the year: a transcript records the
  // standing a student finished the year at, and stacking every term's subject
  // table would spread one year over several pages.
  const last = y.terms[y.terms.length - 1];
  const subjectRows = (last.subjects ?? []).map((s) => `
    <tr>
      <td>${orDash(s.subjectName)}</td>
      <td class="num">${num(s.normalizedMark)}</td>
      <td class="num ${s.isPassing ? "pass" : "fail"}">${orDash(s.grade)}</td>
    </tr>
  `).join("");

  return `
    <div class="section">
      ${heading}
      <table>
        <thead>
          <tr>
            <th>${esc(labels.term)}</th>
            <th class="num">${esc(labels.average)} ${esc(labels.outOf20 ?? "/20")}</th>
            <th class="num">${esc(labels.grade)}</th>
            <th class="num">${esc(labels.position)}</th>
          </tr>
        </thead>
        <tbody>${termRows}</tbody>
      </table>

      ${subjectRows ? `
        <table style="margin-top:6px">
          <thead>
            <tr>
              <th>${esc(labels.subject)}</th>
              <th class="num">${esc(labels.mark)}</th>
              <th class="num">${esc(labels.grade)}</th>
            </tr>
          </thead>
          <tbody>${subjectRows}</tbody>
        </table>` : ""}
    </div>
  `;
};

const buildTranscriptHtml = ({ data, labels, printedOn, origin, verify }) => {
  const { school, student, years, overall } = data;

  const body = `
    <div class="sheet">
      ${renderHeading(school, origin)}
      <h2 class="doc-title">${esc(labels.transcript)}</h2>
      <div class="doc-sub">${orDash(student.name)}</div>

      ${renderFacts([
        { label: labels.student,     value: student.name ?? "" },
        { label: labels.admissionNo, value: student.enrollmentNo ?? "" },
        { label: labels.gender,      value: wordFor(labels.sexValues, student.gender) },
        { label: labels.dateOfBirth, value: dayOf(student.dateOfBirth) },
        { label: labels.status,      value: wordFor(labels.statusValues, student.status) },
      ])}

      ${renderFacts([
        { label: labels.yearsOnRecord,  value: String(overall.yearsOnRecord) },
        { label: labels.overallAverage,
          value: overall.average == null ? "—" : `${num(overall.average)} ${labels.outOf20 ?? "/20"}` },
      ])}

      ${years.length === 0
        ? `<p class="muted">${esc(labels.emptyRecord)}</p>`
        : years.map((y) => yearBlock(y, labels)).join("")}

      ${renderSignatures([labels.registrar, labels.headTeacher])}

      ${renderVerify(verify, labels)}

      <p class="muted" style="margin-top:12px;font-size:8.5px">${esc(labels.disclaimer)}</p>
    </div>
  `;

  return buildDocument({
    title: `${labels.transcript} — ${student.name ?? student.enrollmentNo ?? ""}`,
    body,
    footerLeft:  `${labels.printedOn} ${printedOn}`,
    footerRight: school.name ?? "",
  });
};

module.exports = { buildTranscriptHtml, dayOf, periodLabel };
