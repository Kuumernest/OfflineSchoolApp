// backend/middleware/auth.js
"use strict";

const jwt  = require("jsonwebtoken");
const User = require("../src/db/models/User");

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
      decoded = jwt.verify(token, process.env.JWT_SECRET);
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

    console.log("JWT decoded id:", decoded.id);

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

    req.user = {
      ...user,
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

const authorize = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Required roles: ${roles.join(", ")}`,
    });
  }
  return next();
};

module.exports = { authenticate, authorize };