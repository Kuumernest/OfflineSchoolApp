// backend/scripts/check-portal-codes.js
"use strict";

/**
 * C8 — the Portal access list (GET /api/documents/guardian-access).
 *
 *   tem    label "Mrs Tem", opens Ama and Bih, both guardian "Mrs Tem"    → names once
 *   nolab  no label, opens Cho (guardian "Mr Ndi"), opened yesterday      → guardianNames ["Mr Ndi"]
 *   gone   opens Dan only, and Dan has been deleted                       → linked to no student
 *   empty  opens nobody at all                                            → linked to no student
 *
 *   node scripts/check-portal-codes.js
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

  const S = "sch-1";
  await M("User").create({
    _id: "adm-1", name: "Admin", email: "adm@example.test",
    password: "check-only-password", role: "school_admin", schoolId: S, isActive: true,
  });
  const pupil = (id, name, guardianName, extra = {}) => M("Student").create({
    _id: id, userId: `usr-${id}`, schoolId: S, classId: "cls-1",
    studentName: name, enrollmentNo: `EN-${id}`, guardianName, isActive: true, ...extra,
  });
  await pupil("ama", "Ama", "Mrs Tem");
  await pupil("bih", "Bih", " Mrs Tem ");
  await pupil("cho", "Cho", "Mr Ndi");
  await pupil("dan", "Dan", "Mr Fon", { deletedAt: new Date() });
  // One guardian, three children — the ordinary family, not a duplicate.
  for (const [id, name] of [["eve", "Eve"], ["fay", "Fay"], ["gus", "Gus"]]) {
    await pupil(id, name, "Mrs Bate", { guardianEmail: "bate@gmail.com", guardianPhone: "+237670000001" });
  }
  await pupil("hal", "Hal", "Mrs Bate", { deletedAt: new Date() });

  const yesterday = new Date(Date.now() - 86_400_000);
  const access = (_id, studentIds, extra = {}) => M("GuardianAccess").create({
    _id, schoolId: S, studentIds, codeHash: "$2a$10$check.only", codeHint: "11", ...extra,
  });
  await access("tem",   ["ama", "bih"], { label: "Mrs Tem" });
  await access("nolab", ["cho"], { lastSeenAt: yesterday });
  await access("gone",  ["dan"]);
  await access("empty", []);
  await access("bate",  ["eve", "fay", "gus"]);
  await access("part",  ["hal", "eve"]);

  const auth = require(path.join(__dirname, "..", "middleware", "auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/documents", auth.authenticate, require(path.join(SRC, "routes/documents.routes")));
  const server = app.listen(0);
  const token  = jwt.sign({ id: "adm-1", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const res    = await fetch(`http://127.0.0.1:${server.address().port}/api/documents/guardian-access?schoolId=${S}`,
    { headers: { Authorization: `Bearer ${token}` } });
  const body   = await res.json().catch(() => ({}));
  const row    = (id) => (body.data ?? []).find((r) => r._id === id) ?? {};

  console.log("\n--- the list ---");
  check("the office reads the list → 200", res.status, 200);
  check("a guardian named on two children's records is named once",
    row("tem").guardianNames, ["Mrs Tem"]);
  check("a code issued with no label still has a guardian to show",
    [row("nolab").label, row("nolab").guardianNames], [null, ["Mr Ndi"]]);
  check("last opened is returned when the code was used",
    row("nolab").lastSeenAt, yesterday.toISOString());
  check("and is null when it never was (the page says Never)", row("tem").lastSeenAt, null);

  console.log("\n--- codes linked to no student ---");
  check("a code whose only child was deleted is flagged",
    [row("gone").linkedToNoStudent, row("gone").children], [true, []]);
  check("a code with no children at all is flagged", row("empty").linkedToNoStudent, true);
  check("codes that open a current pupil are not",
    [row("tem").linkedToNoStudent, row("nolab").linkedToNoStudent], [false, false]);

  console.log("\n--- one guardian, three children ---");
  check("one code lists all three children, in order",
    (row("bate").children ?? []).map((c) => c.name), ["Eve", "Fay", "Gus"]);
  check("the guardian is named once, and the code is not flagged",
    [row("bate").guardianNames, row("bate").linkedToNoStudent], [["Mrs Bate"], false]);
  check("a code with one child left of two is not flagged (only zero children is)",
    [row("part").linkedToNoStudent, (row("part").children ?? []).map((c) => c.name)], [false, ["Eve"]]);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
