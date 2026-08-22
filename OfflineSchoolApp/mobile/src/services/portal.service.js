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

const TOKEN_KEY = "portal_token";
const CACHE     = "portal_cache";

const client = axios.create({ baseURL: `${API_URL}/portal`, timeout: 20_000 });

client.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSION
// ─────────────────────────────────────────────────────────────────────────────

export const getToken   = () => SecureStore.getItemAsync(TOKEN_KEY);
export const setToken   = (t) => SecureStore.setItemAsync(TOKEN_KEY, t);
export const clearToken = () => SecureStore.deleteItemAsync(TOKEN_KEY);

export const login = async ({ admissionNo, code }) => {
  const { data } = await axios.post(`${API_URL}/portal/login`, { admissionNo, code });
  if (data?.token) await setToken(data.token);
  return data;
};

export const signOut = async () => {
  await clearToken();
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
export const fetchResults       = (studentId) => load("results", "/results", studentId);
export const fetchAttendance    = (studentId) => load("attendance", "/attendance", studentId);
export const fetchAnnouncements = (studentId) => load("news", "/announcements", studentId);

/** The printable receipt, as HTML the phone turns into a PDF. */
export const fetchReceiptHtml = async (paymentId, lang = "en") => {
  const { data } = await client.get(`/receipt/${paymentId}`, {
    params: { lang },
    responseType: "text",
    transformResponse: [(body) => body],
  });
  return typeof data === "string" ? data : String(data ?? "");
};

export default {
  login, signOut, getToken, clearToken,
  fetchMe, fetchFees, fetchResults, fetchAttendance, fetchAnnouncements,
  fetchReceiptHtml,
};
