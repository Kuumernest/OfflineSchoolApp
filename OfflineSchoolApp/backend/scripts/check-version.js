// backend/scripts/check-version.js
"use strict";

/**
 * GET /api/version says which build is running.
 *
 *   the commit and branch come from Render (RENDER_GIT_COMMIT/BRANCH), or
 *     GIT_COMMIT/GIT_BRANCH elsewhere; Render's wins
 *   only a hex commit and a plain branch name are reported — anything else
 *     in those variables is reported as null, never echoed
 *   the package version, when the process started, the Node version
 *   the route is public, answers JSON and is never cached
 *   it is registered in server.js, among the public routes
 *
 *   node scripts/check-version.js
 */

const fs   = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  const { buildInfo, versionHandler, STARTED_AT } = require("../src/config/buildInfo");
  const pkg = require("../package.json");
  const SHA = "46bb7a5e4696e6baf9b98e02ff4f995701c3f33a";

  console.log("--- what is reported ---");
  let b = buildInfo({ RENDER_GIT_COMMIT: SHA, RENDER_GIT_BRANCH: "master" });
  check("Render's commit and branch", [b.commit, b.commitShort, b.branch], [SHA, "46bb7a5", "master"]);
  check("the package version, start time and Node version",
    [b.version, b.startedAt, b.node], [pkg.version, STARTED_AT, process.version]);
  b = buildInfo({ GIT_COMMIT: SHA.toUpperCase(), GIT_BRANCH: "release/0.3" });
  check("GIT_COMMIT / GIT_BRANCH elsewhere (commit lower-cased)", [b.commit, b.branch], [SHA, "release/0.3"]);
  b = buildInfo({ RENDER_GIT_COMMIT: SHA, GIT_COMMIT: "a".repeat(40) });
  check("Render's commit wins", b.commit, SHA);
  b = buildInfo({});
  check("nothing set: nulls, not a guess", [b.commit, b.commitShort, b.branch], [null, null, null]);
  b = buildInfo({ RENDER_GIT_COMMIT: "secret=hunter2", RENDER_GIT_BRANCH: "x; rm -rf /" });
  check("anything that is not a commit or a branch name is not echoed", [b.commit, b.branch], [null, null]);
  check("  nor a too-short commit", buildInfo({ GIT_COMMIT: "abc12" }).commit, null);

  console.log("--- the route ---");
  const express = require("express");
  const app = express();
  app.get("/api/version", versionHandler);
  const server = app.listen(0);
  try {
    process.env.RENDER_GIT_COMMIT = SHA;
    process.env.RENDER_GIT_BRANCH = "master";
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/version`);
    const body = await r.json();
    check("answers 200 JSON without a token", [r.status, body.commitShort, body.branch], [200, "46bb7a5", "master"]);
    check("  and is never cached", r.headers.get("cache-control"), "no-store");
  } finally {
    server.close();
  }

  const srv = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const versionAt = srv.indexOf('app.get("/api/version"');
  check("registered in server.js beside the public health routes",
    versionAt > srv.indexOf('app.get("/api/health"') && versionAt < srv.indexOf('app.get("/api/health/ready"'), true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
