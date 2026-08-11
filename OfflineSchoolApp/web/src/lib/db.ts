// web/src/lib/db.ts
//
// This is the WEB project (Vite + React).
// There is no React Native, no expo-sqlite, no SQLite.
//
// All persistence is handled via:
//   • localStorage  — auth token, user profile, simple flags
//   • React Query   — server-state caching
//   • API calls     — source of truth (MongoDB via Express)
// ─────────────────────────────────────────────────────────

export type WebDB = {
  getItem:    (key: string) => string | null;
  setItem:    (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear:      () => void;
};

// ─────────────────────────────────────────────────────────
// initDB
// Returns a localStorage wrapper so any existing code that
// called initDB() keeps working without changes.
// ─────────────────────────────────────────────────────────
export function initDB(): WebDB {
  return {
    getItem:    (key)        => {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    setItem:    (key, value) => {
      try { localStorage.setItem(key, value); } catch { /* ignore */ }
    },
    removeItem: (key)        => {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    },
    clear:      ()           => {
      try { localStorage.clear(); } catch { /* ignore */ }
    },
  };
}

// ─────────────────────────────────────────────────────────
// db — convenience singleton with typed helpers
// ─────────────────────────────────────────────────────────
export const db = {
  // ── Generic ────────────────────────────────────────────

  get<T = string>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      // Try JSON parse; fall back to returning raw string
      try {
        return JSON.parse(raw) as T;
      } catch {
        return raw as unknown as T;
      }
    } catch {
      return null;
    }
  },

  set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(
        key,
        typeof value === "string" ? value : JSON.stringify(value)
      );
    } catch (err) {
      console.warn("db.set failed:", err);
    }
  },

  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch { /* ignore */ }
  },

  clear(): void {
    try {
      localStorage.clear();
    } catch { /* ignore */ }
  },

  // ── Auth shortcuts ──────────────────────────────────────

  getToken():          string | null { return this.get<string>("token"); },
  setToken(t: string): void          { this.set("token", t);             },
  clearToken():        void          { this.remove("token");              },

  getUser<T = unknown>(): T | null   { return this.get<T>("user");        },
  setUser<T>(u: T):       void       { this.set("user", u);               },
  clearUser():            void       { this.remove("user");               },

  // ── School / session shortcuts ──────────────────────────

  getSchoolId():             string | null { return this.get<string>("schoolId"); },
  setSchoolId(id: string):   void          { this.set("schoolId", id);            },
  clearSchoolId():           void          { this.remove("schoolId");             },
};

export default db;