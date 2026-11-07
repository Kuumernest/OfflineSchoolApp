// backend/scripts/check-idempotency-ttl.js
"use strict";

/**
 * The idempotency key outlives the 30-day offline period — in a new database
 * AND in one built when the TTL was 14 days.
 *
 * Owner decision: devices may be offline for up to 30 days. A write queued on
 * day 1 and replayed on day 30 is deduplicated only if its key still exists, so
 * models/IdempotencyKey.js declares 45 days. Mongo keeps the TTL an index was
 * built with, so the declaration alone changes nothing in production;
 * ensureIdempotencyIndex() (run at every boot) brings the live index to it.
 *
 *   new database             → built at 45 days
 *   old 14-day TTL index     → collMod to 45 days, rows and unique index kept
 *   a plain createdAt index  → rebuilt as the 45-day TTL index
 *   second boot              → no change (idempotent)
 *   the boot index check and provision-indexes then call it "present"
 *
 *   node scripts/check-idempotency-ttl.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

const DAY = 24 * 60 * 60;
const EXPECTED = 45 * DAY;
const OLD = 14 * DAY;

(async () => {
  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  require("../src/db/models");
  // As production connects: nothing built behind the boot's back.
  await mongoose.connect(mongo.getUri(), { autoIndex: false, autoCreate: false });
  const IdempotencyKey = require("../src/db/models/IdempotencyKey");
  const idx = require("../src/db/ensureStudentIndexes");
  const coll = () => mongoose.connection.db.collection("idempotencykeys");

  const ttlIndex = async () =>
    (await coll().indexes()).find((i) => Object.keys(i.key).length === 1 && i.key.createdAt === 1) ?? null;
  const uniqueThere = async () =>
    (await coll().indexes()).some((i) => i.unique && i.key.key === 1 && i.key.userId === 1);

  // Boot output is noise here; the outcomes are asserted.
  const quietly = async (fn) => {
    const { log, warn, error } = console;
    const said = [];
    console.log = console.warn = console.error = (...a) => said.push(a.join(" "));
    try { return { value: await fn(), said }; } finally { Object.assign(console, { log, warn, error }); }
  };

  try {
    console.log("--- the declaration ---");
    const declared = IdempotencyKey.schema.indexes().find(([k]) => k.createdAt === 1)?.[1]?.expireAfterSeconds;
    check("the model declares 45 days", declared, EXPECTED);
    check("  which is above the 30-day offline period with margin", declared - 30 * DAY >= 14 * DAY, true);
    check("  and is exported as one constant", [IdempotencyKey.TTL_DAYS, IdempotencyKey.TTL_SECONDS], [45, EXPECTED]);

    console.log("--- a new database ---");
    await quietly(() => idx.ensureIdempotencyIndex());
    check("boot builds the TTL index at 45 days", (await ttlIndex())?.expireAfterSeconds, EXPECTED);
    check("  and the unique (key, userId) index", await uniqueThere(), true);
    check("  ensureIdempotencyTtl then reports ok", (await quietly(() => idx.ensureIdempotencyTtl())).value, "ok");

    console.log("--- an existing database with the old 14-day index ---");
    await coll().drop();
    await coll().createIndex({ key: 1, userId: 1 }, { unique: true, name: "key_1_userId_1" });
    await coll().createIndex({ createdAt: 1 }, { expireAfterSeconds: OLD, name: "createdAt_1" });
    const now = new Date();
    await coll().insertMany([
      { key: "k1", userId: "u1", method: "POST", path: "/api/fees", state: "completed", statusCode: 201, response: {}, createdAt: now, updatedAt: now },
      { key: "k2", userId: "u1", method: "POST", path: "/api/fees", state: "completed", statusCode: 201, response: {}, createdAt: now, updatedAt: now },
    ]);
    check("  (the case under test: TTL is 14 days)", (await ttlIndex())?.expireAfterSeconds, OLD);
    const old = await quietly(() => idx.ensureIdempotencyIndex());
    check("boot moves it to 45 days", (await ttlIndex())?.expireAfterSeconds, EXPECTED);
    check("  in place (collMod), saying what it changed",
      old.said.some((l) => l.includes(`${OLD}s → ${EXPECTED}s (collMod)`)), true);
    check("  without the IndexOptionsConflict a plain createIndexes would hit",
      old.said.some((l) => /could not create the declared indexes/.test(l)), false);
    check("  the stored keys are kept", await coll().countDocuments(), 2);
    check("  the unique index is untouched", await uniqueThere(), true);
    check("  and the boot says the TTL is right", old.said.some((l) => l.includes("TTL is 45 days")), true);

    const again = await quietly(() => idx.ensureIdempotencyIndex());
    check("a second boot changes nothing", (await ttlIndex())?.expireAfterSeconds, EXPECTED);
    check("  and says nothing about changing it", again.said.some((l) => /→/.test(l)), false);

    console.log("--- a createdAt index that is not a TTL at all ---");
    await coll().dropIndex("createdAt_1");
    await coll().createIndex({ createdAt: 1 }, { name: "createdAt_1" });
    const plain = await quietly(() => idx.ensureIdempotencyTtl());
    check("is rebuilt as the TTL index", [plain.value, (await ttlIndex())?.expireAfterSeconds], ["rebuilt", EXPECTED]);
    check("  rows still there, unique index still there", [await coll().countDocuments(), await uniqueThere()], [2, true]);

    console.log("--- the other index readers agree ---");
    const { compareIndex } = require("../src/services/indexCheck.service");
    const [ttlKey, ttlOpts] = IdempotencyKey.schema.indexes().find(([k]) => k.createdAt === 1);
    check("indexCheck calls the live TTL index present", compareIndex(ttlKey, ttlOpts, await coll().indexes()).status, "present");
    const { provision } = require("./provision-indexes");
    const plan = await provision({ only: ["IdempotencyKey"], log: () => {} });
    check("provision-indexes plans nothing for IdempotencyKey",
      plan.rows.map((r) => r.status), ["present", "present"]);

    console.log("--- a failure is said out loud ---");
    await coll().dropIndex("createdAt_1");
    const missing = await quietly(() => idx.reportIdempotencyTtl());
    check("a missing TTL index is reported, with the fix",
      [missing.value, missing.said.some((l) => l.includes("collMod"))], [false, true]);
  } finally {
    await mongoose.disconnect();
    await stopQuietly(mongo);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
