// backend/scripts/check-verify-links.js
"use strict";

/**
 * Verification codes on printed documents (2026-10-30).
 *
 *   - the QR and link name the app's own domain, not the API host that drew
 *     the page (offlineschool-app.onrender.com): PUBLIC_VERIFY_BASE_URL, else
 *     APP_LOGIN_URL's origin + /verify, else the browser's Origin + /verify,
 *     else the request's host + /api/verify;
 *   - a code is issued by a print or a download, never by a preview.
 *
 *   node scripts/check-verify-links.js
 */

const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  const doc = require("../src/services/documentVerify.service");
  const req = (headers = {}) => ({ headers: { host: "offlineschool-app.onrender.com", ...headers },
    protocol: "https", get: () => "offlineschool-app.onrender.com" });
  const env = (o) => { for (const [k, v] of Object.entries(o)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };

  console.log("--- where the QR points ---");
  env({ PUBLIC_VERIFY_BASE_URL: null, APP_LOGIN_URL: null });
  check("nothing configured, no browser origin: the API host's own page (development)",
    doc.verifyBase(req()), "https://offlineschool-app.onrender.com/api/verify");
  check("nothing configured: the app the request came from",
    doc.verifyBase(req({ origin: "https://ecole.example.cm" })), "https://ecole.example.cm/verify");
  env({ APP_LOGIN_URL: "https://app.example.cm/login" });
  check("APP_LOGIN_URL set: the app's own domain, whoever asked",
    doc.verifyBase(req({ origin: "https://elsewhere.example" })), "https://app.example.cm/verify");
  env({ PUBLIC_VERIFY_BASE_URL: "https://verify.example.cm/v/" });
  check("PUBLIC_VERIFY_BASE_URL wins, trailing slash dropped",
    doc.verifyUrl(doc.verifyBase(req()), "BCDFGHJKMNPQ"), "https://verify.example.cm/v/BCDF-GHJK-MNPQ");
  env({ PUBLIC_VERIFY_BASE_URL: null, APP_LOGIN_URL: "not a url" });
  check("a malformed APP_LOGIN_URL is skipped, not printed",
    doc.verifyBase(req({ origin: "https://ecole.example.cm" })), "https://ecole.example.cm/verify");

  console.log("--- a preview issues nothing ---");
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  const DV = require("../src/db/models/DocumentVerification");
  env({ APP_LOGIN_URL: "https://app.example.cm/login" });
  const block = (count) => doc.printableBlock({ schoolId: "s1", kind: "transcript", studentId: "zz-test-1",
    examId: null, snapshot: { facts: [] }, req: req(), count });
  check("preview of a transcript never printed: no strip, no code", [await block(false), await DV.countDocuments()], [null, 0]);
  const printed = await block(true);
  check("print: a code, on the app's domain", [Boolean(printed?.code), printed?.url.startsWith("https://app.example.cm/verify/")], [true, true]);
  const again = await block(false);
  check("preview after a print: the same code, no extra print counted",
    [again?.code === printed?.code, (await DV.findOne({ studentId: "zz-test-1" }).lean()).printCount], [true, 1]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
