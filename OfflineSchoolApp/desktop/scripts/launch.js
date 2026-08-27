// desktop/scripts/launch.js
"use strict";

/**
 * Start Electron, whatever terminal you started from.
 *
 * ── Why this is not just "electron ." ─────────────────────────────────────
 *
 * VS Code sets ELECTRON_RUN_AS_NODE=1 in its integrated terminal — it is itself
 * an Electron app and uses that variable for its own child processes. Any
 * Electron launched from that terminal inherits it, and the variable makes the
 * binary behave as a plain Node interpreter: no app, no window, and
 * require("electron") returning something with no whenReady on it.
 *
 * The failure that produces is genuinely misleading. `electron --version`
 * prints the NODE version, and the app dies on
 *
 *     TypeError: Cannot read properties of undefined (reading 'whenReady')
 *
 * which reads like a broken install or a bad import rather than an environment
 * variable set by the editor. It cost time here; it should not cost anybody
 * else's.
 *
 * Deleting the variable in a launcher works on every platform, which
 * `ELECTRON_RUN_AS_NODE= electron .` does not — that is shell syntax, and npm
 * runs scripts through cmd.exe on Windows.
 *
 *   node scripts/launch.js [--smoke]
 */

const path         = require("path");
const { spawn }    = require("child_process");
const electronPath = require("electron");

const env = { ...process.env };

// The whole point of the file.
delete env.ELECTRON_RUN_AS_NODE;

const args = [path.join(__dirname, "..")];

// Chromium's sandbox needs privileges that are not always present in a CI
// container or a remote session. Harmless on a real desktop.
if (process.env.SCHOOL_DESKTOP_NO_SANDBOX || process.env.CI) args.push("--no-sandbox");

if (process.argv.includes("--smoke")) {
  // Opens everything a real launch opens, writes what it found, and leaves —
  // so a build can be verified without a person watching a window.
  env.SCHOOL_DESKTOP_SMOKE = env.SCHOOL_DESKTOP_SMOKE || "5000";
  args.push("--no-sandbox");
}

const child = spawn(electronPath, args, { env, stdio: "inherit" });

child.on("close", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Could not start Electron:", err.message);
  process.exit(1);
});
