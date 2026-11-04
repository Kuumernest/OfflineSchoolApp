// backend/scripts/check-period-state-fields.js
"use strict";

/**
 * A period's isActive and sortOrder, stated in the body of PUT /admin/periods/:id
 * (and of POST /admin/periods), are stored as given.
 *
 * The phone queues a toggle or a reorder made offline as the period's whole
 * record (mobile syncBackfill period spec) and replays it as one PUT. PUT
 * ignored both fields, so the toggle and the new order never reached the
 * server and the next pull put the old ones back. Absolute values, not the
 * relative /toggle and /reorder routes: a replayed or doubled "flip" or
 * "swap with the neighbour" gives another answer against a day that changed.
 *
 *   A. PUT isActive false / true, PUT sortOrder — stored; the same PUT twice
 *      leaves the same state (a replay does not flip it back);
 *   B. reorders as absolute values, sent in any order, end in the stated order;
 *   C. a PUT naming neither leaves both alone; bad values are refused (400)
 *      and nothing is stored;
 *   D. deactivating a period that overlaps an active one is allowed (an
 *      inactive period is not on the day); reactivating it is refused (409);
 *   E. POST honours isActive false and a stated sortOrder; without them it
 *      behaves as before (active, appended);
 *   F. another school's period is still 404 (tenancy unchanged).
 *
 *   node scripts/check-period-state-fields.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

(async () => {
  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-long-enough-for-validation";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);

  const A = "school-a", B = "school-b";
  for (const id of [A, B]) await M("School").collection.insertOne({ _id: id, name: id, isActive: true });
  for (const [id, sid] of [["adm-a", A], ["adm-b", B]]) {
    await M("User").create({ _id: id, name: id, email: `${id}@example.test`,
      password: "check-only-password", role: "school_admin", schoolId: sid, isActive: true });
  }
  const P = (id, sortOrder, startTime, endTime, schoolId = A) =>
    M("Period").create({ _id: id, schoolId, name: id, startTime, endTime, sortOrder });
  await P("p1", 1, "08:00", "09:00");
  await P("p2", 2, "09:00", "10:00");
  await P("p3", 3, "10:00", "11:00");
  await P("pb", 1, "08:00", "09:00", B);

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app = express();
  app.use(express.json());
  app.use("/api/admin/periods", auth.authenticate, require(path.join(SRC, "routes/periods.routes")));
  app.use(require(path.join(ROOT, "middleware/errorHandler")));
  const server = app.listen(0);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout   = 121_000;
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tok = jwt.sign({ id: "adm-a", role: "school_admin", schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let json = {}; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
  const state = async (id) => {
    const p = await M("Period").findById(id).lean();
    return p ? { isActive: p.isActive, sortOrder: p.sortOrder } : null;
  };
  // The phone's whole-record PUT (syncBackfill period spec).
  const record = async (id, over) => {
    const p = await M("Period").findById(id).lean();
    return { id, name: p.name, startTime: p.startTime, endTime: p.endTime, isBreak: p.isBreak,
      sortOrder: p.sortOrder, isActive: p.isActive, schoolId: A, ...over };
  };

  console.log("--- A. isActive and sortOrder are stored ---");
  let r = await call("PUT", "/admin/periods/p2", await record("p2", { isActive: false }));
  check("PUT isActive false answers 200 with it", [r.status, r.body.data?.isActive], [200, false]);
  check("p2 is inactive in the database", await state("p2"), { isActive: false, sortOrder: 2 });
  r = await call("PUT", "/admin/periods/p2", await record("p2", { isActive: false }));
  check("the same PUT again leaves it inactive (no flip on replay)", await state("p2"), { isActive: false, sortOrder: 2 });
  r = await call("PUT", "/admin/periods/p2", await record("p2", { isActive: true }));
  check("PUT isActive true reactivates it", [r.status, await state("p2")], [200, { isActive: true, sortOrder: 2 }]);
  check("the list without inactive ones shows it again",
    (await call("GET", "/admin/periods")).body.data.map((p) => p._id), ["p1", "p2", "p3"]);

  console.log("--- B. reorders as absolute values, in any order ---");
  // Device: p3 up (p2<->p3), then p3 up again (p1<->p3): p3=1, p1=2, p2=3.
  await call("PUT", "/admin/periods/p2", await record("p2", { sortOrder: 3 }));
  await call("PUT", "/admin/periods/p1", await record("p1", { sortOrder: 2 }));
  await call("PUT", "/admin/periods/p3", await record("p3", { sortOrder: 1 }));
  check("the list comes back in the stated order",
    (await call("GET", "/admin/periods")).body.data.map((p) => p._id), ["p3", "p1", "p2"]);

  console.log("--- C. absent leaves alone, bad values refused ---");
  r = await call("PUT", "/admin/periods/p1", { name: "Period one" });
  check("a PUT naming neither keeps both", [r.status, await state("p1")], [200, { isActive: true, sortOrder: 2 }]);
  for (const [label, body] of [
    ["isActive as a string", { isActive: "false" }],
    ["isActive as a number", { isActive: 0 }],
    ["sortOrder negative", { sortOrder: -1 }],
    ["sortOrder fractional", { sortOrder: 1.5 }],
    ["sortOrder as a string", { sortOrder: "2" }],
  ]) {
    r = await call("PUT", "/admin/periods/p1", body);
    check(`${label}: 400, nothing stored`, [r.status, await state("p1")], [400, { isActive: true, sortOrder: 2 }]);
  }

  console.log("--- D. overlap only matters for an active period ---");
  await P("px", 9, "08:30", "09:30");
  await M("Period").updateOne({ _id: "px" }, { isActive: false });
  r = await call("PUT", "/admin/periods/px", { name: "Clash", isActive: false });
  check("editing an inactive period that overlaps is allowed", [r.status, await state("px")], [200, { isActive: false, sortOrder: 9 }]);
  r = await call("PUT", "/admin/periods/px", { isActive: true });
  check("making it active while it overlaps is refused, nothing stored", [r.status, await state("px")], [409, { isActive: false, sortOrder: 9 }]);

  console.log("--- E. POST ---");
  r = await call("POST", "/admin/periods", { name: "Late", startTime: "15:00", endTime: "16:00", isActive: false, sortOrder: 4 });
  const late = r.body.data?._id;
  check("POST with isActive false and sortOrder 4 stores both", [r.status, await state(late)], [201, { isActive: false, sortOrder: 4 }]);
  r = await call("POST", "/admin/periods", { name: "Later", startTime: "16:00", endTime: "17:00" });
  check("POST without them: active, appended after the highest", [r.status, await state(r.body.data?._id)], [201, { isActive: true, sortOrder: 10 }]);
  r = await call("POST", "/admin/periods", { name: "Bad", startTime: "17:00", endTime: "18:00", isActive: "no" });
  check("POST with a bad isActive is refused", r.status, 400);

  console.log("--- F. tenancy unchanged ---");
  r = await call("PUT", "/admin/periods/pb", { isActive: false });
  check("another school's period is 404 and untouched", [r.status, await state("pb")], [404, { isActive: true, sortOrder: 1 }]);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
