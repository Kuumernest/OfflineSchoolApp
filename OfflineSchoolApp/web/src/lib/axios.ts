// web/src/lib/axios.ts
import axios            from "axios";
import { getAuthState } from "@/store/auth.store";
import { offlineAdapter } from "@/lib/offline/adapter";

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE
// baseURL "/api" pairs with the Vite dev proxy.
// In production set VITE_API_URL and have your reverse-proxy
// (nginx / caddy) forward /api → backend.
// ─────────────────────────────────────────────────────────────────────────────

import {
  scaleTimeout, recordSuccess, recordTimeout, recordFailure,
} from "./linkQuality";

// axios has no `metadata` on its config; this is the conventional way to
// carry per-request state from the request interceptor to the response one.
declare module "axios" {
  export interface InternalAxiosRequestConfig {
    metadata?: { budget: number; startedAt: number; servedLocally?: boolean };
  }
  export interface AxiosRequestConfig {
    metadata?: { budget: number; startedAt: number; servedLocally?: boolean };
  }
}
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "/api",
  // 30s, not 15s. The schools run over the public internet, and 15s was
  // short enough that an ordinary slow response looked like a failure —
  // the request was aborted while the server was still working on it, so
  // the user saw an error for something that would have succeeded.
  // Genuinely long operations override this; see TIMEOUTS below.
  timeout: 30_000,
  headers: { "Content-Type": "application/json" },

  /**
   * On the desktop, reads are answered from the local database.
   *
   * This one line is the whole offline seam for the 225 api.* calls in this
   * codebase. In a browser the adapter sees no bridge and hands every request
   * straight to the network, so nothing about the web build changes.
   *
   * axios.getAdapter resolves the default — which is a LIST of names
   * (["xhr","http","fetch"]) rather than a function, so it cannot simply be
   * called. Resolved lazily, inside the fallback, because resolving it at module
   * load would pick an adapter before axios has finished deciding which of those
   * three this environment supports.
   */
  adapter: offlineAdapter((config) => axios.getAdapter(axios.defaults.adapter)(config)),
});

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH QUEUE
// When a 401 arrives and a refresh is already in progress, subsequent
// requests are held here and replayed once the refresh resolves.
// ─────────────────────────────────────────────────────────────────────────────

interface QueueEntry {
  resolve: (token: string) => void;
  reject:  (reason?: unknown) => void;
}

let _isRefreshing = false;
let _failedQueue: QueueEntry[] = [];

/**
 * Flush the queue after a refresh attempt.
 * @param error  - If set, all queued requests are rejected.
 * @param token  - If set, all queued requests are retried with this token.
 */
const processQueue = (error: unknown, token: string | null = null): void => {
  _failedQueue.forEach(({ resolve, reject }) => {
    if (error || !token) reject(error);
    else                 resolve(token);
  });
  _failedQueue = [];
};

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST INTERCEPTOR
// Attaches the JWT to every outgoing request.
// Reads from the Zustand store first (always current after login) then
// falls back to localStorage for the page-refresh / cold-start case.
// ─────────────────────────────────────────────────────────────────────────────

api.interceptors.request.use(
  (config) => {
    let token: string | null = null;

    // 1️⃣  In-memory Zustand store — authoritative after first login
    try {
      token = getAuthState().token;
    } catch {
      // Store not yet initialised (extremely unlikely but safe to handle)
    }

    // 2️⃣  localStorage fallback — covers hard page refreshes before initAuth
    if (!token) {
      try {
        token = localStorage.getItem("token");
      } catch { /* private-browsing / storage blocked */ }
    }

    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // 3️⃣  Scale the timeout to the link actually in use.
    //
    // The ORIGINAL budget, remembered, not whatever is on the config now:
    // the 401 path below replays originalRequest — the same object — so it
    // re-enters this interceptor with config.timeout already scaled once.
    // Reading it back would scale the scaled value, and on a slow link a
    // 30s budget would reach the 180s ceiling by its second attempt.
    const prior  = Number(config.metadata?.budget);
    const budget = prior > 0 ? prior : (Number(config.timeout) || 30_000);

    config.timeout  = scaleTimeout(budget);
    config.metadata = { budget, startedAt: Date.now() };

    return config;
  },
  (error) => Promise.reject(error),
);

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE INTERCEPTOR
// On 401:
//   1. Skip auth/* endpoints to prevent infinite loops.
//   2. If a refresh is already in-flight, queue the request.
//   3. Otherwise attempt a token refresh via the store.
//   4. On success replay all queued requests with the new token.
//   5. On failure clear auth and redirect to /login.
// ─────────────────────────────────────────────────────────────────────────────

api.interceptors.response.use(
  (res) => {
    const meta = res.config?.metadata;
    if (meta?.startedAt && !meta.servedLocally) {
      recordSuccess(Date.now() - meta.startedAt, meta.budget);
    }
    return res;
  },
  async (err) => {
    // ECONNABORTED is how axios reports its own timeout firing. Only that
    // counts: a 500 or a 404 says nothing about how fast the link is, and
    // feeding those in would raise every budget because of a server fault.
    if (err?.code === "ECONNABORTED") recordTimeout();
    else recordFailure();

    const originalRequest = err?.config as (typeof err)["config"] & { _retry?: boolean };
    const status          = err?.response?.status as number | undefined;
    const url             = (originalRequest?.url as string) ?? "";

    // Never attempt refresh for requests that are themselves auth operations.
    // This prevents redirect loops when credentials are wrong on login, and
    // avoids recursion on /auth/refresh itself failing.
    const isAuthEndpoint = url.includes("/auth/");

    if (status === 401 && !isAuthEndpoint && !originalRequest._retry) {
      // ── Case A: refresh already in progress ──────────────────────────────
      // Hold this request in the queue; it will be retried once the
      // in-flight refresh settles.
      if (_isRefreshing) {
        return new Promise<string>((resolve, reject) => {
          _failedQueue.push({ resolve, reject });
        }).then((newToken) => {
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return api(originalRequest);
        });
      }

      // ── Case B: initiate a refresh ────────────────────────────────────────
      originalRequest._retry = true; // Guard against retrying the retry
      _isRefreshing          = true;

      try {
        const success = await getAuthState().refreshSession();

        if (success) {
          const newToken = getAuthState().token;

          if (!newToken) throw new Error("Token missing after successful refresh");

          processQueue(null, newToken);

          // Replay the original request with the fresh token
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return api(originalRequest);
        }

        // refreshSession returned false — it already called logout() internally
        throw new Error("Token refresh returned false");

      } catch (refreshErr) {
        processQueue(refreshErr, null);

        // Ensure auth state is clean (logout is idempotent)
        try { getAuthState().logout(); } catch { /* ignore */ }

        if (
          typeof window !== "undefined" &&
          window.location.pathname !== "/login"
        ) {
          window.location.replace("/login");
        }

        return Promise.reject(refreshErr);
      } finally {
        _isRefreshing = false;
      }
    }

    return Promise.reject(err);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// HELPER UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the error message from an axios error.
 * Handles both server-returned messages and network errors.
 */
export const getErrorMessage = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    const serverMsg =
      (error.response?.data as Record<string, unknown>)?.message ||
      (error.response?.data as Record<string, unknown>)?.error;
    if (typeof serverMsg === "string" && serverMsg) return serverMsg;
    if (error.message) return error.message;
  }
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
};

export const isNotFound = (error: unknown): boolean =>
  axios.isAxiosError(error) && error.response?.status === 404;

export const isConflict = (error: unknown): boolean =>
  axios.isAxiosError(error) && error.response?.status === 409;

export const isBadRequest = (error: unknown): boolean =>
  axios.isAxiosError(error) && error.response?.status === 400;

/**
 * Per-operation timeouts, for the calls that do real work on the server
 * before they can answer.
 *
 * The instance default above is sized for ordinary reads and writes. It is
 * the wrong ceiling for rendering a report card or recomputing a term: for
 * those, thirty seconds is the length of a normal success rather than the
 * sign of a problem, and aborting at that point throws away work the server
 * has already done and is about to return.
 */
export const TIMEOUTS = {
  /** The server renders one document per request — report cards. */
  render: 60_000,
  /** Whole-cohort work: compute, publish, promote, export. */
  long: 120_000,
} as const;

export default api;