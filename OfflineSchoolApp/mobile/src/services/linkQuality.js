// src/services/linkQuality.js
"use strict";

/**
 * How fast this link is, measured rather than assumed.
 *
 * Every timeout in this app used to be a constant chosen for one school's
 * connection — the comment on the sync interval said so outright: "the schools
 * run over the public internet". They do not all run over the same one. A
 * school on fibre and a school on a village 3G tower are the same build, and
 * so is one teacher on staff-room wifi and that same teacher on mobile data an
 * hour later. The link is not a property of the school; it is a property of
 * this device, right now.
 *
 * A fixed timeout is therefore wrong in both directions at once. Too long and
 * a dead link takes 30 or 60 seconds to admit it, with the user watching. Too
 * short and a request that was going to succeed is killed, its work thrown
 * away, and retried into the same wall.
 *
 * ── What is measured ─────────────────────────────────────────────────────────
 *
 * Not the duration. The ratio of duration to the budget the caller asked for.
 *
 * That normalisation is what makes one number enough. A /sync/pull carrying a
 * whole school is legitimately slower than fetching a conversation list, and a
 * median over raw durations would let the pull inflate the timeout of every
 * small request that follows it. Measured against its own budget, both answer
 * the same question: how much of what we allowed did this actually need.
 *
 * A healthy link is one where a typical request finishes well inside its
 * budget. TARGET_RATIO says how much slack that means — a quarter, so a
 * typical request has four times the room it needs. When the observed median
 * drifts above that, budgets grow; when it sits far below, they shrink, and
 * failures surface in seconds instead of half a minute.
 *
 * ── What is not done ─────────────────────────────────────────────────────────
 *
 * Nothing here changes WHEN a sync runs, WHAT it carries, or how many times it
 * retries. Only how long a single request is given before it is abandoned.
 * Keeping it to that is deliberate: the scheduler is the part of this app with
 * the worst bug history, and a timeout is the one knob that cannot lose data.
 *
 * Nothing is persisted. A fresh launch starts from the defaults and converges
 * within a handful of requests, which is the honest behaviour — the link on
 * this launch is not necessarily the link on the last one.
 */

/** Requests kept in the rolling window. Small enough to follow a change. */
const WINDOW = 24;

/** Ignore the first few: one sample is noise, not a measurement. */
const MIN_SAMPLES = 5;

/** The fraction of its budget a healthy request should use. */
const TARGET_RATIO = 0.25;

/**
 * How far the multiplier may travel.
 *
 * The ceiling is not politeness — it is the point past which waiting longer
 * stops being a strategy. The floor stops a burst of cached 304s from cutting
 * budgets so fine that the next real request fails.
 */
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 6;

/** Absolute bounds, whatever the factor says. */
const MIN_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 180_000;

const ratios = [];
let factor = 1;

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const recompute = () => {
  if (ratios.length < MIN_SAMPLES) { factor = 1; return; }
  const next = median(ratios) / TARGET_RATIO;
  factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, next));
};

/**
 * A request came back.
 *
 * @param durationMs  time on the wire, excluding any queueing this app did
 * @param budgetMs    the timeout it was given
 */
export const recordSuccess = (durationMs, budgetMs) => {
  if (!(durationMs > 0) || !(budgetMs > 0)) return;
  ratios.push(Math.min(1, durationMs / budgetMs));
  if (ratios.length > WINDOW) ratios.shift();
  recompute();

  // Additive increase, once a run of COMFORTABLE requests has earned it. A
  // success that only just made it resets the run rather than advancing it.
  const ratio = durationMs / budgetMs;
  if (ratio > BATCH_COMFORT) {
    cleanRun = 0;
  } else if (++cleanRun >= BATCH_RECOVERY) {
    cleanRun = 0;
    batchScale = Math.min(BATCH_MAX_SCALE, batchScale + BATCH_INCREASE);
  }
};

/**
 * A request hit its timeout.
 *
 * Recorded as having used its whole budget, because that is all that is known:
 * it needed at least this long, and possibly far more. Counting it as 1.0 is
 * what lets a link that has genuinely slowed pull the budgets up rather than
 * sitting at a median formed from the requests that happened to succeed.
 */
export const recordTimeout = () => {
  ratios.push(1);
  if (ratios.length > WINDOW) ratios.shift();
  recompute();

  // Multiplicative decrease, and the recovery run starts again.
  cleanRun = 0;
  batchScale = Math.max(BATCH_MIN_SCALE, batchScale * BATCH_DECREASE);
};

/** Non-timeout failures say nothing about speed, so they are dropped. */
export const recordFailure = () => {};

/** The current multiplier, for logging and for the diagnostics screen. */
export const currentFactor = () => factor;

/** How many samples are behind it. Below MIN_SAMPLES the factor is 1. */
export const sampleCount = () => ratios.length;

/**
 * Scale a caller's budget to this link.
 *
 * The caller's number is kept as the statement of intent it is — a pull is
 * allowed longer than a message fetch, and that relationship survives — while
 * its absolute size follows the connection.
 */
export const scaleTimeout = (baseMs) => {
  const base = Number(baseMs);
  if (!(base > 0)) return base;
  return Math.round(
    Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, base * factor))
  );
};

/** Testing only. */
export const _reset = () => { ratios.length = 0; factor = 1; batchScale = 1; cleanRun = 0; };


// ═════════════════════════════════════════════════════════════════════════
// HOW MUCH ONE REQUEST SHOULD CARRY
//
// A separate control law from the timeout above, deliberately.
//
// The multiplier is a ratio of time to budget, and batch size CHANGES that
// time — so driving the batch from the multiplier closes a loop on itself:
// smaller batches finish sooner, which lowers the ratio, which grows the
// batch, which raises the ratio. It oscillates, and the oscillation is
// visible to the user as a save that is fast, then times out, then is fast.
//
// So this uses additive-increase / multiplicative-decrease instead — the
// rule TCP uses for the same problem, and stable for the same reason. Halve
// on a timeout, because a timeout means the last size was too big and the
// only safe move is a large one. Creep back up after a run of clean
// successes, because the link recovering is a guess until proven.
// ═════════════════════════════════════════════════════════════════════════

/** Fractions of the caller's preferred size. */
const BATCH_MIN_SCALE = 0.2;
const BATCH_MAX_SCALE = 2;

/** Halve on failure; creep up in quarters. */
const BATCH_DECREASE  = 0.5;
const BATCH_INCREASE  = 0.25;

/** Clean requests needed before growing. Slow on purpose. */
const BATCH_RECOVERY  = 8;

/**
 * How much of its budget a request may use and still count as evidence that
 * there is room for a bigger one.
 *
 * "It succeeded" is not that evidence. A link where every request finishes at
 * 80% of its budget is one hiccup from failing, and growing the batch is the
 * hiccup — the extra rows are exactly what pushes the next one over. Only a
 * request with real headroom argues for more.
 */
const BATCH_COMFORT   = 0.5;

let batchScale = 1;
let cleanRun   = 0;

/**
 * How many items the next request of this kind should carry.
 *
 * @param base the size the caller would use on a healthy link
 */
export const batchSize = (base) => {
  const n = Number(base);
  if (!(n > 0)) return base;
  // Never zero: a batch of nothing is an infinite loop in every caller that
  // walks a list in slices.
  return Math.max(1, Math.round(n * batchScale));
};

/** The current fraction. Exposed for diagnostics and the checks. */
export const currentBatchScale = () => batchScale;

/** Testing only. */
export const _resetBatch = () => { batchScale = 1; cleanRun = 0; };

export default {
  recordSuccess, recordTimeout, recordFailure,
  currentFactor, sampleCount, scaleTimeout,
  batchSize, currentBatchScale,
  _reset, _resetBatch,
};
