// backend/scripts/check-expense-category-defaults.js
"use strict";

/**
 * A school with no expense categories starts with the usual five.
 *
 * Before this a new school's expense book was empty and "Record expense" was
 * disabled until somebody invented a category. Now:
 *
 *   - POST /api/super-admin/schools seeds utilities, maintenance, stationery,
 *     transport and events (English label + French labelFr);
 *   - GET /api/finance/expense-categories seeds them for a school that has
 *     NEVER had a category (schools created before this);
 *   - a school with its own categories, or one that retired them all, is left
 *     alone; reading twice, or seeding concurrently, never duplicates.
 *
 *   node scripts/check-expense-category-defaults.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const CODES = ["events", "maintenance", "stationery", "transport", "utilities"];

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
  const Cat = M("ExpenseCategory");

  const OLD = "68f0000000000000000000b1";   // existed before seeding, no categories
  const OWN = "68f0000000000000000000b2";   // made its own category
  const RET = "68f0000000000000000000b3";   // retired the only category it had
  const RACE = "68f0000000000000000000b4";
  await M("School").create([
    { _id: OLD,  name: "Old School",     email: "old@example.test" },
    { _id: OWN,  name: "Own Ways",       email: "own@example.test" },
    { _id: RET,  name: "Retired Things", email: "ret@example.test" },
    { _id: RACE, name: "Race Academy",   email: "race@example.test" },
  ]);
  await M("User").create([
    { _id: "root",       name: "Root",     email: "root@example.test", password: "Check-only-passw0rd", role: "super_admin", schoolId: null, isActive: true },
    { _id: "bursar-old", name: "Bursar O", email: "bo@example.test",   password: "Check-only-passw0rd", role: "bursar", schoolId: OLD, isActive: true },
    { _id: "bursar-own", name: "Bursar W", email: "bw@example.test",   password: "Check-only-passw0rd", role: "bursar", schoolId: OWN, isActive: true },
    { _id: "bursar-ret", name: "Bursar R", email: "br@example.test",   password: "Check-only-passw0rd", role: "bursar", schoolId: RET, isActive: true },
  ]);
  await Cat.create({ schoolId: OWN, code: "GEN", label: "General" });
  await Cat.create({ schoolId: RET, code: "OLD", label: "Retired", deletedAt: new Date() });

  const auth = require(path.join(ROOT, "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/super-admin", auth.authenticate, require(path.join(SRC, "routes/superAdmin.routes")));
  app.use("/api/finance",     auth.authenticate, require(path.join(SRC, "routes/finance.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API    = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, url, token, body) => {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const token = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const ROOT_T = token("root", "super_admin", null);
  const codes = (rows) => (rows ?? []).map((r) => r.code).sort();
  const live  = async (schoolId) => codes(await Cat.find({ schoolId, deletedAt: null }).lean());

  console.log("\n--- a school created on the platform starts with the defaults ---");
  const made = await call("POST", "/super-admin/schools", ROOT_T, { name: "Brand New College", email: "new@example.test" });
  const NEW = made.body?.data?.school?._id ?? made.body?.school?._id;
  check("POST /super-admin/schools → 201", made.status, 201);
  check("it has the five default categories", await live(NEW), CODES);
  const util = await Cat.findOne({ schoolId: NEW, code: "utilities" }).lean();
  check("with an English label and a French labelFr", [util?.label, util?.labelFr], ["Utilities", "Services publics"]);

  console.log("\n--- a school that never had a category gets them on first read ---");
  const OLD_T = token("bursar-old", "bursar", OLD);
  let r = await call("GET", "/finance/expense-categories", OLD_T);
  check("GET answers 200 with the five defaults", [r.status, codes(r.body?.data)], [200, CODES]);
  r = await call("GET", "/finance/expense-categories", OLD_T);
  check("a second read does not add a second set", [r.body?.count, await Cat.countDocuments({ schoolId: OLD })], [5, 5]);

  await Cat.updateOne({ schoolId: OLD, code: "events" }, { $set: { deletedAt: new Date() } });
  r = await call("GET", "/finance/expense-categories", OLD_T);
  check("a default the school retired stays retired", codes(r.body?.data), ["maintenance", "stationery", "transport", "utilities"]);

  console.log("\n--- a school with its own categories is left alone ---");
  r = await call("GET", "/finance/expense-categories", token("bursar-own", "bursar", OWN));
  check("only the category it made", codes(r.body?.data), ["GEN"]);
  r = await call("GET", "/finance/expense-categories", token("bursar-ret", "bursar", RET));
  check("a school that retired every category is not re-seeded", [r.status, r.body?.count], [200, 0]);

  console.log("\n--- never for a school that does not exist ---");
  const GHOST = "68f00000000000000000dead";
  r = await call("GET", `/finance/expense-categories?schoolId=${GHOST}`, ROOT_T);
  check("a super_admin naming no real school writes nothing", [r.status < 500, await Cat.countDocuments({ schoolId: GHOST })], [true, 0]);

  console.log("\n--- concurrent first reads seed once ---");
  const { ensureDefaultExpenseCategories, defaultCategoryId } =
    require(path.join(SRC, "services/expenseCategories.service"));
  await Promise.all([1, 2, 3, 4].map(() => ensureDefaultExpenseCategories(RACE)));
  check("four racing seeds leave exactly five rows", await Cat.countDocuments({ schoolId: RACE }), 5);
  const ids = (await Cat.find({ schoolId: RACE }).lean()).map((c) => c._id).sort();
  check("ids are a function of (school, code)", ids, CODES.map((c) => defaultCategoryId(RACE, c)).sort());
  check("and differ between schools", defaultCategoryId(RACE, "utilities") === defaultCategoryId(OLD, "utilities"), false);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
