// backend/src/print/classList.js
"use strict";

/**
 * A class list, in the three forms a school actually uses it.
 *
 * The variants are not decoration. The sheet pinned to a classroom wall, the
 * sheet carried round for a headcount and the sheet used to phone parents are
 * three different pieces of paper — and a register with no blank boxes cannot
 * be ticked, which is the only thing it is for.
 */

const {
  buildDocument, renderHeading, renderFacts, renderSignatures, esc, orDash,
} = require("./document");

/** Blank columns on a register — a fortnight of school days. */
const REGISTER_COLUMNS = 10;

const VARIANTS = ["plain", "register", "contacts"];

const buildClassListHtml = ({ data, variant, labels, printedOn, origin }) => {
  const kind = VARIANTS.includes(variant) ? variant : "plain";
  const { school, students, counts } = data;

  const title =
    kind === "register" ? labels.register
    : kind === "contacts" ? labels.contacts
    : labels.classList;

  const headCells =
    kind === "register"
      ? `<th class="num">${esc(labels.no)}</th>
         <th>${esc(labels.student)}</th>
         ${Array.from({ length: REGISTER_COLUMNS }, () => `<th class="tick"></th>`).join("")}`
      : kind === "contacts"
      ? `<th class="num">${esc(labels.no)}</th>
         <th>${esc(labels.student)}</th>
         <th>${esc(labels.admissionNo)}</th>
         <th>${esc(labels.guardian)}</th>
         <th>${esc(labels.phone)}</th>`
      : `<th class="num">${esc(labels.no)}</th>
         <th>${esc(labels.student)}</th>
         <th>${esc(labels.admissionNo)}</th>
         <th class="num">${esc(labels.gender)}</th>
         <th class="num">${esc(labels.dateOfBirth)}</th>`;

  const row = (s, i) => {
    const index = `<td class="idx">${i + 1}</td>`;
    const name  = `<td>${orDash(s.name)}</td>`;

    if (kind === "register") {
      return `<tr>${index}${name}${
        Array.from({ length: REGISTER_COLUMNS }, () => `<td class="tick"></td>`).join("")
      }</tr>`;
    }
    if (kind === "contacts") {
      return `<tr>${index}${name}` +
        `<td>${orDash(s.enrollmentNo)}</td>` +
        `<td>${orDash(s.guardianName)}</td>` +
        `<td>${orDash(s.guardianPhone)}</td></tr>`;
    }
    return `<tr>${index}${name}` +
      `<td>${orDash(s.enrollmentNo)}</td>` +
      `<td class="num">${orDash(s.gender)}</td>` +
      `<td class="num">${orDash(s.dateOfBirth)}</td></tr>`;
  };

  // `unspecified` only appears when it is non-zero, so a school that records
  // gender for everyone never sees a zero it has to stop and think about.
  const countFacts = [
    { label: labels.total,  value: String(counts.total) },
    { label: labels.male,   value: String(counts.male) },
    { label: labels.female, value: String(counts.female) },
    ...(counts.unspecified > 0
      ? [{ label: labels.unspecified, value: String(counts.unspecified) }]
      : []),
  ];

  const body = `
    <div class="sheet">
      ${renderHeading(school, origin)}
      <h2 class="doc-title">${esc(title)}</h2>
      <div class="doc-sub">${esc(data.class.name)}</div>

      ${renderFacts([
        { label: labels.class,        value: data.class.name },
        { label: labels.academicYear, value: school.academicYear ?? "" },
        { label: labels.term,         value: school.currentTerm ?? "" },
        ...countFacts,
      ])}

      ${students.length === 0
        ? `<p class="muted">${esc(labels.emptyClass)}</p>`
        : `<table>
             <thead><tr>${headCells}</tr></thead>
             <tbody>${students.map(row).join("")}</tbody>
           </table>`}

      ${renderSignatures([labels.teacher, labels.headTeacher])}
    </div>
  `;

  return buildDocument({
    title: `${title} — ${data.class.name}`,
    body,
    footerLeft:  `${labels.printedOn} ${printedOn}`,
    footerRight: school.name ?? "",
  });
};

module.exports = { buildClassListHtml, VARIANTS, REGISTER_COLUMNS };
