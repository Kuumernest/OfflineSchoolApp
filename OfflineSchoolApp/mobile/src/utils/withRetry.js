// src/utils/withRetry.js
"use strict";

/**
 * Lightweight retry wrapper for direct api.get/post calls that live
 * outside SyncManager._withRetry.
 *
 * Mirrors the same exponential back-off + jitter logic used by
 * SyncManager._withRetry so behaviour is consistent across the app.
 *
 * Usage:
 *   import { withRetry } from "../utils/withRetry";
 *
 *   const res  = await withRetry(() => api.get("/teacher/profile"));
 *   const data = await withRetry(() => api.post("/admin/assignments", body), 3, 1000);
 *
 * @param {() => Promise<any>} fn        — the axios call to retry
 * @param {number}             retries   — max attempts          (default 3)
 * @param {number}             delayMs   — base delay in ms      (default 1 000)
 * @returns {Promise<any>}               — resolves with the first success
 * @throws  {Error}                      — re-throws after all attempts fail
 */
export const withRetry = async (fn, retries = 3, delayMs = 1_000) => {
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const status      = err?.response?.status;
      const isNetErr    = !err.response;                      // no response at all
      const isServerErr = status >= 500 && status <= 599;    // 5xx
      const isTimeout   = err.code === "ECONNABORTED" ||
                          err.message?.includes("timeout");

      // ── Hard-fail — retrying won't help ────────────────────────────────
      // Auth errors: token is invalid, a retry won't fix that.
      if (status === 401 || status === 403) throw err;
      // Client errors: bad request, not found, etc.
      if (status >= 400 && status < 500)   throw err;
      // Offline guard error set by api.js request interceptor
      if (err.isOffline)                   throw err;

      // ── Decide whether to retry ─────────────────────────────────────────
      const shouldRetry =
        (isNetErr || isServerErr || isTimeout) &&
        attempt < retries;

      if (!shouldRetry) break;

      // ── Exponential back-off with jitter ────────────────────────────────
      // attempt 1 → ~1 000 ms
      // attempt 2 → ~2 000 ms
      // attempt 3 → ~4 000 ms
      // capped at 8 000 ms
      const base  = delayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 300;
      const delay  = Math.min(base + jitter, 8_000);

      console.warn(
        `[withRetry] attempt ${attempt}/${retries} failed` +
        ` (${err.message}).` +
        ` Retrying in ${Math.round(delay)}ms…`
      );

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastErr;
};