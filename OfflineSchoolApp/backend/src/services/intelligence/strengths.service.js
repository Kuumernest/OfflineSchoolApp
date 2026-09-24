// backend/src/services/intelligence/strengths.service.js
"use strict";

/**
 * The strengths layer, loaded and served.
 *
 * ── What this file does ───────────────────────────────────────────────────
 *
 * Fetches the two inputs the pure layer needs — the academic profile from
 * subjectInsights.service (one engine, one loader) and the pupil's
 * exploration-evidence rows — and hands them to shared/strengths. Records
 * snapshots for the longitudinal view and evidence rows for the exploration
 * loop. Joins nothing about identity: the router does that after
 * authorisation, as for every intelligence surface.
 *
 * ── Live and offline ──────────────────────────────────────────────────────
 *
 * offlineProfileFor builds the same profile from the exporter's mapping
 * (cohortFromDocuments → toEngineInput → runEngine) instead of the live
 * loader, with the same evidence rows on both sides, so the consistency
 * checker can diff the two roads to the academic profile and the strength
 * profile on top of it. Nothing is normalised on the way.
 */

const path = require("path");
const crypto = require("crypto");
const ExplorationEvidence      = require("../../db/models/ExplorationEvidence");
const StrengthProfileSnapshot  = require("../../db/models/StrengthProfileSnapshot");
const subjectInsights          = require("./subjectInsights.service");
const reviewCases              = require("./reviewCases.service");
const strengths                = require("../../../../shared/strengths");

const CAL = path.join(__dirname, "..", "..", "..", "scripts", "calibration");

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

/**
 * The row as the pure layer reads it: kind, domain, who, when, which
 * exploration, and the rated outcome — no notes, no name. The exploration id
 * is what lets fusion count one activity's several rows as one event.
 */
const evidenceForEngine = (rows) => rows.map((e) => ({
  _id: String(e._id), kind: e.kind, source: e.source, dimension: e.dimension ?? null, area: e.area ?? null, activity: e.activity,
  date: e.date, participation: e.participation ?? null, reflection: e.reflection ?? null, recordedBy: String(e.recordedBy),
  explorationId: e.explorationId ?? null, activityId: e.activityId ?? null, activityVersion: e.activityVersion ?? null, outcome: e.outcome ?? null,
}));

/** The recency clock: the start of today (UTC), the same on every road in one request. */
const startOfToday = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

const evidenceRows = ({ schoolId, studentId }) =>
  ExplorationEvidence.find({ schoolId, studentId: String(studentId), deletedAt: null }).sort({ date: 1, createdAt: 1 }).lean();

/** The live strengths profile for one pupil, or null when the pupil has no academic profile. */
const profileFor = async ({ schoolId, studentId, asOf = null }) => {
  const [academicProfile, rows] = await Promise.all([
    subjectInsights.profileFor({ schoolId, studentId: String(studentId) }),
    evidenceRows({ schoolId, studentId }),
  ]);
  if (!academicProfile) return null;
  return strengths.buildStrengthProfile({ academicProfile, explorationEvidence: evidenceForEngine(rows), asOf: asOf ?? startOfToday() });
};

/** The same profile through the offline road to the academic engine. */
const offlineProfileFor = async ({ schoolId, studentId, asOf = null }) => {
  const { runEngine } = require(path.join(CAL, "analyseCohort"));
  const id = String(studentId);
  const [{ cohort }, rows] = await Promise.all([
    reviewCases.liveCohort({ schoolId, classIds: null, studentIds: [id] }),
    evidenceRows({ schoolId, studentId: id }),
  ]);
  const run = runEngine(cohort);
  const academicProfile = run.profiles.get(id);
  if (!academicProfile) return null;
  return strengths.buildStrengthProfile({ academicProfile, explorationEvidence: evidenceForEngine(rows), asOf: asOf ?? startOfToday() });
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPLORATION EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────

/** Which kinds each source may record. Interest and reflection are the pupil's to give. */
const KINDS_BY_SOURCE = Object.freeze({
  student: ["interest", "student_reflection"],
  teacher: ["exposure", "performance", "teacher_observation"],
  office:  ["exposure", "performance", "teacher_observation"],
});

const recordEvidence = async ({ schoolId, studentId, classId, source, actor, body }) => {
  const kind = String(body.kind ?? "");
  if (!(KINDS_BY_SOURCE[source] ?? []).includes(kind)) {
    throw fail(400, "INVALID_EVIDENCE", `${source} may record ${(KINDS_BY_SOURCE[source] ?? []).join(", ")}; not ${kind || "(none)"}`);
  }
  const dimension = body.dimension ? String(body.dimension) : null;
  if (dimension && !strengths.DIMENSIONS.includes(dimension)) throw fail(400, "INVALID_EVIDENCE", `unknown dimension ${dimension}`);
  const area = body.area ? String(body.area) : null;
  if (area && !strengths.EXPLORATION_AREAS.some((a) => a.code === area)) throw fail(400, "INVALID_EVIDENCE", `unknown area ${area}`);
  if (!dimension && !area) throw fail(400, "INVALID_EVIDENCE", "a dimension or an area is required");
  const activity = String(body.activity ?? "").trim();
  if (!activity || activity.length > 200) throw fail(400, "INVALID_EVIDENCE", "activity is required");
  const date = body.date ? new Date(body.date) : null;
  if (!date || Number.isNaN(date.getTime())) throw fail(400, "INVALID_EVIDENCE", "date is required");
  const participation = body.participation ? String(body.participation) : null;
  if (participation && !ExplorationEvidence.PARTICIPATION.includes(participation)) throw fail(400, "INVALID_EVIDENCE", `unknown participation ${participation}`);
  const reflection = body.reflection ? String(body.reflection) : null;
  if (reflection && !ExplorationEvidence.REFLECTIONS.includes(reflection)) throw fail(400, "INVALID_EVIDENCE", `unknown reflection ${reflection}`);
  if (kind === "student_reflection" && !reflection) throw fail(400, "INVALID_EVIDENCE", "a reflection code is required");

  return ExplorationEvidence.create({
    _id: body._id ? String(body._id) : undefined,
    schoolId, studentId: String(studentId), classId: classId ?? "",
    kind, source, dimension, area, activity, date, participation, reflection,
    outcome: body.outcome ? String(body.outcome).slice(0, 500) : null,
    notes:   body.notes ? String(body.notes).slice(0, 2000) : null,
    recordedBy: actor,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOTS
// ─────────────────────────────────────────────────────────────────────────────

/** What a snapshot keeps of a profile: the reading, not the mark series. */
const readingOf = (p) => ({
  confidence: p.confidence, evidenceCoverage: p.evidenceCoverage, limitations: p.limitations,
  strengths: p.strengths.map(({ evidence, ...d }) => ({ ...d, evidenceCount: evidence.length })),
  emergingAreas: p.emergingAreas.map(({ evidence, ...d }) => ({ ...d, evidenceCount: evidence.length })),
  decliningAreas: p.decliningAreas.map(({ evidence, ...d }) => ({ ...d, evidenceCount: evidence.length })),
  singleSubjectStrengths: p.singleSubjectStrengths,
  explorationAreas: p.explorationAreas,
  interestSignals: p.interestSignals.length,
  notInferred: p.notInferred,
  fusion: p.fusion ? { asOf: p.fusion.asOf, coverage: p.fusion.coverage, contradictions: p.fusion.contradictions, timeline: p.fusion.timeline, evidenceIds: p.fusion.evidence.map((e) => e.evidenceId) } : null,
});

/** What the reading was made from, hashed, so an unchanged boundary is recognised. */
const boundaryOf = (profile) => {
  const ids = (profile.fusion?.evidence ?? []).map((e) => e.evidenceId).sort();
  const academicTo = profile.evidenceCoverage?.to ?? null;
  const hash = crypto.createHash("sha1").update(JSON.stringify({ ids, academicTo, seq: profile.evidenceCoverage?.sequences ?? 0,
    v: [profile.academicEngineVersion, profile.strengthEngineVersion] })).digest("hex");
  const dates = (profile.fusion?.evidence ?? []).map((e) => e.timestamp).filter(Boolean).sort();
  return { evidenceRows: ids.length, latestEvidenceAt: dates.length ? new Date(dates[dates.length - 1]) : null, academicTo, hash };
};

const latestSnapshot = ({ schoolId, studentId }) =>
  StrengthProfileSnapshot.findOne({ schoolId, studentId: String(studentId), deletedAt: null }).sort({ profileVersion: -1 }).lean();

/**
 * Keep today's reading. Idempotent on the evidence boundary: when the latest
 * snapshot was made from exactly these rows under these engine versions, it is
 * returned and nothing new is written. Engine versions are the server's; a
 * caller cannot supply them. Old snapshots are never touched.
 */
const snapshot = async ({ schoolId, studentId, classId, actor, periodLabel = null, force = false }) => {
  const profile = await profileFor({ schoolId, studentId });
  if (!profile) throw fail(404, "NO_PROFILE", "The pupil has no academic profile to snapshot.");
  const boundary = boundaryOf(profile);
  const last = await latestSnapshot({ schoolId, studentId });
  if (!force && last?.evidenceBoundary?.hash === boundary.hash && last.strengthEngineVersion === profile.strengthEngineVersion) {
    return { snapshot: last, created: false };
  }
  const { EXPLORATION_ENGINE_VERSION } = require("../../../../shared/exploration");
  const created = await StrengthProfileSnapshot.create({
    schoolId, studentId: String(studentId), classId: classId ?? null,
    profileVersion: (last?.profileVersion ?? 0) + 1,
    academicEngineVersion: profile.academicEngineVersion,
    strengthEngineVersion: profile.strengthEngineVersion,
    explorationEngineVersion: EXPLORATION_ENGINE_VERSION,
    asOf: new Date(profile.fusion.asOf),
    evidenceBoundary: boundary,
    sourcePeriod: { from: profile.evidenceCoverage.from, to: profile.evidenceCoverage.to, sequences: profile.evidenceCoverage.sequences },
    periodLabel: periodLabel ? String(periodLabel).slice(0, 60) : null,
    generatedAt: new Date(),
    recordedBy: actor,
    profile: readingOf(profile),
  });
  return { snapshot: created, created: true };
};

/** What changed since the last snapshot: structured, with the new evidence since it. */
const changesSince = async ({ schoolId, studentId }) => {
  const [profile, last, rows] = await Promise.all([
    profileFor({ schoolId, studentId }), latestSnapshot({ schoolId, studentId }), evidenceRows({ schoolId, studentId }),
  ]);
  if (!profile) return null;
  const since = last?.generatedAt ?? null;
  const newRows = rows.filter((r) => !since || new Date(r.createdAt ?? r.date) > since);
  const byKind = newRows.reduce((o, r) => { o[r.kind] = (o[r.kind] ?? 0) + 1; return o; }, {});
  return {
    previous: last ? { snapshotId: String(last._id), profileVersion: last.profileVersion, generatedAt: last.generatedAt, strengthEngineVersion: last.strengthEngineVersion } : null,
    current: { strengthEngineVersion: profile.strengthEngineVersion, academicEngineVersion: profile.academicEngineVersion, asOf: profile.fusion.asOf },
    newEvidence: { rows: newRows.length, byKind, explorations: new Set(newRows.map((r) => r.explorationId).filter(Boolean)).size },
    comparison: strengths.compareProfiles(last?.profile ?? null, profile),
    pendingSnapshot: !last || last.evidenceBoundary?.hash !== boundaryOf(profile).hash || last.strengthEngineVersion !== profile.strengthEngineVersion,
  };
};

const history = ({ schoolId, studentId }) =>
  StrengthProfileSnapshot.find({ schoolId, studentId: String(studentId), deletedAt: null }).sort({ profileVersion: 1 }).lean();

// ─────────────────────────────────────────────────────────────────────────────
// TEACHER CONFIRMATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The "case" a strength review is of: a dimension the current profile names
 * as established or emerging, or a single-subject strength. Verified on
 * submission exactly as an academic review case is; the stored
 * classifications are the server's reading, never the request's.
 */
const strengthReviewCase = async ({ schoolId, studentId, code }) => {
  const p = await profileFor({ schoolId, studentId });
  if (!p) return null;
  const dim = [...p.strengths, ...p.emergingAreas].find((d) => d.dimension === code);
  if (dim) return { classifications: [{ code: dim.dimension, confidence: dim.confidence }], state: dim.state };
  const single = p.singleSubjectStrengths.find((s) => s.subjectId === code);
  if (single) return { classifications: [{ code: `subject:${single.subjectId}`, confidence: single.state === "ESTABLISHED" ? "strong" : "emerging" }], state: single.state };
  return null;
};

/** The parent's view: plain, no engine detail, no teacher's words. */
const forGuardian = (p) => (p ? {
  strengths: p.strengths.map((d) => ({ dimension: d.dimension, persistence: d.persistence, supportingSubjects: d.supportingSubjects.map((s) => s.subjectName ?? s.subjectId) })),
  emergingAreas: p.emergingAreas.map((d) => ({ dimension: d.dimension, persistence: d.persistence, supportingSubjects: d.supportingSubjects.map((s) => s.subjectName ?? s.subjectId) })),
  explorationAreas: p.explorationAreas.map((a) => ({ area: a.area, evidenceLevel: a.evidenceLevel, waysToExplore: a.waysToExplore })),
  limitations: p.limitations,
  confidence: p.confidence,
  notInferred: p.notInferred,
  versions: { academic: p.academicEngineVersion, strengths: p.strengthEngineVersion },
} : null);

module.exports = {
  profileFor,
  offlineProfileFor,
  startOfToday,
  boundaryOf,
  latestSnapshot,
  changesSince,
  evidenceRows,
  recordEvidence,
  KINDS_BY_SOURCE,
  snapshot,
  history,
  readingOf,
  strengthReviewCase,
  forGuardian,
};
