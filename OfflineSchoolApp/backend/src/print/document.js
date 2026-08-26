// backend/src/print/document.js
"use strict";

/**
 * The shared skeleton for everything the school prints.
 *
 * This lives on the server, not in the clients, for one reason: there are two
 * clients. A browser prints HTML and the phone turns HTML into a PDF through
 * expo-print, so both want the same string — and a copy of these templates in
 * each project is a copy that drifts. The first fix to a column width lands in
 * one and not the other, and nobody notices until two teachers compare printouts
 * of the same class.
 *
 * The clients keep what is genuinely theirs: how to put a string in front of a
 * printer.
 */

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** An em dash for anything missing, so a gap reads as a gap and not an error. */
const orDash = (value) => {
  const s = String(value ?? "").trim();
  return s ? esc(s) : "—";
};

/**
 * Absolute URL for the school logo.
 *
 * A printed page is rendered from a blob, a detached document or a PDF engine,
 * none of which have a base URL — so a relative `/uploads/...` path resolves
 * against nothing and the logo silently vanishes from every sheet.
 */
const absoluteLogo = (logo, origin) => {
  if (!logo) return null;
  if (/^(https?:|data:)/i.test(logo)) return logo;
  if (!origin) return null;
  return logo.startsWith("/") ? `${origin}${logo}` : `${origin}/${logo}`;
};

const PAGE_CSS = `
  /* A4 with a margin that survives most printers' unprintable edge. */
  @page { size: A4; margin: 14mm 12mm; }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 11px;
    line-height: 1.45;
    color: #14181f;
    background: #fff;
    /* Printers drop background colours by default; without this every shaded
       header row prints plain white and the table loses the structure that
       makes it readable across a page of forty names. */
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  h1, h2, h3 { margin: 0; font-weight: 700; }

  .head {
    display: flex; align-items: center; gap: 14px;
    padding-bottom: 10px; margin-bottom: 12px;
    border-bottom: 2px solid #14181f;
  }
  .head__logo { width: 62px; height: 62px; object-fit: contain; flex: none; }
  .head__text { flex: 1; min-width: 0; }
  .head__name { font-size: 17px; letter-spacing: 0.02em; text-transform: uppercase; }
  .head__motto { font-style: italic; color: #55607a; font-size: 10px; margin-top: 1px; }
  .head__meta { color: #55607a; font-size: 10px; margin-top: 3px; }

  .doc-title {
    text-align: center; font-size: 13px; text-transform: uppercase;
    letter-spacing: 0.09em; margin-bottom: 2px;
  }
  .doc-sub { text-align: center; color: #55607a; font-size: 10px; margin-bottom: 12px; }

  .facts {
    display: flex; flex-wrap: wrap; gap: 4px 26px;
    margin-bottom: 12px; padding: 8px 10px;
    border: 1px solid #d7dbe3; border-radius: 3px; background: #f7f8fa;
  }
  .fact__label { color: #55607a; text-transform: uppercase; font-size: 8.5px; letter-spacing: 0.06em; }
  .fact__value { font-weight: 700; font-size: 11px; }

  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #c8cdd8; padding: 4px 6px; text-align: left; vertical-align: top; }
  thead th {
    background: #eceef3; font-size: 9px; text-transform: uppercase;
    letter-spacing: 0.05em; color: #2b3242;
  }
  /* Repeats the header on every page of a long register. */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  td.num, th.num { text-align: center; font-variant-numeric: tabular-nums; }
  td.idx { width: 26px; text-align: center; color: #55607a; }
  /* Blank boxes a teacher fills in by hand. */
  td.tick, th.tick { width: 22px; }

  .section { margin-top: 14px; page-break-inside: avoid; }
  .section__title {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em;
    color: #2b3242; margin-bottom: 5px; padding-bottom: 3px;
    border-bottom: 1px solid #c8cdd8;
  }

  .muted { color: #55607a; }
  .fail  { color: #a1160a; font-weight: 700; }
  .pass  { color: #0d5c33; font-weight: 700; }

  .signs { display: flex; gap: 40px; margin-top: 26px; page-break-inside: avoid; }
  .sign  { flex: 1; }
  .sign__line { border-bottom: 1px dotted #14181f; height: 26px; }
  .sign__label { font-size: 9px; color: #55607a; margin-top: 3px; }

  .foot {
    margin-top: 16px; padding-top: 6px; border-top: 1px solid #d7dbe3;
    color: #55607a; font-size: 8.5px; display: flex; justify-content: space-between;
  }

  .verify {
    display: flex; align-items: center; gap: 10px;
    margin-top: 16px; padding: 8px 10px;
    border: 1px solid #d7dbe3; border-radius: 3px; background: #f7f8fa;
    page-break-inside: avoid;
  }
  .verify__qr { width: 20mm; height: 20mm; flex: none; }
  .verify__qr svg { width: 100%; height: 100%; display: block; }
  .verify__title {
    font-size: 9px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.07em; color: #2b3242;
  }
  .verify__text { font-size: 9px; color: #55607a; margin-top: 2px; }
  .verify__code {
    font-family: Consolas, Menlo, monospace; font-weight: 700;
    color: #14181f; letter-spacing: 0.05em;
  }

  @media screen {
    body { padding: 18px; background: #eceef3; }
    .sheet {
      max-width: 210mm; margin: 0 auto 18px; background: #fff;
      padding: 14mm 12mm; box-shadow: 0 1px 3px rgba(0,0,0,.18);
    }
  }
`;

/** The masthead every document carries. */
const renderHeading = (school, origin) => {
  const logo = absoluteLogo(school.logo, origin);
  const meta = [school.address, school.phone, school.email].filter(Boolean).map(esc);

  return `
    <div class="head">
      ${logo ? `<img class="head__logo" src="${esc(logo)}" alt="" />` : ""}
      <div class="head__text">
        <h1 class="head__name">${orDash(school.name)}</h1>
        ${school.motto ? `<div class="head__motto">${esc(school.motto)}</div>` : ""}
        ${meta.length ? `<div class="head__meta">${meta.join(" &nbsp;·&nbsp; ")}</div>` : ""}
      </div>
    </div>
  `;
};

const renderFacts = (facts) => `
  <div class="facts">
    ${facts.map((f) => `
      <div>
        <div class="fact__label">${esc(f.label)}</div>
        <div class="fact__value">${orDash(f.value)}</div>
      </div>
    `).join("")}
  </div>
`;

const renderSignatures = (labels) => `
  <div class="signs">
    ${labels.map((l) => `
      <div class="sign">
        <div class="sign__line"></div>
        <div class="sign__label">${esc(l)}</div>
      </div>
    `).join("")}
  </div>
`;

/**
 * The verification strip an outward-facing document carries.
 *
 * `verify` is documentVerify.service.printableBlock()'s answer, and may be
 * null — a document that could not get its code still prints, exactly like an
 * ID card whose QR failed to render.
 */
const renderVerify = (verify, labels) => {
  if (!verify) return "";
  return `
    <div class="verify">
      <div class="verify__qr">${verify.qrSvg ?? ""}</div>
      <div>
        <div class="verify__title">${esc(labels.verifyTitle)}</div>
        <div class="verify__text">
          ${esc(labels.verifyHint)}
          <span class="verify__code">${esc(verify.code)}</span>
          — ${esc(verify.url)}
        </div>
      </div>
    </div>
  `;
};

const buildDocument = ({ title, body, footerLeft, footerRight }) => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
    <style>${PAGE_CSS}</style>
  </head>
  <body>
    ${body}
    ${(footerLeft || footerRight) ? `
      <div class="foot">
        <span>${esc(footerLeft ?? "")}</span>
        <span>${esc(footerRight ?? "")}</span>
      </div>` : ""}
  </body>
</html>`;

module.exports = {
  esc, orDash, absoluteLogo,
  renderHeading, renderFacts, renderSignatures, renderVerify, buildDocument,
};
