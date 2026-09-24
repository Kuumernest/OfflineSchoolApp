// backend/src/services/intelligence/developmentInterventions.service.js
"use strict";

/**
 * Development interventions: proposed from evidence, owned by a person,
 * run through a closed lifecycle, reviewed against observed change.
 *
 * ── Where they live ───────────────────────────────────────────────────────
 *
 * In the existing Intervention collection — the school's record of what it
 * did for a pupil — under sourceType "development_guidance", with the Stage
 * 15 contract in a `development` sub-document. The legacy `status` is derived
 * from the lifecycle so every older reader (the class page, the sync feed,
 * the outcome page) keeps working. No second collection, no second truth.
 *
 * ── What the system does and does not do ─────────────────────────────────
 *
 * It proposes only from a trigger the current development history supports;
 * it refuses a proposal the evidence does not carry. It never activates,
 * escalates, alerts or refers: a person accepts, activates, pauses, reviews,
 * completes. It reports REVIEW_DUE as a fact about a date. The outcome it
 * interprets is observed change after the period, never a cause.
 */

const Intervention = require("../../db/models/Intervention");
const developmentSvc = require("./development.service");
const guidanceSvc = require("./developmentGuidance.service");
const strengthsSvc = require("./strengths.service");
const outcomeSvc = require("./interventionOutcome.service");
const iv = require("../../../../shared/interventions");

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const SOURCE = "development_guidance";

const actorRoleOf = (role) => ({ student: "STUDENT", teacher: "TEACHER", school_admin: "SCHOOL_ADMIN", super_admin: "SCHOOL_ADMIN" })[role] ?? null;

const listFor = ({ schoolId, studentId }) =>
  Intervention.find({ schoolId, studentId: String(studentId), sourceType: SOURCE, deletedAt: null }).sort({ createdAt: 1 }).lean();

const oneFor = ({ schoolId, studentId, interventionId }) =>
  Intervention.findOne({ _id: String(interventionId), schoolId, studentId: String(studentId), sourceType: SOURCE, deletedAt: null }).lean();

/** The triggers the history supports today, with a preview of the proposal each would make. Nothing is written. */
const proposalsFor = async ({ schoolId, studentId, asOf = null }) => {
  const at = asOf ?? strengthsSvc.startOfToday();
  const [history, guidance] = await Promise.all([developmentSvc.historyFor({ schoolId, studentId, asOf: at }), guidanceSvc.guidanceFor({ schoolId, studentId, asOf: at })]);
  const triggers = history ? iv.triggersFor({ development: history, guidance }) : [];
  return {
    asOf: at.toISOString(), interventionEngineVersion: iv.INTERVENTION_ENGINE_VERSION, triggers,
    previews: triggers.map((t) => iv.buildIntervention({ trigger: t.trigger, dimension: t.dimension, triggerEvidence: t.evidence, startDate: at, engineVersions: { development: history?.developmentEngineVersion ?? null, guidance: guidance?.guidanceEngineVersion ?? null } })),
  };
};

const legacyEntry = (from, to, by) => ({ from, to, by, at: new Date() });

/**
 * Propose. Refuses a trigger the current history does not support for that
 * dimension. Idempotent on a client-minted _id: a replay returns the row.
 */
const propose = async ({ schoolId, studentId, classId, actor, actorRole, body, asOf = null }) => {
  const role = actorRoleOf(actorRole);
  if (!role) throw fail(403, "ROLE_NOT_ALLOWED", "This role may not propose an intervention.");
  const requestedId = body?._id ? String(body._id) : null;
  if (requestedId) { const existing = await Intervention.findOne({ _id: requestedId, schoolId }).lean(); if (existing) return { intervention: existing, created: false }; }
  if (!classId) throw fail(400, "NO_CLASS", "The pupil has no class to record the intervention under.");
  const { triggers } = await proposalsFor({ schoolId, studentId, asOf });
  const trig = triggers.find((t) => t.trigger === body?.trigger && t.dimension === body?.dimension);
  if (!trig) throw fail(409, "TRIGGER_NOT_SUPPORTED", "The current development history does not support that trigger for that dimension.", { supported: triggers.map((t) => `${t.dimension}:${t.trigger}`) });
  let proposal;
  try {
    proposal = iv.buildIntervention({ trigger: trig.trigger, dimension: trig.dimension, triggerEvidence: trig.evidence, guidanceId: body?.guidanceId ?? null, action: body?.action ?? null,
      ownerRole: body?.ownerRole ?? null, durationDays: body?.durationDays ?? null, startDate: body?.startDate ?? (asOf ?? strengthsSvc.startOfToday()),
      engineVersions: { development: "1.0.0", guidance: "1.0.0" } });
  } catch (e) { throw fail(400, e.code ?? "INVALID_INTERVENTION", e.message); }
  if (role === "STUDENT" && proposal.ownerRole !== "STUDENT") throw fail(403, "ROLE_NOT_ALLOWED", "A pupil may propose only an intervention they own themselves.");
  const doc = await Intervention.create({
    _id: requestedId ?? undefined, schoolId, studentId: String(studentId), classId: String(classId), createdBy: actor, updatedBy: actor,
    sourceType: SOURCE, sourceCode: `${proposal.trigger}`, actionCode: proposal.action, subjectId: body?.subjectId ?? null, notes: role === "STUDENT" ? null : (body?.notes ?? null),
    status: iv.LEGACY_STATUS.PROPOSED,
    development: { ...proposal, proposedBy: actor, proposedByRole: role, lifecycleHistory: [{ from: null, to: "PROPOSED", action: "propose", by: actor, role, at: new Date(), note: null }], reviews: [] },
  });
  return { intervention: doc.toObject(), created: true };
};

/** One lifecycle move by one actor. Idempotent: a replayed move that already happened changes nothing. */
const act = async ({ schoolId, studentId, interventionId, action, actor, actorRole, note = null }) => {
  const role = actorRoleOf(actorRole);
  if (!role) throw fail(403, "ROLE_NOT_ALLOWED", "This role may not act on an intervention.");
  const doc = await Intervention.findOne({ _id: String(interventionId), schoolId, studentId: String(studentId), sourceType: SOURCE, deletedAt: null });
  if (!doc) throw fail(404, "NOT_FOUND", "Intervention not found.");
  let next;
  try { next = iv.transition({ lifecycle: doc.development.lifecycle, action, actorRole: role }); }
  catch (e) { throw fail(e.code === "ROLE_NOT_ALLOWED" ? 403 : 409, e.code, e.message); }
  if (!next.changed) return { intervention: doc.toObject(), changed: false };
  const from = doc.development.lifecycle, to = next.lifecycle;
  const legacyFrom = doc.status, legacyTo = iv.LEGACY_STATUS[to];
  doc.development.lifecycle = to;
  doc.development.lifecycleHistory.push({ from, to, action, by: actor, role, at: new Date(), note: role === "STUDENT" ? null : note });
  if (action === "accept") { doc.development.acceptedBy = actor; doc.development.acceptedAt = new Date(); }
  if (action === "activate") doc.startedAt = doc.startedAt ?? new Date();
  if (action === "complete") doc.completedAt = new Date();
  if (action === "cancel" || action === "decline") doc.cancelledAt = new Date();
  if (legacyFrom !== legacyTo) { doc.status = legacyTo; doc.statusHistory.push(legacyEntry(legacyFrom, legacyTo, actor)); }
  doc.updatedBy = actor; doc.version = (doc.version ?? 1) + 1;
  await doc.save();
  return { intervention: doc.toObject(), changed: true };
};

/**
 * The observed outcome after the period: the existing academic before/after
 * (when a subject is named) beside the development reading before and after
 * the start date, both on one asOf.
 */
const outcomeFor = async (doc, { asOf = null } = {}) => {
  const at = asOf ?? strengthsSvc.startOfToday();
  const [academic, history] = await Promise.all([doc.subjectId ? outcomeSvc.compare(doc) : Promise.resolve(null), developmentSvc.historyFor({ schoolId: doc.schoolId, studentId: doc.studentId, asOf: at })]);
  const t = (history?.trajectories ?? []).find((x) => x.dimensionId === doc.development?.dimension) ?? null;
  const start = new Date(doc.development?.startDate).toISOString();
  const before = [...(t?.observations ?? [])].filter((o) => o.observedAt < start).pop() ?? null;
  const after = [...(t?.observations ?? [])].filter((o) => o.observedAt >= start && (!before || o.boundaryHash !== before.boundaryHash)).pop() ?? null;
  return { asOf: at.toISOString(), reviewDue: iv.reviewDue({ lifecycle: doc.development?.lifecycle, reviewDate: doc.development?.reviewDate, asOf: at }), ...iv.interpretOutcome({ academicOutcome: academic, developmentBefore: before, developmentAfter: after }) };
};

/** A review: the outcome interpreted on that day is recorded with the reviewer's note; the intervention continues or completes. */
const review = async ({ schoolId, studentId, interventionId, actor, actorRole, note = null, complete = false, asOf = null }) => {
  const doc = await Intervention.findOne({ _id: String(interventionId), schoolId, studentId: String(studentId), sourceType: SOURCE, deletedAt: null });
  if (!doc) throw fail(404, "NOT_FOUND", "Intervention not found.");
  const outcome = await outcomeFor(doc.toObject(), { asOf });
  const moved = await act({ schoolId, studentId, interventionId, action: complete ? "complete" : "review", actor, actorRole, note });
  const fresh = await Intervention.findOne({ _id: String(interventionId), schoolId });
  fresh.development.reviews.push({ at: new Date(), by: actor, note, outcome: { outcome: outcome.outcome, academic: outcome.academic, development: outcome.development, asOf: outcome.asOf } });
  if (complete) fresh.outcomeCode = { IMPROVED: "improved", STABLE: "no_change", DECLINED: "further_support", MIXED: "further_support", INSUFFICIENT_EVIDENCE: "not_assessed" }[outcome.outcome];
  fresh.updatedBy = actor;
  await fresh.save();
  return { intervention: fresh.toObject(), outcome, changed: moved.changed };
};

/** Shapes for readers. Staff see notes; a pupil or a parent never sees a staff note or a reviewer's identity. */
const view = (doc, { outcome = null, staff = false } = {}) => ({
  interventionId: String(doc._id), studentId: doc.studentId, classId: doc.classId, subjectId: doc.subjectId ?? null,
  dimension: doc.development?.dimension ?? null, trigger: doc.development?.trigger ?? null, triggerEvidence: staff ? doc.development?.triggerEvidence ?? null : undefined,
  guidanceId: doc.development?.guidanceId ?? null, objective: doc.development?.objective ?? null, action: doc.development?.action ?? doc.actionCode, ownerRole: doc.development?.ownerRole ?? null,
  startDate: doc.development?.startDate ?? null, durationDays: doc.development?.durationDays ?? null, reviewDate: doc.development?.reviewDate ?? null, evidenceToCollect: doc.development?.evidenceToCollect ?? [],
  lifecycle: doc.development?.lifecycle ?? null, legacyStatus: doc.status,
  lifecycleHistory: (doc.development?.lifecycleHistory ?? []).map((h) => ({ from: h.from, to: h.to, action: h.action, role: h.role, at: h.at, ...(staff ? { by: h.by, note: h.note } : {}) })),
  reviews: (doc.development?.reviews ?? []).map((r) => ({ at: r.at, outcome: r.outcome, ...(staff ? { by: r.by, note: r.note } : {}) })),
  proposedByRole: doc.development?.proposedByRole ?? null, acceptedAt: doc.development?.acceptedAt ?? null,
  ...(staff ? { notes: doc.notes ?? null, createdBy: doc.createdBy, assignedTo: doc.assignedTo ?? null } : {}),
  engineVersions: doc.development?.engineVersions ?? null, outcome, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
});

const AGREED = ["ACCEPTED", "ACTIVE", "REVIEW_DUE", "PAUSED", "COMPLETED"];
/** The parent's view: agreed support only, and progress since it began. */
const forGuardian = (docs, outcomes) => docs.filter((d) => AGREED.includes(d.development?.lifecycle)).map((d) => ({
  dimension: d.development.dimension, objective: d.development.objective, action: d.development.action, ownerRole: d.development.ownerRole, lifecycle: d.development.lifecycle,
  startDate: d.development.startDate, reviewDate: d.development.reviewDate, evidenceToCollect: d.development.evidenceToCollect,
  progress: outcomes.get(String(d._id)) ? { outcome: outcomes.get(String(d._id)).outcome, statement: outcomes.get(String(d._id)).statement } : null,
}));

module.exports = { SOURCE, actorRoleOf, listFor, oneFor, proposalsFor, propose, act, review, outcomeFor, view, forGuardian };
