// src/services/api.js
"use strict";

/**
 * api.js
 *
 * Central Axios instance used by every service in the app.
 *
 * Responsibilities:
 *  - Attach Bearer token to every request
 *  - Auto-inject schoolId into /admin/* query params
 *  - Handle 401 auto-logout (with guards for background sync routes)
 *  - Provide dev-mode request / response logging
 *
 * Fixed issues:
 *  #C6   — getSchoolId() local function replaced with getCurrentAuth()
 *           from authHelpers (single source of truth for auth state)
 *  #PERF — NetInfo.fetch() removed from the hot request path. A background
 *           listener now tracks connectivity state so the interceptor never
 *           blocks on a network probe. Cold-start default is "assume online"
 *           which matches the behaviour expected when the app first launches.
 *  #CIRC — getCurrentAuth() called lazily via the already-cached _authStore
 *           reference instead of importing authHelpers at module load time.
 *           This removes a potential circular dependency chain:
 *           api → authHelpers → auth.store → (may import api)
 *  #401  — _loggingOut reset extended to 10 s to cover slow-network cases
 *           where multiple 401s arrive within the same request cascade.
 */

import axios             from "axios";
import NetInfo           from "@react-native-community/netinfo";
import * as SecureStore  from "expo-secure-store";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — BASE URL
// ═════════════════════════════════════════════════════════════════════════════

const LAN_IP = "192.168.1.232";
const PORT   = 5000;

const getBaseURL = () => {
  if (!__DEV__) return "https://your-production-domain.com/api";
  return `http://${LAN_IP}:${PORT}/api`;
};

export const API_URL = getBaseURL();

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — AXIOS INSTANCE
// ═════════════════════════════════════════════════════════════════════════════

const api = axios.create({
  baseURL: API_URL,
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

const TOKEN_KEY     = "auth_token";
const OFFLINE_TOKEN = "offline_mode";

/**
 * Background / sync routes that fire before the auth store is fully loaded.
 * A 401 on these routes means a timing issue, NOT an expired session.
 */
const SYNC_ROUTES = [
  "/teacher/my-assignments",
  "/teacher/assignments",
  "/teacher/my-subjects",
  "/teacher/profile",
  "/admin/stats",
  "/users/me",
  "/sync/pull",
  "/sync/push",
  "/quiz/sync",
  "/school/info",
  "/admin/school-info",
];

const isSyncRoute = (url = "") =>
  SYNC_ROUTES.some((route) => url.includes(route));

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — CONNECTIVITY TRACKING
// ═════════════════════════════════════════════════════════════════════════════

/**
 * #PERF — Track connectivity state with a background listener so the request
 * interceptor never has to await NetInfo.fetch() on the hot path.
 *
 * Default is `true` (assume online) so the app works correctly on cold start
 * before the first connectivity event fires. If the device is actually
 * offline, the first failed request will surface the error naturally and
 * subsequent requests will be rejected instantly once `_isConnected` flips.
 *
 * The unsubscribe function is kept in module scope so it is never GC'd.
 */
let _isConnected = true;

const _netInfoUnsubscribe = NetInfo.addEventListener((state) => {
  const wasConnected = _isConnected;
  _isConnected       = state.isConnected !== false; // treat null as online

  if (__DEV__ && wasConnected !== _isConnected) {
    console.log(`[api] 🌐 Connectivity changed: ${_isConnected ? "online" : "offline"}`);
  }
});

// Suppress unused-variable lint warnings — the subscription must stay alive
void _netInfoUnsubscribe;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — LAZY AUTH STORE ACCESSOR
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Lazily requires the Zustand auth store to avoid circular dependency issues
 * at module load time (api.js is imported by almost every other service).
 *
 * Cached after the first successful require.
 */
let _authStore = null;

const getAuthStore = () => {
  if (_authStore) return _authStore;
  try {
    _authStore = require("../store/auth.store").useAuthStore;
    return _authStore;
  } catch (err) {
    console.warn("[api] Could not load auth store:", err.message);
    return null;
  }
};

/**
 * #CIRC — Reads schoolId directly from the Zustand store state instead of
 * importing getCurrentAuth() from authHelpers. This avoids the circular
 * dependency: api → authHelpers → auth.store → (services that import api).
 *
 * Falls back to null when the store is not yet hydrated.
 *
 * @returns {string|null}
 */
const getSchoolIdFromStore = () => {
  try {
    const store = getAuthStore();
    if (!store) return null;
    const state = store.getState();
    return (
      state?.user?.schoolId   ??
      state?.user?.school_id  ??
      state?.schoolId         ??
      null
    );
  } catch {
    return null;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — TOKEN RESOLVER
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolves the current auth token using two fallback strategies:
 *
 *  1. Zustand store  (fastest, always in memory after login)
 *  2. SecureStore    (fallback for cold starts before store is hydrated)
 *
 * Returns null when no token exists or token is the offline sentinel.
 *
 * @returns {Promise<string|null>}
 */
const getToken = async () => {
  // ── Strategy 1: Zustand store ─────────────────────────────────────────────
  try {
    const store = getAuthStore();
    if (store) {
      const token = store.getState()?.token;
      if (token && token !== OFFLINE_TOKEN) return token;
      if (token === OFFLINE_TOKEN) return null;
    }
  } catch (err) {
    console.warn("[api] Store token read failed:", err.message);
  }

  // ── Strategy 2: SecureStore ───────────────────────────────────────────────
  try {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (token && token !== OFFLINE_TOKEN) {
      if (__DEV__) {
        console.log("[api] 🔐 Token loaded from SecureStore fallback");
      }

      // Rehydrate the Zustand store so subsequent calls hit strategy 1.
      try {
        const store = getAuthStore();
        if (store && !store.getState()?.token) {
          const userJson = await SecureStore.getItemAsync("user");
          if (userJson) {
            const user = JSON.parse(userJson);
            store.setState({ token, user });
            if (__DEV__) {
              console.log("[api] 🔄 Store rehydrated from SecureStore");
            }
          }
        }
      } catch { /* non-critical */ }

      return token;
    }
  } catch (err) {
    console.warn("[api] SecureStore read failed:", err.message);
  }

  return null;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — 401 GUARD STATE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Prevents firing multiple simultaneous logouts when several concurrent
 * requests all fail with 401 (common during a sync cascade).
 *
 * #401 — Reset delay extended to 10 s. The original 3 s was too short for
 * slow networks where a retry storm could arrive after the reset fired.
 */
let _loggingOut     = false;
const LOGOUT_RESET_MS = 10_000;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — REQUEST INTERCEPTOR
// ═════════════════════════════════════════════════════════════════════════════

api.interceptors.request.use(
  async (config) => {

    // ── 1. Offline check — synchronous, zero latency ──────────────────────
    // #PERF — reads the cached _isConnected flag set by the NetInfo listener
    // instead of awaiting NetInfo.fetch() on every request.
    if (!_isConnected) {
      const offlineError     = new Error("No internet connection");
      offlineError.isOffline = true;
      return Promise.reject(offlineError);
    }

    // ── 2. Auth token ─────────────────────────────────────────────────────
    const token = await getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // ── 3. Auto-inject schoolId for /admin/* routes ───────────────────────
    // #CIRC — reads schoolId from the store directly (no authHelpers import)
    if (config.url?.includes("/admin/")) {
      const schoolId = getSchoolIdFromStore();

      if (schoolId) {
        config.params = { schoolId, ...config.params };
        if (__DEV__) {
          console.log(`[api]    🏫 schoolId injected: ${schoolId}`);
        }
      } else if (__DEV__) {
        console.warn(
          "[api] ⚠️  /admin/ request fired but no schoolId in store.\n" +
          `        URL: ${config.url}\n` +
          "        Ensure the user is logged in and store has user.schoolId"
        );
      }
    }

    // ── 4. Dev request log ────────────────────────────────────────────────
    if (__DEV__) {
      const method  = (config.method || "GET").toUpperCase();
      const fullUrl = `${config.baseURL ?? ""}${config.url ?? ""}`;
      const authTag = token
        ? `Bearer ${token.slice(0, 20)}…`
        : "❌ NO TOKEN";

      console.log(
        `\n[api] 📡 ${method} ${fullUrl}` +
        `\n         Auth: ${authTag}`
      );
    }

    return config;
  },
  (error) => Promise.reject(error)
);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — RESPONSE INTERCEPTOR
// ═════════════════════════════════════════════════════════════════════════════

api.interceptors.response.use(

  // ── Success handler ───────────────────────────────────────────────────────
  (response) => {
    if (__DEV__) {
      console.log(`[api] ✅ ${response.status} ← ${response.config?.url}`);
    }
    return response;
  },

  // ── Error handler ─────────────────────────────────────────────────────────
  async (error) => {
    const status  = error?.response?.status;
    const url     = error?.config?.url    ?? "unknown";
    const fullUrl = `${error?.config?.baseURL ?? API_URL}${url}`;

    // ── Dev error log ─────────────────────────────────────────────────────
    if (__DEV__) {
      if (error.response) {
        console.error(
          `\n[api] ❌ ${status} ← ${url}` +
          `\n         Full URL : ${fullUrl}` +
          `\n         Response : ${JSON.stringify(error.response.data, null, 2)}`
        );
      } else if (error.request) {
        console.error(
          `\n[api] ❌ No response ← ${url}` +
          `\n         Full URL  : ${fullUrl}` +
          "\n         Checklist :" +
          "\n           • Is your backend server running?" +
          "\n           • If on a physical phone, verify LAN_IP is correct" +
          "\n           • Do NOT use 10.0.2.2 on a physical device"
        );
      } else {
        console.error(`\n[api] ❌ Request error: ${error.message}`);
      }
    }

    // ── Auto-logout on 401 ────────────────────────────────────────────────
    if (status === 401) {
      const syncRoute = isSyncRoute(url);

      if (syncRoute) {
        if (__DEV__) {
          console.warn(
            `[api] ⚠️  401 on sync route "${url}" — skipping auto-logout.`
          );
        }
      } else if (!_loggingOut) {
        _loggingOut = true;
        try {
          const store = getAuthStore();
          if (store?.getState?.().logout) {
            await store.getState().logout();
            if (__DEV__) {
              console.warn("[api] 🔒 401 received — user logged out automatically");
            }
          }
        } catch (err) {
          console.warn("[api] Auto-logout failed:", err.message);
        } finally {
          // #401 — extended from 3 s to 10 s
          setTimeout(() => { _loggingOut = false; }, LOGOUT_RESET_MS);
        }
      }
    }

    return Promise.reject(error);
  }
);

export default api;