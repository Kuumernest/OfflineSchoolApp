// backend/middleware/auth.js
"use strict";

const jwt  = require("jsonwebtoken");
const User = require("../src/db/models/User");
const { normalizeRole, ROLES } = require("../src/config/roles");
const { lookupSchool, isSchoolClosedFor } = require("../src/utils/schoolContext");

const SCHOOL_INACTIVE_MESSAGE =
  "This school has been deactivated. Contact the platform operator.";
const SCHOOL_ACCESS_DENIED_MESSAGE =
  "You may only act within your own school.";

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

    // ── The school, at the door ─────────────────────────────────────────────
    //
    // Two rules, both decided here and nowhere else, because a rule copied
    // into seventeen routers is a rule the eighteenth misses.
    //
    // 1. A school-scoped caller's OWN school must be open. A school the
    //    platform has switched off, or deleted, takes its staff and pupils
    //    with it: this refuses every request from then on, so a token issued
    //    before the switch stops working at its very next use, with no
    //    blacklist. Reactivation lifts it just as immediately.
    //
    // 2. A school-scoped caller may not NAME another school. utils/tenant.js
    //    used to correct such a request silently to the caller's own school.
    //    Silence is the wrong answer to "give me school B's data": the client
    //    that asked is either mistaken or hostile, and both deserve a 403
    //    that says so, not school A's figures under school B's heading. The
    //    correction downstream stays as a second line; it should now never
    //    be reached by anyone but a super_admin.
    //
    //    Path parameters are not visible here — see guardSchoolParam in
    //    utils/tenant.js, which the one router with /:schoolId applies.
    //
    // 3. A super_admin may name any school, and is taken at their word about
    //    WHICH — but the word is checked: the school must exist and not be
    //    deleted, or the request is a 404 rather than an empty page that looks
    //    like a real school with nothing in it. A deactivated school is still
    //    reachable for them — switching it back on is done from inside — and
    //    is flagged on req.schoolContext for whatever cares.
    if (role !== ROLES.SUPER_ADMIN && await isSchoolClosedFor(user)) {
      return res.status(401).json({
        success: false,
        code:    "SCHOOL_INACTIVE",
        message: SCHOOL_INACTIVE_MESSAGE,
      });
    }

    const askedSchoolId = (() => {
      const q = req.query?.schoolId;
      if (q != null && String(q).trim() !== "") return String(q).trim();
      const b = req.body;
      if (b && typeof b === "object" && !Array.isArray(b) && b.schoolId != null &&
          String(b.schoolId).trim() !== "") {
        return String(b.schoolId).trim();
      }
      return null;
    })();

    if (role !== ROLES.SUPER_ADMIN && askedSchoolId !== null &&
        askedSchoolId !== String(user.schoolId ?? "")) {
      return res.status(403).json({
        success: false,
        code:    "SCHOOL_ACCESS_DENIED",
        message: SCHOOL_ACCESS_DENIED_MESSAGE,
      });
    }

    let schoolContext = null;
    if (role === ROLES.SUPER_ADMIN) {
      const asked = req.query?.schoolId ?? req.body?.schoolId;
      if (asked != null && String(asked).trim() !== "") {
        const school = await lookupSchool(asked);
        if (!school) {
          return res.status(404).json({
            success: false,
            code:    "SCHOOL_NOT_FOUND",
            message: "No such school",
          });
        }
        schoolContext = school;
      }
    }

    req.user = {
      ...user,
      role,
      id:           user._id,
      _id:          user._id,
      enrollmentNo: user.enrollmentNo ?? null,
    };
    req.schoolContext = schoolContext;

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

module.exports = {
  authenticate, authorize,
  SCHOOL_INACTIVE_MESSAGE, SCHOOL_ACCESS_DENIED_MESSAGE,
};