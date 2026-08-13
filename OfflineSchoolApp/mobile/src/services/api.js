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
 *  - Auto-refresh token on 401 before giving up
 *  - Provide dev-mode request / response logging
 *  - Suppress "No response" error logs for non-final retry attempts
 *    and downgrade one-shot transient blips from error → warn
 *
 * Fixed issues:
 *  #C6    — schoolId read from Zustand store directly (no circular dep)
 *  #PERF  — NetInfo listener replaces per-request NetInfo.fetch()
 *  #CIRC  — auth store loaded lazily to break circular imports
 *  #401   — _loggingOut reset extended to 10 s
 *  #RETRY — mid-retry "No response" logs suppressed; one-shot blips
 *           downgraded from console.error → console.warn
 *  #KEEP  — Connection: keep-alive header added to reduce TCP reconnects
 *  #TMO   — timeout increased to 20 s for Android WiFi radio wake-up
 *  #TREF  — Token refresh on 401 before auto-logout
 */

import axios            from "axios";
import NetInfo          from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";

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
  timeout: 20_000,
  headers: { "Content-Type": "application/json" },
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

const TOKEN_KEY       = "auth_token";
const REFRESH_KEY     = "refresh_token";
const OFFLINE_TOKEN   = "offline_mode";

/**
 * Background / sync routes that fire before the auth store is fully loaded.
 * A 401 on these routes will attempt a token refresh before giving up.
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

let _isConnected = true;

const _netInfoUnsubscribe = NetInfo.addEventListener((state) => {
  const wasConnected = _isConnected;
  _isConnected       = state.isConnected !== false;

  if (__DEV__ && wasConnected !== _isConnected) {
    console.log(
      `[api] 🌐 Connectivity: ${_isConnected ? "online" : "offline"}`
    );
  }
});

void _netInfoUnsubscribe;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — RETRY CONTEXT
// ═════════════════════════════════════════════════════════════════════════════

let _currentAttempt    = 1;
let _currentMaxRetries = 1;

export const setRetryContext = (attempt, maxRetries) => {
  _currentAttempt    = attempt;
  _currentMaxRetries = maxRetries;
};

export const clearRetryContext = () => {
  _currentAttempt    = 1;
  _currentMaxRetries = 1;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — LAZY AUTH STORE ACCESSOR
// ═════════════════════════════════════════════════════════════════════════════

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

const getSchoolIdFromStore = () => {
  try {
    const store = getAuthStore();
    if (!store) return null;
    const state = store.getState();
    return (
      state?.user?.schoolId  ??
      state?.user?.school_id ??
      state?.schoolId        ??
      null
    );
  } catch {
    return null;
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — TOKEN RESOLVER
// ═════════════════════════════════════════════════════════════════════════════

const getToken = async () => {
  // Strategy 1: Zustand store
  try {
    const store = getAuthStore();
    if (store) {
      const token = store.getState()?.token;
      if (token && token !== OFFLINE_TOKEN) return token;
      if (token === OFFLINE_TOKEN)          return null;
    }
  } catch (err) {
    console.warn("[api] Store token read failed:", err.message);
  }

  // Strategy 2: SecureStore
  try {
    const token = await SecureStore.getItemAsync(TOKEN_KEY);
    if (token && token !== OFFLINE_TOKEN) {
      if (__DEV__) console.log("[api] 🔐 Token from SecureStore fallback");

      try {
        const store = getAuthStore();
        if (store && !store.getState()?.token) {
          const userJson = await SecureStore.getItemAsync("user");
          if (userJson) {
            store.setState({ token, user: JSON.parse(userJson) });
            if (__DEV__) console.log("[api] 🔄 Store rehydrated from SecureStore");
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
// SECTION 8 — TOKEN REFRESH
// ═════════════════════════════════════════════════════════════════════════════

let _isRefreshing     = false;
let _refreshPromise   = null;

/**
 * Attempts to get a new access token using:
 *   1. The refresh token from the Zustand store
 *   2. The refresh token from SecureStore
 *   3. Re-using the existing access token via POST /auth/refresh (Mode B)
 *
 * Returns the new access token string, or null if refresh failed.
 */
const refreshAccessToken = async () => {
  // Deduplicate concurrent refresh calls
  if (_isRefreshing && _refreshPromise) {
    return _refreshPromise;
  }

  _isRefreshing   = true;
  _refreshPromise = (async () => {
    try {
      if (__DEV__) console.log("[api] 🔄 Attempting token refresh…");

      // ── Get refresh token ─────────────────────────────────────────────────
      let refreshToken = null;

      try {
        const store = getAuthStore();
        refreshToken = store?.getState?.()?.refreshToken ?? null;
      } catch { /* ignore */ }

      if (!refreshToken) {
        try {
          refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
        } catch { /* ignore */ }
      }

      // ── Get current access token (for Mode B fallback) ───────────────────
      const currentToken = await getToken();

      // ── Call /auth/refresh ────────────────────────────────────────────────
      const payload  = refreshToken ? { refreshToken } : {};
      const headers  = {};

      if (!refreshToken && currentToken) {
        // Mode B: server re-issues from a still-valid (or recently-expired)
        // access token. Works when JWT_REFRESH_SECRET is not configured.
        headers.Authorization = `Bearer ${currentToken}`;
      }

      const response = await axios.post(
        `${API_URL}/auth/refresh`,
        payload,
        { headers, timeout: 10_000 }
      );

      const newToken        = response.data?.token;
      const newRefreshToken = response.data?.refreshToken;

      if (!newToken) {
        console.warn("[api] Token refresh returned no token");
        return null;
      }

      if (__DEV__) console.log("[api] ✅ Token refreshed successfully");

      // ── Persist new tokens ────────────────────────────────────────────────
      try {
        await SecureStore.setItemAsync(TOKEN_KEY, newToken);
        if (newRefreshToken) {
          await SecureStore.setItemAsync(REFRESH_KEY, newRefreshToken);
        }
      } catch (err) {
        console.warn("[api] SecureStore write failed during refresh:", err.message);
      }

      // ── Update Zustand store ──────────────────────────────────────────────
      try {
        const store = getAuthStore();
        if (store) {
          store.setState((prev) => ({
            ...prev,
            token:        newToken,
            refreshToken: newRefreshToken ?? prev.refreshToken,
          }));
        }
      } catch { /* ignore */ }

      return newToken;

    } catch (err) {
      if (__DEV__) {
        console.warn(
          "[api] Token refresh failed:",
          err.response?.data?.message ?? err.message
        );
      }
      return null;
    } finally {
      _isRefreshing   = false;
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9 — 401 GUARD STATE
// ═════════════════════════════════════════════════════════════════════════════

let _loggingOut       = false;
const LOGOUT_RESET_MS = 10_000;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10 — REQUEST INTERCEPTOR
// ═════════════════════════════════════════════════════════════════════════════

api.interceptors.request.use(
  async (config) => {

    // 1. Offline guard
    if (!_isConnected) {
      const err     = new Error("No internet connection");
      err.isOffline = true;
      return Promise.reject(err);
    }

    // 2. Auth token
    const token = await getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // 3. Auto-inject schoolId for /admin/* routes
    if (config.url?.includes("/admin/")) {
      const schoolId = getSchoolIdFromStore();
      if (schoolId) {
        config.params = { schoolId, ...config.params };
        if (__DEV__) console.log(`[api]    🏫 schoolId injected: ${schoolId}`);
      } else if (__DEV__) {
        console.warn(
          `[api] ⚠️  /admin/ request fired but no schoolId in store.\n` +
          `        URL: ${config.url}`
        );
      }
    }

    // 4. Stamp retry context
    config._attempt    = _currentAttempt;
    config._maxRetries = _currentMaxRetries;

    // 5. Mark whether this request has already been retried after a refresh
    //    (prevents infinite retry loops)
    if (config._retried === undefined) {
      config._retried = false;
    }

    // 6. Keep-alive to reduce TCP reconnects on Android WiFi
    config.headers["Connection"] = "keep-alive";

    // 7. Dev request log
    if (__DEV__) {
      const method  = (config.method || "GET").toUpperCase();
      const fullUrl = `${config.baseURL ?? ""}${config.url ?? ""}`;
      const authTag = token ? `Bearer ${token.slice(0, 20)}…` : "❌ NO TOKEN";
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
// SECTION 11 — RESPONSE INTERCEPTOR
// ═════════════════════════════════════════════════════════════════════════════

api.interceptors.response.use(

  (response) => {
    if (__DEV__) {
      console.log(`[api] ✅ ${response.status} ← ${response.config?.url}`);
    }
    return response;
  },

  async (error) => {
    const status  = error?.response?.status;
    const url     = error?.config?.url    ?? "unknown";
    const fullUrl = `${error?.config?.baseURL ?? API_URL}${url}`;

    const attempt    = error?.config?._attempt    ?? 1;
    const maxRetries = error?.config?._maxRetries ?? 1;
    const isFinal    = attempt >= maxRetries;
    const isOneShot  = maxRetries <= 1;

    // ── 401 handling ─────────────────────────────────────────────────────────
    if (status === 401) {

      const originalConfig = error.config;

      // ── Try token refresh first (once per request) ────────────────────────
      if (!originalConfig._retried) {
        originalConfig._retried = true;

        if (__DEV__) {
          console.warn(
            `[api] ⚠️  401 on "${url}" — attempting token refresh…`
          );
        }

        const newToken = await refreshAccessToken();

        if (newToken) {
          // Retry the original request with the new token
          originalConfig.headers.Authorization = `Bearer ${newToken}`;
          if (__DEV__) {
            console.log(`[api] 🔁 Retrying "${url}" with refreshed token`);
          }
          return api(originalConfig);
        }

        // Refresh failed — decide whether to logout or just warn
        if (__DEV__) {
          console.warn(`[api] ⚠️  Token refresh failed for "${url}"`);
        }
      }

      // ── Sync routes: warn and reject, never auto-logout ───────────────────
      if (isSyncRoute(url)) {
        if (__DEV__) {
          console.warn(
            `[api] ⚠️  401 on sync route "${url}" — skipping auto-logout.`
          );
        }
        return Promise.reject(error);
      }

      // ── Non-sync routes: auto-logout ──────────────────────────────────────
      if (!_loggingOut) {
        _loggingOut = true;
        try {
          const store = getAuthStore();
          if (store?.getState?.().logout) {
            await store.getState().logout();
            if (__DEV__) {
              console.warn("[api] 🔒 401 — user logged out automatically");
            }
          }
        } catch (err) {
          console.warn("[api] Auto-logout failed:", err.message);
        } finally {
          setTimeout(() => { _loggingOut = false; }, LOGOUT_RESET_MS);
        }
      }

      return Promise.reject(error);
    }

    // ── Non-401 error logging ─────────────────────────────────────────────
    if (__DEV__) {
      if (error.response) {
        console.error(
          `\n[api] ❌ ${status} ← ${url}` +
          `\n         Full URL : ${fullUrl}` +
          `\n         Response : ${JSON.stringify(error.response.data, null, 2)}`
        );

      } else if (error.request) {
        if (isFinal) {
          const reason = error.code === "ECONNABORTED"
            ? `Timeout after ${api.defaults.timeout}ms`
            : "No response (network error / server down)";

          if (isOneShot) {
            console.warn(`[api] ⚠️  No response ← ${url} (${reason})`);
          } else {
            console.error(
              `\n[api] ❌ No response ← ${url}` +
              `\n         Full URL  : ${fullUrl}` +
              `\n         Reason    : ${reason}` +
              "\n         Checklist :" +
              "\n           • Is your backend server running?" +
              "\n           • If on a physical phone, verify LAN_IP is correct" +
              "\n           • Do NOT use 10.0.2.2 on a physical device"
            );
          }
        }

      } else if (!error.isOffline) {
        console.error(`\n[api] ❌ Request setup error: ${error.message}`);
      }
    }

    return Promise.reject(error);
  }
);

export default api;