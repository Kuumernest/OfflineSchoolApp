// desktop/scripts/seam-launch.js
"use strict";

/** Runs src/main/seam-check.js under a real Electron main process. See launch.js. */

const path      = require("path");
const fs        = require("fs");
const { spawn } = require("child_process");
const electron  = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  electron,
  [path.join(__dirname, "..", "src", "main", "seam-check.js"), "--no-sandbox"],
  { env, stdio: "inherit" }
);

child.on("close", (code) => {
  const out = path.join(__dirname, "..", "seam-result.txt");
  try { console.log("\n" + fs.readFileSync(out, "utf8")); } catch { console.log("(no result written)"); }
  process.exit(code ?? 0);
});
