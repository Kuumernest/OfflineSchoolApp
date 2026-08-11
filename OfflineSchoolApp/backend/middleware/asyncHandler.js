// middleware/asyncHandler.js
"use strict";

/**
 * Wraps async route handlers so unhandled promise rejections
 * are forwarded to Express error handler instead of hanging.
 * 
 * WITHOUT this: async throw = request hangs forever (Network Error)
 * WITH this:    async throw = 500 JSON response
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`💥 Async handler error [${req.method} ${req.path}]:`, err.message);
    next(err); // → goes to errorHandler middleware
  });
};

module.exports = asyncHandler;