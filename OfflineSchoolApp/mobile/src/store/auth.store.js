// src/store/auth.store.js — complete fixed file

import { create }       from "zustand";
import * as SecureStore from "expo-secure-store";
import { API_URL }      from "../services/api";
import { appError }     from "../utils/appError";

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
const ACTIVE_SCHOOL_KEY = "active_school";

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

/**
 * A super_admin's user, with the school they are working inside mirrored in.
 *
 * The account has no school of its own, by design. Every screen and service on
 * the phone reads its school from user.schoolId (about seventy places), so the
 * chosen school is mirrored there — the same arrangement as the web console's
 * enterSchool — and the ordinary admin screens work unchanged. Everyone else
 * is returned untouched.
 */
const withActiveSchool = (user, school) => {
  if (!user || user.role !== "super_admin" || !school?._id) return user;
  return { ...user, schoolId: school._id, school_id: school._id, schoolName: school.name };
};

// ── Module-level sync guard ────────────────────────────────────────────────
let _syncLock        = false;
let _lastSyncAt      = 0;
let _prevSyncAt      = 0;
const MIN_SYNC_GAP_MS = 15_000;

/** Dedupes concurrent upgradeOfflineSession() calls. */
let _upgradeInFlight = null;

/**
 * @param {{force?: boolean}} opts  `force` skips the rate-limit gap. Used by
 *   the reconnect and foreground triggers, which are edge-driven and must not
 *   be swallowed just because a periodic tick happened to run seconds earlier.
 *
 * The gap stamp is provisional: a caller that bails out before doing any real
 * work calls releaseSyncLock(false) and the previous stamp is restored. Without
 * that rollback, every offline tick consumed the whole 15 s budget, so the
 * sync fired the moment the network came back was rejected as "too soon" and
 * the user waited out a full interval before anything uploaded.
 */
export const acquireSyncLock = ({ force = false } = {}) => {
  const now = Date.now();
  if (_syncLock)                                    return false;
  if (!force && now - _lastSyncAt < MIN_SYNC_GAP_MS) return false;
  _syncLock   = true;
  _prevSyncAt = _lastSyncAt;
  _lastSyncAt = now;
  return true;
};

/**
 * @param {boolean} consumed  Pass false when the caller acquired the lock but
 *   did no work (offline, logged out, password wall) so the rate-limit window
 *   is handed back instead of burned.
 */
export const releaseSyncLock = (consumed = true) => {
  _syncLock = false;
  if (!consumed) _lastSyncAt = _prevSyncAt;
};

export const resetSyncLock = () => {
  _syncLock   = false;
  _lastSyncAt = 0;
  _prevSyncAt = 0;
};

// ── Store ──────────────────────────────────────────────────────────────────
/**
 * Remove messages this phone holds for anyone but `keepUserId`.
 *
 * The message store and the guardian portal's cache live in the one shared
 * schoolapp.db, and nothing cleared them between accounts: a pupil who
 * signed in after an admin read the admin's threads with parents from the
 * local store. With an id, that person's own threads are kept (their
 * history stays offline-readable) and every other thread is deleted; with
 * none, everything is. Any guardian portal session is signed out either way,
 * which also clears the portal's cached threads. Never throws: failing to
 * tidy must not fail a sign-in or a sign-out.
 */
async function forgetOtherPeoplesMessages(keepUserId) {
  try {
    const messages = require("../services/message.service");
    if (keepUserId) await messages.purgeNotMine(keepUserId);
    else            await messages.clearLocalMessages();
  } catch (err) {
    console.warn("[auth] clearing other accounts' messages failed:", err?.message);
  }
  try {
    const portal = require("../services/portal.service");
    if (await portal.hasSession()) await portal.signOut();
  } catch (err) {
    console.warn("[auth] signing out the guardian portal failed:", err?.message);
  }
}

/** True while the outbox still holds a change that has not reached the server. */
async function hasPendingUploads() {
  try {
    const { MutationQueue } = require("../services/mutationQueue.service");
    return (await MutationQueue.pendingKeys("")).length > 0;
  } catch (err) {
    // Unknown is treated as pending: switching is the step that cannot be undone.
    console.warn("[auth] could not read the outbox:", err?.message);
    return true;
  }
}

/**
 * After a super_admin changes school: forget the cached school details and
 * pull the new school from the beginning. The sync cursor is one value for the
 * phone, so without the reset the first pull would ask for the new school's
 * changes since the OLD school's last sync and miss nearly everything.
 */
async function restartSyncForSchool() {
  try {
    const { clearSchoolCache } = require("../services/school.service");
    clearSchoolCache();
  } catch { /* non-critical */ }
  resetSyncLock();
  try {
    const { SyncManager } = require("../services/syncManager");
    await SyncManager.resetLastSync();
    // Started if it was not: a super_admin outside any school had nothing to sync.
    await SyncManager.ensureStarted();
    SyncManager.syncAll({ force: true }).catch((err) =>
      console.warn("[auth] sync after changing school failed:", err?.message)
    );
  } catch (err) {
    console.warn("[auth] restarting sync after changing school failed:", err?.message);
  }
}

export const useAuthStore = create((set, get) => ({
  user:             null,
  token:            null,
  // The refresh token VALUE. Deliberately not named `refreshToken` — that
  // name belongs to the refresh action below, and api.js used to read the
  // action by mistake, which broke token refresh entirely.
  refreshTokenValue: null,
  error:            null,
  syncError:        null,
  isLoading:        false,
  hydrated:         false,
  // ✅ Keep hasInitialized as an alias so any code still reading the old
  //    name also works without needing a find-and-replace across the app.
  hasInitialized:   false,
  profileCompleted: false,
  // The school a super_admin is working inside: { _id, name, code }, or null.
  activeSchool:     null,

  setProfileCompleted: (val) => set({ profileCompleted: val }),

  // ✅ Set/clear sync error so the UI can warn about stale data
  setSyncError: (msg) => set({ syncError: msg }),
  clearSyncError: () => set({ syncError: null }),

  // ── SET USER ──────────────────────────────────────────────────────────────
  setUser: async (user, token) => {
    try {
      const normalized = withActiveSchool(normalizeUser(user), get().activeSchool);
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
      const [token, userJson, storedRefresh, schoolJson] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(USER_KEY),
        SecureStore.getItemAsync(REFRESH_TOKEN_KEY).catch(() => null),
        SecureStore.getItemAsync(ACTIVE_SCHOOL_KEY).catch(() => null),
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

      let activeSchool = null;
      try { activeSchool = schoolJson ? JSON.parse(schoolJson) : null; } catch { /* ignore */ }
      const user = withActiveSchool(normalizeUser(JSON.parse(userJson)), activeSchool);

      // ✅ Single atomic set — all fields in one render
      set({
        user,
        token,
        activeSchool: user?.role === "super_admin" ? activeSchool : null,
        refreshTokenValue: storedRefresh || null,
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

      if (!password)               throw appError("svcErr.passwordRequired", "Password is required");
      if (!email && !enrollmentNo) throw appError("svcErr.emailOrEnrollmentRequired", "Email or enrollment number is required");

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
        if (!res.ok) {
          throw data.message
            ? new Error(data.message)
            : appError("svcErr.loginFailed", "Login failed");
        }

        user         = normalizeUser(data.user);
        token        = data.token;
        refreshToken = data.refreshToken;

        if (!token || !user?.role) throw appError("svcErr.invalidServerResponse", "Invalid server response");

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
        if (!DB) throw appError("svcErr.offlineUnavailable", "Offline mode not available");

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
          throw isEnrollment
            ? appError(
                "svcErr.noOfflineAccountEnrollment",
                "No offline account found for that enrollment number"
              )
            : appError("svcErr.noOfflineAccount", "No offline account found");
        }

        const cached = rows[0];

        if (
          !cached.passwordSalt ||
          !comparePassword(password, cached.passwordSalt, cached.passwordHash)
        ) {
          throw isEnrollment
            ? appError(
                "svcErr.invalidEnrollmentOrPassword",
                "Invalid enrollment number or password"
              )
            : appError("svcErr.invalidCredentials", "Invalid credentials");
        }

        const { passwordSalt, passwordHash, ...safeUser } = cached;
        user  = normalizeUser(safeUser);
        token = OFFLINE_TOKEN;

        // Keep any refresh token from a previous online session for THIS
        // user. It is what lets upgradeOfflineSession() turn this
        // offline-only session into a real one when the network returns —
        // without it, everything queued offline would never sync.
        try {
          const prior = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
          const priorUserJson = await SecureStore.getItemAsync(USER_KEY);
          const priorUser = priorUserJson ? JSON.parse(priorUserJson) : null;
          if (prior && priorUser && String(priorUser.id) === String(user.id)) {
            refreshToken = prior;
          } else if (prior) {
            // Different user — the old refresh token must not be reused.
            await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => {});
          }
        } catch { /* ignore */ }

        await SecureStore.setItemAsync(TOKEN_KEY, token);
        await SecureStore.setItemAsync(USER_KEY,  JSON.stringify(user));
        console.log(
          `✅ Offline session saved to SecureStore${
            refreshToken ? " (upgradeable)" : " (no refresh token — sync needs re-login online)"
          }`
        );
      }

      // A phone is shared. Whatever the previous account left in the
      // message store, and any guardian portal session with its cached
      // threads, belong to somebody else; this person sees neither.
      await forgetOtherPeoplesMessages(String(user?.id ?? user?._id ?? ""));

      resetSyncLock();

      // A sign-in starts outside any school: a super_admin picks one next.
      await SecureStore.deleteItemAsync(ACTIVE_SCHOOL_KEY).catch(() => {});

      // ✅ Single atomic set — isLoading:false included so the component
      //    only re-renders once after login completes.
      set({
        user,
        token,
        activeSchool: null,
        refreshTokenValue: refreshToken || null,
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
      // Re-mirrored: an update carrying the server's copy of a super_admin
      // (schoolId null) must not drop them out of the school they are in.
      const normalized = withActiveSchool(
        normalizeUser({ ...current, ...updatedUser }), get().activeSchool
      );
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
      if (data.refreshToken) {
        await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, data.refreshToken);
      }
      set({
        token: data.token,
        ...(data.refreshToken ? { refreshTokenValue: data.refreshToken } : {}),
      });
      return true;
    } catch (err) {
      console.error("refreshToken error:", err.message);
      return false;
    }
  },

  // ── UPGRADE OFFLINE SESSION ───────────────────────────────────────────────
  //
  // A user who logged in while offline holds the sentinel token
  // "offline_mode". isAuthenticated() rejects that sentinel, so SyncManager
  // refuses to run and everything written during the session stays queued
  // forever. This exchanges the sentinel for a real access token as soon as
  // the network is back, using the refresh token kept from the last online
  // session.
  //
  // Returns true when the session is (or has become) a real online session.
  upgradeOfflineSession: async () => {
    const { token, user } = get();
    if (!user)                    return false;
    if (token !== OFFLINE_TOKEN)  return true;   // already a real session

    if (_upgradeInFlight) return _upgradeInFlight;

    _upgradeInFlight = (async () => {
      try {
        if (NetInfo) {
          const net = await NetInfo.fetch();
          if (!net.isConnected) return false;
        }

        const { refreshAccessToken } = require("../services/api");
        const newToken = await refreshAccessToken();

        if (!newToken) {
          console.log(
            "🔒 Offline session could not be upgraded — sign in again to sync queued changes"
          );
          set({
            syncError:
              "Signed in offline. Sign in again while connected to upload your changes.",
          });
          return false;
        }

        // refreshAccessToken already persisted the token and updated
        // `token` / `refreshTokenValue` in the store.
        console.log("🔓 Offline session upgraded to an online session");
        set({ syncError: null });
        resetSyncLock();
        return true;
      } catch (err) {
        console.warn("upgradeOfflineSession failed:", err.message);
        return false;
      } finally {
        _upgradeInFlight = null;
      }
    })();

    return _upgradeInFlight;
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

    // Nobody is signed in: no conversation on this phone is anybody's now.
    await forgetOtherPeoplesMessages(null);

    // ✅ Single atomic set — hydrated stays true so the splash doesn't
    //    re-appear; the navigation guard sees token:null and redirects
    //    to /auth/login immediately.
    set({
      user:              null,
      token:             null,
      refreshTokenValue: null,
      hydrated:          true,
      hasInitialized:    true,
      isLoading:         false,
      profileCompleted:  false,
      activeSchool:      null,
      error:             null,
    });

    return true;
  },

  // ── ENTER / LEAVE A SCHOOL (super_admin only) ─────────────────────────────
  //
  // Returns { ok: true } or { ok: false, reason }. Refused while changes are
  // waiting to upload: the push names the CURRENT school, so a change made
  // inside one school and sent after switching would be written to the other.
  enterSchool: async (school) => {
    const current = get().user;
    if (!current || current.role !== "super_admin" || !school?._id) {
      return { ok: false, reason: "notSuperAdmin" };
    }
    if (String(current.schoolId ?? "") === String(school._id)) return { ok: true };
    if (await hasPendingUploads()) return { ok: false, reason: "pendingUploads" };

    const activeSchool = {
      _id:  String(school._id),
      name: school.name ?? "",
      code: school.code ?? null,
    };
    const user = withActiveSchool({ ...current }, activeSchool);
    await Promise.all([
      SecureStore.setItemAsync(ACTIVE_SCHOOL_KEY, JSON.stringify(activeSchool)),
      SecureStore.setItemAsync(USER_KEY,          JSON.stringify(user)),
    ]);
    set({ activeSchool, user });
    await restartSyncForSchool();
    return { ok: true };
  },

  leaveSchool: async () => {
    const current = get().user;
    if (!current || current.role !== "super_admin") return { ok: false, reason: "notSuperAdmin" };
    if (await hasPendingUploads()) return { ok: false, reason: "pendingUploads" };

    const user = { ...current, schoolId: null, school_id: null, schoolName: null };
    await Promise.all([
      SecureStore.deleteItemAsync(ACTIVE_SCHOOL_KEY).catch(() => {}),
      SecureStore.setItemAsync(USER_KEY, JSON.stringify(user)),
    ]);
    set({ activeSchool: null, user });
    await restartSyncForSchool();
    return { ok: true };
  },

  // ── CLEAR STORAGE ─────────────────────────────────────────────────────────
  _clearStorage: async () => {
    await Promise.allSettled([
      SecureStore.deleteItemAsync(TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.deleteItemAsync(USER_KEY),
      SecureStore.deleteItemAsync(ACTIVE_SCHOOL_KEY),
    ]);
  },

  // ── SELECTORS ─────────────────────────────────────────────────────────────
  getUser:         () => get().user,
  getToken:        () => get().token,
  isAuthenticated: () => !!get().user && !!get().token,
  isOnlineMode:    () => get().token !== OFFLINE_TOKEN,
  isStudent:       () => get().user?.role === "student",
}));