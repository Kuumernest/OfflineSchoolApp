// mobile/src/services/portal.service.js
"use strict";

/**
 * The guardian portal on the phone.
 *
 * A deliberately separate axios instance, not the shared `api` client. That
 * client attaches the STAFF bearer token and, on a 401, tries to refresh a
 * staff session — both wrong here. A guardian holds a different token with a
 * different audience, and a genuine "your code was revoked" must reach the
 * screen rather than being swallowed by a refresh that cannot succeed.
 *
 * Read-only, and cached per section so a parent standing in the school yard
 * with one bar of signal still sees what they came for. The cache is stamped,
 * and the screen says when it is showing yesterday's copy.
 */

import axios from "axios";
import * as SecureStore from "expo-secure-store";

import { API_URL }           from "./api";
import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";

const TOKEN_KEY   = "portal_token";
const SESSION_KEY = "portal_refresh_token";
const CACHE       = "portal_cache";

const client = axios.create({ baseURL: `${API_URL}/portal`, timeout: 20_000 });

// ─────────────────────────────────────────────────────────────────────────────
// SESSION
//
// Two tokens, two jobs. The ACCESS token rides on every request and lasts
// twenty minutes. The REFRESH token is the session: it lasts ninety days and is
// what "signed in" means on this phone. The screen asks hasSession(), not
// whether an access token happens to be unexpired — the first version asked
// the latter, so a parent who opened the app the next morning was signed out
// before the first request had gone.
//
// A lapsed access token is renewed here, inside the client, and the request
// that hit it is sent again. No screen knows this happens.
// ─────────────────────────────────────────────────────────────────────────────

export const getToken        = () => SecureStore.getItemAsync(TOKEN_KEY);
export const setToken        = (t) => SecureStore.setItemAsync(TOKEN_KEY, t);
export const getRefreshToken = () => SecureStore.getItemAsync(SESSION_KEY);
export const hasSession      = async () => Boolean(await getRefreshToken());

/** Forget both tokens. Local only — signOut is what tells the server. */
export const clearToken = async () => {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(SESSION_KEY);
};

// One refresh at a time. Three sections waking together after a night offline
// would otherwise each ask, and the answer is the same token.
let refreshing = null;

/**
 * Renew the access token. Resolves to the new token, or null when this phone
 * holds no session. A 401 from the server is final — the session ended or the
 * code was withdrawn — so both tokens are dropped and the error is rethrown
 * for the screen to explain. Any other failure (no signal, a timeout) is
 * rethrown untouched WITH the session kept: being offline is not a reason to
 * sign anyone out.
 */
const refreshAccessToken = async () => {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) return null;
    try {
      const { data } = await axios.post(
        `${API_URL}/portal/refresh`, { refreshToken }, { timeout: 20_000 }
      );
      await setToken(data.token);
      return data.token;
    } catch (err) {
      if (err?.response?.status === 401) await clearToken();
      throw err;
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
};

client.interceptors.request.use(async (config) => {
  let token = await getToken();
  // A session with no access token: the first request after an update of the
  // app, or after a refresh whose reply never arrived. Renew before asking.
  if (!token && (await getRefreshToken())) token = await refreshAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Which 401s are about the access token rather than the parent. These are
// renewed and retried once; ACCESS_REVOKED and the rest go straight through to
// the screen, which knows what to say.
const RENEWABLE = new Set(["TOKEN_EXPIRED", "NO_TOKEN", "INVALID_TOKEN"]);

client.interceptors.response.use(undefined, async (err) => {
  const config = err?.config;
  if (err?.response?.status !== 401 || !config || config._retried) throw err;
  if (!RENEWABLE.has(err.response?.data?.code)) throw err;
  if (!(await getRefreshToken())) throw err;

  // A refused refresh replaces the original error, so the screen hears
  // "session over" or "code revoked" rather than "token expired". A refresh
  // lost to the network replaces it too — `load` then sees a network failure
  // and serves the cache, instead of a 401 it would refuse to cache over.
  await refreshAccessToken();
  config._retried = true;
  return client.request(config);
});

export const login = async ({ admissionNo, code }) => {
  const { data } = await axios.post(`${API_URL}/portal/login`, { admissionNo, code });
  if (data?.refreshToken) await SecureStore.setItemAsync(SESSION_KEY, data.refreshToken);
  if (data?.token) await setToken(data.token);
  return data;
};

export const signOut = async () => {
  const refreshToken = await getRefreshToken();
  await clearToken();
  // The server is told, so the session cannot be resumed from a backup of this
  // phone. Not awaited: a parent signing out with no signal is signed out of
  // the phone regardless, which is what they asked for.
  if (refreshToken) {
    axios.post(`${API_URL}/portal/logout`, { refreshToken }, { timeout: 10_000 })
      .catch(() => {});
  }
  const db = await getDatabase();
  await ensureSchema(db);
  // The cache holds one child's fees and results. Leaving it behind would show
  // the previous family's figures to whoever signs in next on a shared phone.
  await db.runAsync(`DELETE FROM ${CACHE}`).catch(() => {});
};

// ─────────────────────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────────────────────

const ensureSchema = async (db) => {
  await ensureTableSchema(CACHE, async (database) => {
    await database.execAsync(`CREATE TABLE IF NOT EXISTS ${CACHE} (
      section     TEXT PRIMARY KEY,
      payload     TEXT NOT NULL,
      _fetched_at TEXT
    )`);
  }, db);
};

const cachePut = async (section, payload) => {
  const db = await getDatabase();
  await ensureSchema(db);
  await db.runAsync(
    `INSERT OR REPLACE INTO ${CACHE} (section, payload, _fetched_at) VALUES (?, ?, ?)`,
    [section, JSON.stringify(payload), new Date().toISOString()]
  ).catch(() => {});
};

const cacheGet = async (section) => {
  const db = await getDatabase();
  await ensureSchema(db);
  const row = await db.getFirstAsync(
    `SELECT payload, _fetched_at FROM ${CACHE} WHERE section = ?`, [section]
  ).catch(() => null);
  if (!row) return null;
  try {
    return { data: JSON.parse(row.payload), fetchedAt: row._fetched_at, stale: true };
  } catch {
    return null;
  }
};

/**
 * Fetch a section for one child, falling back to its cached copy when offline.
 *
 * The cache key includes the child. One code can cover three children, and a
 * cache keyed only by section would show the eldest's balance under the
 * youngest's name the moment the parent switched with no signal — which is a
 * worse failure than showing nothing.
 *
 * A 401 is NOT cached over: a revoked code must reach the screen as an error,
 * not be masked by yesterday's figures.
 */
const load = async (section, path, studentId) => {
  const key = studentId ? `${section}:${studentId}` : section;

  try {
    const { data } = await client.get(path, {
      params: studentId ? { studentId } : undefined,
    });
    const payload = data?.data ?? data;
    await cachePut(key, payload);
    return { data: payload, stale: false, fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (err?.response?.status === 401) throw err;
    const cached = await cacheGet(key);
    if (cached) return cached;
    throw err;
  }
};

export const fetchMe            = (studentId) => load("me", "/me", studentId);
export const fetchFees          = (studentId) => load("fees", "/fees", studentId);
export const fetchFeeReminders  = (studentId) => load("fee-reminders", "/fees/reminders", studentId);
export const fetchNotifications = (studentId) => load("notifications", "/notifications", studentId);
export const fetchResults       = (studentId) => load("results", "/results", studentId);
export const fetchAttendance    = (studentId) => load("attendance", "/attendance", studentId);
export const fetchAnnouncements = (studentId) => load("news", "/announcements", studentId);

/**
 * Mark one notice read.
 *
 * Deliberately NOT through `load`: nothing to cache, and a failure here must
 * not be papered over with a stale copy. The screen marks optimistically and
 * the next poll settles it, so a lost call costs a badge that is one too high
 * for twenty-five seconds.
 *
 * Returns the server's new unread count, so the caller can settle onto it
 * rather than trusting its own arithmetic.
 */
export const markNoticeRead = async (noticeId) => {
  const { data } = await client.post(`/notifications/${noticeId}/read`);
  return data?.unreadNotices ?? null;
};

/**
 * Mark every unread notice read.
 *
 * The companion to the above for a parent coming back after a week of gate
 * scans, who would otherwise tap a dozen cards to clear a badge.
 */
export const markAllNoticesRead = async () => {
  const { data } = await client.post("/notifications/read-all");
  return data?.unreadNotices ?? null;
};

// ── Messaging ───────────────────────────────────────────────────────────────
//
// The first part of the portal that writes. Conversations go through `load` so
// the list survives a dead link like every other section; sending does not,
// because a guardian's phone has no outbox — a failed send has to be reported
// rather than silently queued, or a parent would believe the school had been
// told something it never received.

export const fetchConversations = (studentId) =>
  load("messages", "/messages/conversations", studentId);

/** Who this guardian may write to. Needs a connection. */
export const fetchRecipients = async (q = "") => {
  const { data } = await client.get("/messages/recipients", { params: { q } });
  return data?.data ?? [];
};

/** Open, or reuse, a thread. Needs a connection. */
export const openConversation = async (id, kind = "user") => {
  const { data } = await client.post("/messages/conversations", { id, kind });
  return data?.data ?? null;
};

/** One thread, cached per conversation so it re-opens offline. */
export const fetchThread = (conversationId) =>
  load(`thread:${conversationId}`, `/messages/conversations/${conversationId}`);

export const sendMessage = async (conversationId, body) => {
  const { data } = await client.post(
    `/messages/conversations/${conversationId}`,
    { body }
  );
  return data?.data ?? null;
};

export const markRead = async (conversationId, seq) => {
  try {
    await client.post(`/messages/conversations/${conversationId}/read`, { seq });
  } catch {
    // A read receipt is not worth surfacing to a parent.
  }
};

/** The printable receipt, as HTML the phone turns into a PDF. */
export const fetchReceiptHtml = async (paymentId, lang = "en") => {
  const { data } = await client.get(`/receipt/${paymentId}`, {
    params: { lang },
    responseType: "text",
    transformResponse: [(body) => body],
  });
  return typeof data === "string" ? data : String(data ?? "");
};

/**
 * The frozen report card a published result was issued with, as HTML.
 * Returns { html, term, academicYear, issuedAt } — the exact card the school
 * printed, never a re-render. A 404 with code NOT_ISSUED means the marks were
 * published but the school has not issued a card yet.
 */
export const fetchReportCardHtml = async (summaryId) => {
  const { data } = await client.get(`/results/${summaryId}/report-card`);
  return data?.data ?? null;
};

/**
 * The default export, and it must carry EVERYTHING.
 *
 * The messaging functions were added as named exports and never added here.
 * Two of the three portal screens import this module as a namespace —
 * `import * as PortalService` — so they saw every named export and worked.
 * The third, app/portal/index.js, imports the default:
 *
 *   import PortalService from "../../src/services/portal.service";
 *   PortalService.fetchConversations      // undefined
 *
 * `await undefined(childId)` throws, loadAll catches it, setSection(null)
 * runs, and the Messages tab prints "No conversations yet" — over a
 * conversation the server was returning the whole time. The recipient picker
 * and the thread screen kept working, because they use the namespace import.
 * Which is the reported symptom exactly: the messages only appeared when you
 * opened the sender by name.
 *
 * Nothing was wrong with the request, the URL, the parent's identity or the
 * response. One object literal was missing seven keys.
 *
 * check-portal-client asserts this against the object each screen actually
 * imports, derived from that screen's own import statement, so a function
 * added below and forgotten here fails the check rather than one screen.
 */
export default {
  login, signOut, getToken, setToken, clearToken, getRefreshToken, hasSession,
  fetchMe, fetchFees, fetchFeeReminders, fetchNotifications,
  fetchResults, fetchAttendance, fetchAnnouncements,
  fetchReceiptHtml, fetchReportCardHtml,
  markNoticeRead, markAllNoticesRead,
  // Messaging. The omission that caused all of the above.
  fetchConversations, fetchRecipients, openConversation,
  fetchThread, sendMessage, markRead,
};
