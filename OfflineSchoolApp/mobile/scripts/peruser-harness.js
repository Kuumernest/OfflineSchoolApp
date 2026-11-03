// mobile/scripts/peruser-harness.js
"use strict";

/**
 * A shared phone on disk, for the per-user local data checks (docs/40).
 *
 * Like offline-harness.js — the REAL mobile modules Babel-loaded, over a real
 * SQLite (node:sqlite) — but with what a multi-file migration needs:
 *
 *   - every database is a real FILE in one temp directory (schoolapp.db,
 *     device.db, schoolapp.u_<id>.db), opened by name through expo-sqlite's
 *     surface, deletable through deleteDatabaseAsync;
 *   - SecureStore is a key/value file in the same directory, so it survives a
 *     "reboot";
 *   - the REAL auth store (zustand), so sign-in, offline sign-in and sign-out
 *     run the app's own code; its HTTP sign-in goes to `apiUrl` with fetch;
 *   - reboot(): every connection is closed WITHOUT committing anything in
 *     flight (what a killed process leaves) and a fresh module graph is
 *     loaded over the same files — a new launch of the app.
 *
 * Not a check itself.
 */

const path = require("path");
const fs   = require("fs");
const os   = require("os");
const nodeCrypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const babel = require("@babel/core");
const { MOBILE } = require("./offline-harness");

// offline-harness.js's loader, with one difference: a "reboot" loads a fresh
// module graph, and transforming every file again each time made the
// crash-at-every-step check take minutes. Same file, same mtime → same code,
// so the transform is remembered for the run. Module state is still fresh.
const transformed = new Map();
const transform = (file) => {
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  if (!transformed.has(key)) {
    transformed.set(key, babel.transformFileSync(file, {
      presets: [require.resolve("babel-preset-expo")],
      caller:  { name: "check", supportsStaticESM: false },
      babelrc: false, configFile: false,
    }).code);
  }
  return transformed.get(key);
};
const makeLoader = (pkgStubs, relStubs) => {
  const cache = new Map();
  const load = (abs) => {
    const key = abs.replace(/\.js$/, "");
    for (const [r, stub] of relStubs) if (key.endsWith(r)) return stub;
    if (cache.has(key)) return cache.get(key).exports;
    const file = fs.existsSync(`${key}.js`) ? `${key}.js` : `${key}/index.js`;
    const code = transform(file);
    const mod = { exports: {} };
    cache.set(key, mod);
    const d = path.dirname(file);
    const req = (id) => {
      if (id.startsWith(".")) return load(path.resolve(d, id));
      if (pkgStubs.has(id)) return pkgStubs.get(id);
      return require(id);
    };
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (r) => load(path.join(MOBILE, r));
};

const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `peruser-${tag}-`));

/** expo-sqlite's async surface over one real file. */
const adaptFile = (file, registry) => {
  const raw = new DatabaseSync(file);
  registry.add(raw);
  let open = true;
  const db = {
    __raw: raw,
    __file: file,
    execAsync:     async (sql) => { raw.exec(sql); },
    runAsync:      async (sql, params = []) => raw.prepare(sql).run(...params),
    getAllAsync:   async (sql, params = []) => raw.prepare(sql).all(...params),
    getFirstAsync: async (sql, params = []) => raw.prepare(sql).get(...params) ?? null,
    withTransactionAsync: async (fn) => {
      raw.exec("BEGIN");
      try { await fn(); raw.exec("COMMIT"); }
      catch (err) { try { raw.exec("ROLLBACK"); } catch { /* none open */ } throw err; }
    },
    closeAsync: async () => { if (open) { open = false; registry.delete(raw); raw.close(); } },
  };
  return db;
};

/**
 * @param {object} o
 * @param {string} o.dir      the phone's storage (database files + SecureStore)
 * @param {object} o.api      what the services import as `api`
 * @param {string} [o.apiUrl] where the auth store's fetch sign-in goes
 */
const bootDevice = async ({ dir, api, apiUrl = "http://phone.invalid/api" }) => {
  const registry = new Set();
  const noop = () => {};
  const net = { connected: true };
  const secureFile = path.join(dir, "securestore.json");
  const readSecure = () => { try { return JSON.parse(fs.readFileSync(secureFile, "utf8")); } catch { return {}; } };
  const writeSecure = (m) => fs.writeFileSync(secureFile, JSON.stringify(m));
  const secure = {
    getItemAsync: async (k) => readSecure()[k] ?? null,
    setItemAsync: async (k, v) => { const m = readSecure(); m[k] = String(v); writeSecure(m); },
    deleteItemAsync: async (k) => { const m = readSecure(); delete m[k]; writeSecure(m); },
  };
  const removeFile = (name) => {
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(path.join(dir, name + ext)); } catch { /* absent */ }
    }
  };

  const pkg = new Map([
    ["expo-sqlite", {
      openDatabaseAsync: async (name) => adaptFile(path.join(dir, name), registry),
      deleteDatabaseAsync: async (name) => removeFile(name),
      defaultDatabaseDirectory: dir,
    }],
    ["expo-secure-store", secure],
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
    ["src/services/api", {
      __esModule: true, default: api, API_URL: apiUrl,
      setRetryContext: noop, clearRetryContext: noop,
      getAuthToken: async () => null, refreshAccessToken: async () => null,
    }],
    ["src/services/content.service", { processPendingUploads: async () => ({ succeeded: 0, failed: 0 }) }],
  ]);
  const load = makeLoader(pkg, rel);
  const { useAuthStore } = load("src/store/auth.store");

  /** Sign an account in without the HTTP round trip (for local-only checks). */
  const setSession = (user, token = "token") => useAuthStore.setState({ user, token, hydrated: true, hasInitialized: true });

  /** Open a database file outside the app, for assertions (closed by reboot). */
  const inspect = (name) => {
    const raw = new DatabaseSync(path.join(dir, name));
    registry.add(raw);
    return {
      all: (sql, p = []) => raw.prepare(sql).all(...p),
      one: (sql, p = []) => raw.prepare(sql).get(...p) ?? null,
      close: () => { registry.delete(raw); raw.close(); },
    };
  };
  const exists = (name) => fs.existsSync(path.join(dir, name));

  /** Kill: close every connection, rolling back whatever is uncommitted. */
  const kill = () => {
    for (const raw of [...registry]) {
      try { if (raw.isTransaction) raw.exec("ROLLBACK"); } catch { /* none */ }
      try { raw.close(); } catch { /* closed */ }
      registry.delete(raw);
    }
  };

  return { dir, load, net, secure, useAuthStore, setSession, inspect, exists, kill };
};

/** Console noise from the services, kept out of a check's report. */
const quietly = (fn) => async (...args) => {
  if (process.env.CHECK_VERBOSE) return fn(...args);
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return await fn(...args); } finally { Object.assign(console, { log, warn, error }); }
};

module.exports = { bootDevice, tmpDir, quietly };
