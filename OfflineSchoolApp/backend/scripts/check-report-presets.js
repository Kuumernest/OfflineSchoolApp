// backend/scripts/check-report-presets.js
"use strict";

/**
 * C12 — ready-made report layouts (GET/POST /api/templates/presets).
 *
 *   - three layouts, each the shipped template's HTML: every section switch in
 *     Settings > Report layout still hides its block on every one of them
 *   - they differ in CSS only, and each differs from the others
 *   - "use" makes it the school's one default template; using it again creates
 *     nothing new; switching to another moves the default, never leaving none
 *   - a school's own (custom HTML) template is reported as such
 *
 *   node scripts/check-report-presets.js
 */

const path     = require("path");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const { stopQuietly } = require("./stopQuietly");

const SRC = path.join(__dirname, "..", "src");

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  console.log("\n--- the layouts ---");
  const { PRESETS, PRESET_HTML } = require(path.join(SRC, "print/reportPresets"));
  const { DEFAULT_TEMPLATE_HTML } = require(path.join(SRC, "print/defaultReportTemplate"));
  const sections = require("../../shared/reportSections");
  const allOff = Object.fromEntries(sections.SECTION_IDS.map((id) => [id, false]));
  check("three ready-made layouts", PRESETS.map((p) => p.id), ["classic", "compact", "clear"]);
  check("all are the shipped template's HTML", PRESET_HTML === DEFAULT_TEMPLATE_HTML, true);
  check("so every section switch hides its block on each of them",
    sections.ungatedDisabledSections(PRESET_HTML, allOff), []);
  check("and each one looks different", new Set(PRESETS.map((p) => p.css)).size, 3);

  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Green Valley", email: "gv-rp@example.test" });
  await M("User").create({ _id: "adm-1", name: "Admin", email: "adm-rp@example.test",
    password: "check-only-password", role: "school_admin", schoolId: S, isActive: true });

  const auth = require(path.join(__dirname, "..", "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/templates", auth.authenticate, require(path.join(SRC, "routes/template.routes")));
  const server = app.listen(0);
  const token  = jwt.sign({ id: "adm-1", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/templates${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify({ schoolId: S }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const defaults = async () =>
    (await M("ReportTemplate").find({ schoolId: S, isDefault: true, deletedAt: null }).lean()).map((t) => t.name);

  console.log("\n--- choosing one ---");
  let r = await call("GET", `/presets?schoolId=${S}`);
  check("listed, none in use yet (cards print the built-in layout)",
    [r.status, r.body.presets?.map((p) => p.inUse), r.body.custom], [200, [false, false, false], null]);

  r = await call("POST", "/presets/compact/use");
  check("using Compact → 200 and it is the one default", [r.status, await defaults()], [200, ["Compact report card"]]);
  const compact = await M("ReportTemplate").findOne({ schoolId: S, name: "Compact report card" }).lean();
  check("its CSS is the compact layout's", compact.css, PRESETS[1].css);

  await call("POST", "/presets/compact/use");
  check("using it again creates nothing new",
    await M("ReportTemplate").countDocuments({ schoolId: S, name: "Compact report card" }), 1);

  r = await call("POST", "/presets/clear/use");
  check("switching to Clear moves the default — never two, never none", await defaults(), ["Clear report card"]);
  r = await call("GET", `/presets?schoolId=${S}`);
  check("and the list says which is in use", r.body.presets.map((p) => p.inUse), [false, false, true]);

  check("an unknown layout → 404", (await call("POST", "/presets/fancy/use")).status, 404);

  console.log("\n--- a school's own HTML ---");
  await M("ReportTemplate").updateMany({ schoolId: S }, { $set: { isDefault: false } });
  await M("ReportTemplate").create({ _id: "own", schoolId: S, name: "Our own card", html: "<p>{{student_name}}</p>", isDefault: true });
  r = await call("GET", `/presets?schoolId=${S}`);
  check("is reported as custom, with no preset in use",
    [r.body.custom, r.body.presets.some((p) => p.inUse)], ["Our own card", false]);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
