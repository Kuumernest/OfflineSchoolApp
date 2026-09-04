// backend/routes/auth.routes.js
"use strict";

const express  = require("express");
const router   = express.Router();
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const User     = require("../db/models/User");
const { authenticate } = require("../../middleware/auth");
const {
  effectiveFor,
  defaultsFor,
} = require("../services/permissions.service");
const { normalizeRole } = require("../config/roles");

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING — brute-force protection on login
// ─────────────────────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // 10 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts. Please try again after 15 minutes." },
  // Use the default keyGenerator which handles IPv6 correctly
  //
  // The verification harness signs in dozens of times from 127.0.0.1 in a few
  // seconds, which is indistinguishable from the attack this exists to stop.
  // Only an explicit environment opt-out lifts it, and only scripts/ sets that
  // — production never does, so the protection there is unchanged.
  skip: () => process.env.DISABLE_LOGIN_RATE_LIMIT === "1",
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Something to compare against when there is no user.
 *
 * Both failures answer "Invalid email or password", but they used to take
 * markedly different times: a real account meant a bcrypt comparison at cost
 * 12, and an unknown address returned immediately. That difference is
 * measurable over the network, which turns the login form into a way of asking
 * whether an address holds an account here — worth knowing for a school's
 * bursar or head teacher, whose addresses are often public.
 *
 * Hashed once at startup rather than per request; the value is a constant and
 * never matches anything.
 */
const DUMMY_HASH = bcrypt.hashSync("dummy-timing-guard-value", 12);

/**
 * An access token, short-lived while a temporary password is still in force.
 *
 * Thirty days is right for a teacher in a school with intermittent power and
 * worse connectivity — being signed out is a real cost there. It is the wrong
 * answer for an account whose password was typed into a chat message or read
 * aloud across an office, which is how a temporary password reaches somebody
 * when the welcome email does not arrive. Fifteen minutes bounds how long that
 * credential is worth anything: change the password and the next token is a
 * normal one.
 *
 * Ported from a helper in an auth controller that had this exactly right and
 * was required by no file in the project — so the running app signed thirty
 * days for everybody while the reasoning for not doing that sat in a comment
 * nothing executed. That file has since been deleted, its three good ideas
 * moved here: this, the timing guard below, and the reuse check in
 * change-password.
 */
const signAccessToken = (user) =>
  jwt.sign(
    { id: user._id, role: user.role, schoolId: user.schoolId ?? null },
    process.env.JWT_SECRET,
    {
      expiresIn: user.mustResetPassword
        ? "15m"
        : (process.env.JWT_EXPIRES_IN || "30d"),
    }
  );

const signRefreshToken = (user) => {
  if (!process.env.JWT_REFRESH_SECRET) return null;
  return jwt.sign(
    { id: user._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES || "90d" }
  );
};

/**
 * The caller's effective capabilities, for the client to draw a menu with.
 *
 * ── What was here before ──────────────────────────────────────────────────
 *
 * `permissions: user.permissions ?? []`. There is no permissions field on the
 * User schema — capabilities are computed from the role and the school's
 * overrides — so that expression evaluated to [] for every user who has ever
 * signed in. The web app's usePermission() hook reads exactly this list, so
 * every capability-gated control in the console was drawn disabled or hidden
 * for everybody, school admins included.
 *
 * The correct resolver existed the whole time, in an auth controller nothing
 * mounted — deleted now that what was worth keeping lives here.
 *
 * ── Why a failure here does not fail the login ────────────────────────────
 *
 * Resolving overrides reads the school. If that read fails, falling back to []
 * would sign the user in with an empty menu — the same invisible failure, and
 * harder to spot because it would be intermittent. defaultsFor() is pure and
 * needs no database, and answers what the role holds before any school
 * adjustment, so a school that has customised nothing gets exactly the right
 * answer and one that has customised something gets a stale one rather than an
 * empty one. Every route still checks for itself either way.
 */
const permissionsFor = async (user) => {
  try {
    return await effectiveFor(user.role, user.schoolId);
  } catch (err) {
    console.warn(
      `permissions lookup failed for ${user.email ?? user._id} — ` +
      `falling back to role defaults: ${err.message}`
    );
    return defaultsFor(user.role);
  }
};

const serializeUser = (user, permissions = []) => ({
  id:                user._id,
  _id:               user._id,
  name:              user.name              ?? null,
  email:             user.email             ?? null,
  enrollmentNo:      user.enrollmentNo      ?? null,
  // Canonicalised for the same reason middleware/auth.js does it at the door:
  // this payload is what both clients store and route on, and it is read
  // straight off the document rather than through the middleware. A legacy
  // "admin" row would otherwise hand the web app a role string its navigation
  // does not know, and that user would be shown the not-for-you wall.
  role:              normalizeRole(user.role) ?? user.role,
  schoolId:          user.schoolId          ?? null,
  isActive:          user.isActive          ?? true,
  mustResetPassword: user.mustResetPassword ?? false,
  // Passed in, not read off the document — see permissionsFor above.
  permissions,
  createdAt:         user.createdAt         ?? null,
  updatedAt:         user.updatedAt         ?? null,
});

const buildTokenResponse = async (user) => {
  const token        = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  return {
    success: true,
    token,
    ...(refreshToken !== null ? { refreshToken } : {}),
    user: serializeUser(user, await permissionsFor(user)),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Dual-mode: { email, password } for staff | { enrollmentNo, password } for students
// ─────────────────────────────────────────────────────────────────────────────

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { email, enrollmentNo, password } = req.body;

    const isStudentLogin = Boolean(enrollmentNo && !email);
    const isStaffLogin   = Boolean(email && !enrollmentNo);

    if (!password) {
      return res.status(400).json({ success: false, message: "Password is required" });
    }
    if (!isStudentLogin && !isStaffLogin) {
      return res.status(400).json({
        success: false,
        message: "Provide either an enrollment number (students) or an email (staff)",
      });
    }

    let user = null;

    if (isStaffLogin) {
      const cleanEmail = email.toLowerCase().trim();

      user = await User.findOne({ email: cleanEmail, isActive: true }).select("+password");

      if (!user) {
        // Spend what a real comparison would have spent — see DUMMY_HASH.
        await bcrypt.compare(password, DUMMY_HASH);
        return res.status(401).json({ success: false, message: "Invalid email or password" });
      }
      if (user.role === "student") {
        return res.status(401).json({
          success: false,
          message: "Students must log in with their enrollment number",
        });
      }
    } else {
      const cleanNo = enrollmentNo.trim().toUpperCase();

      user = await User.findOne({
        enrollmentNo: cleanNo,
        isActive:     true,
        role:         "student",
      }).select("+password");

      if (!user) {
        await bcrypt.compare(password, DUMMY_HASH);
        return res.status(401).json({
          success: false,
          message: "Invalid enrollment number or password",
        });
      }
    }

    /*
     * Nothing is logged about the attempt itself.
     *
     * This block used to print the identifier tried, the account's name and
     * role, the length of its hash and whether the password matched — on every
     * attempt, successful or not. Three things were wrong with it. It put an
     * email address or enrolment number into stdout for anything collecting
     * logs; it recorded a name against a failed password, which is a record of
     * who is having trouble rather than of anything operational; and printing
     * "User found: NO" for a miss while printing a name for a hit turned the
     * log into a user-enumeration oracle for anybody who could read it.
     *
     * A successful login is still recorded below, by id — enough to answer
     * "who signed in" without writing down what was typed to get there.
     */
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: isStudentLogin
          ? "Invalid enrollment number or password"
          : "Invalid email or password",
      });
    }

    console.log(`🔐 Login success: ${user._id} (${user.role})`);
    return res.json(await buildTokenResponse(user));

  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ success: false, message: "Login failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/refresh — Mode A (refresh token) + Mode B (access token)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/refresh", async (req, res, next) => {
  if (!process.env.JWT_REFRESH_SECRET) return next();

  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      // Fall through to the Mode B handler below (re-issue from a still-valid
      // access token) instead of hard-failing. Returning 400 here made Mode B
      // unreachable whenever JWT_REFRESH_SECRET was configured, so a client
      // holding only an access token could never refresh.
      return next();
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch (err) {
      const isExpired = err.name === "TokenExpiredError";
      return res.status(401).json({
        success: false,
        message: isExpired
          ? "Refresh token has expired — please log in again"
          : "Invalid refresh token",
        code: isExpired ? "REFRESH_EXPIRED" : "REFRESH_INVALID",
      });
    }

    const user = await User.findById(decoded.id).select("-password");
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: "User not found or account deactivated",
      });
    }

    // Same rule middleware/auth.js applies to access tokens: a refresh token
    // minted before the last password change must not mint new ones. Without
    // this, "sign out everybody" never actually finished — the access token
    // died but the ninety-day refresh token quietly reissued sessions.
    if (user.passwordChangedAt && decoded.iat &&
        decoded.iat * 1000 < user.passwordChangedAt.getTime() - 5_000) {
      return res.status(401).json({
        success: false,
        message: "Session ended when your password changed — please log in again",
        code:    "REFRESH_STALE",
      });
    }

    console.log(`🔄 Token refreshed: ${user._id}`);
    return res.json(await buildTokenResponse(user));

  } catch (err) {
    console.error("Refresh error (A):", err.message);
    return res.status(500).json({ success: false, message: "Token refresh failed" });
  }
});

router.post("/refresh", authenticate, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const user   = await User.findById(userId).select("-password");
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: "User not found or account deactivated",
      });
    }
    console.log(`🔄 Token refreshed: ${user._id}`);
    return res.json(await buildTokenResponse(user));
  } catch (err) {
    console.error("Refresh error (B):", err.message);
    return res.status(500).json({ success: false, message: "Token refresh failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/change-password
// ─────────────────────────────────────────────────────────────────────────────

router.post("/change-password", authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "newPassword and confirmPassword are required",
      });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: "Passwords do not match" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters",
      });
    }
    if (!/[A-Z]/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least one uppercase letter",
      });
    }
    if (!/[a-z]/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least one lowercase letter",
      });
    }
    if (!/\d/.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least one number",
      });
    }

    const userId = req.user.id || req.user._id;
    const user   = await User.findById(userId).select("+password");

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Checked for everybody, including a first sign-in.
    //
    // It used to sit inside the branch below, so an account on a temporary
    // password could "change" it to the same string: the flag cleared, the
    // screen said success, and the credential that had been read out over a
    // phone went on working — with nothing left to prompt a real change. That
    // is the one case where reuse matters most.
    const isSame = await bcrypt.compare(newPassword, user.password);
    if (isSame) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from your current password",
      });
    }

    // The current password is still waived for a forced reset: the user was
    // signed in with something they may never have typed themselves, and the
    // token that got them here is a fifteen-minute one.
    if (!user.mustResetPassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, message: "currentPassword is required" });
      }

      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        // No hints here. Student first passwords are random (generateTempPassword
        // in students.routes) — never the enrollment number — and echoing any
        // credential hint on a failed attempt would leak information anyway.
        return res.status(401).json({
          success: false,
          message: "Current password is incorrect",
        });
      }
    }

    // ❌ Do NOT call bcrypt.hash() here — pre-save hook handles hashing
    user.password          = newPassword;
    user.mustResetPassword = false;
    await user.save();

    console.log(`🔑 Password changed: ${user._id} (${user.role})`);

    return res.json({
      success: true,
      message: "Password updated successfully",
      ...(await buildTokenResponse(user)),
    });

  } catch (err) {
    console.error("Change password error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to change password" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────

router.get("/me", authenticate, async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const user   = await User.findById(userId).select("-password").lean();

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (!user.isActive) {
      return res.status(401).json({ success: false, message: "Account is deactivated" });
    }

    return res.json({
      success: true,
      user: serializeUser(user, await permissionsFor(user)),
    });

  } catch (err) {
    console.error("GET /auth/me error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch user" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────────────────

router.post("/logout", (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token   = authHeader.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log(`👋 Logout: userId=${decoded.id}`);
    }
  } catch { /* token missing or expired — fine */ }

  return res.json({ success: true, message: "Logged out" });
});

module.exports = router;