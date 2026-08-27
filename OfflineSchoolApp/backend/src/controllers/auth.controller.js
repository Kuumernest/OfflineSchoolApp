// backend/controllers/auth.controller.js
"use strict";

const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const User   = require("../db/models/User");
const { normalizeRole } = require("../config/roles");
const permissions       = require("../services/permissions.service");

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-computed hash used in the timing-safe login path so that a
 * "user not found" branch takes the same wall-clock time as
 * "user found but wrong password".
 */
const DUMMY_HASH = bcrypt.hashSync("dummy-timing-guard-value", 12);

/**
 * Minimum password requirements.
 * At least 8 characters, one uppercase, one lowercase, one digit.
 */
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a human-readable error string when the password is too weak,
 * or null when it is acceptable.
 */
const validatePasswordStrength = (pw) => {
  if (!pw || pw.length < 8) {
    return "Password must be at least 8 characters";
  }
  if (!PASSWORD_RE.test(pw)) {
    return (
      "Password must contain at least one uppercase letter, " +
      "one lowercase letter, and one number"
    );
  }
  return null;
};

/**
 * Signs a short-lived access token.
 * Accounts with mustResetPassword receive a tighter 15-minute window
 * so that a stolen token cannot be used to hijack the forced-reset flow.
 */
const generateAccessToken = (user) =>
  jwt.sign(
    { id: user._id, schoolId: user.schoolId ?? null, role: normalizeRole(user.role) },
    process.env.JWT_SECRET,
    {
      expiresIn: user.mustResetPassword
        ? "15m"
        : (process.env.JWT_ACCESS_EXPIRES || process.env.JWT_EXPIRES_IN || "1h"),
    }
  );

/**
 * Signs a refresh token when JWT_REFRESH_SECRET is configured,
 * otherwise returns null.
 */
const generateRefreshToken = (user) => {
  if (!process.env.JWT_REFRESH_SECRET) return null;
  return jwt.sign(
    { id: user._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES || "30d" }
  );
};

/**
 * Builds a safe, canonical user payload for API responses.
 * Exposes a single string `id` — no raw ObjectId or duplicate `_id`.
 */
const serializeUser = (user) => ({
  id:                String(user._id),
  name:              user.name              ?? null,
  email:             user.email             ?? null,
  enrollmentNo:      user.enrollmentNo      ?? null,
  // Canonicalised for the same reason the auth middleware does it: this
  // response is what both clients store and route on, and it is read straight
  // off the document rather than through the middleware. A legacy "admin" row
  // would otherwise get a role string no client navigation knows.
  role:              normalizeRole(user.role),
  schoolId:          user.schoolId          ?? null,
  isActive:          user.isActive          ?? true,
  mustResetPassword: user.mustResetPassword ?? false,
  // Filled in by withPermissions() below rather than here, because resolving
  // them reads the school. Left as the empty array on the rare path that skips
  // that step, which is the safe default: a client that receives no permissions
  // offers nothing, rather than offering everything.
  permissions:       [],
  createdAt:         user.createdAt         ?? null,
  updatedAt:         user.updatedAt         ?? null,
});

/**
 * Issues a fresh access + refresh token pair and returns the standard
 * success envelope.  Accepts an optional `extra` object that is merged
 * into the response (e.g. { message: "Password updated" }).
 */
/**
 * Attach the caller's effective capabilities to a serialised user.
 *
 * Both clients need these to decide what to OFFER — which tiles to draw, which
 * buttons to enable. It is not what decides whether an action is allowed: every
 * route checks for itself, and this list is a copy that goes stale the moment a
 * school changes a permission. Treat it as a menu, never as a lock.
 *
 * Sent at sign-in and refreshed by GET /api/auth/me, which is the seam a client
 * uses to pick up a change without making the user sign in again.
 */
const withPermissions = async (payload, user) => ({
  ...payload,
  permissions: await permissions.effectiveFor(user.role, user.schoolId),
});

const issueTokens = async (user, extra = {}) => {
  const token        = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  return {
    success: true,
    ...extra,
    token,
    ...(refreshToken ? { refreshToken } : {}),
    user: await withPermissions(serializeUser(user), user),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────

exports.login = async (req, res) => {
  try {
    const { email, enrollmentNo, password } = req.body;

    const isStudentLogin = Boolean(enrollmentNo && !email);
    const isStaffLogin   = Boolean(email && !enrollmentNo);

    // ── Basic input validation ────────────────────────────────────────────
    if (!password) {
      return res
        .status(400)
        .json({ success: false, message: "Password is required" });
    }
    if (!isStudentLogin && !isStaffLogin) {
      return res.status(400).json({
        success: false,
        message:
          "Provide either an enrollment number (students) or an email (staff)",
      });
    }

    let user            = null;
    let hashToCompare   = DUMMY_HASH; // always compare so response time is constant

    if (isStaffLogin) {
      const cleanEmail = email.trim().toLowerCase();
      console.log(`=== LOGIN (staff) === email: ${cleanEmail}`);

      // findByEmail should use a case-insensitive index and select +password
      user = await User.findByEmail(cleanEmail);

      if (user) {
        if (user.role === "student") {
          // Run bcrypt anyway to prevent timing oracle, then reject
          await bcrypt.compare(password, user.password ?? DUMMY_HASH);
          console.log(`❌ Student tried email login: "${cleanEmail}"`);
          return res.status(401).json({
            success: false,
            message: "Students must log in with their enrollment number",
          });
        }
        hashToCompare = user.password ?? DUMMY_HASH;
      }

    } else {
      const cleanNo = enrollmentNo.trim().toUpperCase();
      console.log(`=== LOGIN (student) === enrollmentNo: ${cleanNo}`);

      user = await User.findOne({
        enrollmentNo: cleanNo,
        isActive:     true,
        role:         "student",
      }).select("+password");

      if (user) hashToCompare = user.password ?? DUMMY_HASH;
    }

    // ── Constant-time password comparison ────────────────────────────────
    const isMatch = await bcrypt.compare(password, hashToCompare);

    if (!user || !isMatch) {
      const label = isStaffLogin
        ? `email="${email}"`
        : `enrollmentNo="${enrollmentNo}"`;
      console.log(`❌ Login failed for: ${label}`);
      return res.status(401).json({
        success: false,
        message: isStaffLogin
          ? "Invalid email or password"
          : "Invalid enrollment number or password",
      });
    }

    const logLabel = isStaffLogin
      ? email.toLowerCase().trim()
      : enrollmentNo.toUpperCase().trim();

    console.log(
      `✅ Login success: ${logLabel} (${user.role}) | mustReset: ${user.mustResetPassword}`
    );

    return res.json(await issueTokens(user));

  } catch (err) {
    console.error("🔴 Login error:", err.message, err.stack);
    return res
      .status(500)
      .json({ success: false, message: "Login failed" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/refresh
// ─────────────────────────────────────────────────────────────────────────────

exports.refresh = async (req, res) => {
  try {
    // ── Guard — disabled when no refresh secret is configured ─────────────
    if (!process.env.JWT_REFRESH_SECRET) {
      return res.status(501).json({
        success: false,
        message: "Token refresh is not configured on this server",
      });
    }

    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res
        .status(400)
        .json({ success: false, message: "Refresh token required" });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({
        success: false,
        message: "Refresh token is invalid or expired",
      });
    }

    const user = await User.findById(decoded.id);

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: "User not found or account deactivated",
      });
    }

    const logLabel = user.enrollmentNo ?? user.email;
    console.log(`🔄 Token refreshed: ${logLabel}`);

    return res.json(await issueTokens(user));

  } catch (err) {
    console.error("🔴 Refresh error:", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Token refresh failed" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/change-password
// ─────────────────────────────────────────────────────────────────────────────

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const userId = req.user?.id || req.user?._id;

    // ── Validate new password ─────────────────────────────────────────────
    const strengthError = validatePasswordStrength(newPassword);
    if (strengthError) {
      return res.status(400).json({ success: false, message: strengthError });
    }

    if (confirmPassword && newPassword !== confirmPassword) {
      return res
        .status(400)
        .json({ success: false, message: "Passwords do not match" });
    }

    // ── Load user ─────────────────────────────────────────────────────────
    const user = await User.findById(userId).select("+password");

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // ── Verify current password ───────────────────────────────────────────
    //
    // We always require the current password, even for mustResetPassword
    // accounts. The access token for those accounts is intentionally
    // short-lived (15 min — see generateAccessToken) so the window for a
    // stolen-token attack is narrow. Requiring the old credential closes
    // it entirely without degrading UX for users who just logged in.
    if (!currentPassword) {
      return res
        .status(400)
        .json({ success: false, message: "currentPassword is required" });
    }

    const isMatch = await user.comparePassword(currentPassword);

    if (!isMatch) {
      // Do NOT hint at what the default password might be — the client
      // already knows mustResetPassword from the login response and can
      // display contextual help without the server leaking credentials.
      return res
        .status(401)
        .json({ success: false, message: "Current password is incorrect" });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from your current password",
      });
    }

    // ── Persist ───────────────────────────────────────────────────────────
    user.password          = newPassword; // pre-save hook hashes this
    user.mustResetPassword = false;
    await user.save();

    const logLabel = user.enrollmentNo ?? user.email;
    console.log(`✅ Password changed: ${logLabel} (${user.role})`);

    return res.json(
      await issueTokens(user, { message: "Password updated successfully" })
    );

  } catch (err) {
    console.error("🔴 Change-password error:", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Password change failed" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────

exports.me = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const user   = await User.findById(userId).select("-password");

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: "Account not found or deactivated",
      });
    }

    return res.json({
      success: true,
      user: await withPermissions(serializeUser(user), user),
    });

  } catch (err) {
    console.error("🔴 /me error:", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load user" });
  }
};