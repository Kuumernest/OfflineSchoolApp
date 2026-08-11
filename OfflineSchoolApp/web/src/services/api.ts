import axios, { AxiosError } from "axios";
import type { InternalAxiosRequestConfig, AxiosResponse } from "axios";

// ─────────────────────────────────────────────────────────
// BASE INSTANCE
// ─────────────────────────────────────────────────────────

const api = axios.create({
  baseURL: "/api",           // proxied by Vite → http://192.168.1.232:5000/api
  timeout: 30_000,
  headers: {
    "Content-Type": "application/json",
  },
});

// ─────────────────────────────────────────────────────────
// REQUEST INTERCEPTOR — attach JWT
// ─────────────────────────────────────────────────────────

api.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem("auth_token");
    if (token) {
      if (!config.headers) config.headers = {} as InternalAxiosRequestConfig["headers"];
      (config.headers as Record<string, string | undefined>)["Authorization"] = `Bearer ${token}`;
    }
    console.log(`[api] ${config.method?.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => Promise.reject(error)
);

// ─────────────────────────────────────────────────────────
// RESPONSE INTERCEPTOR — handle 401 globally
// ─────────────────────────────────────────────────────────

api.interceptors.response.use(
  (response: AxiosResponse) => {
    console.log(`[api] ✅ ${response.status} ← ${response.config.url}`);
    return response;
  },
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      // Token expired — clear storage and redirect to login
      localStorage.removeItem("auth_token");
      localStorage.removeItem("auth_user");
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);

export default api;