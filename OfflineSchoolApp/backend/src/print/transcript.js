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
  buildDocument, renderHeading, renderFacts, renderSignatures, esc, orDash,
} = require("./document");

const num = (v) =>
  v === null || v === undefined ? "—" : String(Math.round(v * 10) / 10);

const yearBlock = (y, labels) => {
  const heading = `
    <div class="section__title">
      ${esc(y.academicYear)}
      ${y.className ? ` &nbsp;·&nbsp; ${esc(y.className)}` : ""}
      ${y.outcome ? ` &nbsp;·&nbsp; ${esc(y.outcome)}` : ""}
    </div>
  `;

  if (!y.terms || !y.terms.length) {
    return `<div class="section">${heading}<p class="muted">${esc(labels.noResults)}</p></div>`;
  }

  const termRows = y.terms.map((tm) => `
    <tr>
      <td>${orDash(tm.term)}</td>
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
            <th class="num">${esc(labels.average)}</th>
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

const buildTranscriptHtml = ({ data, labels, printedOn, origin }) => {
  const { school, student, years, overall } = data;

  const body = `
    <div class="sheet">
      ${renderHeading(school, origin)}
      <h2 class="doc-title">${esc(labels.transcript)}</h2>
      <div class="doc-sub">${orDash(student.name)}</div>

      ${renderFacts([
        { label: labels.student,     value: student.name ?? "" },
        { label: labels.admissionNo, value: student.enrollmentNo ?? "" },
        { label: labels.gender,      value: student.gender ?? "" },
        { label: labels.dateOfBirth, value: student.dateOfBirth ?? "" },
        { label: labels.status,      value: student.status },
      ])}

      ${renderFacts([
        { label: labels.yearsOnRecord,  value: String(overall.yearsOnRecord) },
        { label: labels.overallAverage, value: num(overall.average) },
      ])}

      ${years.length === 0
        ? `<p class="muted">${esc(labels.emptyRecord)}</p>`
        : years.map((y) => yearBlock(y, labels)).join("")}

      ${renderSignatures([labels.registrar, labels.headTeacher])}

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

module.exports = { buildTranscriptHtml };
