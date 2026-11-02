// mobile/scripts/check-session-safety.js
"use strict";
/**
 * A session that cannot be renewed must never cost the person their queued
 * work, and must never end silently.
 *
 *  - A token refresh that fails for want of a network (no answer, timeout,
 *    5xx) changes nothing: the person stays signed in, the outbox rows stay
 *    pending, nobody is logged out — mid-drain included.
 *  - Only a definitive refusal from /auth/refresh (401/403: REFRESH_EXPIRED,
 *    REFRESH_STALE, account or school closed…) ends the session's usefulness,
 *    and even then it is not ended: auth.store raises "needs sign-in" (shown
 *    by SyncStatusBar as "Sign in again to send N unsent changes"), and the
 *    outbox is untouched.
 *  - A 401 after a successful refresh is the route's own answer (a wrong
 *    current password), not a dead session.
 *  - Every sign-out button asks first when this account has unsent changes
 *    (hooks/useSafeLogout), and auth.store's hasPendingUploads counts them
 *    (it read `.length` on a Set and always said "nothing pending").
 *
 * Runs the real api.js (its interceptors over a fake HTTP layer), the real
 * auth.store, and the real MutationQueue over a real SQLite.
 *
 *   node scripts/check-session-safety.js
 */
const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

global.__DEV__ = false;
process.env.EXPO_PUBLIC_API_URL = process.env.EXPO_PUBLIC_API_URL || "http://stub.test/api";

const MOBILE = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label, `expected ${e}\n     got ${a}`);
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
const networkError = (config) => {
  const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.request = {}; e.config = config; return e;
};

(async () => {
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);

  // ── The fake HTTP layer under the real api.js ───────────────────────────
  // server.validToken is the only bearer the "server" accepts; everything
  // else answers 401 TOKEN_EXPIRED. server.refresh decides /auth/refresh.
  const server = { validToken: "fresh-1", refresh: "offline", log: [], refreshCalls: 0 };

  const instance = (() => {
    const reqH = [], resH = [];
    const run = async (config) => {
      config = { headers: {}, method: "get", ...config };
      for (const h of reqH) config = await h.ok(config);
      try {
        server.log.push(`${config.method.toUpperCase()} ${config.url}`);
        const auth = config.headers.Authorization;
        if (config.url === "/teacher/change-password") {
          if (auth !== `Bearer ${server.validToken}`) throw httpError(401, { code: "TOKEN_EXPIRED" }, config);
          throw httpError(401, { message: "Current password is incorrect" }, config);
        }
        if (auth !== `Bearer ${server.validToken}`) throw httpError(401, { code: "TOKEN_EXPIRED" }, config);
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
    post: async (url) => {
      server.refreshCalls++;
      const config = { url };
      switch (server.refresh) {
        case "offline":  throw networkError(config);
        case "timeout":  { const e = networkError(config); e.code = "ECONNABORTED"; throw e; }
        case "500":      throw httpError(500, { message: "Token refresh failed" }, config);
        case "expired":  throw httpError(401, { code: "REFRESH_EXPIRED", message: "Refresh token has expired" }, config);
        case "closed":   throw httpError(401, { code: "SCHOOL_INACTIVE" }, config);
        case "ok":       return { status: 200, data: { token: server.validToken, refreshToken: "rt-2" } };
        default:         throw new Error(`unknown refresh mode ${server.refresh}`);
      }
    },
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
    [path.join(MOBILE, "src/i18n/useTranslation"), { useTranslation: () => ({ t: (k) => k }) }],
  ]);
  const pkgStubs = new Map([
    ["axios", { __esModule: true, default: axiosStub }],
    ["expo-secure-store", secureStub],
    ["@react-native-community/netinfo", { __esModule: true, default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) } }],
    ["react-native", { Alert: { alert: () => {} } }],
    ["expo-router", { useRouter: () => ({ replace: () => {} }) }],
  ]);
  const load = makeLoader(stubs, pkgStubs);

  const api   = load("src/services/api.js");
  const store = load("src/store/auth.store.js");
  const { MutationQueue } = load("src/services/mutationQueue.service.js");
  const { runSafeLogout, decideLogoutPrompt } = load("src/hooks/useSafeLogout.js");
  const { useAuthStore, getUnsentCount, hasPendingUploads } = store;

  // A teacher, signed in online, whose access token has expired.
  const signIn = () => useAuthStore.setState({
    user: { _id: "t-1", id: "t-1", role: "teacher", schoolId: "sch-a", name: "Ama" },
    token: "stale-0", refreshTokenValue: "rt-1", needsSignIn: false, needsSignInReason: null,
  });
  signIn();
  const realLogout = useAuthStore.getState().logout;
  let logouts = 0;
  useAuthStore.setState({ logout: async () => { logouts++; return realLogout(); } });

  const outbox = () => raw.prepare(
    "SELECT entity_key, status, owner_id FROM mutation_outbox ORDER BY created_at, entity_key"
  ).all().map((r) => `${r.entity_key}:${r.status}:${r.owner_id}`);

  console.log("\n--- the outbox, and the count the warning uses ---");
  check("nothing queued: no unsent changes", await getUnsentCount(), 0);
  check("  hasPendingUploads says no", await hasPendingUploads(), false);
  await MutationQueue.enqueue({ entityKey: "attendance:a1", method: "POST", endpoint: "/attendance", payload: { id: "a1" } });
  await MutationQueue.enqueue({ entityKey: "attendance:a2", method: "POST", endpoint: "/attendance", payload: { id: "a2" } });
  check("two registers queued by this teacher", outbox(), ["attendance:a1:pending:t-1", "attendance:a2:pending:t-1"]);
  check("  unsent count is 2", await getUnsentCount(), 2);
  check("  hasPendingUploads now says yes (it read .length on a Set and said no)", await hasPendingUploads(), true);

  const state = () => {
    const s = useAuthStore.getState();
    return { signedIn: Boolean(s.user && s.token), needsSignIn: s.needsSignIn, reason: s.needsSignInReason };
  };

  for (const mode of ["offline", "timeout", "500"]) {
    console.log(`\n--- the refresh fails for want of a network (${mode}) ---`);
    server.refresh = mode;
    const summary = await MutationQueue.drain({ includeUploads: false });
    check("the drain stops on the session, not on the rows", [summary.synced, summary.stopped], [0, "unauthenticated"]);
    check("  the refresh was attempted", server.refreshCalls > 0, true);
    check("  still signed in, not asked to sign in again", state(), { signedIn: true, needsSignIn: false, reason: null });
    check("  nobody logged out, the sync was not stopped", [logouts, calls.syncDestroy], [0, 0]);
    check("  both rows still pending, still this teacher's", outbox(), ["attendance:a1:pending:t-1", "attendance:a2:pending:t-1"]);

    let rejected = null;
    try { await api.default.get("/admin/students"); } catch (e) { rejected = e; }
    check("  a screen's request (not a sync route) is rejected to the screen", rejected?.response?.status, 401);
    check("  …and that does not log out either (it used to)", [logouts, state().signedIn], [0, true]);
    check("  the error says why: the refresh was transient", rejected?.authRefresh, "transient");
  }

  console.log("\n--- the server refuses the refresh: REFRESH_EXPIRED ---");
  server.refresh = "expired";
  let summary = await MutationQueue.drain({ includeUploads: false });
  check("the drain stops on the session", summary.stopped, "unauthenticated");
  check("  the session is marked 'needs sign-in', with the server's reason", state(),
    { signedIn: true, needsSignIn: true, reason: "REFRESH_EXPIRED" });
  check("  not logged out — not silently, not at all", [logouts, calls.syncDestroy], [0, 0]);
  check("  the outbox is untouched", outbox(), ["attendance:a1:pending:t-1", "attendance:a2:pending:t-1"]);
  check("  the prompt's N: 2 unsent changes", await getUnsentCount(), 2);

  console.log("\n--- a school closed while the phone was away: SCHOOL_INACTIVE ---");
  server.refresh = "closed";
  await MutationQueue.drain({ includeUploads: false });
  check("needs sign-in, reason SCHOOL_INACTIVE; rows kept", [state(), outbox().length],
    [{ signedIn: true, needsSignIn: true, reason: "SCHOOL_INACTIVE" }, 2]);

  console.log("\n--- the store's own refresh action never logs out ---");
  useAuthStore.setState({ needsSignIn: false, needsSignInReason: null });
  const realFetch = global.fetch;
  global.fetch = async () => ({ status: 401, ok: false, json: async () => ({ code: "REFRESH_STALE" }) });
  check("a 401 answer returns false", await useAuthStore.getState().refreshToken("rt-1"), false);
  global.fetch = realFetch;
  check("  and marks needs sign-in instead of logging out", [state(), logouts],
    [{ signedIn: true, needsSignIn: true, reason: "REFRESH_STALE" }, 0]);

  console.log("\n--- the refresh succeeds again ---");
  server.refresh = "ok";
  summary = await MutationQueue.drain({ includeUploads: false });
  check("the rows go out with the new token", [summary.synced, outbox()],
    [2, ["attendance:a1:synced:t-1", "attendance:a2:synced:t-1"]]);
  check("  'needs sign-in' clears by itself", state(), { signedIn: true, needsSignIn: false, reason: null });
  check("  nothing left unsent", await getUnsentCount(), 0);

  console.log("\n--- a 401 that is the route's answer, after a good refresh ---");
  useAuthStore.setState({ token: "stale-0" });
  let rejected = null;
  try { await api.default.post("/teacher/change-password", { currentPassword: "wrong" }); } catch (e) { rejected = e; }
  check("the wrong password is the caller's error", rejected?.response?.data?.message, "Current password is incorrect");
  check("  not 'needs sign-in', not logged out", [state(), logouts], [{ signedIn: true, needsSignIn: false, reason: null }, 0]);

  console.log("\n--- signing out: the pending count drives the warning ---");
  check("unsent > 0 → warn, whatever the screen", [decideLogoutPrompt(3, true), decideLogoutPrompt(1, false)], ["warnUnsent", "warnUnsent"]);
  check("nothing unsent → the screen's own question, or none", [decideLogoutPrompt(0, true), decideLogoutPrompt(0, false)], ["confirm", "direct"]);
  check("unknown count → the screen's own question", decideLogoutPrompt(null, true), "confirm");

  const t = (k, o) => (o ? `${k}${JSON.stringify(o)}` : k);
  const alerts = [];
  let signedOut = 0;
  const run = (unsent, confirm) => runSafeLogout({
    t, confirm,
    logout: async () => { logouts++; },
    onSignedOut: () => { signedOut++; },
    countUnsent: async () => { if (unsent instanceof Error) throw unsent; return unsent; },
    alert: (title, body, buttons) => alerts.push({ title, body, buttons }),
  });
  logouts = 0;
  check("3 unsent: the warning, not the sign-out", [await run(3, { title: "Logout", body: "Sure?" }), logouts], ["warnUnsent", 0]);
  const warn = alerts.at(-1);
  check("  it names the count", [warn.title, warn.body], ["logoutGuard.title", 'logoutGuard.body{"count":3}']);
  check("  Cancel / Sign out", warn.buttons.map((b) => `${b.text}:${b.style}`), ["common.cancel:cancel", "logoutGuard.signOut:destructive"]);
  await warn.buttons[1].onPress();
  check("  Sign out signs out, then leaves for the login screen", [logouts, signedOut], [1, 1]);
  await run(0, { title: "Logout", body: "Sure?" });
  check("0 unsent: the screen's own confirmation", alerts.at(-1).title, "Logout");
  await run(0, undefined);
  check("0 unsent, no confirmation on that screen: straight out", [logouts, signedOut], [2, 2]);
  check("an unreadable outbox never blocks signing out",
    [await run(new Error("db gone"), undefined), logouts], ["direct", 3]);

  console.log("\n--- signing in again keeps the rows for the same account ---");
  signIn();
  await MutationQueue.enqueue({ entityKey: "attendance:a3", method: "POST", endpoint: "/attendance", payload: { id: "a3" } });
  useAuthStore.setState({ logout: realLogout });
  await useAuthStore.getState().signInAgain();
  check("'Sign in again' ends the session", Boolean(useAuthStore.getState().token), false);
  check("  the queued row is still there, still this teacher's", outbox().filter((r) => r.startsWith("attendance:a3")), ["attendance:a3:pending:t-1"]);

  console.log("\n--- online-only actions say they need a connection ---");
  const NI = load("src/hooks/useNeedsInternet.js");
  const tt = (k) => `T:${k}`;
  const offlineErr = (() => { try { return networkError({}); } catch (e) { return e; } })();
  const local = Object.assign(new Error("No internet connection"), { isOffline: true });
  const refusal = httpError(400, { message: "Subject name already exists" }, {});
  check("no answer from the server → 'needs an internet connection'",
    [NI.needsInternetFailureText(tt, offlineErr), NI.needsInternetFailureText(tt, local)],
    ["T:common.needsInternet", "T:common.needsInternet"]);
  check("  the drop-in for errorText says the same offline",
    NI.needsInternetErrorText(tt, offlineErr, "x.failed"), "T:common.needsInternet");
  check("a real refusal keeps the server's own reason", NI.needsInternetFailureText(tt, refusal, "x.failed"),
    "Subject name already exists");
  check("  and a screen's own text is kept when it is not about the connection",
    [NI.orNeedsInternet(tt, refusal, "own"), NI.orNeedsInternet(tt, offlineErr, "own")], ["own", "T:common.needsInternet"]);
  check("a 401/500 with a response is not 'offline'", [NI.isOfflineError(httpError(500, {}, {})), NI.isOfflineError(null)], [false, false]);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
