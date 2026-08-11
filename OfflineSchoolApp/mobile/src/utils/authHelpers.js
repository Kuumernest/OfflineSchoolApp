// src/utils/authHelpers.js
"use strict";

/**
 * authHelpers.js
 *
 * Centralised authentication checking used by all service files.
 *
 * Problem solved:
 *  - syncAssignments, teacherStats, syncManager, and timetableService each
 *    had their own version of "am I authenticated?" with different logic
 *  - Some checked `token === "offline_mode"`, others did not
 *  - timetableService had no auth check at all
 *  - Hard to add a global auth change in one place
 */

// ─── Store access ─────────────────────────────────────────────────────────────

/**
 * Safely accesses the Zustand auth store.
 * Uses dynamic require to avoid circular dependency issues at module load time
 * (api.js is imported by almost every other service).
 *
 * Returns a safe default if the store is not yet initialised.
 *
 * @returns {{ user: any, token: string|null }}
 */
const getRawAuthState = () => {
  try {
    const { useAuthStore } = require("../store/auth.store");
    const state = useAuthStore.getState();
    return {
      user:  state?.user  ?? null,
      token: state?.token ?? null,
    };
  } catch {
    return { user: null, token: null };
  }
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if the current session is authenticated and the token is
 * not the offline fallback sentinel value.
 *
 * Conditions that return false:
 *  - No user object in the store
 *  - No token or empty token
 *  - Token is the sentinel "offline_mode"
 *  - Auth store not accessible
 *
 * @returns {boolean}
 */
export const isAuthenticated = () => {
  const { user, token } = getRawAuthState();
  return !!(user && token && token !== "offline_mode");
};

/**
 * Returns true if the app is operating in offline mode.
 * Distinct from "not authenticated" — the user may be logged in but
 * the device has no connection.
 *
 * @returns {boolean}
 */
export const isOfflineMode = () => {
  const { token } = getRawAuthState();
  return token === "offline_mode";
};

/**
 * Returns the current auth information without requiring authentication.
 * All fields may be null if not authenticated.
 *
 * @returns {{ user: any, token: string|null, role: string|null, schoolId: string|null }}
 */
export const getCurrentAuth = () => {
  const { user, token } = getRawAuthState();
  return {
    user,
    token,
    role:     user?.role     ?? null,
    schoolId: user?.schoolId ?? null,
  };
};

/**
 * Throws an error with code "NOT_AUTHENTICATED" if the user is not
 * authenticated. Use at the top of service functions that require login.
 *
 * @param {string} [operationName] - Shown in the error message
 * @throws {{ message: string, code: "NOT_AUTHENTICATED" }}
 *
 * @example
 * export const syncAssignments = async () => {
 *   requireAuth("syncAssignments");
 *   // ... rest of function
 * };
 */
export const requireAuth = (operationName = "operation") => {
  if (!isAuthenticated()) {
    const err = new Error(
      `[auth] "${operationName}" requires authentication`
    );
    err.code = "NOT_AUTHENTICATED";
    throw err;
  }
};

/**
 * Returns true if the current user has one of the given roles.
 *
 * @param {string | string[]} requiredRoles
 * @returns {boolean}
 *
 * @example
 * if (hasRole(["admin", "school_admin"])) { ... }
 */
export const hasRole = (requiredRoles) => {
  const { role } = getCurrentAuth();
  const allowed  = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
  return allowed.includes(role);
};

/**
 * Throws if the current user does not have one of the required roles.
 * Also calls requireAuth() first so a single call covers both checks.
 *
 * @param {string | string[]} requiredRoles
 * @param {string}            [operationName]
 * @throws {{ message: string, code: "NOT_AUTHENTICATED" | "INSUFFICIENT_ROLE" }}
 */
export const requireRole = (requiredRoles, operationName = "operation") => {
  requireAuth(operationName);

  if (!hasRole(requiredRoles)) {
    const allowed = Array.isArray(requiredRoles)
      ? requiredRoles.join(", ")
      : requiredRoles;
    const { role } = getCurrentAuth();
    const err = new Error(
      `[auth] "${operationName}" requires role(s): ${allowed}. ` +
      `Current role: "${role}"`
    );
    err.code = "INSUFFICIENT_ROLE";
    throw err;
  }
};

/**
 * Logs the current auth state to the console.
 * Redacts the token to show only the first 10 characters.
 * For development debugging only.
 */
export const debugAuth = () => {
  const auth = getCurrentAuth();
  console.log("[auth] Current state:", {
    authenticated: isAuthenticated(),
    offlineMode:   isOfflineMode(),
    user:     auth.user ? `${auth.user.name} (${auth.user._id})` : "none",
    role:     auth.role,
    schoolId: auth.schoolId,
    token:    auth.token ? `${String(auth.token).slice(0, 10)}…` : "none",
  });
};