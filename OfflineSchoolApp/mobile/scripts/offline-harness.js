// mobile/scripts/offline-harness.js
"use strict";

/**
 * The phone, minus the phone: the REAL mobile services and the REAL table
 * setup (db/database.js, db/quizSchema.js, the SyncManager migrations) over a
 * real SQLite (node:sqlite), with the device packages stubbed.
 *
 * Shared by check-offline-p0.js (a fake server that records what it is sent)
 * and check-offline-e2e.js (the real backend routes over an in-memory
 * MongoDB). Not a check itself.
 *
 * What is stubbed, and why it is safe to stub:
 *   expo-sqlite         → the node:sqlite database, through expo's async API
 *   NetInfo             → `net.connected`, which a check flips to go offline
 *   src/services/api    → whatever client the caller passes (api.js itself
 *                         is axios plus interceptors for tokens and
 *                         connectivity; its offline guard is reproduced by
 *                         the caller's client)
 *   src/store/auth.store→ a signed-in account; the global sync lock always
 *                         granted (it only arbitrates between timers)
 *   content.service     → no attachments to upload
 */

const path  = require("path");
const fs    = require("fs");
const nodeCrypto = require("crypto");
const babel = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

const MOBILE = path.join(__dirname, "..");

/** expo-sqlite's async surface, over a real synchronous SQLite. */
const adapt = (db) => ({
  execAsync:     async (sql) => { db.exec(sql); },
  runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
  getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  withTransactionAsync: async (fn) => { await fn(); },
  closeAsync:    async () => {},
});

const makeLoader = (pkgStubs, relStubs) => {
  const cache = new Map();
  const load = (abs) => {
    const key = abs.replace(/\.js$/, "");
    for (const [rel, stub] of relStubs) if (key.endsWith(rel)) return stub;
    if (cache.has(key)) return cache.get(key).exports;
    const file = fs.existsSync(`${key}.js`) ? `${key}.js` : `${key}/index.js`;
    const { code } = babel.transformFileSync(file, {
      presets: [require.resolve("babel-preset-expo")],
      caller:  { name: "check", supportsStaticESM: false },
      babelrc: false, configFile: false,
    });
    const mod = { exports: {} };
    cache.set(key, mod);
    const dir = path.dirname(file);
    const req = (id) => {
      if (id.startsWith(".")) return load(path.resolve(dir, id));
      if (pkgStubs.has(id)) return pkgStubs.get(id);
      return require(id);
    };
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (rel) => load(path.join(MOBILE, rel));
};

/**
 * @param {object} o
 * @param {object} o.api   what the services import as `api` (axios-shaped)
 * @param {object} o.user  the signed-in account ({ _id, role, schoolId, name })
 */
const bootPhone = async ({ api, user, token = "token" }) => {
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);
  const noop = () => {};
  const net = { connected: true };
  const auth = { user, token };

  const pkg = new Map([
    ["expo-sqlite", { openDatabaseAsync: async () => db, openDatabaseSync: () => db }],
    ["expo-secure-store", { getItemAsync: async () => auth.token, setItemAsync: async () => {}, deleteItemAsync: async () => {} }],
    ["@react-native-community/netinfo", {
      __esModule: true,
      default: { addEventListener: () => noop, fetch: async () => ({ isConnected: net.connected }) },
      addEventListener: () => noop, fetch: async () => ({ isConnected: net.connected }),
    }],
    ["react-native", { AppState: { addEventListener: () => ({ remove: noop }), currentState: "active" }, Platform: { OS: "android" } }],
    ["expo-crypto", { getRandomBytes: (n) => nodeCrypto.randomBytes(n), randomUUID: () => nodeCrypto.randomUUID() }],
    ["react-native-get-random-values", {}],
  ]);
  const rel = new Map([
    ["src/services/api", { __esModule: true, default: api, API_URL: "http://phone", setRetryContext: noop, clearRetryContext: noop, getAuthToken: async () => auth.token }],
    ["src/store/auth.store", {
      useAuthStore: { getState: () => ({ user: auth.user, token: auth.token }) },
      acquireSyncLock: () => true,
      releaseSyncLock: noop,
    }],
    ["src/services/content.service", { processPendingUploads: async () => ({ succeeded: 0, failed: 0 }) }],
  ]);
  const load = makeLoader(pkg, rel);

  const { getDatabase } = load("src/db/database");
  await getDatabase();                                   // the app's own table setup
  await load("src/db/quizSchema").ensureQuizTables(db, { log: { log: noop, warn: noop } });
  const { SyncManager } = load("src/services/syncManager");
  for (const step of ["migrateLocalDatabase", "migrateUsersTable", "migrateClassesTable",
                      "migrateSubjectsTable", "migrateAssignmentsTable", "migrateAnnouncementsTable",
                      "migrateQuizTables"]) {
    await SyncManager[step]?.().catch?.(() => {});
  }

  const q   = (sql, p = []) => raw.prepare(sql).all(...p);
  const one = (sql, p = []) => raw.prepare(sql).get(...p) ?? null;
  return { raw, db, net, auth, load, q, one, SyncManager };
};

/** Console noise from the services, kept out of a check's report. */
const quietly = (fn) => async (...args) => {
  if (process.env.CHECK_VERBOSE) return fn(...args);   // to debug a failure
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return await fn(...args); } finally { Object.assign(console, { log, warn, error }); }
};

module.exports = { bootPhone, quietly, adapt, makeLoader, MOBILE };
