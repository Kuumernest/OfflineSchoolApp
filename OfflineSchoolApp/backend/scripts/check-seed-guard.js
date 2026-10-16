// backend/scripts/check-seed-guard.js
"use strict";

/**
 * Seed scripts that create accounts with a known password refuse a real
 * database (scripts/seedGuard.js, docs/40 0.7). The scripts found that do:
 * seed-form1-students.js (pupils and their logins, password "student123").
 *
 * The real script is run against URIs that would be dangerous; it must stop
 * with "Refused" before connecting. No URI here reaches a database: the
 * hosts are reserved (.invalid) or nothing listens.
 *
 *   node scripts/check-seed-guard.js
 */

const path = require("path");
const { execFile } = require("child_process");
const { checkSeedTarget } = require("./seedGuard");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const ok = (uri, env = {}, argv = []) => checkSeedTarget({ uri, env, argv }).ok;

(async () => {
  console.log("--- the rule ---");
  check("NODE_ENV=production is refused, even on localhost", ok("mongodb://localhost:27017/school", { NODE_ENV: "production" }), false);
  check("a hosted cluster is refused", ok("mongodb+srv://user:pw@cluster0.example.invalid/school_db"), false);
  check("the Compose stack's own database (host `mongo`) is refused", ok("mongodb://u:p@mongo:27017/school_app?authSource=admin"), false);
  check("localhost and 127.0.0.1 are allowed", [ok("mongodb://localhost:27017/school"), ok("mongodb://127.0.0.1:27017/x")], [true, true]);
  check("a database named as a test one is allowed", [ok("mongodb+srv://u:p@cluster0.example.invalid/school_test"), ok("mongodb://h.example.invalid/test")], [true, true]);
  check("no URI is refused", ok(""), false);
  check("--i-know overrides", ok("mongodb+srv://u:p@cluster0.example.invalid/school_db", { NODE_ENV: "production" }, ["--i-know"]), true);

  console.log("--- the seed script refuses before connecting ---");
  const run = (env) => new Promise((resolve) => {
    const t0 = Date.now();
    execFile(process.execPath, [path.join(__dirname, "seed-form1-students.js")],
      { env: { PATH: process.env.PATH, ...env }, timeout: 30000 },
      (err, out, errOut) => resolve({ code: err ? err.code : 0, text: `${out}${errOut}`, ms: Date.now() - t0 }));
  });
  for (const [label, env] of [
    ["NODE_ENV=production", { NODE_ENV: "production", MONGODB_URI: "mongodb://localhost:1/school" }],
    ["a hosted URI", { NODE_ENV: "development", MONGODB_URI: "mongodb+srv://user:pw@cluster0.example.invalid/school_db" }],
  ]) {
    const r = await run(env);
    check(`${label}: exits 1 with "Refused", and never tried to connect`,
      [r.code, /Refused: this script creates accounts with a known password/.test(r.text), /MongooseServerSelectionError|ENOTFOUND|ECONNREFUSED|querySrv/.test(r.text)], [1, true, false]);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
