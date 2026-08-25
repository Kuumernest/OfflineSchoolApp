// backend/routes/auth.routes.js
"use strict";

const express  = require("express");
const router   = express.Router();
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const User     = require("../db/models/User");
const { authenticate } = require("../../middleware/auth");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const signAccessToken = (user) =>
  jwt.sign(
    { id: user._id, role: user.role, schoolId: user.schoolId ?? null },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "30d" }
  );

const signRefreshToken = (user) => {
  if (!process.env.JWT_REFRESH_SECRET) return null;
  return jwt.sign(
    { id: user._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES || "90d" }
  );
};

const serializeUser = (user) => ({
  id:                user._id,
  _id:               user._id,
  name:              user.name              ?? null,
  email:             user.email             ?? null,
  enrollmentNo:      user.enrollmentNo      ?? null,
  role:              user.role,
  schoolId:          user.schoolId          ?? null,
  isActive:          user.isActive          ?? true,
  mustResetPassword: user.mustResetPassword ?? false,
  permissions:       user.permissions       ?? [],
  createdAt:         user.createdAt         ?? null,
  updatedAt:         user.updatedAt         ?? null,
});

const buildTokenResponse = (user) => {
  const token        = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  return {
    success: true,
    token,
    ...(refreshToken !== null ? { refreshToken } : {}),
    user: serializeUser(user),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Dual-mode: { email, password } for staff | { enrollmentNo, password } for students
// ─────────────────────────────────────────────────────────────────────────────

router.post("/login", async (req, res) => {
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
      console.log("=== LOGIN (staff) ===");
      console.log("Email:", cleanEmail);

      user = await User.findOne({ email: cleanEmail, isActive: true }).select("+password");

      if (!user) {
        console.log("User found: NO");
        return res.status(401).json({ success: false, message: "Invalid email or password" });
      }
      if (user.role === "student") {
        console.log("Blocked: student tried email login");
        return res.status(401).json({
          success: false,
          message: "Students must log in with their enrollment number",
        });
      }
    } else {
      const cleanNo = enrollmentNo.trim().toUpperCase();
      console.log("=== LOGIN (student) ===");
      console.log("Enrollment No:", cleanNo);

      user = await User.findOne({
        enrollmentNo: cleanNo,
        isActive:     true,
        role:         "student",
      }).select("+password");

      if (!user) {
        console.log("Student found: NO");
        return res.status(401).json({
          success: false,
          message: "Invalid enrollment number or password",
        });
      }
    }

    console.log(`User     : ${user.name} (${user.role})`);
    console.log(`Hash len : ${user.password?.length}`);
    console.log(`MustReset: ${user.mustResetPassword}`);

    const isMatch = await bcrypt.compare(password, user.password);
    console.log(`PwdMatch : ${isMatch}`);
    console.log("======================");

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: isStudentLogin
          ? "Invalid enrollment number or password"
          : "Invalid email or password",
      });
    }

    console.log(`🔐 Login success: ${user.name} (${user.role})`);
    return res.json(buildTokenResponse(user));

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

    console.log(`🔄 Token refreshed (A): ${user.enrollmentNo ?? user.email}`);
    return res.json(buildTokenResponse(user));

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
    console.log(`🔄 Token refreshed (B): ${user.enrollmentNo ?? user.email}`);
    return res.json(buildTokenResponse(user));
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

    if (!user.mustResetPassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, message: "currentPassword is required" });
      }

      const isSame = await bcrypt.compare(newPassword, user.password);
      if (isSame) {
        return res.status(400).json({
          success: false,
          message: "New password must be different from your current password",
        });
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

    console.log(`🔑 Password changed: ${user.enrollmentNo ?? user.email} (${user.role})`);

    return res.json({
      success: true,
      message: "Password updated successfully",
      ...buildTokenResponse(user),
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

    return res.json({ success: true, user: serializeUser(user) });

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