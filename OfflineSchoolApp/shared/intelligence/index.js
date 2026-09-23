// OfflineSchoolApp/shared/intelligence/index.js
"use strict";

/**
 * The deterministic student intelligence engine, in one place.
 *
 * ── What this is ──────────────────────────────────────────────────────────
 *
 *   academicOrder        which results count, and in what order they happened
 *   subjectInsights      what those marks say, per subject, with evidence
 *   guidance             what a teacher could reasonably do about it
 *   interventionOutcome  what the marks looked like before and after an action
 *
 * Every function in every one of them is pure: plain data in, plain data out.
 * No database, no Mongoose, no Express, no HTTP, no filesystem, no clock, no
 * network, no authorisation, no money. That is not incidental — it is the whole
 * reason the engine is here rather than in the backend, because it is what lets
 * the server, the desktop and anything else answer the same question about the
 * same child and get the same answer.
 *
 * ── What stays with the application ───────────────────────────────────────
 *
 * Loading the documents, deciding who may see them, scoping to a school and a
 * teacher's classes, persisting anything, and formatting a response. This
 * module does not know whether the caller is a teacher, an administrator or a
 * parent, and it must not learn: an engine that could answer "may I" as well as
 * "what does the evidence say" would be two things, and the guard would end up
 * with two implementations too.
 *
 * ── Note on the directory ─────────────────────────────────────────────────
 *
 * shared/ is otherwise flat. This is a folder because it is four files that
 * only make sense together and are always reached as a unit; flattening them
 * would put four intelligence modules in a directory whose other members are
 * each a single self-contained concern.
 */

const academicOrder       = require("./academicOrder");
const subjectInsights     = require("./subjectInsights");
const guidance            = require("./guidance");
const interventionOutcome = require("./interventionOutcome");

module.exports = {
  academicOrder,
  subjectInsights,
  guidance,
  interventionOutcome,

  // The engine's own version, so a school asking why a statement changed can
  // tell "the pupil changed" from "the rules changed".
  ENGINE_VERSION: subjectInsights.ENGINE_VERSION,
};
