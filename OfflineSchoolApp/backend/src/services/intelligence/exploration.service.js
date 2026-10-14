// backend/src/services/intelligence/exploration.service.js
"use strict";

/**
 * The exploration loop, served: suggestions, the pupil's choices, what
 * happened, and the evidence it produced.
 *
 * ── Boundary with the strengths layer ─────────────────────────────────────
 *
 * This file reads the strengths profile and writes ExplorationEvidence rows.
 * It never writes a strength. The strengths engine (1.0.0) consumes the kinds
 * it already knew — interest, exposure, reflection as signals, teacher
 * observation under its one rule — and ignores participation and performance
 * until a versioned change says otherwise. The current profile is not
 * recomputed differently because an activity was completed; the next
 * snapshot, when the office takes it, reads whatever the evidence then says.
 *
 * ── Every write is a replay-safe write ────────────────────────────────────
 *
 * Creates accept the client's _id; evidence ids are derived from the
 * exploration and the kind; reflections and observations are one per
 * exploration (per observer) and revise rather than duplicate; transitions
 * are idempotent when the row is already in the target state. A queue that
 * resends after a dropped connection lands on the same rows.
 */

const StudentExploration     = require("../../db/models/StudentExploration");
const ExplorationReflection  = require("../../db/models/ExplorationReflection");
const ExplorationObservation = require("../../db/models/ExplorationObservation");
const ExplorationActivity    = require("../../db/models/ExplorationActivity");
const ExplorationEvidence    = require("../../db/models/ExplorationEvidence");
const strengthsSvc           = require("./strengths.service");
const ex                     = require("../../../../shared/exploration");

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

// ─────────────────────────────────────────────────────────────────────────────
// CATALOG
// ─────────────────────────────────────────────────────────────────────────────

/** The shipped catalog plus the school's own active additions, one language. */
const catalog = async ({ schoolId, lang = "en", area = null, level = null, resources = null }) => {
  const own = schoolId
    ? (await ExplorationActivity.find({ schoolId, deletedAt: null, status: "active" }).lean()).map((d) => d.definition)
    : [];
  return [...ex.ACTIVITIES, ...own]
    .filter((a) => a.status === "active")
    .filter((a) => !area || a.area === area)
    .filter((a) => !level || a.level === level)
    .filter((a) => !resources || a.resources.every((r) => r === "NO_SPECIAL_RESOURCES" || resources.includes(r)))
    .map((a) => ex.localize(a, lang));
};

const activityById = async ({ schoolId, activityId }) => {
  const shipped = ex.activityById(activityId);
  if (shipped) return shipped;
  const own = schoolId ? await ExplorationActivity.findOne({ _id: activityId, schoolId, deletedAt: null }).lean() : null;
  return own?.definition ?? null;
};

// ─────────────────────────────────────────────────────────────────────────────
// SUGGESTIONS AND HISTORY
// ─────────────────────────────────────────────────────────────────────────────

const historyRows = ({ schoolId, studentId }) =>
  StudentExploration.find({ schoolId, studentId: String(studentId), deletedAt: null }).sort({ createdAt: 1 }).lean();

/** What to put in front of this pupil now, with reasons. */
const recommended = async ({ schoolId, studentId, resources = null, count = 6, lang = "en" }) => {
  const [profile, history] = await Promise.all([
    strengthsSvc.profileFor({ schoolId, studentId }),
    historyRows({ schoolId, studentId }),
  ]);
  const r = ex.recommend({
    strengthProfile: profile,
    history: history.map((h) => ({ activityId: h.activityId, area: h.area, level: h.level, status: h.status })),
    resources, count,
    // Two completed activities in an area and its aligned slot yields to
    // breadth. The pupil may still open the area from the catalog.
    saturation: 2,
  });
  const suggestions = [];
  for (const s of r.suggestions) {
    const a = await activityById({ schoolId, activityId: s.activityId });
    if (a) suggestions.push({ ...s, activity: ex.localize(a, lang) });
  }
  return { ...r, suggestions, profileConfidence: profile?.confidence ?? "insufficient" };
};

/**
 * Who may see which layer of a reflection.
 *   student   everything, their own
 *   staff     controlled values; the text only when the pupil shared it
 *   guardian  nothing (progress only)
 */
const reflectionFor = (r, viewer) => {
  if (!r) return null;
  const b = r.body ?? {};
  if (viewer === "student") return { ...b, version: r.version, revisions: r.revisions?.length ?? 0, updatedAt: r.updatedAt };
  if (viewer === "staff") return {
    interest: b.interest ?? null, difficulty: b.difficulty ?? null, continue: b.continue ?? null,
    ...(b.shareText ? { enjoyed: b.enjoyed ?? null, difficult: b.difficult ?? null, next: b.next ?? null } : {}),
    shareText: Boolean(b.shareText), updatedAt: r.updatedAt,
  };
  return null;
};

/** The pupil's explorations, each with its reflection (as the viewer may see it), observations, evidence. */
const history = async ({ schoolId, studentId, viewer = "staff", lang = "en" }) => {
  const id = String(studentId);
  const [rows, reflections, observations, evidence] = await Promise.all([
    historyRows({ schoolId, studentId: id }),
    ExplorationReflection.find({ schoolId, studentId: id, deletedAt: null }).lean(),
    ExplorationObservation.find({ schoolId, studentId: id, deletedAt: null }).lean(),
    ExplorationEvidence.find({ schoolId, studentId: id, deletedAt: null, explorationId: { $ne: null } }).lean(),
  ]);
  const refBy = new Map(reflections.map((r) => [r.explorationId, r]));
  const out = [];
  for (const e of rows) {
    const a = await activityById({ schoolId, activityId: e.activityId });
    const obs = observations.filter((o) => o.explorationId === e._id);
    const ev  = evidence.filter((v) => v.explorationId === e._id);
    const reflection = reflectionFor(refBy.get(e._id), viewer);
    out.push({
      explorationId: e._id, activityId: e.activityId, activityVersion: e.activityVersion, area: e.area, level: e.level,
      title: a ? ex.localize(a, lang).title : e.activityId,
      status: e.status, relevance: e.relevance, suggestedBecause: e.suggestedBecause,
      discoveredAt: e.discoveredAt, startedAt: e.startedAt, submittedAt: e.submittedAt, completedAt: e.completedAt, closedAt: e.closedAt,
      completionMode: e.completionMode, outputs: viewer === "guardian" ? undefined : e.outputs,
      performance: viewer === "guardian" ? (e.performance ? { level: e.performance.level } : null) : e.performance,
      reflection,
      observations: viewer === "guardian" ? obs.length : obs.map((o) => ({ observationId: o._id, level: o.level, codes: o.codes, note: o.note, observedBy: o.observedBy, observedAt: o.observedAt, version: o.version })),
      evidence: viewer === "guardian" ? ev.map((v) => v.kind) : ev.map((v) => ({ evidenceId: v._id, kind: v.kind, source: v.source, date: v.date, outcome: v.outcome ?? null })),
      // The pair, never a score.
      pattern: ex.patternOf({ interest: refBy.get(e._id)?.body?.interest ?? null, performance: e.performance?.level ?? null }),
      transitions: viewer === "guardian" ? undefined : e.transitions,
      version: e.version, explorationEngineVersion: e.explorationEngineVersion,
    });
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// THE PUPIL'S CHOICES
// ─────────────────────────────────────────────────────────────────────────────

const move = (e, to, by) => {
  e.transitions.push({ from: e.status, to, by });
  e.status = to;
  e.version += 1;
};

/**
 * A pupil takes an activity from the list: START, SAVE, SKIP or NOT_INTERESTED.
 * A replayed create (same _id) returns the row it made. An open exploration of
 * the same activity is returned rather than doubled.
 */
const choose = async ({ schoolId, studentId, classId, actor, body, suggestion = null }) => {
  const action = String(body.action ?? "start").toUpperCase();
  const target = { START: "STARTED", SAVE: "SAVED", SKIP: "SKIPPED", NOT_INTERESTED: "NOT_INTERESTED", DISCOVER: "DISCOVERED" }[action];
  if (!target) throw fail(400, "INVALID_ACTION", "action must be start, save, skip, not_interested or discover");
  const activity = await activityById({ schoolId, activityId: String(body.activityId ?? "") });
  if (!activity) throw fail(404, "ACTIVITY_NOT_FOUND", "No such activity");

  if (body._id) {
    const replayed = await StudentExploration.findOne({ _id: String(body._id), schoolId });
    if (replayed) return { exploration: replayed, replayed: true };
  }
  const open = await StudentExploration.findOne({
    schoolId, studentId: String(studentId), activityId: activity.activityId, deletedAt: null,
    status: { $in: ex.OPEN_STATUSES },
  });
  if (open) return { exploration: open, replayed: true };

  const now = new Date();
  const e = await StudentExploration.create({
    _id: body._id ? String(body._id) : undefined,
    schoolId, studentId: String(studentId), classId: classId ?? "",
    activityId: activity.activityId, activityVersion: activity.version, area: activity.area, level: activity.level,
    explorationEngineVersion: ex.EXPLORATION_ENGINE_VERSION,
    status: target,
    suggestedBecause: suggestion?.reasons ?? (Array.isArray(body.reasons) ? body.reasons.filter((r) => ex.REASONS.includes(r)) : []),
    relevance: suggestion?.relevance ?? (typeof body.relevance === "string" ? body.relevance : null),
    startedAt: target === "STARTED" ? now : null,
    closedAt: ["SKIPPED", "NOT_INTERESTED"].includes(target) ? now : null,
    transitions: [{ from: null, to: target, by: actor }],
  });
  if (target === "STARTED") await writeEvidence(e, activity, ex.evidenceForStart({ exploration: e, activity }));
  return { exploration: e, replayed: false };
};

const load = async ({ schoolId, explorationId }) => {
  const e = await StudentExploration.findOne({ _id: String(explorationId), schoolId, deletedAt: null });
  if (!e) throw fail(404, "EXPLORATION_NOT_FOUND", "No such exploration");
  return e;
};

const checkVersion = (e, version) => {
  if (version !== undefined && version !== null && Number(version) !== e.version) {
    throw fail(409, "VERSION_CONFLICT", "The exploration changed elsewhere.", { current: e.version });
  }
};

/** Idempotent transition: already there → no-op, same row back. */
const transitionTo = async (e, to, actor, version) => {
  if (e.status === to) return { exploration: e, changed: false };
  checkVersion(e, version);
  if (!ex.canTransition(e.status, to)) {
    throw fail(409, "INVALID_TRANSITION", `An exploration cannot move from ${e.status} to ${to}.`, { from: e.status, allowed: ex.TRANSITIONS[e.status] });
  }
  move(e, to, actor);
  return { exploration: e, changed: true };
};

const start = async ({ schoolId, explorationId, actor, version }) => {
  const e = await load({ schoolId, explorationId });
  const r = await transitionTo(e, "STARTED", actor, version);
  if (r.changed) {
    e.startedAt = e.startedAt ?? new Date();
    await e.save();
    const activity = await activityById({ schoolId, activityId: e.activityId });
    if (activity) await writeEvidence(e, activity, ex.evidenceForStart({ exploration: e, activity }));
  }
  return e;
};

const skip = async ({ schoolId, explorationId, actor, version, notInterested = false }) => {
  const e = await load({ schoolId, explorationId });
  const r = await transitionTo(e, notInterested ? "NOT_INTERESTED" : "SKIPPED", actor, version);
  if (r.changed) { e.closedAt = new Date(); await e.save(); }
  return e;
};

const abandon = async ({ schoolId, explorationId, actor, version }) => {
  const e = await load({ schoolId, explorationId });
  const r = await transitionTo(e, "ABANDONED", actor, version);
  if (r.changed) { e.closedAt = new Date(); await e.save(); }
  return e;
};

/**
 * The pupil submits: what they produced, how it went. Participation and
 * exposure rows are written; interest when the reflection says so. If the
 * activity's evidence includes a rated performance, the exploration waits in
 * REVIEW_REQUIRED for a teacher; otherwise it completes.
 */
const submit = async ({ schoolId, explorationId, actor, body }) => {
  const e = await load({ schoolId, explorationId });
  const activity = await activityById({ schoolId, activityId: e.activityId });
  if (!activity) throw fail(404, "ACTIVITY_NOT_FOUND", "The activity no longer exists");

  if (["SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"].includes(e.status)) {
    // Duplicate delivery of a submission: nothing to do twice.
    return e;
  }
  checkVersion(e, body.version);
  if (e.status !== "STARTED") {
    if (["DISCOVERED", "SAVED", "SKIPPED"].includes(e.status)) { move(e, "STARTED", actor); e.startedAt = e.startedAt ?? new Date(); }
    else throw fail(409, "INVALID_TRANSITION", `An exploration cannot be submitted from ${e.status}.`);
  }

  const outputs = Array.isArray(body.outputs)
    ? body.outputs.slice(0, 10).map((o) => ({ label: String(o.label ?? "").slice(0, 200), value: String(o.value ?? "").slice(0, 2000) })).filter((o) => o.value)
    : [];
  if (!outputs.length) throw fail(400, "OUTPUT_REQUIRED", "Say what you produced — at least one output.");
  const completionMode = body.completionMode && StudentExploration.COMPLETION_MODES.includes(body.completionMode) ? body.completionMode : null;

  const reflection = body.reflection && typeof body.reflection === "object" ? await upsertReflection({ schoolId, e, actor, body: body.reflection }) : null;

  e.outputs = outputs;
  e.completionMode = completionMode;
  e.submittedAt = new Date();
  move(e, "SUBMITTED", actor);
  if (needsReviewFor(activity)) move(e, "REVIEW_REQUIRED", actor);
  else { move(e, "COMPLETED", actor); e.completedAt = new Date(); }
  await e.save();

  await writeEvidence(e, activity, ex.evidenceForSubmission({ exploration: e, activity, reflection: reflection?.body ?? null }));
  return e;
};
// Completion must not wait on a teacher: a pupil who did the work alone is
// done when they submit, and a teacher may still rate the output afterwards.
// Only an activity done WITH a teacher (TEACHER_SUPPORT) waits in
// REVIEW_REQUIRED for that teacher's rating.
const needsReviewFor = (activity) => activity.resources.includes("TEACHER_SUPPORT") && activity.evidenceTypes.includes("performance");

// ─────────────────────────────────────────────────────────────────────────────
// REFLECTION, OBSERVATION, PERFORMANCE
// ─────────────────────────────────────────────────────────────────────────────

const validReflection = (body) => {
  const out = {};
  for (const k of ["interest", "difficulty", "continue"]) {
    const v = body[k] ?? null;
    if (v !== null && !ex.REFLECTION[k].includes(v)) throw fail(400, "INVALID_REFLECTION", `${k} must be one of ${ex.REFLECTION[k].join(", ")}`);
    out[k] = v;
  }
  for (const k of ["enjoyed", "difficult", "next"]) out[k] = body[k] ? String(body[k]).slice(0, 1000) : null;
  out.shareText = body.shareText === true;
  if (!out.interest && !out.difficulty && !out.continue && !out.enjoyed && !out.difficult && !out.next) {
    throw fail(400, "INVALID_REFLECTION", "A reflection needs at least one answer.");
  }
  return out;
};

/** One reflection per exploration, revised in place with the earlier account kept. */
const upsertReflection = async ({ schoolId, e, actor, body }) => {
  const next = validReflection(body);
  let r = await ExplorationReflection.findOne({ schoolId, explorationId: e._id, deletedAt: null });
  if (!r) {
    r = await ExplorationReflection.create({ _id: body._id ? String(body._id) : undefined, schoolId, studentId: e.studentId, classId: e.classId, explorationId: e._id, body: next, authoredBy: actor });
    return r;
  }
  if (JSON.stringify(r.body.toObject ? r.body.toObject() : r.body) === JSON.stringify(next)) return r;
  r.revisions.push({ body: r.body.toObject ? r.body.toObject() : r.body, replacedAt: new Date() });
  r.body = next;
  r.version += 1;
  await r.save();
  return r;
};

const reflect = async ({ schoolId, explorationId, actor, body }) => {
  const e = await load({ schoolId, explorationId });
  if (String(e.studentId) !== String(body.studentId ?? e.studentId)) throw fail(403, "NOT_OWNER", "A reflection is the student's own.");
  return upsertReflection({ schoolId, e, actor, body });
};

/** A teacher's observation of the activity; one per observer, revised in place. */
const observe = async ({ schoolId, explorationId, actor, body }) => {
  const e = await load({ schoolId, explorationId });
  const level = String(body.level ?? "");
  if (!ex.OBSERVATION_LEVELS.includes(level)) throw fail(400, "INVALID_OBSERVATION", `level must be one of ${ex.OBSERVATION_LEVELS.join(", ")}`);
  const codes = Array.isArray(body.codes) ? body.codes.map(String) : [];
  if (codes.some((c) => !ex.OBSERVATION_CODES.includes(c))) throw fail(400, "INVALID_OBSERVATION", `codes must be among ${ex.OBSERVATION_CODES.join(", ")}`);
  const note = body.note ? String(body.note).slice(0, 1000) : null;

  let o = await ExplorationObservation.findOne({ schoolId, explorationId: e._id, observedBy: actor, deletedAt: null });
  if (!o) {
    o = await ExplorationObservation.create({ _id: body._id ? String(body._id) : undefined, schoolId, studentId: e.studentId, classId: e.classId, explorationId: e._id, level, codes, note, observedBy: actor });
  } else if (o.level !== level || JSON.stringify(o.codes) !== JSON.stringify(codes) || o.note !== note) {
    o.revisions.push({ level: o.level, codes: o.codes, note: o.note, replacedAt: new Date() });
    o.level = level; o.codes = codes; o.note = note; o.version += 1;
    await o.save();
  }
  const activity = await activityById({ schoolId, activityId: e.activityId });
  if (activity) await writeEvidence(e, activity, ex.evidenceForObservation({ exploration: e, activity, observation: { observedBy: actor, observedAt: o.observedAt, level, codes } }));
  return o;
};

/** A teacher rates the output against the activity's own criteria; the exploration completes. */
const ratePerformance = async ({ schoolId, explorationId, actor, body }) => {
  const e = await load({ schoolId, explorationId });
  const activity = await activityById({ schoolId, activityId: e.activityId });
  if (!activity) throw fail(404, "ACTIVITY_NOT_FOUND", "The activity no longer exists");
  if (!activity.evidenceTypes.includes("performance")) throw fail(409, "NO_PERFORMANCE_CRITERIA", "This activity has no rated output.");
  if (!["SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"].includes(e.status)) throw fail(409, "NOT_SUBMITTED", "Rate a submitted exploration.");
  const ratings = Array.isArray(body.ratings) ? body.ratings : [];
  if (!ratings.length) throw fail(400, "INVALID_PERFORMANCE", "At least one criterion must be rated.");
  for (const r of ratings) {
    if (!activity.performanceCriteria.includes(r.criterion)) throw fail(400, "INVALID_PERFORMANCE", `${r.criterion} is not a criterion of this activity`);
    if (!ex.PERFORMANCE_RATINGS.includes(r.rating)) throw fail(400, "INVALID_PERFORMANCE", `rating must be one of ${ex.PERFORMANCE_RATINGS.join(", ")}`);
  }
  checkVersion(e, body.version);
  const clean = ratings.map((r) => ({ criterion: r.criterion, rating: r.rating }));
  e.performance = { ratings: clean, level: ex.performanceLevel(clean), note: body.note ? String(body.note).slice(0, 1000) : null, ratedBy: actor, ratedAt: new Date() };
  if (e.status !== "COMPLETED") { move(e, "COMPLETED", actor); e.completedAt = new Date(); } else e.version += 1;
  await e.save();
  await writeEvidence(e, activity, ex.evidenceForPerformance({ exploration: e, activity, performance: { ratings: clean, ratedBy: actor, ratedAt: e.performance.ratedAt } }));
  return e;
};

// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────

/** Upsert by derived id: a resend lands on the same row. Records the ids on the exploration. */
const writeEvidence = async (e, activity, rows) => {
  for (const row of rows) {
    await ExplorationEvidence.updateOne(
      { _id: row._id },
      { $setOnInsert: { ...row, recordedBy: row.recordedBy ?? "system" } },
      { upsert: true }
    );
    if (!e.generatedEvidenceIds.includes(row._id)) e.generatedEvidenceIds.push(row._id);
  }
  await StudentExploration.updateOne({ _id: e._id }, { $addToSet: { generatedEvidenceIds: { $each: rows.map((r) => r._id) } } });
};

/** The rows an exploration produced, by kind, never one derived from another. */
const evidenceFor = ({ schoolId, studentId }) =>
  ExplorationEvidence.find({ schoolId, studentId: String(studentId), deletedAt: null, explorationId: { $ne: null } }).sort({ date: 1 }).lean();

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL AGGREGATE
// ─────────────────────────────────────────────────────────────────────────────

/** Counts for the office: areas explored, completion, skips, declines, evidence volume. No pupil, no reflection. */
const summary = async ({ schoolId, classIds = null }) => {
  const filter = { schoolId, deletedAt: null, ...(classIds ? { classId: { $in: classIds } } : {}) };
  const rows = await StudentExploration.find(filter).select("studentId area activityId status").lean();
  const byArea = {};
  for (const r of rows) {
    const b = byArea[r.area] ?? { students: new Set(), started: 0, completed: 0, skipped: 0, notInterested: 0, abandoned: 0 };
    b.students.add(r.studentId);
    if (["STARTED", "SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"].includes(r.status)) b.started += 1;
    if (r.status === "COMPLETED") b.completed += 1;
    if (r.status === "SKIPPED") b.skipped += 1;
    if (r.status === "NOT_INTERESTED") b.notInterested += 1;
    if (r.status === "ABANDONED") b.abandoned += 1;
    byArea[r.area] = b;
  }
  const byActivity = {};
  for (const r of rows) {
    const b = byActivity[r.activityId] ?? { started: 0, completed: 0, skipped: 0, notInterested: 0 };
    if (["STARTED", "SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"].includes(r.status)) b.started += 1;
    if (r.status === "COMPLETED") b.completed += 1;
    if (r.status === "SKIPPED") b.skipped += 1;
    if (r.status === "NOT_INTERESTED") b.notInterested += 1;
    byActivity[r.activityId] = b;
  }
  const evidence = await ExplorationEvidence.countDocuments({ schoolId, deletedAt: null, explorationId: { $ne: null }, ...(classIds ? { classId: { $in: classIds } } : {}) });
  const top = (key) => Object.entries(byActivity).filter(([, v]) => v[key] > 0).sort((a, b) => b[1][key] - a[1][key] || a[0].localeCompare(b[0])).slice(0, 5).map(([id, v]) => ({ activityId: id, count: v[key] }));
  return {
    explorationEngineVersion: ex.EXPLORATION_ENGINE_VERSION,
    students: new Set(rows.map((r) => r.studentId)).size,
    explorations: rows.length,
    byArea: Object.fromEntries(Object.entries(byArea).sort().map(([k, v]) => [k, { ...v, students: v.students.size }])),
    frequentlySkipped: top("skipped"),
    frequentlyDeclined: top("notInterested"),
    frequentlyCompleted: top("completed"),
    evidenceRows: evidence,
  };
};

module.exports = {
  catalog, activityById, recommended, history, reflectionFor,
  choose, start, skip, abandon, submit, reflect, observe, ratePerformance,
  evidenceFor, summary,
};
