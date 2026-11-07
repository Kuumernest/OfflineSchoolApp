// backend/scripts/check-delete-all-schools.js
"use strict";

/**
 * D2 — deleting both test schools leaves a working, empty platform.
 *
 *   Green Valley Academy and Kena Academy, a portal code shared between them
 *   (as in the real data), then each deleted in launch order: Green Valley
 *   first (the shared code is unlinked and moves to Kena), then Kena (the code
 *   goes with it).
 *
 *   After: zero schools and nothing school-scoped left; the Super Admin logs
 *   in; the dashboard, performance, filters and school list load empty (200,
 *   zero totals); a new school can be created and shows up.
 *
 *   node scripts/check-delete-all-schools.js
 */

const path     = require("path");
const express  = require("express");
const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

(async () => {
  process.env.JWT_SECRET         = process.env.JWT_SECRET         || "test-only-secret";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-only-refresh-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M  = (n) => mongoose.model(n);
  const db = mongoose.connection.db;
  const C  = (n) => db.collection(n);
  const { run } = require("./delete-school");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const YEAR = "2026/2027";
  const GV = new mongoose.Types.ObjectId(), KA = new mongoose.Types.ObjectId();
  await C("schools").insertMany([
    { _id: GV, name: "Green Valley Academy", isActive: true, settings: { academicYear: YEAR }, deletedAt: null },
    { _id: KA, name: "Kena Academy",         isActive: true, settings: { academicYear: YEAR }, deletedAt: null },
  ]);
  await M("User").create({
    _id: "sa-1", name: "Root", email: "root@example.test", password: "Check-only-passw0rd",
    role: "super_admin", schoolId: null, isActive: true,
  });
  for (const [S, kids] of [[GV, ["ama", "bih"]], [KA, ["tem", "ewi"]]]) {
    const sid = String(S);
    await C("users").insertOne({ _id: `adm-${sid}`, name: "Admin", email: `adm-${sid}@example.test`, role: "school_admin", schoolId: sid, isActive: true });
    for (const k of kids) {
      await C("students").insertOne({ _id: k, schoolId: sid, studentName: k, status: "approved", deletedAt: null, guardianName: "Mrs Tem" });
      await C("feecharges").insertOne({ schoolId: sid, studentId: k, academicYear: YEAR, amount: 50000, voidedAt: null });
    }
    await C("exams").insertOne({ _id: `e-${sid}`, schoolId: sid, name: "Test 1", academicYear: YEAR, term: 1, deletedAt: null });
    await C("classes").insertOne({ schoolId: sid, name: "Form 1" });
  }
  await C("guardianaccesses").insertOne({ _id: "shared", schoolId: String(KA), studentIds: ["tem", "ama"] });

  console.log("\n--- Green Valley, then Kena ---");
  const gv = await run({ school: "Green Valley Academy", apply: true, confirm: "Green Valley Academy" });
  check("Green Valley: the shared code is unlinked, not deleted", gv.plan.codesUnlinked, ["shared"]);
  check("and now covers only Kena's child", (await C("guardianaccesses").findOne({ _id: "shared" }))?.studentIds, ["tem"]);
  const ka = await run({ school: "Kena Academy", apply: true, confirm: "Kena Academy" });
  check("Kena: the code goes with it", ka.plan.codesDeleted, ["shared"]);

  const left = {};
  for (const { name } of await db.listCollections().toArray()) {
    const n = name === "users"
      ? await C(name).countDocuments({ role: { $ne: "super_admin" } })
      : await C(name).countDocuments({});
    if (n) left[name] = n;
  }
  check("zero schools, and nothing but the Super Admin left", left, {});

  console.log("\n--- the platform with no schools ---");
  const auth = require(path.join(ROOT, "middleware/auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/auth", require(path.join(SRC, "routes/auth.routes")));
  app.use("/api/super-admin", auth.authenticate, require(path.join(SRC, "routes/superAdmin.routes")));
  app.use(require(path.join(ROOT, "middleware/errorHandler")));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const login = await call("POST", "/api/auth/login", { email: "root@example.test", password: "Check-only-passw0rd" });
  const token = login.body.token ?? login.body.accessToken ?? login.body.data?.token ?? login.body.data?.accessToken;
  check("the Super Admin can still log in", [login.status, Boolean(token)], [200, true]);

  const dash = await call("GET", "/api/super-admin/dashboard", null, token);
  const data = dash.body.data ?? dash.body;
  check("the dashboard loads with no schools", [dash.status, data.schools?.length ?? null], [200, 0]);
  const totals = data.totals ?? {};
  check("platform totals are returned", Object.keys(totals).length > 0, true);
  check("and every platform total is zero (none NaN)",
    Object.entries(totals).filter(([, v]) => typeof v === "number" && v !== 0 || Number.isNaN(v)), []);
  for (const url of ["/api/super-admin/performance", "/api/super-admin/filters", "/api/super-admin/schools"]) {
    const r = await call("GET", url, null, token);
    check(`${url} loads (200)`, r.status, 200);
  }

  console.log("\n--- a new school ---");
  const made = await call("POST", "/api/super-admin/schools", { name: "Clean Test School", settings: { academicYear: YEAR } }, token);
  check("the Super Admin creates a new school", [made.status < 300, made.body.success !== false], [true, true]);
  const after = await call("GET", "/api/super-admin/dashboard", null, token);
  check("and the dashboard shows it", ((after.body.data ?? after.body).schools ?? []).map((s) => s.name), ["Clean Test School"]);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
