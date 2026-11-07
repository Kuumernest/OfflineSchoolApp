// desktop/src/main/logFile.js
"use strict";

/**
 * The main process's console, also written to a file.
 *
 * A packaged Windows build has no console attached, so every console.log the
 * main process made — the database path, the server it was syncing with, why a
 * cycle failed — went nowhere. When a school reported "signed in, sees nothing"
 * there was no file to ask them for.
 *
 * Now there is: app.getPath("logs"), which on Windows is
 * %APPDATA%\school-desktop\logs\main.log. One previous file is kept as
 * main.old.log when this one passes MAX_BYTES, so the log cannot grow without
 * bound on an office machine nobody looks after.
 *
 * Never throws. A log that cannot be written must not stop the application;
 * the console still works as before.
 */

const fs   = require("fs");
const path = require("path");
const util = require("util");

const MAX_BYTES = 5 * 1024 * 1024;

/** @returns {string|null} the file being written, or null if none could be. */
const install = (dir) => {
  let file = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "main.log");
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, "main.old.log"));
    } catch { /* no file yet */ }
  } catch {
    return null;
  }

  const write = (level, args) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${util.format(...args)}\n`);
    } catch { /* see the note above */ }
  };

  for (const [method, level] of [["log", "INFO "], ["info", "INFO "], ["warn", "WARN "], ["error", "ERROR"]]) {
    const original = console[method].bind(console);
    console[method] = (...args) => { original(...args); write(level, args); };
  }

  return file;
};

module.exports = { install, MAX_BYTES };
