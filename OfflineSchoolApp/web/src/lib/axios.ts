// web/src/lib/axios.ts
import axios            from "axios";
import { getAuthState } from "@/store/auth.store";

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE
// baseURL "/api" pairs with the Vite dev proxy.
// In production set VITE_API_URL and have your reverse-proxy
// (nginx / caddy) forward /api → backend.
// ─────────────────────────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "/api",
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
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
  (res) => res,
  async (err) => {
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

export default api;