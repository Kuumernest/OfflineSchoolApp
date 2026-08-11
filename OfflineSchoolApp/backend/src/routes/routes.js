// src/services/routes.js

/**
 * getRoleRoute
 * Returns the correct initial route for a given user.
 *
 * Priority order:
 *   1. No user / no role       → login
 *   2. mustResetPassword=true  → set-password
 *   3. Role-based routing      → dashboard for that role
 */
export function getRoleRoute(user) {
  // ── No user ──────────────────────────────────────────────
  if (!user || !user.role) {
    return "/auth/login";
  }

  // ── Must reset password ───────────────────────────────────
  if (user.mustResetPassword) {
    console.log("🔒 mustResetPassword=true → /auth/set-password");
    return "/auth/set-password";
  }

  // ── Role-based routing ────────────────────────────────────
  switch (user.role) {
    case "super_admin":
    case "school_admin":
      return "/admin/dashboard";

    case "teacher":
      return "/teacher/dashboard";

    case "student":
      return "/student";

    default:
      console.warn("Unknown user role:", user.role);
      return "/auth/login";
  }
}