// backend/src/services/intervention.service.js
"use strict";

/**
 * The lifecycle of a support action, and the only copy of it.
 *
 * ── Why a state machine rather than a free-text status field ──────────────
 *
 * An intervention is the record of what a school DID about a pupil who was
 * struggling, and its value is entirely in being trustworthy after the fact.
 * "Completed" has to mean somebody actually completed it, not that a stale
 * offline device resent a status it had been holding for a week.
 *
 * So the moves are enumerated, the illegal ones are refused rather than
 * tolerated, and every move that does happen writes down who made it and when.
 * A record that can go from completed back to planned is a record nobody can
 * read a history out of.
 *
 * ── The four states ───────────────────────────────────────────────────────
 *
 *   planned     recorded, not started
 *   active      the teacher is doing it
 *   completed   done, and an outcome may be recorded against it
 *   cancelled   abandoned; kept rather than deleted, because "we decided not
 *               to" is itself part of the record
 *
 * Both end states are terminal. Reopening is deliberately not a transition: a
 * second attempt at the same problem is a second intervention, which keeps the
 * first one's dates and outcome honest instead of overwriting them.
 *
 * ── Setting the status a record already has ───────────────────────────────
 *
 * Silently does nothing, rather than throwing. That is not laxity: it is what
 * makes the offline outbox safe. A replayed PATCH carrying "active" against a
 * row that is already active must not be an error, or a dropped connection
 * turns into a red row in the pending-changes screen that a teacher cannot
 * clear. It writes no history entry either, so a resend does not inflate the
 * audit trail with moves that never happened.
 *
 * ── The error this throws ─────────────────────────────────────────────────
 *
 * `err.status = 409`, which is this repository's convention for a service
 * telling its router what to answer (gate, documents, approvals and payroll all
 * do the same). The GLOBAL handler in middleware/errorHandler.js reads
 * `statusCode`, not `status`, so a router that forwards this to next() answers
 * 500. Routers translate it themselves — see interventions.routes.js.
 */

/** Which states each state may move to. Empty means terminal. */
const TRANSITIONS = {
  planned:   ["active", "cancelled"],
  active:    ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/**
 * Move a record to its next state, recording who moved it.
 *
 * Mutates the document in place — it is called on a Mongoose document the
 * router is about to save, and returning a copy would mean the router had two
 * versions of one row to keep straight.
 *
 * @param {object} item  an Intervention document, with statusHistory
 * @param {string} next  the state to move to
 * @param {string} by    the acting user's id
 * @throws {Error} INVALID_INTERVENTION_TRANSITION, carrying status 409
 */
const transition = (item, next, by) => {
  // A resend of the state already held. See the header: not an error.
  if (next === item.status) return;

  if (!TRANSITIONS[item.status]?.includes(next)) {
    const err = new Error("INVALID_INTERVENTION_TRANSITION");
    err.status = 409;
    throw err;
  }

  const at = new Date();
  item.statusHistory.push({ from: item.status, to: next, by, at });
  item.status = next;

  // One stamp per state, so "when did this actually start" survives a later
  // edit to any other field.
  if (next === "active")    item.startedAt   = at;
  if (next === "completed") item.completedAt = at;
  if (next === "cancelled") item.cancelledAt = at;
};

module.exports = { TRANSITIONS, transition };
