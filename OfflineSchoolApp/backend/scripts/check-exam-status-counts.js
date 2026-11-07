// backend/scripts/check-exam-status-counts.js
"use strict";

/**
 * Exams by status: every status counted, and the parts adding up to the total.
 *
 * The dashboard's count named four of the six statuses, so a school whose
 * exams were published saw "Total 2" over a bar of 0% segments. All three
 * endpoints now read services/examStatusCounts.service.js.
 *
 *   node scripts/check-exam-status-counts.js
 */

const { stopQuietly } = require("./stopQuietly");
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
  const Exam = require("../src/db/models/Exam");
  const { countExamsByStatus, EXAM_STATUSES } = require("../src/services/examStatusCounts.service");

  check("every status the model allows is counted",
    EXAM_STATUSES, ["draft", "scheduled", "ongoing", "completed", "published", "archived"]);

  const S = "school-1";
  const raw = Exam.collection;   // straight to the collection: no validation in the way
  await raw.insertMany([
    { schoolId: S, status: "published", deletedAt: null },
    { schoolId: S, status: "published", deletedAt: null },
    { schoolId: S, status: "completed", deletedAt: null },
    { schoolId: S, status: "draft",     deletedAt: null },
    { schoolId: S, status: "archived",  deletedAt: null },
    { schoolId: S, status: "published", deletedAt: new Date() },   // deleted
    { schoolId: "other", status: "draft", deletedAt: null },       // another school
  ]);

  const c = await countExamsByStatus({ schoolId: S, deletedAt: null });
  check("published and archived exams are counted (the dashboard dropped them)",
    [c.published, c.archived], [2, 1]);
  check("the total is the sum of the parts",
    [c.total, EXAM_STATUSES.reduce((n, s) => n + c[s], 0)], [5, 5]);
  check("deleted exams and other schools are left out", c.draft, 1);

  await raw.insertOne({ schoolId: S, status: "retired-status", deletedAt: null });
  const d = await countExamsByStatus({ schoolId: S, deletedAt: null });
  check("a status outside the enum is counted apart, never dropped", [d.total, d.other], [6, 1]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
