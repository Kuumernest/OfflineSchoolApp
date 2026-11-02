// web/scripts/check-session-refresh.mjs
//
// Losing the connection must not sign anybody out.
//
// The failure this pins: refreshSession signed out on ANY failure of
// /auth/refresh, and the axios 401 path then sent the window to /login. So a
// token that expired while the school's connection was down — a minute of
// flaky 3G, a router restart — ended the session, and on the desktop, where the
// work carries on offline, it put a bursar in front of a sign-in screen they
// could not get past until the connection came back.
//
// Only a definitive refusal from the server (401/403 on /auth/refresh) ends a
// session now. This loads the REAL modules — src/lib/axios.ts and
// src/store/auth.store.ts, through Vite, so the "@/" imports, the i18n bundle
// and the interceptors are the ones the console runs — and replaces only the
// transport underneath axios with a scripted server.
//
//   node scripts/check-session-refresh.mjs

import path  from "node:path";
import url   from "node:url";
import axios, { AxiosError } from "axios";
import { createServer } from "vite";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

// ── The browser the modules expect ──────────────────────────────────────────
const mem = new Map();
globalThis.localStorage = {
  getItem:    (k) => (mem.has(k) ? mem.get(k) : null),
  setItem:    (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
const redirects = [];
globalThis.window = {
  location: { pathname: "/students", replace: (to) => { redirects.push(to); } },
  addEventListener: () => {}, removeEventListener: () => {},
};

// ── The scripted server ─────────────────────────────────────────────────────
// `refresh` decides what /auth/refresh does; every other path answers 401 to
// the stale token and 200 to the fresh one, so a replay is visible.
let refresh = () => ({ status: 200, data: {} });
const calls = [];

const respond = (config, status, data) => {
  const response = { data, status, statusText: String(status), headers: {}, config, request: {} };
  if (status >= 200 && status < 300) return response;
  throw new AxiosError(`Request failed with status code ${status}`,
    status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST", config, {}, response);
};

axios.defaults.adapter = async (config) => {
  const p = String(config.url);
  calls.push(p);
  // Let concurrent requests line up behind one refresh, as they do for real.
  await new Promise((r) => setTimeout(r, 5));
  if (p.includes("/auth/logout")) return respond(config, 200, { success: true });
  if (p.includes("/auth/refresh")) {
    const r = refresh(config);
    if (r === "network") throw new AxiosError("Network Error", "ERR_NETWORK", config, {});
    if (r === "timeout") throw new AxiosError("timeout of 30000ms exceeded", "ECONNABORTED", config, {});
    return respond(config, r.status, r.data);
  }
  const auth = String(config.headers?.Authorization ?? "");
  return auth === "Bearer fresh"
    ? respond(config, 200, { ok: true, path: p })
    : respond(config, 401, { success: false, code: "TOKEN_EXPIRED" });
};

// ── The real modules ────────────────────────────────────────────────────────
const vite = await createServer({
  root: ROOT, configFile: false, logLevel: "error", appType: "custom",
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  server: { middlewareMode: true, hmr: false, watch: null },
});

let failedToLoad = null;
try {
  const { useAuthStore } = await vite.ssrLoadModule("/src/store/auth.store.ts");
  const { default: api, getErrorMessage } = await vite.ssrLoadModule("/src/lib/axios.ts");
  const { default: i18n } = await vite.ssrLoadModule("/src/i18n/index.ts");
  await i18n.changeLanguage("en");

  const USER = { _id: "u1", name: "Bursar", role: "bursar", schoolId: "s1", permissions: [] };
  const signIn = () => {
    useAuthStore.getState().setAuth(USER, "stale", "refresh-1");
    redirects.length = 0;
    calls.length = 0;
  };
  const signedIn = () => ({
    store:   useAuthStore.getState().isAuthenticated && useAuthStore.getState().token === "stale",
    storage: localStorage.getItem("token") === "stale" && localStorage.getItem("refreshToken") === "refresh-1",
  });

  /** Settles, or reports that it hung — a request stuck in the queue is a failure too. */
  const settle = (promise) => Promise.race([
    promise.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    new Promise((r) => setTimeout(() => r({ hung: true }), 2_000)),
  ]);

  // ── 1. No connection while renewing ───────────────────────────────────────
  console.log("--- refresh fails for want of a network ---");
  signIn();
  refresh = () => "network";
  const [a, b] = await Promise.all([settle(api.get("/students")), settle(api.get("/classes"))]);
  check("the request fails rather than hangs", [a.hung ?? false, a.ok], [false, false]);
  check("and so does the one queued behind the refresh", [b.hung ?? false, b.ok], [false, false]);
  check("with a network error, not the 401", [a.e?.code, b.e?.code], ["ERR_NETWORK", "ERR_NETWORK"]);
  check("which reads as no connection, not a lost session",
    getErrorMessage(a.e), i18n.t("errors.offline"));
  check("the session is kept, in the store and on disk", signedIn(), { store: true, storage: true });
  check("nobody is sent to /login", redirects, []);
  check("no sign-out request was made", calls.filter((c) => c.includes("/auth/logout")).length, 0);
  check("the refresh was asked once for both", calls.filter((c) => c.includes("/auth/refresh")).length, 1);

  console.log("--- a timeout, a server fault, a page that is not ours ---");
  for (const [label, behaviour] of [
    ["a timeout", () => "timeout"],
    ["a 502 from the proxy", () => ({ status: 502, data: "<html>Bad gateway</html>" })],
    ["a 500 from the server", () => ({ status: 500, data: { success: false, message: "Token refresh failed" } })],
    ["a 200 captive-portal page", () => ({ status: 200, data: "<html>Log in to Wi-Fi</html>" })],
  ]) {
    signIn();
    refresh = behaviour;
    const r = await settle(api.get("/students"));
    check(`${label}: the request fails`, [r.hung ?? false, r.ok], [false, false]);
    check(`${label}: the session is kept`, signedIn(), { store: true, storage: true });
    check(`${label}: no redirect`, redirects, []);
  }

  console.log("--- after an unreachable refresh, the next 401 tries again ---");
  signIn();
  refresh = () => "network";
  await settle(api.get("/students"));
  refresh = () => ({ status: 200, data: { token: "fresh", refreshToken: "refresh-2", user: USER } });
  const again = await settle(api.get("/students"));
  check("the retry renews and the request succeeds", [again.ok, again.v?.data?.ok], [true, true]);
  check("with the new token stored", localStorage.getItem("token"), "fresh");

  // ── 2. The server refuses ─────────────────────────────────────────────────
  console.log("--- the server refuses the session ---");
  for (const [label, status, code] of [
    ["401 REFRESH_EXPIRED", 401, "REFRESH_EXPIRED"],
    ["401 REFRESH_STALE (password changed)", 401, "REFRESH_STALE"],
    ["401 SCHOOL_INACTIVE", 401, "SCHOOL_INACTIVE"],
    ["401 account deactivated", 401, undefined],
    ["403 UNKNOWN_ROLE", 403, "UNKNOWN_ROLE"],
  ]) {
    signIn();
    refresh = () => ({ status, data: { success: false, ...(code ? { code } : {}), message: "no" } });
    const [r, q] = await Promise.all([settle(api.get("/students")), settle(api.get("/classes"))]);
    const s = useAuthStore.getState();
    check(`${label}: both requests fail, none hangs`,
      [r.hung ?? false, r.ok, q.hung ?? false, q.ok], [false, false, false, false]);
    check(`${label}: signed out`, [s.isAuthenticated, s.token, localStorage.getItem("token")], [false, null, null]);
    check(`${label}: sent to /login`, redirects.includes("/login"), true);
  }

  // ── 3. The ordinary renewal still works ───────────────────────────────────
  console.log("--- a successful refresh replays the queue ---");
  signIn();
  refresh = () => ({ status: 200, data: { token: "fresh", refreshToken: "refresh-2", user: USER } });
  const [x, y] = await Promise.all([settle(api.get("/students")), settle(api.get("/classes"))]);
  check("both requests are replayed with the new token", [x.ok, y.ok, x.v?.data?.path, y.v?.data?.path],
    [true, true, "/students", "/classes"]);
  check("one refresh served both", calls.filter((c) => c.includes("/auth/refresh")).length, 1);
  check("still signed in", useAuthStore.getState().isAuthenticated, true);
  check("no redirect", redirects, []);
} catch (err) {
  failedToLoad = err;
} finally {
  await vite.close();
}

if (failedToLoad) {
  console.log(`  FAIL the harness itself: ${failedToLoad?.stack ?? failedToLoad}`);
  fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
