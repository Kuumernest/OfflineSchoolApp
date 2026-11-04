// mobile/scripts/check-app-update-required.js
"use strict";

/**
 * "Never downgrade a school with the per-user switch on" (docs/40 §8.9), the
 * phone's half.
 *
 *  A. Every request says which build this is (X-App-Platform, X-App-Version,
 *     X-App-Data-Format): the axios instance, api.js's raw refresh, and the
 *     auth store's raw-fetch sign-in and refresh, which bypass axios.
 *  B. The server answers 426 APP_UPDATE_REQUIRED (sign-in, refresh, a write):
 *     the update-required state is raised, the sync is stopped, NOTHING is
 *     signed out or cleared — the stored session and every outbox row stay as
 *     they were, no row is parked as failed, no retry budget is spent — and
 *     nothing more is sent until "Check again".
 *  C. A newer build wrote this phone's data (device.db stamped with a higher
 *     data format — a sideloaded older APK): at start the app shows the
 *     update-required state and does not open, change or send anything; no
 *     per-user store is touched, sign-in is refused locally. A current or
 *     pre-stamp device.db opens as before and is stamped.
 *
 * A and B: the real api.js (its interceptors over a fake HTTP layer), the real
 * auth store and the real MutationQueue over node:sqlite. C: the real
 * deviceDb, perUserData and auth store over real SQLite files on disk
 * (scripts/peruser-harness.js).
 *
 *   node scripts/check-app-update-required.js
 */
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");
const babel  = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

global.__DEV__ = false;
process.env.EXPO_PUBLIC_API_URL = process.env.EXPO_PUBLIC_API_URL || "http://stub.test/api";

const MOBILE = path.join(__dirname, "..");
let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};
const quiet = async (fn) => {
  if (process.env.CHECK_VERBOSE) return fn();
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, { log, warn, error }); }
};

const adapt = (db) => ({
  execAsync:     async (sql) => { db.exec(sql); },
  runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
  getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  withTransactionAsync: async (fn) => { await fn(); },
});

const makeLoader = (stubs, pkgStubs) => {
  const cache = new Map();
  const load = (abs) => {
    if (stubs.has(abs)) return stubs.get(abs);
    if (cache.has(abs)) return cache.get(abs).exports;
    const file = fs.existsSync(abs) ? abs : `${abs}.js`;
    const { code } = babel.transformFileSync(file, {
      presets: [require.resolve("babel-preset-expo")],
      caller:  { name: "check", supportsStaticESM: false },
      babelrc: false, configFile: false,
    });
    const mod = { exports: {} };
    cache.set(abs, mod);
    const dir = path.dirname(file);
    const req = (id) => {
      if (id.startsWith(".")) return load(path.resolve(dir, id).replace(/\.js$/, ""));
      if (pkgStubs.has(id)) return pkgStubs.get(id);
      return require(id);
    };
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (rel) => load(path.join(MOBILE, rel).replace(/\.js$/, ""));
};

const httpError = (status, data, config) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data }; e.config = config; return e;
};
const UPDATE = { success: false, code: "APP_UPDATE_REQUIRED", message: "Update the app to keep syncing.", minDataFormat: 2 };
const BUILD_KEYS = ["X-App-Platform", "X-App-Version", "X-App-Data-Format"];
const buildOf = (headers = {}) => BUILD_KEYS.map((k) => headers[k] ?? null);
const EXPECTED_BUILD = ["android", "9.9.9", "1"];

// ═════════════════════════════════════════════════════════════════════════════
// A + B — api.js, the auth store's raw fetch, the outbox
// ═════════════════════════════════════════════════════════════════════════════
const partAB = async () => {
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);

  // The fake server: `mode` "ok" serves, "update" answers 426 to everything.
  const server = { mode: "ok", sent: [], validToken: "tok-1" };
  const instance = (() => {
    const reqH = [], resH = [];
    const run = async (config) => {
      config = { headers: {}, method: "get", ...config };
      try {
        for (const h of reqH) config = await h.ok(config);
      } catch (err) {
        return Promise.reject(err);
      }
      try {
        server.sent.push({ via: "axios", url: config.url, headers: { ...config.headers } });
        if (server.mode === "update") throw httpError(426, UPDATE, config);
        if (config.headers.Authorization !== `Bearer ${server.validToken}`) throw httpError(401, { code: "TOKEN_EXPIRED" }, config);
        return await resH[0].ok({ status: 201, data: { success: true }, config });
      } catch (err) {
        if (!err.config) err.config = config;
        return resH[0].err(err);
      }
    };
    const inst = (config) => run(config);
    inst.request = run;
    inst.get     = (url, c = {}) => run({ ...c, method: "get", url });
    inst.post    = (url, data, c = {}) => run({ ...c, method: "post", url, data });
    inst.put     = (url, data, c = {}) => run({ ...c, method: "put", url, data });
    inst.patch   = (url, data, c = {}) => run({ ...c, method: "patch", url, data });
    inst.delete  = (url, c = {}) => run({ ...c, method: "delete", url });
    inst.defaults = { timeout: 30_000, headers: {} };
    inst.interceptors = {
      request:  { use: (ok, err) => reqH.push({ ok, err }) },
      response: { use: (ok, err) => resH.push({ ok, err }) },
    };
    return inst;
  })();
  const axiosStub = {
    create: () => instance,
    post: async (url, _body, config = {}) => {
      server.sent.push({ via: "axios.post", url, headers: { ...(config.headers ?? {}) } });
      if (server.mode === "update") throw httpError(426, UPDATE, { url });
      return { status: 200, data: { token: server.validToken, refreshToken: "rt-2" } };
    },
  };
  // The auth store's raw fetch (sign-in, refresh action).
  global.fetch = async (url, opts = {}) => {
    server.sent.push({ via: "fetch", url: String(url), headers: { ...(opts.headers ?? {}) } });
    if (server.mode === "update") return { ok: false, status: 426, json: async () => UPDATE };
    return { ok: false, status: 401, json: async () => ({ success: false, message: "Invalid email or password" }) };
  };

  const secure = new Map();
  const secureStub = {
    getItemAsync:    async (k) => (secure.has(k) ? secure.get(k) : null),
    setItemAsync:    async (k, v) => { secure.set(k, v); },
    deleteItemAsync: async (k) => { secure.delete(k); },
  };
  const calls = { syncDestroy: 0 };
  const stubs = new Map([
    [path.join(MOBILE, "src/db/database"),  { getDatabase: async () => db }],
    [path.join(MOBILE, "src/db/dbService"), { DB: null }],
    [path.join(MOBILE, "src/services/content.service"), { processPendingUploads: async () => ({ succeeded: 0, failed: 0 }) }],
    [path.join(MOBILE, "src/services/syncManager"), { SyncManager: { destroy: () => { calls.syncDestroy++; } } }],
    [path.join(MOBILE, "src/services/school.service"), { clearSchoolCache: () => {} }],
    [path.join(MOBILE, "src/services/message.service"), { purgeNotMine: async () => {}, clearLocalMessages: async () => {} }],
    [path.join(MOBILE, "src/services/portal.service"), { hasSession: async () => false, signOut: async () => {} }],
    [path.join(MOBILE, "src/services/perUserData.service"), {
      prepareSession: async () => ({ mode: "legacy" }), needsPriming: async () => false,
      rememberSchoolSwitch: async () => {}, admitForSignIn: async () => ({ ok: true }),
    }],
  ]);
  const pkgStubs = new Map([
    ["axios", { __esModule: true, default: axiosStub }],
    ["expo-secure-store", secureStub],
    ["expo-constants", { __esModule: true, default: { expoConfig: { version: "9.9.9" } } }],
    ["@react-native-community/netinfo", { __esModule: true, default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) } }],
    ["react-native", { Alert: { alert: () => {} }, Platform: { OS: "android" } }],
  ]);
  const load = makeLoader(stubs, pkgStubs);
  const api = load("src/services/api.js");
  const { useAuthStore } = load("src/store/auth.store.js");
  const { MutationQueue } = load("src/services/mutationQueue.service.js");

  const USER = { _id: "t-1", id: "t-1", role: "teacher", schoolId: "sch-a", name: "Ama" };
  const session = () => {
    useAuthStore.setState({ user: USER, token: server.validToken, refreshTokenValue: "rt-1", needsSignIn: false, needsSignInReason: null });
    secure.set("auth_token", server.validToken);
    secure.set("auth_refresh_token", "rt-1");
    secure.set("user", JSON.stringify(USER));
  };
  session();
  const realLogout = useAuthStore.getState().logout;
  let logouts = 0;
  useAuthStore.setState({ logout: async () => { logouts++; return realLogout(); } });
  const last = (via) => [...server.sent].reverse().find((x) => x.via === via);

  console.log("\n--- A. every path says which build this is ---");
  await quiet(() => api.default.get("/teacher/profile"));
  check("axios instance (request interceptor)", buildOf(last("axios")?.headers), EXPECTED_BUILD);
  await quiet(() => api.refreshAccessToken());
  check("api.js raw refresh (axios.post)", buildOf(last("axios.post")?.headers), EXPECTED_BUILD);
  await quiet(() => useAuthStore.getState().login({ email: "ama@s.test", password: "pw-1" }));
  check("auth store sign-in (raw fetch)", buildOf(last("fetch")?.headers), EXPECTED_BUILD);
  check("  …and its Content-Type is kept", last("fetch")?.headers?.["Content-Type"], "application/json");
  session();
  server.sent.length = 0;
  await quiet(() => useAuthStore.getState().refreshToken("rt-1"));
  check("auth store refresh action (raw fetch)", buildOf(last("fetch")?.headers), EXPECTED_BUILD);
  session();

  const outbox = () => raw.prepare(
    "SELECT entity_key, status, retry_count, owner_id FROM mutation_outbox ORDER BY entity_key"
  ).all().map((r) => `${r.entity_key}:${r.status}:${r.retry_count}:${r.owner_id}`);
  const stored = () => [secure.get("auth_token"), secure.get("auth_refresh_token"), JSON.parse(secure.get("user") || "null")?.id];
  const state = () => {
    const s = useAuthStore.getState();
    return { signedIn: Boolean(s.user && s.token), updateRequired: s.updateRequired, reason: s.updateRequiredReason, needsSignIn: s.needsSignIn };
  };

  console.log("\n--- B. the server says 426 APP_UPDATE_REQUIRED to a write ---");
  await quiet(() => MutationQueue.enqueue({ entityKey: "attendance:a1", method: "POST", endpoint: "/attendance", payload: { id: "a1" } }));
  await quiet(() => MutationQueue.enqueue({ entityKey: "attendance:a2", method: "POST", endpoint: "/attendance", payload: { id: "a2" } }));
  check("two registers queued", outbox(), ["attendance:a1:pending:0:t-1", "attendance:a2:pending:0:t-1"]);
  server.mode = "update";
  await quiet(() => MutationQueue.drain({ includeUploads: false }));
  check("update-required raised, still signed in, not 'needs sign-in'", state(),
    { signedIn: true, updateRequired: true, reason: "server", needsSignIn: false });
  check("  the sync engine was stopped", calls.syncDestroy > 0, true);
  check("  nobody logged out", logouts, 0);
  const rows = outbox();
  check("  no row parked as failed, no retry budget spent",
    rows.every((r) => /:(pending|retrying):0:t-1$/.test(r)) && rows.length === 2, true);
  check("  the stored session is untouched", stored(), [server.validToken, "rt-1", "t-1"]);

  const before = server.sent.length;
  let rejected = null;
  try { await quiet(() => api.default.get("/admin/students")); } catch (e) { rejected = e; }
  check("  a later request is not sent at all", server.sent.length, before);
  check("  …and the screen is told why (not sent, update required)", [rejected?.isUpdateRequired, rejected?.response], [true, undefined]);
  await quiet(() => MutationQueue.drain({ includeUploads: false }));
  check("  a later drain sends nothing and keeps both rows", [server.sent.length, outbox().length], [before, 2]);

  console.log("\n--- B. 426 on the refresh paths ---");
  useAuthStore.setState({ updateRequired: false, updateRequiredReason: null });
  check("api.js refresh answers null", await quiet(() => api.refreshAccessToken()), null);
  check("  update-required, not 'needs sign-in', still signed in", state(),
    { signedIn: true, updateRequired: true, reason: "server", needsSignIn: false });
  useAuthStore.setState({ updateRequired: false, updateRequiredReason: null });
  check("auth store refresh action answers false", await quiet(() => useAuthStore.getState().refreshToken("rt-1")), false);
  check("  update-required, not 'needs sign-in', still signed in", state(),
    { signedIn: true, updateRequired: true, reason: "server", needsSignIn: false });
  check("  nobody logged out; the stored session is untouched", [logouts, stored()], [0, [server.validToken, "rt-1", "t-1"]]);

  console.log("\n--- B. 426 at sign-in ---");
  useAuthStore.setState({ updateRequired: false, updateRequiredReason: null });
  const signedIn = await quiet(() => useAuthStore.getState().login({ email: "ama@s.test", password: "pw-1" }));
  const s = useAuthStore.getState();
  check("sign-in refused, update-required, a translated reason",
    [signedIn, s.updateRequired, s.updateRequiredReason, s.errorKey], [false, true, "server", "svcErr.appUpdateRequired"]);
  check("  the previous session in SecureStore is untouched", stored(), [server.validToken, "rt-1", "t-1"]);
  check("  the outbox is untouched", outbox().length, 2);

  console.log("\n--- B. 'Check again' (the school turned the switch off) ---");
  session();
  server.mode = "ok";
  useAuthStore.getState().clearUpdateRequired?.();
  check("cleared", useAuthStore.getState().updateRequired, false);
  await raw.prepare("UPDATE mutation_outbox SET next_attempt_at = NULL").run();
  const sum = await quiet(() => MutationQueue.drain({ includeUploads: false }));
  check("the kept rows go out", [sum.synced, outbox().map((r) => r.split(":")[2])], [2, ["synced", "synced"]]);

  console.log("\n--- the strings exist in both languages ---");
  for (const lang of ["en", "fr"]) {
    const d = JSON.parse(fs.readFileSync(path.join(MOBILE, `src/i18n/locales/${lang}.json`), "utf8"));
    check(`${lang}: updateRequired.* and svcErr.appUpdateRequired`,
      ["title", "bodyServer", "bodyLocal", "kept", "checkAgain"].every((k) => typeof d.updateRequired?.[k] === "string") &&
      typeof d.svcErr?.appUpdateRequired === "string", true);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// C — a newer build's data on this phone
// ═════════════════════════════════════════════════════════════════════════════
const partC = async () => {
  const { bootDevice, tmpDir } = require("./peruser-harness");
  const SCHOOL = "5c0e2e000000000000000001";
  const USER = { _id: "tea-a", id: "tea-a", name: "Ama", email: "ama@s.test", role: "teacher", schoolId: SCHOOL };
  let fetches = 0;
  global.fetch = async () => { fetches++; throw new Error("nothing may be sent in part C"); };
  const noNetworkApi = new Proxy({}, { get: () => async () => { fetches++; throw Object.assign(new Error("no network"), { code: "ERR_NETWORK" }); } });

  const sha = (file) => (fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null);
  // device.db and the per-user stores. (The shared file is opened at every
  // app start by the layout, before any of this, as it always was.)
  const snapshot = (dir) => Object.fromEntries(
    fs.readdirSync(dir).filter((f) => /^(device|schoolapp\.u_)/.test(f)).sort().map((f) => [f, sha(path.join(dir, f))])
  );

  console.log("\n--- C. a current build stamps device.db ---");
  const dir = tmpDir("format");
  {
    const phone = await bootDevice({ dir, api: noNetworkApi });
    await quiet(() => phone.load("src/db/deviceDb").openDeviceDb());
    const d = phone.inspect("device.db");
    check("meta.data_format = 1", d.one("SELECT v FROM meta WHERE k = 'data_format'")?.v ?? null, "1");
    // An account that flipped: its own store, with one unsent change.
    d.close();
    const store = new DatabaseSync(path.join(dir, "schoolapp.u_tea-a.db"));
    store.exec("CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT, is_dirty INTEGER)");
    store.prepare("INSERT INTO notes VALUES ('n1', 'unsent', 1)").run();
    store.close();
    const dev = await phone.load("src/db/deviceDb").openDeviceDb();
    await dev.runAsync("INSERT INTO stores (user_id, file, school_id, created_at, primed_at, switched_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["tea-a", "schoolapp.u_tea-a.db", SCHOOL, "2026-01-01", "2026-01-01", "2026-01-01"]);
    await phone.secure.setItemAsync("auth_token", "tok-a");
    await phone.secure.setItemAsync("user", JSON.stringify(USER));
    await phone.secure.setItemAsync("auth_refresh_token", "ref-a");
    phone.kill();
  }

  console.log("\n--- C. a newer build ran here (format 2), then this build is installed again ---");
  {
    const d = new DatabaseSync(path.join(dir, "device.db"));
    d.prepare("UPDATE meta SET v = '2' WHERE k = 'data_format'").run();
    d.close();
  }
  const filesBefore  = snapshot(dir);
  const secureBefore = fs.readFileSync(path.join(dir, "securestore.json"), "utf8");
  {
    const phone = await bootDevice({ dir, api: noNetworkApi });
    const restored = await quiet(() => phone.useAuthStore.getState().initAuth());
    const s = phone.useAuthStore.getState();
    check("start: update-required (local data format), nobody restored into the app",
      [restored, s.updateRequired, s.updateRequiredReason, s.user, s.localDataPhase], [false, true, "local-data-format", null, "idle"]);
    const signed = await quiet(() => phone.useAuthStore.getState().login({ email: "ama@s.test", password: "pw" }));
    check("  sign-in is refused locally, nothing sent", [signed, fetches], [false, 0]);
    let refused = null;
    try { await quiet(() => phone.load("src/db/deviceDb").openDeviceDb()); } catch (e) { refused = e; }
    check("  device.db will not open for this build", [refused?.code, refused?.storedFormat], ["LOCAL_DATA_FORMAT_TOO_NEW", 2]);
    const r = await quiet(() => phone.load("src/services/perUserData.service").prepareSession(USER, { online: false }));
    check("  the per-user code cannot reach a store", r?.mode === "store", false);
    phone.useAuthStore.getState().clearUpdateRequired?.();
    check("  'Check again' does not clear it (only the newer build can read this)", phone.useAuthStore.getState().updateRequired, true);
    phone.kill();
  }
  check("device.db and the account's store are byte-for-byte unchanged", snapshot(dir), filesBefore);
  check("the stored session is untouched", fs.readFileSync(path.join(dir, "securestore.json"), "utf8"), secureBefore);
  {
    const st = new DatabaseSync(path.join(dir, "schoolapp.u_tea-a.db"));
    check("the store's unsent change is still there", st.prepare("SELECT id, body, is_dirty FROM notes").all().map((x) => ({ ...x })),
      [{ id: "n1", body: "unsent", is_dirty: 1 }]);
    st.close();
  }

  console.log("\n--- C. device.db from before the stamp, and a current one, open as before ---");
  {
    const d = new DatabaseSync(path.join(dir, "device.db"));
    d.prepare("DELETE FROM meta WHERE k = 'data_format'").run();
    d.close();
    const phone = await bootDevice({ dir, api: noNetworkApi });
    const s0 = await quiet(() => phone.useAuthStore.getState().initAuth());
    check("pre-stamp: start restores the session, no update-required",
      [s0, phone.useAuthStore.getState().updateRequired], [true, false]);
    await quiet(() => phone.load("src/db/deviceDb").openDeviceDb());
    const i = phone.inspect("device.db");
    check("  …and is stamped 1", i.one("SELECT v FROM meta WHERE k = 'data_format'")?.v ?? null, "1");
    i.close();
    phone.kill();
  }
  {
    const phone = await bootDevice({ dir, api: noNetworkApi });
    const s1 = await quiet(() => phone.useAuthStore.getState().initAuth());
    check("format 1: start restores the session, no update-required",
      [s1, phone.useAuthStore.getState().updateRequired], [true, false]);
    phone.kill();
  }
  {
    const fresh = tmpDir("fresh");
    const phone = await bootDevice({ dir: fresh, api: noNetworkApi });
    const s2 = await quiet(() => phone.useAuthStore.getState().initAuth());
    check("a phone with no device.db: nothing created, no update-required",
      [s2, phone.useAuthStore.getState().updateRequired, phone.exists("device.db")], [false, false, false]);
    phone.kill();
  }
};

(async () => {
  await partAB();
  await partC();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
