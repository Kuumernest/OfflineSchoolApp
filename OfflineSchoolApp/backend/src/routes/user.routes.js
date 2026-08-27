// backend/routes/user.routes.js
"use strict";

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const User     = require("../db/models/User");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fields that must never be sent to any client regardless of role.
 * Defined once so both route handlers stay in sync.
 */
const PRIVATE_FIELDS = "-password -passwordHash -passwordSalt -tempPassword -__v";

/**
 * Roles that are allowed to fetch any user's profile.
 * Using a Set for O(1) lookup instead of Array.includes.
 */
// users.manage is what decides whether you may read somebody ELSE's profile.
// Non-delegable: staff contact details and account state are not the bursar's
// business, and the bursar reads students through /api/students, which carries
// what a fee statement needs and nothing more.
//
// Checked inside the handler rather than as route middleware because the answer
// is not "admit or refuse" — a caller without it may still read their own
// profile from the same route.
const permissions = require("../services/permissions.service");

/**
 * Returns true when the provided string is a syntactically valid
 * MongoDB ObjectId. Prevents Mongoose from throwing a CastError when
 * a caller passes a malformed id (e.g. "me", "undefined", "abc").
 *
 * @param {string} id
 * @returns {boolean}
 */
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/**
 * Auth guard — rejects unauthenticated requests before any DB work is done.
 * Placed as route-level middleware rather than router.use() so it shows
 * up clearly in the handler chain for each route.
 */
const requireAuth = (req, res, next) => {
  if (!req.user?._id) {
    return res.status(401).json({ success: false, error: "Not authenticated" });
  }
  return next();
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/me
//
// FIX #ORDER — This route MUST be registered before GET /:id.
// Express matches routes in registration order. Without this ordering,
// a request to /api/users/me would be captured by GET /:id with
// req.params.id = "me", which is not a valid ObjectId and would cause
// Mongoose to throw a CastError.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select(PRIVATE_FIELDS)
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    return res.json({ success: true, user });
  } catch (err) {
    console.error("GET /users/me error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to fetch user profile" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/:id
//
// Admins can fetch any user's profile scoped to their school.
// Non-admins can only fetch their own profile.
//
// FIX #CAST — Invalid ObjectId strings (e.g. "null", "undefined",
// a local UUID) previously caused Mongoose to throw a CastError which
// surfaced as an unhandled 500. We now validate the id up-front and
// return a 400 immediately.
//
// FIX #SCOPE — Admins (non-super) are now scoped to their own school.
// Without this, a school_admin could enumerate users from other schools
// by guessing ObjectIds.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const requesterId = String(req.user._id);
    const targetId    = req.params.id;
    const role        = req.user.role;
    const isAdmin     = await permissions.can(req.user, "users.manage");

    // FIX #CAST — reject obviously invalid ids before hitting Mongoose
    if (!isValidObjectId(targetId)) {
      return res.status(400).json({ success: false, error: "Invalid user ID format" });
    }

    // Non-admins may only access their own profile
    if (!isAdmin && requesterId !== targetId) {
      return res.status(403).json({
        success: false,
        error:   "You can only view your own profile",
      });
    }

    // FIX #SCOPE — scope the query to the caller's school for non-super-admins
    // so a school_admin cannot fetch users from other schools
    const query = { _id: targetId };
    if (role !== "super_admin" && req.user.schoolId) {
      query.schoolId = req.user.schoolId;
    }

    const user = await User.findOne(query)
      .select(PRIVATE_FIELDS)
      .lean();

    // Return 404 for both "not found" and "belongs to another school"
    // so the response does not reveal cross-school existence
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    return res.json({ success: true, user });
  } catch (err) {
    // FIX #CAST — Mongoose CastError (malformed ObjectId that slipped through
    // isValidObjectId for any edge-case reason) is now a 400, not a 500
    if (err.name === "CastError" && err.path === "_id") {
      return res.status(400).json({ success: false, error: "Invalid user ID format" });
    }
    console.error("GET /users/:id error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to fetch user" });
  }
});

module.exports = router;