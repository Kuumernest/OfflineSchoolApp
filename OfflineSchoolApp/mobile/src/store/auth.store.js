// src/store/auth.store.js
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

// ── Store ──────────────────────────────────────────────────────────────────
export const useAuthStore = create((set, get) => ({
  user:             null,
  token:            null,
  error:            null,
  isLoading:        false,
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
      set({ user: normalized, token: token || null, hasInitialized: true });
      return true;
    } catch (err) {
      console.error("setUser failed:", err.message);
      throw err;
    }
  },

  // ── INIT AUTH ─────────────────────────────────────────────────────────────
  initAuth: async () => {
    if (get().hasInitialized) return true;
    try {
      set({ isLoading: true });

      const [token, userJson] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(USER_KEY),
      ]);

      // ✅ Debug logs — remove after confirming it works
      console.log("🔑 token from SecureStore:", token);
      console.log("👤 userJson from SecureStore:", userJson);

      // ✅ Fixed — removed unnecessary _clearStorage call
      if (!token || !userJson) {
        set({ user: null, token: null, hasInitialized: true });
        return false;
      }

      const user = normalizeUser(JSON.parse(userJson));
      set({ user, token, hasInitialized: true });
      return true;

    } catch (error) {
      console.error("initAuth error:", error.message);
      set({ user: null, token: null, hasInitialized: true, error: error.message });
      return false;
    } finally {
      set({ isLoading: false });
    }
  },

  // ── LOGIN ─────────────────────────────────────────────────────────────────
  //
  // Accepts three call signatures:
  //   login({ email, password })           — staff
  //   login({ enrollmentNo, password })    — student
  //   login(identifierString, password)    — legacy positional args
  //
  login: async (payloadOrIdentifier, legacyPassword) => {
    if (get().isLoading) return false;

    try {
      set({ isLoading: true, error: null });

      // ── Normalise call signature ───────────────────────────────────────
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

      if (!password) throw new Error("Password is required");
      if (!email && !enrollmentNo) throw new Error("Email or enrollment number is required");

      const isEnrollment = !!enrollmentNo;
      const requestBody  = isEnrollment
        ? { enrollmentNo, password }
        : { email,        password };

      // ── Network check ──────────────────────────────────────────────────
      let isOnline = true;
      if (NetInfo) {
        const net = await NetInfo.fetch();
        isOnline  = net.isConnected;
      }

      let user         = null;
      let token        = null;
      let refreshToken = null;

      // ── Online ─────────────────────────────────────────────────────────
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

        // ✅ Save to SecureStore first
        await Promise.all([
          SecureStore.setItemAsync(TOKEN_KEY,         token),
          SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken || ""),
          SecureStore.setItemAsync(USER_KEY,          JSON.stringify(user)),
        ]);

        console.log("✅ Session saved to SecureStore");

        // ✅ Cache to SQLite for offline use
        if (DB) {
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
            console.warn("Offline cache failed:", e.message);
          }
        }
      }

      // ── Offline ────────────────────────────────────────────────────────
      else {
        if (!DB) throw new Error("Offline mode not available");

        const [column, value] = isEnrollment
          ? ["enrollmentNo", enrollmentNo]
          : ["email",        email];

        const rows = await DB.query(
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

      set({ user, token, hasInitialized: true, profileCompleted: false });
      return true;

    } catch (error) {
      console.error("login error:", error.message);
      set({ error: error.message, user: null, token: null });
      return false;
    } finally {
      set({ isLoading: false });
    }
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
  refreshToken: async (refreshToken) => {
    try {
      if (!refreshToken) return false;
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ refreshToken }),
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

    await get()._clearStorage();
    set({
      user:             null,
      token:            null,
      hasInitialized:   false,
      profileCompleted: false,
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
  isAuthenticated: () => !!get().user,
  isOnlineMode:    () => get().token !== OFFLINE_TOKEN,
  isStudent:       () => get().user?.role === "student",
}));