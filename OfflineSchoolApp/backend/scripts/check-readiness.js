// backend/scripts/check-readiness.js
"use strict";

/**
 * GET /api/health/ready answers 200 only while the database answers, and 503
 * otherwise, saying nothing about the database beyond that
 * (services/readiness.service.js). In-memory MongoDB only.
 *
 *   node scripts/check-readiness.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");
const { checkReadiness } = require("../src/services/readiness.service");

(async () => {
  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  check("before any connection: not ready", await checkReadiness(mongoose.connection),
    { ready: false, database: "disconnected" });

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  check("connected and answering a ping: ready", await checkReadiness(mongoose.connection),
    { ready: true, database: "connected" });

  // A ping that never comes back: the open connection is not taken on trust.
  const realDb = mongoose.connection.db;
  const stalled = { admin: () => ({ ping: () => new Promise(() => {}) }) };
  Object.defineProperty(mongoose.connection, "db", { value: stalled, configurable: true });
  const started = Date.now();
  const r = await checkReadiness(mongoose.connection, 200);
  check("a ping that does not answer in time: not ready, and nothing about why",
    [r, Date.now() - started < 2000], [{ ready: false, database: "unreachable" }, true]);
  Object.defineProperty(mongoose.connection, "db", { value: realDb, configurable: true });
  delete mongoose.connection.db;

  await mongoose.disconnect();
  check("after disconnecting: not ready", await checkReadiness(mongoose.connection),
    { ready: false, database: "disconnected" });

  // ── the indexes a school's data depends on ──────────────────────────────
  const { indexReadiness } = require("../src/services/readiness.service");
  const at = new Date();
  check("production, unique indexes missing: not ready, and says why",
    indexReadiness({ checkedAt: at, criticalProblems: 49 }, { production: true }),
    { ok: false, indexes: "incomplete", criticalProblems: 49 });
  check("  outside production: reported, not blocking",
    indexReadiness({ checkedAt: at, criticalProblems: 49 }, { production: false }).ok, true);
  check("  all in place: ready",
    indexReadiness({ checkedAt: at, criticalProblems: 0 }, { production: true }),
    { ok: true, indexes: "ok", criticalProblems: 0 });
  check("  never checked: reported as unchecked, never as ok",
    indexReadiness({ checkedAt: null, criticalProblems: null }, { production: true }),
    { ok: true, indexes: "unchecked", criticalProblems: null });

  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
