// backend/src/utils/passwordPolicy.js
"use strict";

/**
 * The one description of what a password must be.
 *
 * POST /auth/change-password has always enforced these four rules inline, one
 * `if` and one message each. The platform's own account creation needs the
 * same four, and a second copy is how the two drift — a password the sign-in
 * screen would refuse becoming one the platform will happily set. So the rules
 * live here, and both read them.
 *
 * Returns the message to send back, or null when the password passes.
 */
const passwordPolicyError = (password) => {
  const pw = String(password ?? "");
  if (pw.length < 8)      return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(pw))  return "Password must contain at least one uppercase letter";
  if (!/[a-z]/.test(pw))  return "Password must contain at least one lowercase letter";
  if (!/\d/.test(pw))     return "Password must contain at least one number";
  return null;
};

module.exports = { passwordPolicyError };
