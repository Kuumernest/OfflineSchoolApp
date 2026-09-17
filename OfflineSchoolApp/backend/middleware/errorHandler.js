// backend/middleware/errorHandler.js

/**
 * Global Express error handler.
 * Must be registered LAST in server.js with app.use(errorHandler).
 */
function errorHandler(err, req, res, next) {
  console.error("Unhandled error:", err.message);

  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      success: false,
      error:   "Validation Error",
      details: messages,
    });
  }

  if (err.code === 11000) {
    return res.status(409).json({
      success: false,
      error:   "Duplicate entry",
      details: err.keyValue,
    });
  }

  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({
      success: false,
      error:   "Invalid token",
    });
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json({
      success: false,
      error:   "Token expired",
    });
  }

  // A status the code chose (err.statusCode) comes with a message the code
  // wrote, and that is for the caller. An unexpected exception has neither:
  // its message is a driver's, a library's, or a stack frame's, and in
  // production it names models, fields and paths to whoever sent the request.
  const chosen = Number(err.statusCode) >= 400 && Number(err.statusCode) < 500;
  const generic = process.env.NODE_ENV === "production" && !chosen;
  res.status(err.statusCode || 500).json({
    success: false,
    error:   generic ? "Internal Server Error" : (err.message || "Internal Server Error"),
  });
}

module.exports = errorHandler;