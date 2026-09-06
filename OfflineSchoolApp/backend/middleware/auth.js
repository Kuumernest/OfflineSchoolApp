// backend/middleware/auth.js
"use strict";

const jwt  = require("jsonwebtoken");
const User = require("../src/db/models/User");
const { normalizeRole } = require("../src/config/roles");

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ success: false, message: "Malformed authorization header" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    } catch (err) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          message: "Token expired",
          code:    "TOKEN_EXPIRED",
        });
      }
      return res.status(401).json({ success: false, message: "Invalid token" });
    }

    let user;
    try {
      user = await User.findById(decoded.id).lean();
    } catch (dbErr) {
      console.error("Auth middleware DB error:", dbErr.message);
      return res.status(503).json({
        success: false,
        message: "Service temporarily unavailable. Please retry.",
      });
    }

    if (!user) {
      return res.status(401).json({ success: false, message: "User no longer exists" });
    }

    if (!user.isActive) {
      return res.status(401).json({ success: false, message: "Account is deactivated" });
    }

    // A token minted before the last password change is dead.
    //
    // passwordChangedAt is stamped by the pre("save") hook on the User model
    // every time a password is set — creation, a forced reset, a self-service
    // change — but until now nothing read it. Without this check, "change
    // password" only moved the goalposts: a session token issued from a leaked
    // temporary password kept working for its full thirty days, and the
    // fifteen-minute rule on mustResetPassword accounts could not close the
    // hole, because a thief who signed in once already held a long-lived token.
    //
    // decoded.iat is in seconds; passwordChangedAt is a Date. The leeway
    // absorbs the ordering noise between the second this token was signed and
    // the second the comparison runs, so a token issued in the same breath as
    // the change (change-password returns a fresh one) is never rejected.
    if (user.passwordChangedAt && decoded.iat) {
      const issuedAtMs = decoded.iat * 1000;
      const changedMs  = user.passwordChangedAt.getTime();
      if (issuedAtMs < changedMs - 5_000) {
        return res.status(401).json({
          success: false,
          message: "Your session ended when your password changed. Please sign in again.",
          code:    "TOKEN_STALE",
        });
      }
    }

    // Every guard downstream compares req.user.role against the canonical
    // names in config/roles.js, so the role is canonicalised once, here, at
    // the only door into the application. Doing it per-route is how one list
    // ended up written twenty times with twenty chances to drift.
    const role = normalizeRole(user.role);

    if (!role) {
      // A stored role outside the enum is corrupt data, not a permission
      // level. Failing closed with the value named beats letting it through:
      // a role matching no guard would pass authentication and then 403 on
      // every screen, which reads to the user as a broken app.
      console.error(`Auth: unrecognised role "${user.role}" on user ${user._id}`);
      return res.status(403).json({
        success: false,
        code:    "UNKNOWN_ROLE",
        message: "Your account's role is not recognised. Contact your administrator.",
      });
    }

    req.user = {
      ...user,
      role,
      id:           user._id,
      _id:          user._id,
      enrollmentNo: user.enrollmentNo ?? null,
    };

    return next();

  } catch (err) {
    console.error("Auth middleware error:", err.message);
    if (res.headersSent) return;
    return res.status(500).json({ success: false, message: "Authentication failed" });
  }
};

/**
 * Role guard.
 *
 * Accepts either a spread of role names or one of the sets exported by
 * config/roles.js, so authorize(FINANCE_ROLES) and
 * authorize(ROLES.SUPER_ADMIN, ROLES.SCHOOL_ADMIN) are both valid. Prefer the
 * named set: a guard naming FINANCE_ROLES says what kind of decision it
 * protects, and adding a role to the school never means editing it.
 */
const authorize = (...roles) => {
  const allowed = roles.flat().map(normalizeRole).filter(Boolean);

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    // req.user.role is already canonical — authenticate() normalised it.
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required roles: ${allowed.join(", ")}`,
      });
    }
    return next();
  };
};

module.exports = { authenticate, authorize };