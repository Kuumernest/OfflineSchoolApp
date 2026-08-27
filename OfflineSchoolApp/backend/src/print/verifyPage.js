// backend/src/print/verifyPage.js
"use strict";

/**
 * The public verification page.
 *
 * Rendered for whoever scanned the QR on a transcript or report card — a
 * registrar at another school, an employer, an embassy clerk. They have no
 * account and no context, so the page must carry everything: what the school
 * is, whether the code is genuine, and the exact facts to compare against the
 * paper in their hand.
 *
 * Bilingual on one page rather than behind a language switch. The verifier's
 * language is unknown and there is no UI to discover it through; Cameroon's
 * two official languages side by side is the honest default, and it is how
 * the country's own official documents are laid out.
 */

const esc = (str) =>
  String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const PAGE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", Helvetica, Arial, sans-serif;
    background: #f2f3f6; color: #111827;
    padding: 20px 14px; line-height: 1.45;
  }
  .card {
    max-width: 560px; margin: 0 auto; background: #fff;
    border-radius: 12px; overflow: hidden;
    box-shadow: 0 2px 12px rgba(17, 24, 39, .08);
  }
  .banner { padding: 18px 20px; color: #fff; }
  .banner--valid   { background: #12683A; }
  .banner--revoked { background: #96570B; }
  .banner--missing { background: #9F2318; }
  .banner__title { font-size: 18px; font-weight: 700; }
  .banner__sub   { font-size: 13px; opacity: .92; margin-top: 2px; }
  .body { padding: 18px 20px 20px; }
  .school { font-size: 15px; font-weight: 700; }
  .school-meta { font-size: 12px; color: #4F5A70; margin-top: 2px; }
  .kind { font-size: 12px; letter-spacing: .08em; text-transform: uppercase;
          color: #4F5A70; margin: 14px 0 4px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  td { padding: 7px 0; border-bottom: 1px solid #E9EBF0;
       vertical-align: top; font-size: 14px; }
  td.lbl { width: 46%; color: #4F5A70; font-size: 12.5px; padding-right: 10px; }
  td.lbl .fr { display: block; font-size: 11px; color: #8A93A6; }
  td.val { font-weight: 600; }
  .code { font-family: Consolas, Menlo, monospace; font-size: 15px;
          letter-spacing: .06em; }
  .note { margin-top: 16px; font-size: 12px; color: #4F5A70;
          border-top: 1px solid #E9EBF0; padding-top: 12px; }
  .note p + p { margin-top: 6px; }
  form { margin-top: 14px; display: flex; gap: 8px; }
  input {
    flex: 1; font-size: 15px; padding: 10px 12px;
    border: 1px solid #C9CFDB; border-radius: 8px;
    font-family: Consolas, Menlo, monospace; letter-spacing: .06em;
  }
  button {
    font-size: 14px; font-weight: 600; padding: 10px 16px;
    border: 0; border-radius: 8px; background: #1b2945; color: #fff;
  }
`;

const shell = (title, inner) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${esc(title)}</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="card">${inner}</div>
</body>
</html>`;

/** One fact row: English label, French label under it, then the value. */
const factRow = (f) => `
  <tr>
    <td class="lbl">${esc(f.label?.en)}<span class="fr">${esc(f.label?.fr)}</span></td>
    <td class="val">${esc(f.value ?? "—")}</td>
  </tr>
`;

const dateLine = (d) => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric", month: "long", year: "numeric",
    }).format(new Date(d));
  } catch {
    return String(d ?? "");
  }
};

/** The form shown at /verify with no code, and linked from failures. */
const renderVerifyForm = () =>
  shell("Verify a document", `
    <div class="banner banner--valid" style="background:#1b2945">
      <div class="banner__title">Verify a school document</div>
      <div class="banner__sub">Vérifier un document scolaire</div>
    </div>
    <div class="body">
      <p style="font-size:13.5px">
        Enter the verification code printed on the document.<br>
        <span style="color:#4F5A70;font-size:12.5px">
          Saisissez le code de vérification imprimé sur le document.
        </span>
      </p>
      <form method="get" action="">
        <input name="code" placeholder="XXXX-XXXX-XXXX" autocomplete="off"
               autofocus maxlength="20" />
        <button type="submit">Verify</button>
      </form>
    </div>
  `);

const KIND_TITLES = {
  transcript:  { en: "Academic transcript", fr: "Relevé de notes" },
  report_card: { en: "Report card",         fr: "Bulletin de notes" },
};

/**
 * The result page for a code.
 *
 * `result` is documentVerify.service.verify()'s answer. Valid and revoked
 * both show the school and the facts — a revoked document's holder deserves
 * to see what was withdrawn, not a blank page.
 */
const renderVerifyResult = (result) => {
  if (result.status === "not_found") {
    return shell("Code not recognised", `
      <div class="banner banner--missing">
        <div class="banner__title">✘ Code not recognised</div>
        <div class="banner__sub">Code non reconnu</div>
      </div>
      <div class="body">
        <p style="font-size:13.5px">
          This code does not match any document issued through this system.
          Check it was typed exactly as printed — or treat the document with
          caution.
        </p>
        <p style="font-size:12.5px;color:#4F5A70;margin-top:6px">
          Ce code ne correspond à aucun document émis par ce système.
          Vérifiez la saisie — ou considérez le document avec prudence.
        </p>
        <form method="get" action="">
          <input name="code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" maxlength="20" />
          <button type="submit">Try again</button>
        </form>
      </div>
    `);
  }

  const revoked = result.status === "revoked";
  const kind    = KIND_TITLES[result.kind] ?? { en: "Document", fr: "Document" };
  const school  = result.school ?? {};
  const facts   = Array.isArray(result.snapshot?.facts) ? result.snapshot.facts : [];

  const banner = revoked
    ? `<div class="banner banner--revoked">
         <div class="banner__title">⚠ Withdrawn by the school</div>
         <div class="banner__sub">Document retiré par l'établissement</div>
       </div>`
    : `<div class="banner banner--valid">
         <div class="banner__title">✔ Genuine — issued by the school</div>
         <div class="banner__sub">Authentique — émis par l'établissement</div>
       </div>`;

  const schoolMeta = [school.address, school.phone, school.email]
    .filter(Boolean).map(esc).join(" · ");

  return shell(`${kind.en} — verification`, `
    ${banner}
    <div class="body">
      <div class="school">${esc(school.name ?? "—")}</div>
      ${schoolMeta ? `<div class="school-meta">${schoolMeta}</div>` : ""}

      <div class="kind">${esc(kind.en)} · ${esc(kind.fr)}</div>
      <table>
        <tr>
          <td class="lbl">Verification code<span class="fr">Code de vérification</span></td>
          <td class="val code">${esc(result.code)}</td>
        </tr>
        ${facts.map(factRow).join("")}
      </table>

      <div class="note">
        <p>
          Compare each line against the printed document. This page shows what
          the school's records say <strong>as of ${esc(dateLine(result.refreshedAt))}</strong>;
          a paper that says otherwise has been altered or superseded.
        </p>
        <p>
          Comparez chaque ligne au document imprimé. Cette page reflète les
          registres de l'établissement au ${esc(dateLine(result.refreshedAt))} ;
          un document qui en diffère a été modifié ou remplacé.
        </p>
        ${revoked && result.revokedAt
          ? `<p><strong>Withdrawn / retiré :</strong> ${esc(dateLine(result.revokedAt))}${
              result.revokeReason ? ` — ${esc(result.revokeReason)}` : ""
            }</p>`
          : ""}
        <p>First issued / première émission : ${esc(dateLine(result.issuedAt))}</p>
      </div>
    </div>
  `);
};

module.exports = { renderVerifyForm, renderVerifyResult };
