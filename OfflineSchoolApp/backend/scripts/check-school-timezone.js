// backend/scripts/check-school-timezone.js
"use strict";

/**
 * Cameroon time (docs/40 0.11): a new school's time zone is Africa/Douala;
 * a school created before keeps what it stored; and a date printed near
 * midnight UTC falls on the Cameroon day when the server runs with
 * TZ=Africa/Douala, as the backend and nginx services now do
 * (docker-compose.yml; check:deployconfig holds the TZ line).
 *
 *   node scripts/check-school-timezone.js
 */

const { stopQuietly } = require("./stopQuietly");
const path = require("path");
const { execFile } = require("child_process");
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
  const School = require("../src/db/models/School");

  const fresh = await School.create({ _id: new mongoose.Types.ObjectId().toString(), name: "New School", email: "new@example.test" });
  check("a new school's time zone is Africa/Douala", (await School.findById(fresh._id).lean()).settings?.timezone, "Africa/Douala");

  // A school stored before, with UTC, as the old default wrote it.
  const oldId = new mongoose.Types.ObjectId();
  await mongoose.connection.db.collection("schools").insertOne({ _id: oldId, name: "Old School", email: "old@example.test", settings: { timezone: "UTC" } });
  check("an existing school keeps the time zone it stored", (await School.findById(oldId).lean()).settings?.timezone, "UTC");

  // 23:30 UTC on 1 November is 00:30 on 2 November in Douala (UTC+1).
  const printed = (tz) => new Promise((resolve, reject) => execFile(process.execPath, ["-e",
    `const { formatPrintDate } = require(${JSON.stringify(path.join(__dirname, "../src/print/labels"))});` +
    `process.stdout.write(JSON.stringify([formatPrintDate(new Date("2026-11-01T23:30:00Z"), "en"), formatPrintDate(new Date("2026-11-01T23:30:00Z"), "fr")]))`],
    { env: { PATH: process.env.PATH, TZ: tz } }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out)))));
  check("printed at 23:30 UTC with TZ=Africa/Douala: the Cameroon day, 2 November", await printed("Africa/Douala"), ["2 November 2026", "2 novembre 2026"]);
  check("…where a server left on UTC printed 1 November", await printed("UTC"), ["1 November 2026", "1 novembre 2026"]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("check failed:", e); process.exit(1); });
