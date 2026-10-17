// backend/scripts/check-index-boot.js
"use strict";

/**
 * The boot-time index check (services/indexCheck.service.js, docs/40 0.19):
 * after the models build their indexes, every declared index is verified and
 * none is missing; with one dropped, exactly that one is reported, on its own
 * line, and the summary says so. It never throws. In-memory MongoDB.
 *
 *   node scripts/check-index-boot.js
 */

const { stopQuietly } = require("./stopQuietly");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

(async () => {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init().catch(() => null)));
  const { verifyDeclaredIndexes } = require("../src/services/indexCheck.service");

  const lines = [];
  const all = await verifyDeclaredIndexes({ log: (l) => lines.push(l) });
  const declared = mongoose.modelNames().reduce((n, m) => n + mongoose.model(m).schema.indexes().length, 0);
  check("after the models build, every declared index is there", [all.missing.length, all.verified === declared, all.verified > 50], [0, true, true]);
  check("one summary line", lines, [`[indexes] Indexes verified: ${declared}, missing: 0`]);

  // Drop one compound index, as a failed background build would leave it.
  const Student = mongoose.model("Student");
  const target = (await Student.collection.indexes()).find((ix) => ix.name !== "_id_" && Object.keys(ix.key).length > 1);
  await Student.collection.dropIndex(target.name);
  lines.length = 0;
  const one = await verifyDeclaredIndexes({ log: (l) => lines.push(l) });
  const spec = Object.entries(target.key).map(([k, v]) => `${k}: ${v}`).join(", ");
  check("one dropped: exactly that one is reported", one.missing.map((m) => [m.collection, m.key]), [["students", target.key]]);
  check("on its own line, then the summary",
    lines, [`[indexes] missing on students: { ${spec} }${target.unique ? " (unique)" : ""}`, `[indexes] Indexes verified: ${declared - 1}, missing: 1`]);

  // A unique index replaced by a plain one on the same key: the key pattern
  // matches, so this used to count as "verified". It enforces nothing.
  const { indexState } = require("../src/services/indexCheck.service");
  const ExamMark = mongoose.model("ExamMark");
  const uniq = (await ExamMark.collection.indexes()).find((ix) => ix.unique);
  await ExamMark.collection.dropIndex(uniq.name);
  await ExamMark.collection.createIndex(uniq.key, { name: "plain_lookalike" });
  lines.length = 0;
  const lookalike = await verifyDeclaredIndexes({ log: (l) => lines.push(l) });
  check("a plain index where a unique one is declared: INCOMPATIBLE, not verified",
    [lookalike.incompatible.map((m) => [m.collection, m.unique]), lookalike.verified, lookalike.criticalProblems],
    [[["exammarks", true]], declared - 2, 1]);
  check("  said as an error with what to run, and in the summary",
    [lines.some((l) => l.startsWith("[indexes] INCOMPATIBLE on exammarks") && l.includes("plain_lookalike")),
     lines.some((l) => l.includes("Indexes verified:") && l.endsWith("incompatible: 1")),
     lines.some((l) => l.includes("unique/TTL index(es) missing or incompatible") && l.includes("provision-indexes"))],
    [true, true, true]);
  check("  and kept for the readiness check", [indexState().criticalProblems, indexState().checkedAt instanceof Date], [1, true]);

  // A collection that does not exist yet: its indexes are missing, and nothing throws.
  await mongoose.connection.db.dropCollection("students");
  let threw = false, r = null;
  try { r = await verifyDeclaredIndexes({ log: () => {} }); } catch { threw = true; }
  check("a missing collection: its indexes reported missing, never a throw",
    [threw, r?.missing.filter((m) => m.collection === "students").length === Student.schema.indexes().length], [false, true]);

  const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  check("the server runs it at boot, inside a try (never fatal)",
    /try \{\s*await Promise\.all\(mongoose\.modelNames\(\)[\s\S]{0,200}verifyDeclaredIndexes\(\);\s*\} catch/.test(server), true);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("check failed:", e); process.exit(1); });
