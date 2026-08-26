// backend/src/print/idCard.js
"use strict";

/**
 * Student identity cards, laid out for cutting.
 *
 * Navy, cream and gold, following the school's own design. The proportions of
 * that design are within 1.4% of CR80 — 85.6 × 54 mm, bank-card size — so it
 * translates almost exactly, and a finished card fits every wallet, lanyard
 * holder and laminating pouch already sold.
 *
 * Ten to an A4 sheet in two columns, because a school prints a class at a time
 * on card stock and cuts them apart; a card printer is a thing most schools
 * here do not have.
 *
 * Type sizes are chosen for 54 mm of real card rather than scaled down from the
 * on-screen mockup. Scaling 900 px linearly would put the field labels at about
 * 4 pt, which is under what a laser printer resolves cleanly on coated stock.
 *
 * The photo box prints as a framed blank when a student has no photo on file.
 * That is deliberate rather than a fallback: the common workflow is print,
 * affix a photograph, laminate. The moment a photo is attached the card uses it
 * instead, with no change here.
 */

const {
  buildDocument, renderHeading, esc, orDash, absoluteLogo,
} = require("./document");

/**
 * Ten per A4: two columns of five.
 *
 * The vertical arithmetic is tight and was wrong before: five 54 mm rows with
 * 4 mm gaps inside 10 mm margins needs 286 mm of a 277 mm column, so the fifth
 * row was silently pushed onto a new page and a "sheet of ten" printed as two.
 * 8 mm margins with a 2 mm gap needs 278 mm of 281 mm, which fits with room for
 * a guillotine that is a millimetre out.
 */
const PER_SHEET   = 10;
const PAGE_MARGIN = 8;   // mm
const ROW_GAP     = 2;   // mm

// The palette, from the school's design.
const NAVY       = "#1b2945";
const NAVY_DARK  = "#121c30";
const CREAM      = "#f4f1e9";
const GOLD       = "#bd9b5e";
const GOLD_LIGHT = "#d6bb8c";

/**
 * Gold is a gradient, not a flat fill.
 *
 * A single ochre rectangle reads as brown on paper. The light-dark-light ramp
 * is what the eye interprets as metal, and it survives a mono printer as a
 * legible band of tone rather than a muddy block.
 */
const GOLD_FRAME =
  "linear-gradient(135deg,#f8eba5 0%,#d4af37 20%,#8a6327 50%,#d4af37 80%,#f8eba5 100%)";

/**
 * Google Fonts, with real fallbacks behind every one.
 *
 * The link only resolves when the machine printing has a connection. That is
 * usually true — cards are printed at a desk, not at the gate — but this is an
 * offline-first app and the honest assumption is that it sometimes will not be.
 * Each family therefore names a generic that keeps the card looking deliberate
 * rather than defaulting to whatever the renderer picks first.
 */
const FONT_LINK =
  '<link href="https://fonts.googleapis.com/css2?' +
  "family=Cinzel:wght@500;700&" +
  "family=Montserrat:wght@500;600;700&" +
  "family=Playfair+Display:wght@600;700&" +
  "family=Great+Vibes&display=swap" +
  '" rel="stylesheet" />';

const F_HEADER = '"Cinzel", "Trajan Pro", Georgia, serif';
const F_LABEL  = '"Montserrat", "Segoe UI", Helvetica, Arial, sans-serif';
const F_VALUE  = '"Playfair Display", Georgia, "Times New Roman", serif';
const F_SCRIPT = '"Great Vibes", "Segoe Script", cursive';

const CARD_CSS = `
  @page { size: A4; margin: ${PAGE_MARGIN}mm 10mm; }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: ${F_LABEL};
    background: #fff;
    /* Printers drop background colour by default. Without this the navy
       header, the gold frames and the whole design print as white paper. */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .sheet {
    display: grid;
    grid-template-columns: repeat(2, 85.6mm);
    grid-auto-rows: 54mm;
    gap: ${ROW_GAP}mm 4mm;
    justify-content: center;
  }
  .sheet + .sheet { page-break-before: always; }

  /* ── The card ──────────────────────────────────────────────────────────── */
  .card {
    width: 85.6mm; height: 54mm;
    page-break-inside: avoid;
    /* The gold edge is the card's own border, so the cut line IS the design —
       a separate dashed guide would print inside the finished card. */
    background: ${GOLD_FRAME};
    border-radius: 2.2mm;
    padding: 0.35mm;
    overflow: hidden;
  }

  .card__inner {
    width: 100%; height: 100%;
    background: ${CREAM};
    border-radius: 1.9mm;
    overflow: hidden;
    display: flex; flex-direction: column;
    position: relative;
  }

  /* ── Header ────────────────────────────────────────────────────────────── */
  .card__head {
    background: ${NAVY};
    height: 11.5mm;
    display: flex; align-items: center; gap: 2.4mm;
    padding: 0 3mm;
    border-bottom: 0.35mm solid #5a4b31;
    flex: none;
  }
  .card__crest {
    width: 7.4mm; height: 7.4mm; flex: none;
    border: 0.3mm solid ${GOLD};
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
    background: ${NAVY};
  }
  .card__crest img { width: 6.2mm; height: 6.2mm; object-fit: contain; }
  .card__crest span {
    width: 5.4mm; height: 5.4mm;
    border: 0.2mm dashed ${GOLD}; border-radius: 50%;
  }
  /* Tiered for the same reason the name is: a school called "Collège Bilingue
     de la Sainte Trinité de Yaoundé" should read its own name off the card,
     not "…de la Sainte Trinité de…". */
  .card__school {
    font-family: ${F_HEADER};
    font-weight: 700;
    letter-spacing: 0.04em;
    color: ${GOLD_LIGHT};
    line-height: 1.05;
    text-transform: uppercase;
    overflow: hidden;
  }
  .card__school.s1 { font-size: 7.4pt; white-space: nowrap; }
  .card__school.s2 { font-size: 6.2pt; white-space: nowrap; }
  .card__school.s3 {
    font-size: 5.4pt;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  }
  .card__kind {
    font-family: ${F_HEADER};
    font-weight: 500;
    font-size: 4.6pt;
    letter-spacing: 0.16em;
    color: ${GOLD};
    text-transform: uppercase;
    margin-top: 0.4mm;
  }

  /* ── Body ──────────────────────────────────────────────────────────────── */
  .card__body {
    flex: 1; min-height: 0;
    display: flex; align-items: center; gap: 2.6mm;
    padding: 2mm 3mm 1mm;
    position: relative;
  }

  /* A faint crest behind the details. Kept to 8% so it reads as watermark
     rather than as a smudge over the name. */
  .card__watermark {
    position: absolute; top: 50%; left: 58%;
    transform: translate(-50%, -50%);
    width: 26mm; height: 26mm;
    background-image: radial-gradient(circle, transparent 40%, ${GOLD} 45%, transparent 50%);
    opacity: 0.08;
    pointer-events: none;
  }

  /* The metallic frame, shared by the photo and the QR. */
  .frame {
    background: ${GOLD_FRAME};
    padding: 0.45mm;
    border-radius: 1.2mm;
    flex: none;
  }

  .photo {
    width: 19mm; height: 25mm;
    object-fit: cover;
    border-radius: 0.9mm;
    display: block;
    background: #e8e3d6;
  }
  .photo--empty {
    display: flex; align-items: center; justify-content: center;
    text-align: center; line-height: 1.25;
    font-size: 4pt; color: ${NAVY}; padding: 1mm;
    font-family: ${F_LABEL}; font-weight: 500;
  }

  .fields { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1.1mm;
            position: relative; }
  .label {
    font-family: ${F_LABEL};
    font-weight: 600;
    font-size: 4.2pt;
    letter-spacing: 0.14em;
    color: ${GOLD};
    text-transform: uppercase;
  }
  .value {
    font-family: ${F_VALUE};
    font-weight: 600;
    font-size: 7.2pt;
    color: ${NAVY};
    line-height: 1.1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /**
   * The name is never truncated.
   *
   * An ellipsis is acceptable on a class label; on the name field of an
   * identity document it is a defect — "Ngwanyam Fru Bern…" identifies nobody,
   * and it would be laminated and handed to a child before anybody noticed.
   * So the name steps down through these sizes and wraps to a second line
   * rather than losing characters.
   *
   * The thresholds are character counts because this is rendered server-side
   * with no browser to measure in. They are set against the ~40 mm the fields
   * column actually has between the photo and the QR.
   */
  .value--name {
    font-weight: 700;
    white-space: normal;
    overflow-wrap: break-word;
    line-height: 1.06;
    /* Two lines is the ceiling: a third would push into the footer. */
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  }
  .value--name.n1 { font-size: 9.4pt; }
  .value--name.n2 { font-size: 8.2pt; }
  .value--name.n3 { font-size: 7.2pt; }
  .value--name.n4 { font-size: 6.2pt; }

  /* Sized for a cheap camera at arm's length in the shade of a doorway —
     below about 13mm a phone starts hunting for focus. */
  .qr { width: 13.5mm; height: 13.5mm; }
  .qr svg { width: 100%; height: 100%; display: block; background: #fff;
            border-radius: 0.7mm; }

  /* ── Footer ────────────────────────────────────────────────────────────── */
  .card__foot {
    flex: none;
    display: flex; align-items: flex-end; justify-content: space-between;
    gap: 2mm; padding: 0 3mm 1.2mm;
  }
  .sig { display: flex; flex-direction: column; width: 22mm; }
  .sig--right { align-items: flex-end; text-align: right; }
  .sig__script {
    font-family: ${F_SCRIPT};
    font-size: 10pt; color: ${GOLD};
    line-height: 0.75;
    margin-bottom: -0.2mm;
    height: 3.2mm;
    overflow: hidden;
  }
  .sig__line  { height: 0.3mm; background: ${NAVY}; width: 100%; margin-bottom: 0.5mm; }
  .sig__label {
    font-family: ${F_LABEL}; font-weight: 600;
    font-size: 3.8pt; letter-spacing: 0.1em; color: ${GOLD};
    text-transform: uppercase;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .validity { display: flex; flex-direction: column; align-items: center; flex: none; }
  .validity__label {
    font-family: ${F_LABEL}; font-weight: 600;
    font-size: 3.8pt; letter-spacing: 0.1em; color: ${NAVY};
    text-transform: uppercase;
  }
  .validity__date {
    font-family: ${F_VALUE}; font-weight: 600;
    font-size: 6pt; color: ${NAVY}; white-space: nowrap;
  }

  /* ── Bottom strip ──────────────────────────────────────────────────────── */
  .card__strip {
    flex: none; height: 3.4mm;
    background: linear-gradient(90deg,#111a2d 0%,#1a2b4c 50%,#111a2d 100%);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 2mm; overflow: hidden;
  }
  .card__strip span {
    font-family: ${F_HEADER};
    font-size: 4pt; color: ${CREAM}; opacity: 0.16;
    line-height: 1;
  }

  @media screen {
    body { padding: 16px; background: #d1d5db; }
    .sheet {
      background: #fff; padding: ${PAGE_MARGIN}mm 10mm;
      margin: 0 auto 16px; width: max-content;
      box-shadow: 0 4px 18px rgba(0,0,0,.25);
    }
  }
`;

/**
 * Which size band a name needs.
 *
 * Measured against the fields column rather than the whole card: the photo and
 * the QR take roughly half the width, leaving about 40 mm for the text.
 */
/** The header has about 70 mm once the crest is placed. */
const schoolTier = (name) => {
  const length = String(name ?? "").length;
  if (length <= 30) return "s1";
  if (length <= 40) return "s2";
  return "s3";
};

const nameTier = (name) => {
  const length = String(name ?? "").length;
  if (length <= 22) return "n1";
  if (length <= 30) return "n2";
  if (length <= 44) return "n3";
  return "n4";
};

/** The faint repeating crest along the bottom edge. */
const STRIP_MARKS = Array.from({ length: 22 }, () => "<span>&#10022;</span>").join("");

const renderCard = ({ student, school, labels, origin, academicYear }) => {
  const logo  = absoluteLogo(school.logo, origin);
  const photo = absoluteLogo(student.photoUrl, origin);

  return `
    <div class="card">
      <div class="card__inner">

        <div class="card__head">
          <div class="card__crest">
            ${logo ? `<img src="${esc(logo)}" alt="" />` : "<span></span>"}
          </div>
          <div style="min-width:0">
            <div class="card__school ${schoolTier(school.name)}">${orDash(school.name)}</div>
            <div class="card__kind">${esc(labels.idCard)}</div>
          </div>
        </div>

        <div class="card__body">
          <div class="card__watermark"></div>

          <div class="frame">
            ${photo
              ? `<img class="photo" src="${esc(photo)}" alt="" />`
              : `<div class="photo photo--empty">${esc(labels.affixPhoto)}</div>`}
          </div>

          <div class="fields">
            <div>
              <div class="label">${esc(labels.student)}</div>
              <div class="value value--name ${nameTier(student.name)}">${orDash(student.name)}</div>
            </div>
            <div>
              <div class="label">${esc(labels.admissionNo)}</div>
              <div class="value">${orDash(student.enrollmentNo)}</div>
            </div>
            <div>
              <div class="label">${esc(labels.class)}</div>
              <div class="value">${orDash(student.className)}</div>
            </div>
          </div>

          ${student.qrSvg ? `<div class="frame"><div class="qr">${student.qrSvg}</div></div>` : ""}
        </div>

        <div class="card__foot">
          <div class="sig">
            <div class="sig__line"></div>
            <div class="sig__label">${esc(labels.studentSignature)}</div>
          </div>

          <div class="validity">
            <div class="validity__label">${esc(labels.academicYear)}</div>
            <div class="validity__date">${orDash(academicYear)}</div>
          </div>

          <div class="sig sig--right">
            <div class="sig__script">${esc(labels.headTeacher)}</div>
            <div class="sig__line"></div>
            <div class="sig__label">${esc(labels.headTeacher)}</div>
          </div>
        </div>

        <div class="card__strip">${STRIP_MARKS}</div>
      </div>
    </div>
  `;
};

const buildIdCardsHtml = ({ data, labels, printedOn, origin }) => {
  const { school, students, academicYear } = data;

  // Chunked into sheets rather than left to flow, so a page break can only
  // land between cards. A card split across two pages is scrap paper.
  const sheets = [];
  for (let i = 0; i < students.length; i += PER_SHEET) {
    sheets.push(`
      <div class="sheet">
        ${students.slice(i, i + PER_SHEET)
          .map((student) => renderCard({ student, school, labels, origin, academicYear }))
          .join("")}
      </div>
    `);
  }

  const body = students.length
    ? sheets.join("")
    : `<p style="font-family:${F_LABEL};font-size:11px;color:#55607a">${esc(labels.emptyClass)}</p>`;

  return buildDocument({
    title: `${labels.idCard} — ${data.class?.name ?? ""}`,
    body,
    // No page footer: it would print across the cards on the bottom row.
  }).replace(
    // The shared shell carries the A4 document stylesheet. Cards need their own
    // page setup and grid, appended so it wins on equal specificity — and the
    // font link goes in with it.
    "</style>",
    `</style>${FONT_LINK}<style>${CARD_CSS}</style>`
  );
};

module.exports = { buildIdCardsHtml, PER_SHEET, PAGE_MARGIN, ROW_GAP };
