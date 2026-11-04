// backend/src/db/ensureStudentIndexes.js
"use strict";

const mongoose = require("mongoose");

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SELF-HEAL: students.gateToken unique index
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Symptom:  POST /api/students → 409 "E11000 duplicate key error collection:
 *           ... students index: gateToken_1 dup key: { gateToken: null }"
 *
 * Why:      Student.js declares gateToken with `default: null`, so EVERY
 *           student document is stored with an explicit `gateToken: null`.
 *           Older databases carry a unique NON-sparse `gateToken_1`, and even
 *           the "fixed" sparse version does NOT help: MongoDB sparse indexes
 *           only exclude documents where the field is MISSING — a field that
 *           is present with value null IS indexed, so uniqueness still applies
 *           to null. The second student without a card therefore collides.
 *
 * Fix:      At boot, inspect the live index. If `gateToken_1` exists without
 *           the partialFilterExpression that excludes non-string tokens, drop
 *           it and recreate as
 *             { unique: true,
 *               partialFilterExpression: { gateToken: { $type: "string" } } }
 *           Real tokens stay unique (that is the point of the gate-card lookup
 *           in gate.service); null/absent tokens are excluded from the index
 *           entirely, so any number of card-less students can coexist — no
 *           data migration needed for the existing nulls.
 *           Idempotent — after the first run it no-ops on every later boot.
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function ensureStudentGateTokenIndex() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error(
      "ensureStudentGateTokenIndex: no MongoDB connection available"
    );
  }

  const col = db.collection("students");

  // 1) What does the live index look like? On a database that has never
  //    held a student — a fresh deployment, or a verification run against an
  //    empty instance — the collection does not exist yet and MongoDB answers
  //    "ns does not exist" (code 26) rather than an empty list. That is not a
  //    stale index; it is no index, and createIndex below brings the
  //    collection into being with the right shape. Found when the server
  //    refused to boot against an empty database.
  const indexes = await col.indexes().catch((err) => {
    if (err && (err.code === 26 || err.codeName === "NamespaceNotFound")) return [];
    throw err;
  });
  const current = indexes.find(
    (ix) =>
      ix.name === "gateToken_1" ||
      (ix.key && ix.key.gateToken !== undefined && Object.keys(ix.key).length === 1)
  );

  if (
    current &&
    current.partialFilterExpression &&
    current.partialFilterExpression.gateToken &&
    current.unique
  ) {
    // Already the intended shape — nothing to do.
    console.log("[indexes] students.gateToken_1 is unique+partial ✅");
    return;
  }

  if (current) {
    // 2) Stale index (unique non-sparse, or sparse without the partial
    //    filter) — either shape rejects the second `{ gateToken: null }`.
    console.warn(
      `[indexes] students.gateToken_1 is stale (unique=${!!current.unique}, ` +
        `sparse=${!!current.sparse}, partial=${!!current.partialFilterExpression}) — dropping it`
    );
    await col.dropIndex(current.name);
  }

  // 3) Recreate exactly as the model declares it.
  await col.createIndex(
    { gateToken: 1 },
    {
      unique: true,
      partialFilterExpression: { gateToken: { $type: "string" } },
      name: "gateToken_1",
    }
  );

  const after = await col.indexes();
  const recreated = after.find((ix) => ix.name === "gateToken_1");
  console.log(
    `[indexes] students.gateToken_1 recreated → unique=${!!recreated?.unique}, ` +
      `sparse=${!!recreated?.sparse}`
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REQUIRED: idempotencykeys (key, userId) unique index
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Symptom:  none. That is the entire problem.
 *
 * Why:      middleware/idempotency.js is what makes a repeated write safe. It
 *           works by INSERTING a record for the key and catching the duplicate-
 *           key error, and the duplicate-key error is thrown by the unique index
 *           and by nothing else. Take the index away and every insert succeeds,
 *           every request looks new, and the middleware waves each one through
 *           while appearing to work perfectly.
 *
 *           Nothing created that index on purpose. Mongoose's autoIndex default
 *           built it in the background, some time after boot — so there was a
 *           window on every start during which writes were unprotected, and if a
 *           background build ever failed (duplicates already in the collection,
 *           or autoIndex turned off in a future config change) it would never
 *           exist again and nothing would say so.
 *
 *           That was tolerable while nothing replayed requests. It is not now:
 *           the desktop application queues writes while offline and replays them
 *           on reconnect, and a replay that is not deduplicated is a second
 *           payment, a second expense, a second exam.
 *
 * Fix:      create the declared indexes at boot and then CHECK that the unique
 *           one is actually there, because createIndexes can succeed for the TTL
 *           index while failing for this one.
 *
 *           A failure is reported rather than thrown. An inert response cache
 *           must not stop a school from taking fees for the day — but it must
 *           not be quiet either, so the message says what is wrong, what it
 *           costs, and the one command that fixes it.
 *
 *           Idempotent: no-ops on every later boot.
 *
 * Pinned by scripts/check-idempotency.js, which fails 12 of its 24 assertions
 * with the index absent and passes all 24 with it.
 * ═══════════════════════════════════════════════════════════════════════════
 */
async function ensureIdempotencyIndex() {
  const IdempotencyKey = require("./models/IdempotencyKey");

  const present = async () => {
    const indexes = await IdempotencyKey.collection.indexes();
    return indexes.some(
      (ix) =>
        ix.unique &&
        ix.key &&
        ix.key.key === 1 &&
        ix.key.userId === 1 &&
        Object.keys(ix.key).length === 2
    );
  };

  // First, so createIndexes below does not trip over an old TTL with
  // IndexOptionsConflict. Never throws.
  await ensureIdempotencyTtl();

  try {
    // Creates whatever the model declares, so the shape lives in the model and
    // not in a second copy here that can drift from it.
    await IdempotencyKey.createIndexes();
  } catch (err) {
    // Almost always duplicates already in the collection, which itself means the
    // middleware has been inert for a while.
    console.error(
      "[indexes] idempotencykeys: could not create the declared indexes — " +
        err.message
    );
  }

  await reportIdempotencyTtl();

  if (await present()) {
    console.log("[indexes] idempotencykeys (key, userId) is unique ✅");
    return;
  }

  const dupes = await IdempotencyKey.aggregate([
    { $group: { _id: { key: "$key", userId: "$userId" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: "groups" },
  ]);

  console.error(`
════════════════════════════════════════════════════════════════════
  IDEMPOTENCY IS NOT BEING ENFORCED
════════════════════════════════════════════════════════════════════
  The unique index on idempotencykeys (key, userId) is missing, so
  middleware/idempotency.js cannot detect a repeated request. Every
  write replayed by an offline client — a payment, an expense — will
  be recorded a second time, and the server will look as though it
  handled it correctly.

  Duplicate (key, userId) groups already stored: ${dupes[0]?.groups ?? 0}

  To fix, remove the duplicates and create the index:
    db.idempotencykeys.deleteMany({})
    db.idempotencykeys.createIndex({ key: 1, userId: 1 }, { unique: true })

  Dropping the collection is safe: it holds ~45 days of cached
  responses, not records of anything. The cost is that writes already
  in flight lose their protection.
════════════════════════════════════════════════════════════════════
`);
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REQUIRED: idempotencykeys TTL = IdempotencyKey.TTL_SECONDS (45 days)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The supported offline period is 30 days, so a key must outlive it (see
 * models/IdempotencyKey.js). Mongo does not change an existing TTL index when
 * the schema's expireAfterSeconds changes, and createIndexes on the same key
 * with another TTL fails with IndexOptionsConflict — so a database built when
 * the TTL was 14 days would keep expiring keys after 14 days forever, and a
 * device back from three weeks offline would replay writes unprotected.
 *
 * Brought to the declared value here, at every boot, before createIndexes:
 *   no collection / no createdAt index  → nothing (createIndexes builds it)
 *   TTL already right                   → nothing (idempotent)
 *   TTL different                       → collMod (in place, no rebuild)
 *   collMod refused, or a plain index   → drop + recreate THAT index only
 * Dropping the TTL index for a moment only delays expiry; the unique
 * (key, userId) index — the one that deduplicates — is never touched.
 *
 * Never throws: an expiry setting must not stop the school's server. A
 * failure is reported, loudly, by reportIdempotencyTtl().
 *
 * @returns {Promise<"absent"|"ok"|"updated"|"rebuilt"|"failed">}
 */
const isCreatedAtIndex = (i) =>
  Boolean(i.key) && Object.keys(i.key).length === 1 && i.key.createdAt === 1;

async function ensureIdempotencyTtl() {
  const IdempotencyKey = require("./models/IdempotencyKey");
  const ttl  = IdempotencyKey.TTL_SECONDS;
  const coll = IdempotencyKey.collection;

  let live;
  try {
    live = await coll.indexes();
  } catch {
    return "absent"; // no collection yet: createIndexes builds it right
  }
  const ix = live.find(isCreatedAtIndex);
  if (!ix) return "absent";
  if (ix.expireAfterSeconds === ttl) return "ok";

  const was = ix.expireAfterSeconds ?? "none";
  if (ix.expireAfterSeconds != null) {
    try {
      await IdempotencyKey.db.db.command({
        collMod: coll.collectionName,
        index: { name: ix.name, expireAfterSeconds: ttl },
      });
      console.log(`[indexes] idempotencykeys TTL ${was}s → ${ttl}s (collMod)`);
      return "updated";
    } catch (err) {
      console.warn(`[indexes] idempotencykeys TTL collMod refused (${err.message}); rebuilding that index`);
    }
  }
  try {
    await coll.dropIndex(ix.name);
    await coll.createIndex({ createdAt: 1 }, { name: ix.name, expireAfterSeconds: ttl });
    console.log(`[indexes] idempotencykeys TTL ${was} → ${ttl}s (index rebuilt)`);
    return "rebuilt";
  } catch (err) {
    console.error(`[indexes] idempotencykeys: could not set the TTL to ${ttl}s — ${err.message}`);
    return "failed";
  }
}

/** Says, after the build, whether the live TTL is the declared one. */
async function reportIdempotencyTtl() {
  const IdempotencyKey = require("./models/IdempotencyKey");
  const ttl = IdempotencyKey.TTL_SECONDS;
  let live = [];
  try { live = await IdempotencyKey.collection.indexes(); } catch { /* reported below */ }
  const ix = live.find(isCreatedAtIndex);
  if (ix?.expireAfterSeconds === ttl) {
    console.log(`[indexes] idempotencykeys TTL is ${IdempotencyKey.TTL_DAYS} days ✅`);
    return true;
  }
  console.error(
    `[indexes] idempotencykeys TTL is ${ix?.expireAfterSeconds ?? "missing"}, expected ${ttl}s ` +
      `(${IdempotencyKey.TTL_DAYS} days, above the 30-day offline period). Fix: ` +
      `db.runCommand({ collMod: "idempotencykeys", index: { keyPattern: { createdAt: 1 }, expireAfterSeconds: ${ttl} } })`
  );
  return false;
}

module.exports = {
  ensureStudentGateTokenIndex,
  ensureIdempotencyIndex,
  ensureIdempotencyTtl,
  reportIdempotencyTtl,
};