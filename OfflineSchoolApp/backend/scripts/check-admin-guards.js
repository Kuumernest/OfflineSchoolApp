// backend/scripts/check-admin-guards.js
"use strict";

/**
 * Assert that every route in admin.routes.js is guarded by the capability it
 * should be.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * That router used to be one locked block: a single router-level guard
 * requiring ADMIN_ROLES, plus a hand-kept allowlist of four GET paths. It is
 * now 56 routes each carrying their own capability, which is a much better
 * shape and a much easier thing to get subtly wrong — one route missed and it
 * falls through to the STAFF_ROLES backstop, reachable by any teacher.
 *
 * A source grep would not settle it: a guard can be present and name the wrong
 * capability, or sit after the handler. So this mounts the real router in a
 * real Express app and makes a real request to every path.
 *
 * ── How it reads the answer ───────────────────────────────────────────────
 *
 * Every request is made as a TEACHER, and a teacher holds none of the 56
 * capabilities this router uses. So the correct response for all of them is 403
 * with the required capability named in the body — which is what
 * requirePermission answers with. A 401 means the request never reached a
 * per-route guard; anything 2xx or 5xx means it reached a HANDLER, which is the
 * failure this is looking for: an unguarded route.
 *
 * Needs a database only because a teacher is a role whose permissions a school
 * may adjust, so resolving them reads the school. mongodb-memory-server, so
 * nothing real is touched.
 *
 *   node scripts/check-admin-guards.js
 */

const express  = require("express");
const mongoose = require("mongoose");
const fs       = require("fs");
const path     = require("path");

const PERMS = require("../src/config/permissions");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; }
  else {
    fail++;
    console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
};

/** Reads the route table straight out of the file, method + path + capability. */
const routesInFile = () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "admin.routes.js"), "utf8"
  );

  return src.split(/\r?\n/).flatMap((line) => {
    const m = /^router\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,\s*(.*)$/.exec(line);
    if (!m) return [];

    const [, method, routePath, rest] = m;
    const cap = /requirePermission\("([^"]+)"\)/.exec(rest);

    return [{
      method: method.toUpperCase(),
      path:   routePath,
      // Null when the route names no capability at all — the case that matters.
      capability: cap ? cap[1] : null,
    }];
  });
};

/** Turns "/students/:id" into a path a request can actually be made against. */
const concrete = (p) => p.replace(/:[A-Za-z_]+/g, "test-id");

const main = async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({
    // The default launch timeout is ten seconds, which is not enough on a
    // developer machine with a browser and an editor open — the suite failed
    // intermittently with "Instance failed to start within 10000ms" and the
    // failure looked like a broken test rather than a busy host.
    instance: { launchTimeout: 180_000 },
  });
  await mongoose.connect(mongo.getUri(), { dbName: "admin-guards" });

  const routes = routesInFile();

  console.log(`--- ${routes.length} routes found in admin.routes.js ---`);
  check("the router still has its routes", routes.length > 50, true);

  console.log("--- every route names a capability ---");
  check("none unguarded",
    routes.filter((r) => !r.capability).map((r) => `${r.method} ${r.path}`), []);

  console.log("--- every capability named is real ---");
  check("no typos",
    routes.filter((r) => r.capability && !PERMS.isPermission(r.capability))
          .map((r) => `${r.method} ${r.path} -> ${r.capability}`), []);

  console.log("--- and the guard actually runs, for all of them ---");

  // The real router, behind a stub that stamps a teacher on the request the way
  // middleware/auth.js would.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      _id: "teacher-1", id: "teacher-1", role: "teacher",
      schoolId: "000000000000000000000000", email: "t@x.com",
    };
    next();
  });
  app.use("/api/admin", require("../src/routes/admin.routes"));

  const server = app.listen(0);
  const port   = server.address().port;

  const call = async (method, p) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin${p}`, {
      method,
      headers: { "content-type": "application/json" },
      body: ["GET", "DELETE"].includes(method) ? undefined : "{}",
    });
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
  };

  const wrong = [];

  for (const r of routes) {
    const { status, body } = await call(r.method, concrete(r.path));

    // 403 naming the expected capability is the only correct answer for a
    // teacher. Anything else means the guard is missing, in the wrong order, or
    // guarding with something else.
    if (status !== 403 || body?.permission !== r.capability) {
      wrong.push(
        `${r.method} ${r.path} -> ${status} ` +
        `${body?.permission ? `(${body.permission})` : "(no capability named)"} ` +
        `expected 403 (${r.capability})`
      );
    }
  }

  check("all 56 refuse a teacher, naming the right capability", wrong, []);

  console.log("--- the backstop still rejects a student outright ---");
  server.close();

  const app2 = express();
  app2.use(express.json());
  app2.use((req, _res, next) => {
    req.user = { _id: "s1", id: "s1", role: "student", schoolId: "000000000000000000000000" };
    next();
  });
  app2.use("/api/admin", require("../src/routes/admin.routes"));
  const server2 = app2.listen(0);
  const port2 = server2.address().port;

  const asStudent = await fetch(`http://127.0.0.1:${port2}/api/admin/classes`);
  check("a student never reaches a per-route guard", asStudent.status, 403);
  const studentBody = await asStudent.json().catch(() => ({}));
  // The backstop answers without naming a capability, which is how the two are
  // told apart in a log.
  check("and is refused by the role backstop, not a capability",
    studentBody.permission ?? null, null);

  server2.close();

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (wrong.length) {
    console.log("\n  Routes answering incorrectly:");
    wrong.forEach((w) => console.log("   " + w));
  }

  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail ? 1 : 0);
};

main().catch(async (err) => {
  console.error("\nHarness error:", err);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
