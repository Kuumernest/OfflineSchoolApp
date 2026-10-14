// backend/scripts/stopQuietly.js
"use strict";

/**
 * Stop a temporary mongod without letting it decide whether the suite passed.
 *
 * ── The failure this exists to prevent ────────────────────────────────────
 *
 * Every check script in this directory spins up an in-memory MongoDB and stops
 * it at the end. On a loaded machine — and on Windows more or less reliably,
 * once twenty of these have started and stopped in one `npm run check:all`
 * chain — mongod will not exit inside the library's ten-second window, and
 * mongodb-memory-server throws:
 *
 *   Error: Process "mongodProcess" didnt exit, enable debug for more information
 *
 * That throw lands AFTER every assertion has been counted. The script's own
 * `.catch` then exits 1, so the run prints "127 passed, 0 failed" and reports
 * failure — the worst of both for anything reading the exit code, and a red
 * build that says nothing about the repository. In the scripts that print
 * their summary after teardown it is worse still: the verdict never prints at
 * all, and the only output is a stack trace from a temp directory.
 *
 * A lingering temporary process is worth knowing about and is not a result.
 * So it is reported on stdout and stepped over: the process is an in-memory
 * server in a temp directory, nothing outlives the run, and the operating
 * system reaps it when the script exits.
 *
 * ── Why this is shared rather than inlined ────────────────────────────────
 *
 * It was inlined, in check-desktop-parity.js, with the note that became this
 * one. Twenty other scripts had the same teardown and not the guard, so the
 * chain kept dying at whichever of them happened to be running when the
 * machine got slow. A second hand-written copy is how the grading scale came
 * to have four versions that disagreed; one function is cheaper than twenty
 * chances to get it subtly different.
 *
 * Deliberately NOT a general teardown helper: `mongoose.disconnect()` is left
 * to the caller. It is a different operation with different failure modes, and
 * a failure there is worth hearing about rather than swallowing by default.
 *
 * @param {{stop?: () => Promise<unknown>}|null} mongo  a MongoMemoryServer
 * @returns {Promise<void>} never rejects
 */
const stopQuietly = async (mongo) => {
  try {
    await mongo?.stop();
  } catch (err) {
    console.log(`  (the temporary mongod did not exit cleanly: ${err.message})`);
  }
};

module.exports = { stopQuietly };
