// src/services/syncProgress.js
"use strict";

/**
 * What the sync is doing, right now, as a number somebody can act on.
 *
 * The sync was the longest-running thing in the app and the least legible: a
 * spinner in the status bar, minutes of it, identical at the first second and
 * the last. "Almost always fails even when there is connection" was reported
 * against exactly that spinner — with no phase and no count, a slow sync and
 * a stuck sync look the same, so there was nothing to tell the two apart.
 *
 * The percentage here is real, not a timer dressed up as one. syncAll runs a
 * fixed list of named steps — push, then a step per mirrored collection, then
 * quizzes — so "step 7 of 12" is a fact known before the run starts. Steps
 * that carry their own tally (the outbox drain knows how many mutations it
 * holds) report it, and the fraction inside the current step is blended into
 * the total so the bar advances between steps instead of sitting still
 * through the longest one.
 *
 * A step is never inferred from elapsed time. A bar driven by a clock is a
 * lie that gets found out on a slow link, which is the only link where any of
 * this matters.
 */

/** Every step syncAll can run, in order, with the i18n key that names it. */
export const SYNC_STEPS = {
  prepare:      "syncStep.prepare",
  upload:       "syncStep.upload",
  download:     "syncStep.download",
  classes:      "syncStep.classes",
  subjects:     "syncStep.subjects",
  teachers:     "syncStep.teachers",
  periods:      "syncStep.periods",
  assignments:  "syncStep.assignments",
  students:     "syncStep.students",
  announcements:"syncStep.announcements",
  applications: "syncStep.applications",
  school:       "syncStep.school",
  quizzes:      "syncStep.quizzes",
};

/**
 * The steps a given role actually runs.
 *
 * The total has to be right or the percentage is fiction: a student never
 * calls /sync/pull, so counting the six collection steps against them would
 * park their bar at 40% and finish from there.
 */
export const planFor = ({ isStudent = false, isAdmin = false } = {}) => {
  if (isStudent) {
    return ["prepare", "upload", "announcements", "school", "quizzes"];
  }
  return [
    "prepare", "upload", "download",
    "classes", "subjects", "teachers", "periods", "assignments", "students",
    ...(isAdmin ? ["applications"] : []),
    "announcements", "school", "quizzes",
  ];
};

const IDLE = {
  active:    false,
  visible:   false,
  steps:     [],
  index:     0,
  stepKey:   null,
  detail:    "",
  itemDone:  0,
  itemTotal: 0,
};

let state = { ...IDLE };
const listeners = new Set();

const emit = () => {
  // A copy per listener call, so a consumer holding the previous object in
  // state sees a new reference and re-renders.
  const snapshot = { ...state };
  for (const fn of listeners) {
    try { fn(snapshot); } catch { /* a broken consumer must not stop a sync */ }
  }
};

export const subscribe = (fn) => {
  listeners.add(fn);
  fn({ ...state });
  return () => listeners.delete(fn);
};

export const getState = () => ({ ...state });

/**
 * @param visible  whether this run should be shown. A background tick every
 *                 five minutes has nothing to say to somebody reading a
 *                 screen; a forced sync — reconnect, foreground, pull to
 *                 refresh — is the one they are waiting on.
 */
export const begin = ({ steps, visible = false }) => {
  state = { ...IDLE, active: true, visible, steps: [...steps] };
  emit();
};

/** Enter a named step. Unknown or out-of-plan keys are ignored, not guessed. */
export const step = (key, detail = "") => {
  if (!state.active) return;
  const index = state.steps.indexOf(key);
  if (index === -1) return;
  // Monotonic: a step that runs twice (a retry inside the pull) must not drag
  // the bar backwards, which reads as failure even when it is progress.
  state = {
    ...state,
    index:     Math.max(state.index, index),
    stepKey:   key,
    detail,
    itemDone:  0,
    itemTotal: 0,
  };
  emit();
};

/** Report the tally inside the current step, where the step knows one. */
export const items = (done, total, detail) => {
  if (!state.active) return;
  state = {
    ...state,
    itemDone:  Number(done)  || 0,
    itemTotal: Number(total) || 0,
    ...(detail === undefined ? {} : { detail }),
  };
  emit();
};

export const end = () => {
  state = { ...IDLE };
  emit();
};

/**
 * Overall fraction, 0..1.
 *
 * Steps completed, plus how far into the current one — so a drain of forty
 * mutations moves the bar forty times rather than once, and the longest step
 * in the run is not the one where the bar appears to hang.
 */
export const fractionOf = (s) => {
  const total = s?.steps?.length ?? 0;
  if (!s?.active || total === 0) return 0;
  const inner = s.itemTotal > 0
    ? Math.min(1, Math.max(0, s.itemDone / s.itemTotal))
    : 0;
  return Math.min(1, (s.index + inner) / total);
};

export default { SYNC_STEPS, planFor, subscribe, getState, begin, step, items, end, fractionOf };
