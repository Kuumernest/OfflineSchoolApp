// backend/src/services/intelligence/developmentPlans.service.js
"use strict";

/**
 * Development plans, loaded and served.
 *
 * Creates a plan only from a guidance item the current guidance carries
 * (never from one mark, one activity or one observation), refuses a
 * duplicate open plan for the same objective, runs the closed lifecycle and
 * the milestone machine through the pure engines, records the pupil's
 * reflections and documented constraints, and at a review sets the
 * adaptive engine's reading beside the teacher's decision. Every read can
 * be asked as of a date: the plan is reconstructed from its append-only
 * histories and the development history is built for the same day.
 */

const DevelopmentPlan = require("../../db/models/DevelopmentPlan");
const developmentSvc = require("./development.service");
const guidanceSvc = require("./developmentGuidance.service");
const interventionsSvc = require("./developmentInterventions.service");
const strengthsSvc = require("./strengths.service");
const dp = require("../../../../shared/developmentPlanning");
const asup = require("../../../../shared/adaptiveSupport");

const fail = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const actorRoleOf = interventionsSvc.actorRoleOf;
const STAFF = ["TEACHER", "SCHOOL_ADMIN"];

const engineVersions = () => ({ planning: dp.DEVELOPMENT_PLANNING_ENGINE_VERSION, adaptive: asup.ADAPTIVE_SUPPORT_ENGINE_VERSION, development: "1.0.0", guidance: "1.0.0", intervention: "1.0.0" });

const listFor = ({ schoolId, studentId }) => DevelopmentPlan.find({ schoolId, studentId: String(studentId), deletedAt: null }).sort({ createdAt: 1 }).lean();
const oneFor = ({ schoolId, studentId, planId }) => DevelopmentPlan.findOne({ _id: String(planId), schoolId, studentId: String(studentId), deletedAt: null }).lean();
const load = ({ schoolId, studentId, planId }) => DevelopmentPlan.findOne({ _id: String(planId), schoolId, studentId: String(studentId), deletedAt: null });

/** The plan as it stood on asOf; null means now — the whole append-only record. */
const asOfPlan = (doc, asOf = null) => dp.reconstruct(JSON.parse(JSON.stringify(doc)), asOf ?? null);

/**
 * Create, from a guidance item the current guidance carries. Idempotent on
 * a client-minted _id. A student may create only a plan they own themselves.
 */
const create = async ({ schoolId, studentId, classId, actor, actorRole, body, asOf = null }) => {
  const role = actorRoleOf(actorRole);
  if (!role) throw fail(403, "ROLE_NOT_ALLOWED", "This role may not create a plan.");
  const requestedId = body?._id ? String(body._id) : null;
  if (requestedId) { const existing = await DevelopmentPlan.findOne({ _id: requestedId, schoolId }).lean(); if (existing) return { plan: existing, created: false }; }
  const at = asOf ?? strengthsSvc.startOfToday();
  const [g, profile, plans] = await Promise.all([guidanceSvc.guidanceFor({ schoolId, studentId, asOf: at }), strengthsSvc.profileFor({ schoolId, studentId, asOf: at }), listFor({ schoolId, studentId })]);
  const item = (g?.items ?? []).find((i) => i.id === body?.guidanceId) ?? null;
  if (!item) throw fail(409, "GUIDANCE_NOT_CURRENT", "The current guidance does not carry that item.", { available: (g?.items ?? []).map((i) => i.id) });
  const el = dp.eligibility({ guidanceItem: item });
  if (!el.eligible) throw fail(409, "PLAN_NOT_ELIGIBLE", `Guidance does not open a plan: ${el.reason}`, { reason: el.reason });
  const objectiveCategory = body?.objectiveCategory ?? el.objectiveCategory;
  let built;
  try {
    built = dp.buildPlan({ guidanceItem: item, objectiveCategory, actions: body?.actions ?? null, ownerRole: body?.ownerRole ?? null, startDate: body?.startDate ?? at, reviewDays: body?.reviewDays ?? null,
      evidenceBoundaryHash: profile ? strengthsSvc.boundaryOf(profile).hash : null, sourceInterventionIds: body?.sourceInterventionIds ?? [], engineVersions: engineVersions() });
  } catch (e) { throw fail(400, e.code ?? "INVALID_PLAN", e.message); }
  if (role === "STUDENT" && built.ownerRole !== "STUDENT") throw fail(403, "ROLE_NOT_ALLOWED", "A student may create only a plan they own themselves.");
  const dup = dp.duplicateOf(plans, { dimension: item.dimension ?? null, subjectId: item.subjectId ?? null, objectiveCategory });
  if (dup && !body?.supersedes) throw fail(409, "DUPLICATE_PLAN", "An open plan already exists for this objective.", { existingPlanId: String(dup._id) });
  const now = new Date();
  const doc = await DevelopmentPlan.create({
    _id: requestedId ?? undefined, schoolId, studentId: String(studentId), classId: classId ?? null,
    ...built, milestones: built.milestones.map((m) => ({ ...m, createdAt: now })), createdBy: actor, updatedBy: actor,
    status: "DRAFT", statusHistory: [{ from: null, to: "DRAFT", action: "create", by: actor, role, at: now, note: null }],
    ...(body?.supersedes && dup ? { rationale: { ...built.rationale, supersedes: String(dup._id), supersedeReason: String(body.supersedeReason ?? "").slice(0, 200) || "SUPERSEDED" } } : {}),
  });
  return { plan: doc.toObject(), created: true };
};

/** One lifecycle move. Idempotent: a replayed move changes nothing. */
const act = async ({ schoolId, studentId, planId, action, actor, actorRole, note = null }) => {
  const role = actorRoleOf(actorRole);
  if (!role) throw fail(403, "ROLE_NOT_ALLOWED", "This role may not act on a plan.");
  const doc = await load({ schoolId, studentId, planId });
  if (!doc) throw fail(404, "NOT_FOUND", "Plan not found.");
  let next;
  try { next = dp.transition({ status: doc.status, action, actorRole: role }); }
  catch (e) { throw fail(e.code === "ROLE_NOT_ALLOWED" ? 403 : 409, e.code, e.message); }
  if (!next.changed) return { plan: doc.toObject(), changed: false };
  const now = new Date();
  doc.statusHistory.push({ from: doc.status, to: next.status, action, by: actor, role, at: now, note: role === "STUDENT" ? null : note });
  doc.status = next.status;
  if (action === "accept") { doc.studentParticipation.acceptedAt = now; doc.studentParticipation.acceptedBy = actor; }
  if (action === "decline") doc.studentParticipation.declinedAt = now;
  doc.updatedBy = actor; doc.version = (doc.version ?? 1) + 1;
  await doc.save();
  return { plan: doc.toObject(), changed: true };
};

/** One milestone move: start, complete, skip (with a reason), block, unblock. Its owner or staff. */
const milestone = async ({ schoolId, studentId, planId, milestoneId, action, reason = null, actor, actorRole }) => {
  const role = actorRoleOf(actorRole);
  if (!role) throw fail(403, "ROLE_NOT_ALLOWED", "This role may not move a milestone.");
  const doc = await load({ schoolId, studentId, planId });
  if (!doc) throw fail(404, "NOT_FOUND", "Plan not found.");
  if (!["ACTIVE", "REVIEW_DUE", "ADAPTING"].includes(doc.status)) throw fail(409, "PLAN_NOT_ACTIVE", "Milestones move only on an active plan.");
  let r;
  try { r = dp.milestoneTransition(doc.milestones.map((m) => m.toObject()), { milestoneId, action, actorRole: role, reason, at: new Date(), by: actor }); }
  catch (e) { throw fail(e.code === "ROLE_NOT_ALLOWED" ? 403 : e.code === "MILESTONE_NOT_FOUND" ? 404 : 409, e.code, e.message); }
  if (!r.changed) return { plan: doc.toObject(), changed: false };
  doc.milestones = r.milestones; doc.updatedBy = actor; doc.version = (doc.version ?? 1) + 1;
  await doc.save();
  return { plan: doc.toObject(), changed: true };
};

/** The pupil's reflection: controlled codes, an optional short note. The pupil's own; staff may read it; a parent never. */
const reflect = async ({ schoolId, studentId, planId, actor, actorRole, codes, note = null }) => {
  const role = actorRoleOf(actorRole);
  if (role !== "STUDENT") throw fail(403, "ROLE_NOT_ALLOWED", "Only the student reflects on their plan.");
  const list = [...new Set((Array.isArray(codes) ? codes : [codes]).map(String))];
  if (!list.length || list.some((c) => !dp.REFLECTION_CODES.includes(c))) throw fail(400, "INVALID_REFLECTION", "Reflection codes must be from the documented list.");
  const doc = await load({ schoolId, studentId, planId });
  if (!doc) throw fail(404, "NOT_FOUND", "Plan not found.");
  doc.reflections.push({ at: new Date(), by: actor, codes: list, note: note ? String(note).slice(0, 1000) : null });
  doc.studentParticipation.reflections = (doc.studentParticipation.reflections ?? 0) + 1;
  doc.updatedBy = actor; doc.version = (doc.version ?? 1) + 1;
  await doc.save();
  return { plan: doc.toObject() };
};

/** A documented operational constraint, recorded by staff or the pupil about their own plan. Never inferred. */
const constrain = async ({ schoolId, studentId, planId, actor, actorRole, code, note = null }) => {
  const role = actorRoleOf(actorRole);
  if (!role || role === "PARENT") throw fail(403, "ROLE_NOT_ALLOWED", "This role may not record a constraint.");
  if (!dp.CONSTRAINTS.includes(code)) throw fail(400, "INVALID_CONSTRAINT", "Constraint must be from the documented list.");
  const doc = await load({ schoolId, studentId, planId });
  if (!doc) throw fail(404, "NOT_FOUND", "Plan not found.");
  doc.constraints.push({ code, at: new Date(), by: actor, role, note: role === "STUDENT" ? null : (note ? String(note).slice(0, 500) : null), resolvedAt: null });
  doc.updatedBy = actor; doc.version = (doc.version ?? 1) + 1;
  await doc.save();
  return { plan: doc.toObject() };
};

/** The adaptive engine's reading of a plan on one day. Nothing is written. */
const systemReview = async ({ doc, schoolId, studentId, asOf, teacherReview = null }) => {
  const at = asOf ?? strengthsSvc.startOfToday();
  const plan = asOfPlan(doc, asOf);
  if (!plan) return null;
  const [development, interventions] = await Promise.all([developmentSvc.historyFor({ schoolId, studentId, asOf: at }), interventionsSvc.listFor({ schoolId, studentId })]);
  const sources = interventions.filter((i) => (plan.sourceInterventionIds ?? []).includes(String(i._id)));
  const outcomes = await Promise.all(sources.map((i) => interventionsSvc.outcomeFor(i, { asOf: at })));
  return asup.reviewPlan({ plan, development, interventionOutcomes: outcomes, reflections: plan.reflections, teacherReview, constraints: plan.constraints, asOf: at });
};

/** The same reading through the offline road to the development history. */
const offlineSystemReview = async ({ doc, schoolId, studentId, asOf }) => {
  const at = asOf ?? strengthsSvc.startOfToday();
  const plan = asOfPlan(JSON.parse(JSON.stringify(doc)), asOf);
  if (!plan) return null;
  const development = await developmentSvc.offlineHistoryFor({ schoolId, studentId, asOf: at });
  const interventions = JSON.parse(JSON.stringify(await interventionsSvc.listFor({ schoolId, studentId })));
  const sources = interventions.filter((i) => (plan.sourceInterventionIds ?? []).includes(String(i._id)));
  const outcomes = await Promise.all(sources.map((i) => interventionsSvc.outcomeFor(i, { asOf: at })));
  return asup.reviewPlan({ plan, development, interventionOutcomes: outcomes, reflections: plan.reflections, teacherReview: null, constraints: plan.constraints, asOf: at });
};

/**
 * A review by staff: the system reading of the day is recorded with the
 * teacher's observation code and note, and the human decision moves the
 * plan — continue, adapt (with a chosen controlled action), complete, pause
 * or close. The system's outcome is stored beside the decision, never
 * instead of it.
 */
const review = async ({ schoolId, studentId, planId, actor, actorRole, teacherReview = null, decision = "continue", actionType = null, note = null, asOf = null }) => {
  const role = actorRoleOf(actorRole);
  if (!STAFF.includes(role)) throw fail(403, "ROLE_NOT_ALLOWED", "Only staff review a plan.");
  if (!dp.REVIEW_DECISIONS.includes(decision)) throw fail(400, "INVALID_DECISION", "Decision must be one of the documented five.");
  if (teacherReview?.code && !dp.TEACHER_REVIEW_CODES.includes(teacherReview.code)) throw fail(400, "INVALID_TEACHER_REVIEW", "Teacher review code must be from the documented list.");
  const doc = await load({ schoolId, studentId, planId });
  if (!doc) throw fail(404, "NOT_FOUND", "Plan not found.");
  if (!["ACTIVE", "REVIEW_DUE"].includes(doc.status)) throw fail(409, "PLAN_NOT_REVIEWABLE", "Only an active plan can be reviewed.");
  const at = asOf ?? strengthsSvc.startOfToday();
  // The plan is reconstructed for the requested asOf (null = the whole record); the history for that day.
  const system = await systemReview({ doc, schoolId, studentId, asOf, teacherReview: teacherReview ? { code: teacherReview.code } : null });
  if (!system) throw fail(404, "NOT_FOUND", "The plan did not exist as of that date.");
  const now = new Date();
  const reviewId = `r${(doc.reviews?.length ?? 0) + 1}`;
  if (doc.status === "ACTIVE") { doc.statusHistory.push({ from: "ACTIVE", to: "REVIEW_DUE", action: "mark_review_due", by: actor, role, at: now, note: null }); doc.status = "REVIEW_DUE"; }
  doc.reviews.push({ reviewId, at: now, by: actor, role, asOf: at, evidenceBoundaryHash: system.evidenceBoundaryHash, developmentObservationBoundary: system.developmentObservationBoundary,
    teacherReview: teacherReview ? { code: teacherReview.code ?? null, note: teacherReview.note ? String(teacherReview.note).slice(0, 2000) : null } : null,
    system: { outcome: system.outcome, reasons: system.reasons, adaptation: system.adaptation, contract: system.contract, contradiction: system.contradiction, statement: system.statement },
    decision, engineVersions: engineVersions() });
  const move = (action) => { const n = dp.transition({ status: doc.status, action, actorRole: role }); if (n.changed) { doc.statusHistory.push({ from: doc.status, to: n.status, action, by: actor, role, at: now, note }); doc.status = n.status; } };
  try {
    if (decision === "continue") move("continue");
    else if (decision === "complete") move("complete");
    else if (decision === "pause") move("pause");
    else if (decision === "close") move("close");
    else if (decision === "adapt") {
      move("adapt");
      if (actionType) {
        const ad = asup.adaptPlan({ plan: doc.toObject(), review: { ...system, reviewId }, actionType, actorRole: role, by: actor, at: now });
        doc.actions = ad.actions; doc.milestones = ad.milestones; doc.adaptations.push(ad.adaptation);
        move("apply_adaptation");
      }
    }
  } catch (e) { throw fail(e.code === "ROLE_NOT_ALLOWED" ? 403 : e.code === "INVALID_ACTION" ? 400 : 409, e.code, e.message); }
  doc.reviewSchedule.reviewDate = new Date(new Date(at).getTime() + (doc.reviewSchedule.intervalDays ?? 42) * 86400000);
  doc.updatedBy = actor; doc.version = (doc.version ?? 1) + 1;
  await doc.save();
  return { plan: doc.toObject(), review: doc.reviews[doc.reviews.length - 1].toObject ? doc.reviews[doc.reviews.length - 1].toObject() : doc.reviews[doc.reviews.length - 1], system };
};

/** Apply a chosen adaptation to a plan already in ADAPTING (a review that decided to adapt without choosing yet). */
const applyAdaptation = async ({ schoolId, studentId, planId, actor, actorRole, actionType, asOf = null }) => {
  const role = actorRoleOf(actorRole);
  if (!STAFF.includes(role)) throw fail(403, "ROLE_NOT_ALLOWED", "Only staff adapt a plan.");
  const doc = await load({ schoolId, studentId, planId });
  if (!doc) throw fail(404, "NOT_FOUND", "Plan not found.");
  if (doc.status !== "ADAPTING") throw fail(409, "INVALID_TRANSITION", "The plan is not adapting.");
  const last = doc.reviews[doc.reviews.length - 1];
  let ad;
  try { ad = asup.adaptPlan({ plan: doc.toObject(), review: last ? { ...last.system, reviewId: last.reviewId, evidenceBoundaryHash: last.evidenceBoundaryHash, developmentObservationBoundary: last.developmentObservationBoundary } : null, actionType, actorRole: role, by: actor, at: new Date() }); }
  catch (e) { throw fail(400, e.code, e.message); }
  const now = new Date();
  doc.actions = ad.actions; doc.milestones = ad.milestones; doc.adaptations.push(ad.adaptation);
  doc.statusHistory.push({ from: "ADAPTING", to: "ACTIVE", action: "apply_adaptation", by: actor, role, at: now, note: null }); doc.status = "ACTIVE";
  doc.updatedBy = actor; doc.version = (doc.version ?? 1) + 1;
  await doc.save();
  return { plan: doc.toObject() };
};

/** Shapes for readers. Staff see notes; a pupil sees their own reflections and no staff note; a parent sees neither. */
const view = (doc, { asOf = null, system = null, viewer = "staff" } = {}) => {
  const p = asOfPlan(doc, asOf);
  if (!p) return null;
  const staff = viewer === "staff", student = viewer === "student";
  return {
    planId: String(p._id), studentId: p.studentId, classId: p.classId, dimension: p.dimension, subjectId: p.subjectId,
    objective: p.objective, rationale: staff || student ? p.rationale : { observed: p.rationale?.observed ?? null, evidenceQuality: p.rationale?.evidenceQuality ?? null },
    sourceGuidanceIds: p.sourceGuidanceIds, sourceInterventionIds: staff ? p.sourceInterventionIds : undefined,
    actions: p.actions, milestones: p.milestones.map((m) => ({ milestoneId: m.milestoneId, kind: m.kind, owner: m.owner, order: m.order, evidenceFamily: m.evidenceFamily, state: m.state, reason: m.reason, adaptationIndex: m.adaptationIndex ?? null, ...(staff ? { history: m.history } : {}) })),
    reviewSchedule: p.reviewSchedule, ownerRole: p.ownerRole, studentParticipation: p.studentParticipation, status: p.status,
    statusHistory: p.statusHistory.map((h) => ({ from: h.from, to: h.to, action: h.action, role: h.role, at: h.at, ...(staff ? { by: h.by, note: h.note } : {}) })),
    reviews: p.reviews.map((r) => ({ reviewId: r.reviewId, at: r.at, asOf: r.asOf, decision: r.decision, outcome: r.system?.outcome ?? null, reasons: staff || student ? r.system?.reasons ?? [] : undefined, evidenceBoundaryHash: staff ? r.evidenceBoundaryHash : undefined,
      developmentObservationBoundary: staff ? r.developmentObservationBoundary : undefined, contract: staff || student ? r.system?.contract ?? null : undefined, adaptation: staff || student ? r.system?.adaptation ?? null : undefined,
      teacherReview: staff ? r.teacherReview : (r.teacherReview ? { code: r.teacherReview.code } : null), ...(staff ? { by: r.by, engineVersions: r.engineVersions } : {}) })),
    adaptations: p.adaptations.map((a) => ({ index: a.index, at: a.at, role: a.role, previous: a.previous, next: a.next, reason: a.reason, explanation: a.explanation, ...(staff ? { by: a.by, evidenceBoundaryHash: a.evidenceBoundaryHash, engineVersions: a.engineVersions } : {}) })),
    reflections: staff || student ? p.reflections.map((x) => ({ at: x.at, codes: x.codes, note: x.note })) : undefined,
    constraints: staff || student ? p.constraints.map((c) => ({ code: c.code, at: c.at, role: c.role, resolvedAt: c.resolvedAt, ...(staff ? { note: c.note } : {}) })) : p.constraints.map((c) => ({ code: c.code, at: c.at })),
    evidenceBoundaryHash: p.evidenceBoundaryHash, engineVersions: p.engineVersions, explanation: p.explanation,
    reviewDue: ["ACTIVE"].includes(p.status) && p.reviewSchedule?.reviewDate && new Date(p.reviewSchedule.reviewDate).toISOString() <= new Date(asOf ?? strengthsSvc.startOfToday()).toISOString(),
    systemReview: system, asOf: asOf ? new Date(asOf).toISOString() : null, createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
};

/** The parent's view: objective, how the pupil is supported, completed milestones, upcoming support, review status. */
const forGuardian = (docs, asOf = null) => docs.map((d) => view(d, { asOf, viewer: "parent" })).filter(Boolean).filter((p) => !["DRAFT", "DECLINED"].includes(p.status)).map((p) => ({
  planId: p.planId, dimension: p.dimension, subjectId: p.subjectId, objective: { category: p.objective.category, code: p.objective.code }, status: p.status,
  supportedBy: { ownerRole: p.ownerRole, actions: p.actions.filter((a) => !a.replacedAt).map((a) => a.actionType) },
  completedMilestones: p.milestones.filter((m) => m.state === "COMPLETED").map((m) => ({ kind: m.kind })),
  upcoming: p.milestones.filter((m) => m.state === "AVAILABLE" || m.state === "STARTED").map((m) => ({ kind: m.kind, owner: m.owner })),
  review: { reviewDate: p.reviewSchedule.reviewDate, reviewDue: p.reviewDue, lastOutcome: p.reviews.length ? p.reviews[p.reviews.length - 1].outcome : null, lastDecision: p.reviews.length ? p.reviews[p.reviews.length - 1].decision : null },
}));

module.exports = { engineVersions, listFor, oneFor, load, asOfPlan, create, act, milestone, reflect, constrain, systemReview, offlineSystemReview, review, applyAdaptation, view, forGuardian };
