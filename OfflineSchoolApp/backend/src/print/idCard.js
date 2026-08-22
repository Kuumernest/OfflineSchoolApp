// backend/src/print/idCard.js
"use strict";

/**
 * Student identity cards, laid out for cutting.
 *
 * Sized CR80 — 85.6 × 54 mm, the same as a bank card — so a finished card fits
 * every wallet, lanyard holder and laminating pouch already sold. Ten to an A4
 * sheet in two columns, because a school prints a class at a time on ordinary
 * paper or card stock and cuts them apart; a card printer is a thing most
 * schools here do not have.
 *
 * The photo box prints as a framed blank when a student has no photo on file,
 * which today is all of them. That is deliberate rather than a fallback: the
 * common workflow is print, affix a photograph, laminate. The moment a photo is
 * attached the card uses it instead, with no change to this template.
 *
 * The guardian's telephone number is on the front, not tucked on a back face.
 * The card's job when it matters most is reuniting a lost child with someone,
 * and a number nobody can see without turning the card over does not do that.
 */

const {
  buildDocument, renderHeading, esc, orDash, absoluteLogo,
} = require("./document");

/** Ten per A4: two columns of five. */
const PER_SHEET = 10;

/**
 * The card's colours.
 *
 * Drawn from the app's own primary indigo rather than invented, so a printed
 * card and the console that produced it look like one system. Kept to a band
 * and two accents: a card that is colour end to end costs a fortune in toner
 * across a class of forty and reads as a leaflet rather than an identity
 * document.
 */
const INK       = "#14181f";
const BRAND     = "#3B4996";
const BRAND_DEEP = "#2B3670";
const TINT      = "#F0F4FF";
const MUTED     = "#55607a";

const CARD_CSS = `
  /* Cards are cut from the sheet, so the page margin is generous enough to
     survive a guillotine that is a millimetre out. */
  @page { size: A4; margin: 10mm 12mm; }

  body {
    margin: 0;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #14181f;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .sheet {
    display: grid;
    grid-template-columns: repeat(2, 85.6mm);
    grid-auto-rows: 54mm;
    gap: 4mm 6mm;
    justify-content: center;
  }

  /* Every sheet after the first starts on a new page. */
  .sheet + .sheet { page-break-before: always; }

  .card {
    width: 85.6mm;
    height: 54mm;
    box-sizing: border-box;
    /* Dashed grey is the CUT line — deliberately not the brand colour, so the
       guillotine guide is never mistaken for part of the design. */
    border: 0.3mm dashed #9aa3b2;
    border-radius: 2mm;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    page-break-inside: avoid;
    position: relative;
    background: #fff;
  }

  /* ── Masthead: the coloured band ── */
  .card__top {
    display: flex; align-items: center; gap: 2mm;
    background: ${BRAND};
    color: #fff;
    padding: 1.8mm 3mm;
    border-bottom: 0.6mm solid ${BRAND_DEEP};
  }
  .card__logo   {
    width: 8mm; height: 8mm; object-fit: contain; flex: none;
    background: #fff; border-radius: 1mm; padding: 0.4mm;
  }
  .card__school { font-size: 7.4pt; font-weight: 700; text-transform: uppercase;
                  letter-spacing: 0.02em; line-height: 1.1; color: #fff; }
  .card__kind   { font-size: 5.2pt; letter-spacing: 0.14em; text-transform: uppercase;
                  color: #ffffffc0; margin-top: 0.3mm; }

  /* ── Body ── */
  .card__body {
    display: flex; gap: 3mm; flex: 1; min-height: 0;
    padding: 2mm 3mm 0;
  }

  .photo {
    width: 20mm; height: 26mm; flex: none;
    border: 0.4mm solid ${BRAND};
    border-radius: 1mm;
    object-fit: cover;
    background: ${TINT};
  }
  /* The blank a photograph is pasted into. */
  .photo--empty {
    display: flex; align-items: center; justify-content: center;
    font-size: 5pt; color: ${BRAND}; text-align: center; line-height: 1.3;
    padding: 1mm;
  }

  .fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.9mm; }

  /* The QR is scanned at the gate, so it is sized for a cheap camera at arm's
     length rather than for looks: below about 14mm a phone struggles in the
     shade of a doorway. */
  .qr      { width: 15mm; height: 15mm; flex: none; }
  .qr svg  { width: 100%; height: 100%; display: block; }
  .field__label { font-size: 4.8pt; text-transform: uppercase; letter-spacing: 0.08em;
                  color: ${BRAND}; font-weight: 700; }
  .field__value { font-size: 7.6pt; font-weight: 700; line-height: 1.15; color: ${INK};
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .field__value--name { font-size: 8.6pt; }
  .field__value--mono { font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }

  /* ── Signatures ── */
  .card__signs {
    display: flex; gap: 3mm; align-items: flex-end;
    padding: 0 3mm 0.6mm;
  }
  .sign      { flex: 1; min-width: 0; }
  .sign__line {
    border-bottom: 0.25mm solid ${MUTED};
    height: 3.4mm;
  }
  .sign__label {
    font-size: 4.4pt; color: ${MUTED}; margin-top: 0.4mm;
    text-transform: uppercase; letter-spacing: 0.05em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* ── Foot: the tinted contact strip ── */
  .card__foot {
    background: ${TINT};
    border-top: 0.3mm solid ${BRAND};
    padding: 1mm 3mm;
    font-size: 4.9pt; color: ${BRAND_DEEP};
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 600;
  }

  @media screen {
    body { padding: 14px; background: #eceef3; }
    .sheet { background: #fff; padding: 10mm 12mm; margin: 0 auto 14px;
             box-shadow: 0 1px 3px rgba(0,0,0,.18); width: max-content; }
    .card { background: #fff; }
  }
`;

const renderCard = ({ student, school, labels, origin, validUntil }) => {
  const logo  = absoluteLogo(school.logo, origin);
  const photo = absoluteLogo(student.photoUrl, origin);

  return `
    <div class="card">
      <div class="card__top">
        ${logo ? `<img class="card__logo" src="${esc(logo)}" alt="" />` : ""}
        <div style="min-width:0">
          <div class="card__school">${orDash(school.name)}</div>
          <div class="card__kind">${esc(labels.idCard)}</div>
        </div>
      </div>

      <div class="card__body">
        ${photo
          ? `<img class="photo" src="${esc(photo)}" alt="" />`
          : `<div class="photo photo--empty">${esc(labels.affixPhoto)}</div>`}

        <div class="fields">
          <div>
            <div class="field__label">${esc(labels.student)}</div>
            <div class="field__value field__value--name">${orDash(student.name)}</div>
          </div>
          <div>
            <div class="field__label">${esc(labels.admissionNo)}</div>
            <div class="field__value field__value--mono">${orDash(student.enrollmentNo)}</div>
          </div>
          <div>
            <div class="field__label">${esc(labels.class)}</div>
            <div class="field__value">${orDash(student.className)}</div>
          </div>
          <div style="display:flex;align-items:flex-end;gap:2mm">
            <div style="flex:1;min-width:0">
              <div class="field__label">${esc(labels.validUntil)}</div>
              <div class="field__value field__value--mono">${orDash(validUntil)}</div>
            </div>
            ${student.qrSvg ? `<div class="qr">${student.qrSvg}</div>` : ""}
          </div>
        </div>
      </div>

      <!-- Two signatures: the holder's and the school's. A card the student has
           not signed proves only that the school printed it; the pair is what
           makes it theirs and lets a challenge be checked against the ink. -->
      <div class="card__signs">
        <div class="sign">
          <div class="sign__line"></div>
          <div class="sign__label">${esc(labels.studentSignature)}</div>
        </div>
        <div class="sign">
          <div class="sign__line"></div>
          <div class="sign__label">${esc(labels.headTeacher)}</div>
        </div>
      </div>

      <div class="card__foot">
        ${student.guardianPhone
          ? `${esc(labels.ifFound)} ${esc(student.guardianPhone)}`
          : (school.phone ? `${esc(labels.ifFound)} ${esc(school.phone)}` : "&nbsp;")}
      </div>
    </div>
  `;
};

const buildIdCardsHtml = ({ data, labels, printedOn, origin }) => {
  const { school, students, validUntil } = data;

  // Chunked into sheets rather than left to flow, so the page break lands
  // between cards. A card split across two pages is scrap paper.
  const sheets = [];
  for (let i = 0; i < students.length; i += PER_SHEET) {
    const chunk = students.slice(i, i + PER_SHEET);
    sheets.push(`
      <div class="sheet">
        ${chunk.map((student) =>
          renderCard({ student, school, labels, origin, validUntil })
        ).join("")}
      </div>
    `);
  }

  const body = students.length
    ? sheets.join("")
    : `<p style="font-size:11px;color:#55607a">${esc(labels.emptyClass)}</p>`;

  return buildDocument({
    title: `${labels.idCard} — ${data.class?.name ?? ""}`,
    body,
    // No page footer: it would print across the cards on the bottom row.
  }).replace(
    // The shared shell carries the A4 document stylesheet. Cards need their own
    // page setup and grid, appended so it wins on equal specificity.
    "</style>",
    `</style><style>${CARD_CSS}</style>`
  );
};

module.exports = { buildIdCardsHtml, PER_SHEET };
