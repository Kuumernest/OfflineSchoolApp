// backend/scripts/check-id-card.js
"use strict";

/**
 * The pupil identity card (decided 2026-10-16, docs/41 §6).
 *
 *   - no placeholder in the head's signature space (it printed "Principal"
 *     there in script): a clean space for a signature and the school's
 *     stamp, the head's title kept as the label under the line;
 *   - the fields the data model holds: school name, logo, address, phone;
 *     pupil photo, full name, matricule, class, sex, date of birth; the
 *     academic year and a validity date; a guardian's name and phone for
 *     emergencies; the gate QR it already had. No health information;
 *   - in English and French, and printed in the school's language whoever
 *     asks (GET /api/documents/id-cards/:classId, School.defaultLanguage);
 *   - a long name steps down a size rather than losing characters; a
 *     missing photo prints the framed blank; the admission number steps
 *     down a size too and is never cut short ("ETEST-2026-…" finds nobody);
 *     every other value is held to one line (ellipsis) so nothing spills off
 *     the 85.6 × 54 mm card.
 *
 * Renders the real renderer, then the real route against an in-memory
 * MongoDB with a synthetic school.
 *
 *   node scripts/check-id-card.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  const { buildIdCardsHtml } = require("../src/print/idCard");
  const { labelsFor } = require("../src/print/labels");

  const school = { name: "Synthetic Bilingual College", logo: "/uploads/logo.png", address: "BP 123 Bamenda", phone: "+237 600 00 00 00" };
  const pupil = {
    _id: "p1", name: "Ama Synthetic", enrollmentNo: "SBC-2026-0001", className: "Form 1", photoUrl: "/uploads/p1.jpg",
    gender: "female", dateOfBirth: "2014-03-09", guardianName: "Bih Synthetic", guardianPhone: "+237 677 11 22 33",
    bloodGroup: "O+", qrSvg: '<svg id="gate-qr"></svg>',
  };
  const data = (students) => ({ school, class: { name: "Form 1" }, students, academicYear: "2026/2027", validUntil: "31/08/2027" });
  const render = (lang, students = [pupil]) => buildIdCardsHtml({ data: data(students), labels: labelsFor(lang), origin: "https://school.example.test", lang });
  // The cards only: the stylesheet's comments are not printed text.
  const cards = (html) => html.slice(html.indexOf("<body>"));

  console.log("--- the head's corner ---");
  const en = cards(render("en")), fr = cards(render("fr"));
  // Only the placeholder goes: "Principal" in script above the line. The
  // head's title stays as the label under it.
  check("no placeholder in the signature space: a clean space above the line, the title only as its label",
    [/<div class="sig sig--right">\s*<div class="sig__space"><\/div>\s*<div class="sig__line"><\/div>\s*<div class="sig__label">Principal<\/div>\s*<\/div>/.test(en),
     /sig__script/.test(en)], [true, false]);
  check("the head's title printed once, as the label (en: Principal; fr: Chef d'établissement)",
    [(en.match(/Principal/g) || []).length, (fr.match(/Chef d&#39;établissement/g) || []).length], [1, 1]);

  check("the printed documents' title for the head: 'Principal' / 'Chef d'établissement' (class lists, transcripts)",
    [labelsFor("en").headTeacher, labelsFor("fr").headTeacher], ["Principal", "Chef d'établissement"]);

  console.log("--- the fields ---");
  const has = (html) => ({
    schoolName: html.includes("Synthetic Bilingual College"),
    logo:       html.includes('src="https://school.example.test/uploads/logo.png"'),
    contact:    html.includes("BP 123 Bamenda · +237 600 00 00 00"),
    photo:      html.includes('src="https://school.example.test/uploads/p1.jpg"'),
    name:       html.includes("Ama Synthetic"),
    matricule:  html.includes("SBC-2026-0001"),
    className:  html.includes("Form 1"),
    dob:        html.includes("09/03/2014"),
    year:       html.includes("2026/2027"),
    validUntil: html.includes("31/08/2027"),
    emergency:  html.includes("Bih Synthetic · +237 677 11 22 33"),
    qr:         html.includes('<svg id="gate-qr"></svg>'),
  });
  const all = (o) => Object.entries(o).filter(([, v]) => !v).map(([k]) => k);
  check("English: every field present", all(has(en)), []);
  check("French: every field present", all(has(fr)), []);
  check("English labels and sex", ["Admission no.", "Gender", "Date of birth", "Emergency contact", "Valid until", "Female", "Student identity card"].filter((l) => !en.includes(l)), []);
  check("French labels and sex", ["Matricule", "Sexe", "Date de naissance", "Contact d'urgence", "Valable jusqu'au", "Féminin", "Carte d'identité scolaire", "Année scolaire"].filter((l) => !fr.includes(esc(l))), []);
  check("no health information printed (the model's blood group is left off)", [/O\+/.test(en), /blood|groupe sanguin/i.test(en + fr)], [false, false]);
  check("the page says its language", [/<html lang="en">/.test(render("en")), /<html lang="fr">/.test(render("fr"))], [true, true]);

  console.log("--- fitting the card ---");
  const LONG = "Ngwanyam Fru Bernadette Mbuh-Tchoumbou Nkemdirim";   // 49 characters
  const long = cards(render("fr", [{ ...pupil, name: LONG, photoUrl: null, guardianName: "Tchoumbou Nkemdirim Évangéline-Marie", gender: null, dateOfBirth: null }]));
  check("a long name: the smallest size band, every character kept", [/value--name n4">/.test(long), long.includes(LONG)], [true, true]);
  check("a missing photo: the framed blank, in French", long.includes('<div class="photo photo--empty">Coller la photo ici</div>'), true);
  check("missing sex and date of birth print a dash, not a blank", (long.match(/<div class="value value--small">—<\/div>/g) || []).length, 2);
  const css = render("en");
  const rule = (sel) => (css.match(new RegExp(`\\n  ${sel.replace(".", "\\.")} \\{[^}]*\\}`)) || [""])[0];
  check("labels, values, the contact line and the signature labels hold to one line (ellipsis), never spilling",
    [".label", ".value", ".card__contact", ".sig__label"].map((s) => /white-space: nowrap/.test(rule(s)) && /text-overflow: ellipsis/.test(rule(s))), [true, true, true, true]);
  const idRule = (css.match(/\n  \.value--id \{[^}]*\}/) || [""])[0];
  check("the admission number is never ellipsised: it clips nothing and may break, last resort",
    [/text-overflow: clip/.test(idRule), /white-space: normal/.test(idRule), /overflow-wrap: anywhere/.test(idRule)], [true, true, true]);
  const idOf = (no) => (cards(render("en", [{ ...pupil, enrollmentNo: no }])).match(/value--id (a\d)">([^<]*)</) || []).slice(1);
  check("admission numbers step down by length, every character kept",
    [idOf("SBC-26-0001"), idOf("ETEST-2026-006"), idOf("SYNTHCOL-2026-00042")],
    [["a1", "SBC-26-0001"], ["a2", "ETEST-2026-006"], ["a3", "SYNTHCOL-2026-00042"]]);
  check("the signature line's rule is not swallowed by a stray declaration block",
    /\n  \.sig__space \{[^}]*\}\n  \.sig__line  \{/.test(css), true);
  check("the card is still 85.6 × 54 mm, its overflow hidden", [/\.card \{\s*width: 85\.6mm; height: 54mm;/.test(css), /overflow: hidden;\s*\}\s*\n\s*\.card__inner/.test(css)], [true, true]);

  console.log("--- the route prints in the school's language ---");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough-xx";
  process.env.NODE_ENV = "test";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  const M = (n) => mongoose.model(n);
  const S = "68e1000000000000000d0c01";
  await M("School").create({ _id: S, name: "Synthetic Bilingual College", email: "sbc@example.test", address: "BP 123 Bamenda", phone: "+237 600 00 00 00",
    defaultLanguage: "fr", settings: { academicYear: "2026/2027" } });
  await M("Class").create({ _id: "c1", schoolId: S, name: "Form 1" });
  await M("User").create({ _id: "adm", name: "Admin", email: "adm@example.test", password: "Check-only-passw0rd", role: "school_admin", schoolId: S, isActive: true });
  await M("Student").create({ _id: "p1", userId: "u-p1", schoolId: S, classId: "c1", className: "Form 1", studentName: "Ama Synthetic", enrollmentNo: "SBC-2026-0001",
    gender: "female", dateOfBirth: "2014-03-09", guardianName: "Bih Synthetic", guardianPhone: "+237 677 11 22 33", bloodGroup: "O+", status: "approved", isActive: true });
  const express = require("express"), jwt = require("jsonwebtoken");
  const app = express(); app.use(express.json());
  app.use("/api/documents", require("../middleware/auth").authenticate, require("../src/routes/documents.routes"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/documents`;
  const headers = { Authorization: `Bearer ${jwt.sign({ id: "adm", role: "school_admin", schoolId: S }, process.env.JWT_SECRET)}` };
  const html = await (await fetch(`${base}/id-cards/c1?format=html&lang=en`, { headers })).text();
  check("a French school's cards print in French though asked for in English", [/<html lang="fr">/.test(html), html.includes("Matricule"), html.includes("Féminin"), html.includes(esc("Valable jusqu'au"))], [true, true, true, true]);
  check("with the pupil's details, the emergency contact and the end of the academic year",
    [html.includes("09/03/2014"), html.includes("Bih Synthetic · +237 677 11 22 33"), html.includes("31/08/2027"), /O\+/.test(cards(html))], [true, true, true, false]);
  const json = await (await fetch(`${base}/id-cards/c1`, { headers })).json();
  const st = json.data?.students?.[0] ?? {};
  check("the JSON view carries the same fields, and no blood group",
    [st.gender, st.dateOfBirth, st.guardianName, st.guardianPhone, "bloodGroup" in st, json.data?.validUntil], ["female", "2014-03-09", "Bih Synthetic", "+237 677 11 22 33", false, "31/08/2027"]);
  server.close();

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("check failed:", e); process.exit(1); });

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
