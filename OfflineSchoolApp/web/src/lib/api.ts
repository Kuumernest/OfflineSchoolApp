// web/src/lib/api.ts
import axios from "axios";
// verbatimModuleSyntax is on, so types must be imported as types — otherwise
// the emitted JS keeps a runtime import for symbols that only exist in the
// type system.
import type {
  AxiosError,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

// ─────────────────────────────────────────────────────────
// BASE URL
//
// Development:
//   Vite proxies /api → http://192.168.1.232:5000
//   so we use "/api" — no cross-origin issues, no hardcoded IP.
//
// Production:
//   Set VITE_API_URL in your .env file:
//     VITE_API_URL=https://yourserver.com/api
//
// The proxy in vite.config.ts handles the dev rewrite
// automatically — no extra config needed here.
// ─────────────────────────────────────────────────────────

const BASE_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";

// ─────────────────────────────────────────────────────────
// AXIOS INSTANCE
// ─────────────────────────────────────────────────────────

const api = axios.create({
  baseURL:         BASE_URL,
  timeout:         30_000,          // 30 seconds
  withCredentials: false,
  headers: {
    "Content-Type": "application/json",
    "Accept":       "application/json",
  },
});

// ─────────────────────────────────────────────────────────
// REQUEST INTERCEPTOR
// Attaches JWT from localStorage on every request.
//
// Your auth.store.ts writes the token here on login:
//   localStorage.setItem("token", token)
//
// Change "token" to match whatever key your store uses.
// ─────────────────────────────────────────────────────────

api.interceptors.request.use(
  (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
    const token = localStorage.getItem("token");
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error: AxiosError) => Promise.reject(error)
);

// ─────────────────────────────────────────────────────────
// RESPONSE INTERCEPTOR
// Handles auth errors globally so individual services
// don't need to repeat this logic.
// ─────────────────────────────────────────────────────────

api.interceptors.response.use(
  (response: AxiosResponse): AxiosResponse => response,

  (error: AxiosError): Promise<never> => {
    if (error.response?.status === 401) {
      // Token expired or invalid — clear auth state
      localStorage.removeItem("token");
      localStorage.removeItem("user");

      // Redirect to login unless already there
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }

    return Promise.reject(error);
  }
);

// ─────────────────────────────────────────────────────────
// TYPE HELPERS
// ─────────────────────────────────────────────────────────

/**
 * Extract the error message from an axios error.
 * Handles both server-returned messages and network errors.
 */
export const getErrorMessage = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    // Server returned a JSON error body
    const serverMsg =
      (error.response?.data as Record<string, unknown>)?.message ||
      (error.response?.data as Record<string, unknown>)?.error;
    if (typeof serverMsg === "string" && serverMsg) return serverMsg;

    // Network error (no response)
    if (error.message) return error.message;
  }
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
};

/**
 * Returns true if the error is a 404 Not Found.
 */
export const isNotFound = (error: unknown): boolean =>
  axios.isAxiosError(error) && error.response?.status === 404;

/**
 * Returns true if the error is a 409 Conflict.
 */
export const isConflict = (error: unknown): boolean =>
  axios.isAxiosError(error) && error.response?.status === 409;

/**
 * Returns true if the error is a 400 Bad Request.
 */
export const isBadRequest = (error: unknown): boolean =>
  axios.isAxiosError(error) && error.response?.status === 400;

export default api;