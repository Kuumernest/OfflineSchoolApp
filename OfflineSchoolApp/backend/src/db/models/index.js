// backend/src/db/models/index.js
"use strict";

/**
 * Register every model in this directory.
 *
 * ── The bug this exists to prevent ────────────────────────────────────────────
 *
 * The sync feed names its models as STRINGS — `{ collection: "grade", model:
 * "Grade" }` — and syncFeed.controller resolves them through
 * `mongoose.models[name]`. A model whose file no live module happens to require
 * is therefore not registered, the feed answers
 * `{ error: "MODEL_NOT_REGISTERED" }` for that collection, and the client
 * stores nothing. No exception is thrown and no log says anything is wrong: the
 * collection is simply never mirrored, on any device, for as long as that holds.
 *
 * That is not hypothetical twice over. It happened to attendance, because
 * Attendance.js registers StudentAttendance and TeacherAttendance and nothing
 * called "Attendance", which is what the feed had asked for. And it was true of
 * Grade at the time this file was written: Grade.js was required by exactly one
 * module, src/modules/sync/sync.service.js, which the server never loads — so
 * `grade` was in the feed, and unservable.
 *
 * Requiring the whole directory at boot makes registration a property of the
 * directory rather than of who happened to import what. A model added later is
 * registered by existing, which is the only rule that does not rot.
 *
 * scripts/check-orphans.js asserts the result: every model the feed names must
 * be reachable from src/server.js. That check would have failed on `grade`.
 */

const fs = require("fs");
const path = require("path");

const loaded = [];

for (const file of fs.readdirSync(__dirname)) {
  if (!file.endsWith(".js") || file === "index.js") continue;
  // Mongoose throws OverwriteModelError on a second registration, and several
  // modules still require their model directly; both paths hitting the same
  // file is fine, the module cache makes it idempotent.
  require(path.join(__dirname, file));
  loaded.push(file.replace(/\.js$/, ""));
}

module.exports = { loaded };
