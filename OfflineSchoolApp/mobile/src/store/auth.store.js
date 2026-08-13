// src/store/auth.store.js — complete fixed file

import { create }       from "zustand";
import * as SecureStore from "expo-secure-store";
import { API_URL }      from "../services/api";

// ── Safe imports ───────────────────────────────────────────────────────────
let NetInfo = null;
try {
  NetInfo = require("@react-native-community/netinfo").default;
} catch (e) {
  console.warn("NetInfo not available");
}

let CryptoJS = null;
try {
  CryptoJS = require("crypto-js");
} catch (e) {
  console.warn("CryptoJS not available");
}

let DB = null;
try {
  DB = require("../db/dbService").DB;
} catch (e) {
  console.warn("DB not available");
}

// ── Constants ──────────────────────────────────────────────────────────────
const TOKEN_KEY         = "auth_token";
const REFRESH_TOKEN_KEY = "auth_refresh_token";
const USER_KEY          = "user";
const OFFLINE_TOKEN     = "offline_mode";

// ── Crypto helpers ─────────────────────────────────────────────────────────
const generateSalt = () =>
  Date.now().toString(36) + Math.random().toString(36).substring(2);

const hashPassword = (password, salt) => {
  if (!CryptoJS) return password + salt;
  return CryptoJS.PBKDF2(password, salt, {
    keySize:    256 / 32,
    iterations: 10000,
  }).toString();
};

const comparePassword = (password, salt, hash) =>
  hashPassword(password, salt) === hash;

// ── User normalizer ────────────────────────────────────────────────────────
const normalizeUser = (user) => {
  if (!user) return user;
  if (!user.schoolId && user.school_id) {
    user.schoolId = user.school_id;
  }
  if (user.enrollmentNo) {
    user.enrollmentNo = user.enrollmentNo.trim().toUpperCase();
  } else {
    user.enrollmentNo = user.enrollmentNo ?? null;
  }
  return user;
};

// ── Module-level sync guard ────────────────────────────────────────────────
let _syncLock        = false;
let _lastSyncAt      = 0;
const MIN_SYNC_GAP_MS = 15_000;

export const acquireSyncLock = () => {
  const now = Date.now();
  if (_syncLock)                            return false;
  if (now - _lastSyncAt < MIN_SYNC_GAP_MS) return false;
  _syncLock   = true;
  _lastSyncAt = now;
  return true;
};

export const releaseSyncLock = () => { _syncLock = false; };

export const resetSyncLock = () => {
  _syncLock   = false;
  _lastSyncAt = 0;
};

// ── Store ──────────────────────────────────────────────────────────────────
export const useAuthStore = create((set, get) => ({
  user:             null,
  token:            null,
  error:            null,
  isLoading:        false,
  hydrated:         false,
  // ✅ Keep hasInitialized as an alias so any code still reading the old
  //    name also works without needing a find-and-replace across the app.
  hasInitialized:   false,
  profileCompleted: false,

  setProfileCompleted: (val) => set({ profileCompleted: val }),

  // ── SET USER ──────────────────────────────────────────────────────────────
  setUser: async (user, token) => {
    try {
      const normalized = normalizeUser(user);
      await Promise.all([
        SecureStore.setItemAsync(USER_KEY,  JSON.stringify(normalized)),
        SecureStore.setItemAsync(TOKEN_KEY, token || ""),
      ]);
      // ✅ Single atomic set — both flag names updated together
      set({
        user:           normalized,
        token:          token || null,
        hydrated:       true,
        hasInitialized: true,
      });
      return true;
    } catch (err) {
      console.error("setUser failed:", err.message);
      throw err;
    }
  },

  // ── INIT AUTH ─────────────────────────────────────────────────────────────
  initAuth: async () => {
    // Already hydrated — nothing to do
    if (get().hydrated || get().hasInitialized) return !!get().token;

    // Another call is already in flight — wait for it
    if (get().isLoading) {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (get().hydrated || get().hasInitialized) return !!get().token;
      }
      // Timed out waiting — force-unblock so the splash doesn't hang
      set({ hydrated: true, hasInitialized: true, isLoading: false });
      return false;
    }

    // Mark loading synchronously before any await so concurrent callers
    // hit the isLoading guard above instead of starting a second read.
    set({ isLoading: true });

    try {
      const [token, userJson] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(USER_KEY),
      ]);

      console.log("🔑 token from SecureStore:", token ? "found" : "null");
      console.log("👤 userJson from SecureStore:", userJson ? "found" : "null");

      if (!token || !userJson) {
        // ✅ FIX: single set() call — hydrated, hasInitialized, AND
        //    isLoading:false all committed in the same render cycle.
        //    The old code set hydrated:true in the try block and
        //    isLoading:false in finally — two separate set() calls
        //    produced two renders. Between render 1 (hydrated=true,
        //    isLoading=true) and render 2 (isLoading=false) the layout's
        //    authReady formula evaluated to `true && !true = false`,
        //    keeping the spinner visible indefinitely if render 2 was
        //    never scheduled (e.g. the component unmounted in between).
        set({
          user:           null,
          token:          null,
          hydrated:       true,
          hasInitialized: true,
          isLoading:      false,   // ← combined into one set()
          error:          null,
        });
        return false;
      }

      const user = normalizeUser(JSON.parse(userJson));

      // ✅ Single atomic set — all fields in one render
      set({
        user,
        token,
        hydrated:       true,
        hasInitialized: true,
        isLoading:      false,   // ← combined into one set()
        error:          null,
      });
      return true;

    } catch (error) {
      console.error("initAuth error:", error.message);
      // ✅ Single atomic set even on error
      set({
        user:           null,
        token:          null,
        hydrated:       true,
        hasInitialized: true,
        isLoading:      false,   // ← combined into one set()
        error:          error.message,
      });
      return false;
    }
    // ✅ No finally block — every code path above calls set() with
    //    isLoading:false already included, so no double-set needed.
  },

  // ── LOGIN ─────────────────────────────────────────────────────────────────
  login: async (payloadOrIdentifier, legacyPassword) => {
    if (get().isLoading) return false;

    // Mark loading synchronously before any await
    set({ isLoading: true, error: null });

    try {
      let email        = null;
      let enrollmentNo = null;
      let password     = null;

      if (typeof payloadOrIdentifier === "string") {
        const identifier = payloadOrIdentifier.trim();
        password         = legacyPassword;
        if (identifier.includes("@")) {
          email = identifier.toLowerCase();
        } else {
          enrollmentNo = identifier.toUpperCase();
        }
      } else {
        const p  = payloadOrIdentifier ?? {};
        password = p.password ?? "";
        if (p.email) {
          email = p.email.trim().toLowerCase();
        } else if (p.enrollmentNo) {
          enrollmentNo = p.enrollmentNo.trim().toUpperCase();
        } else if (p.identifier) {
          const id = p.identifier.trim();
          if (id.includes("@")) {
            email = id.toLowerCase();
          } else {
            enrollmentNo = id.toUpperCase();
          }
        }
      }

      if (!password)               throw new Error("Password is required");
      if (!email && !enrollmentNo) throw new Error("Email or enrollment number is required");

      const isEnrollment = !!enrollmentNo;
      const requestBody  = isEnrollment
        ? { enrollmentNo, password }
        : { email,        password };

      let isOnline = true;
      if (NetInfo) {
        const net = await NetInfo.fetch();
        isOnline  = net.isConnected;
      }

      let user         = null;
      let token        = null;
      let refreshToken = null;

      // ── Online path ────────────────────────────────────────────────────
      if (isOnline) {
        const res = await fetch(`${API_URL}/auth/login`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(requestBody),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || "Login failed");

        user         = normalizeUser(data.user);
        token        = data.token;
        refreshToken = data.refreshToken;

        if (!token || !user?.role) throw new Error("Invalid server response");

        await Promise.all([
          SecureStore.setItemAsync(TOKEN_KEY,         token),
          SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken || ""),
          SecureStore.setItemAsync(USER_KEY,          JSON.stringify(user)),
        ]);

        console.log("✅ Session saved to SecureStore");

        // Cache to SQLite for offline use
        if (DB && typeof DB.upsert === "function") {
          try {
            const salt = generateSalt();
            await DB.upsert("users", {
              id:           user.id,
              name:         user.name,
              email:        user.email        || null,
              enrollmentNo: user.enrollmentNo || null,
              role:         user.role,
              schoolId:     user.schoolId     || null,
              passwordSalt: salt,
              passwordHash: hashPassword(password, salt),
              updated_at:   new Date().toISOString(),
            });
            console.log("✅ User cached to SQLite");
          } catch (e) {
            console.warn("Offline cache failed:", e?.message || String(e));
          }
        } else if (DB) {
          try {
            const { getDatabase } = require("../db/database");
            const db   = await getDatabase();
            const salt = generateSalt();
            const now  = new Date().toISOString();

            await db.runAsync(
              `INSERT INTO users
                 (id, name, email, enrollmentNo, role, schoolId,
                  passwordSalt, passwordHash, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 name         = excluded.name,
                 email        = excluded.email,
                 enrollmentNo = excluded.enrollmentNo,
                 role         = excluded.role,
                 schoolId     = excluded.schoolId,
                 passwordSalt = excluded.passwordSalt,
                 passwordHash = excluded.passwordHash,
                 updated_at   = excluded.updated_at`,
              [
                user.id, user.name, user.email || null,
                user.enrollmentNo || null, user.role,
                user.schoolId || null, salt,
                hashPassword(password, salt), now,
              ]
            );
            console.log("✅ User cached to SQLite (direct)");
          } catch (e) {
            console.warn("Offline cache failed (direct):", e?.message || String(e));
          }
        }
      }

      // ── Offline path ───────────────────────────────────────────────────
      else {
        if (!DB) throw new Error("Offline mode not available");

        const queryFn = typeof DB.query === "function"
          ? (sql, params) => DB.query(sql, params)
          : async (sql, params) => {
              const { getDatabase } = require("../db/database");
              const db = await getDatabase();
              return db.getAllAsync(sql, params);
            };

        const [column, value] = isEnrollment
          ? ["enrollmentNo", enrollmentNo]
          : ["email",        email];

        const rows = await queryFn(
          `SELECT * FROM users WHERE ${column} = ? LIMIT 1`,
          [value]
        );

        if (!rows?.length) {
          throw new Error(
            isEnrollment
              ? "No offline account found for that enrollment number"
              : "No offline account found"
          );
        }

        const cached = rows[0];

        if (
          !cached.passwordSalt ||
          !comparePassword(password, cached.passwordSalt, cached.passwordHash)
        ) {
          throw new Error(
            isEnrollment
              ? "Invalid enrollment number or password"
              : "Invalid credentials"
          );
        }

        const { passwordSalt, passwordHash, ...safeUser } = cached;
        user  = normalizeUser(safeUser);
        token = OFFLINE_TOKEN;

        await SecureStore.setItemAsync(TOKEN_KEY, token);
        await SecureStore.setItemAsync(USER_KEY,  JSON.stringify(user));
        console.log("✅ Offline session saved to SecureStore");
      }

      resetSyncLock();

      // ✅ Single atomic set — isLoading:false included so the component
      //    only re-renders once after login completes.
      set({
        user,
        token,
        hydrated:         true,
        hasInitialized:   true,
        isLoading:        false,   // ← no separate finally needed
        profileCompleted: false,
        error:            null,
      });
      return true;

    } catch (error) {
      console.error("login error:", error.message);
      // ✅ Single atomic set on error too
      set({
        error:          error.message,
        user:           null,
        token:          null,
        isLoading:      false,   // ← combined
        // ✅ Keep hydrated:true on login failure so the splash doesn't
        //    re-appear — the login screen is already visible.
        hydrated:       true,
        hasInitialized: true,
      });
      return false;
    }
    // ✅ No finally block needed — every path sets isLoading:false above.
  },

  // ── UPDATE USER ───────────────────────────────────────────────────────────
  updateUser: async (updatedUser) => {
    try {
      const current    = get().user || {};
      const normalized = normalizeUser({ ...current, ...updatedUser });
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(normalized));
      set({ user: normalized });
      console.log("✅ Store user updated:", normalized.name);
    } catch (err) {
      console.error("updateUser failed:", err.message);
      set((state) => ({
        user: normalizeUser({ ...state.user, ...updatedUser }),
      }));
    }
  },

  // ── REFRESH TOKEN ─────────────────────────────────────────────────────────
  refreshToken: async (currentRefreshToken) => {
    try {
      if (!currentRefreshToken) return false;
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ refreshToken: currentRefreshToken }),
      });
      if (res.status === 401 || res.status === 403) {
        await get().logout();
        return false;
      }
      const data = await res.json();
      if (!res.ok || !data.token) return false;
      await SecureStore.setItemAsync(TOKEN_KEY, data.token);
      set({ token: data.token });
      return true;
    } catch (err) {
      console.error("refreshToken error:", err.message);
      return false;
    }
  },

  // ── LOGOUT ────────────────────────────────────────────────────────────────
  logout: async () => {
    try {
      const { SyncManager } = require("../services/syncManager");
      SyncManager.destroy();
      console.log("🛑 SyncManager stopped on logout");
    } catch (err) {
      console.warn("SyncManager destroy failed:", err.message);
    }

    try {
      const { clearSchoolCache } = require("../services/school.service");
      clearSchoolCache();
    } catch { /* non-critical */ }

    resetSyncLock();

    await get()._clearStorage();

    // ✅ Single atomic set — hydrated stays true so the splash doesn't
    //    re-appear; the navigation guard sees token:null and redirects
    //    to /auth/login immediately.
    set({
      user:             null,
      token:            null,
      hydrated:         true,
      hasInitialized:   true,
      isLoading:        false,
      profileCompleted: false,
      error:            null,
    });

    return true;
  },

  // ── CLEAR STORAGE ─────────────────────────────────────────────────────────
  _clearStorage: async () => {
    await Promise.allSettled([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.deleteItemAsync(USER_KEY),
    ]);
  },

  // ── SELECTORS ─────────────────────────────────────────────────────────────
  getUser:         () => get().user,
  getToken:        () => get().token,
  isAuthenticated: () => !!get().user && !!get().token,
  isOnlineMode:    () => get().token !== OFFLINE_TOKEN,
  isStudent:       () => get().user?.role === "student",
}));