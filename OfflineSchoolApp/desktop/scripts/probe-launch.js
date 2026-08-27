// desktop/scripts/probe-launch.js
"use strict";

/**
 * Runs src/main/probe.js under a real Electron main process.
 *
 * Separate from launch.js because the probe replaces the entry point rather
 * than starting the app: it is asking what this Electron can do, which has to
 * be answered before the app is trusted to run on it. See launch.js for why the
 * environment has to be scrubbed first.
 */

const path      = require("path");
const { spawn } = require("child_process");
const electron  = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electron,
  [path.join(__dirname, "..", "src", "main", "probe.js"), "--no-sandbox"],
  { env, stdio: "inherit" }
);

child.on("close", (code) => {
  const out = path.join(__dirname, "..", "probe-result.txt");
  try { console.log("\n" + require("fs").readFileSync(out, "utf8")); } catch { /* it said nothing */ }
  process.exit(code ?? 0);
});
