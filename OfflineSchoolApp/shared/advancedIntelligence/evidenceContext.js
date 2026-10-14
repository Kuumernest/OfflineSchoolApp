// shared/advancedIntelligence/evidenceContext.js
"use strict";

/**
 * The evidence context: the compact, whitelisted, viewer-projected,
 * boundary-dated picture of one pupil's structured intelligence that the
 * explanation layer — and, at the application boundary, a model — is
 * allowed to see.
 *
 * ── Whitelist, not blacklist ──────────────────────────────────────────────
 *
 * Nothing reaches the context unless a line here copies it by name. The
 * raw document graph never does: no names, no enrolment numbers, no user or
 * account ids, no tokens, no other pupil, no free-text note, no reflection
 * text, no reviewer-only content. Codes and counts only — the same rule the
 * engines beneath already follow — so a leaked context would still be a
 * page of vocabulary.
 *
 * ── The viewer projection ─────────────────────────────────────────────────
 *
 * The routes decide who is asking; the builder decides what that person is
 * shown, mirroring the projections the Stage 13–16 services already apply:
 * a parent gets objectives, support and progress, never a reflection code,
 * a reason code or a teacher's review code; a pupil gets their own reflection
 * codes and never a teacher's; staff get the codes their existing views
 * carry. A privacy rule that lives here is asserted by the check for every
 * viewer, which a rule scattered across prompts could not be.
 *
 * ── The evidence boundary ─────────────────────────────────────────────────
 *
 * Every item carries the date it was observed; anything dated after asOf is
 * dropped and counted, so a historical question receives a historical
 * context and a future fact cannot be cited. The boundary hash names the
 * exact context an answer was made from, so "why did you say that" can be
 * answered from the same page a week later.
 */

const V = require("./version");
const { hashOf } = require("./hash");

const iso = (d) => (d ? new Date(d).toISOString() : null);
const byId = (a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0);
const uniq = (xs) => [...new Set(xs)];
const names = (subs) => (subs ?? []).map((s) => ({ subjectId: s.subjectId ?? null, subjectName: s.subjectName ?? null }));

const OPEN_PLAN = ["DRAFT", "PROPOSED", "ACCEPTED", "ACTIVE", "REVIEW_DUE", "ADAPTING", "PAUSED"];
const AGREED_INTERVENTION = ["ACCEPTED", "ACTIVE", "REVIEW_DUE", "PAUSED", "COMPLETED"];

const buildEvidenceContext = ({
  asOf, viewer, engineVersions = {},
  academicProfile = null, strengthProfile = null, learningEvidence = null, development = null, guidance = null,
  interventions = [], interventionTriggers = [], plans = [], explorations = [],
} = {}) => {
  if (!asOf) { const e = new Error("asOf is required"); e.code = "ASOF_REQUIRED"; throw e; }
  if (!V.VIEWERS.includes(viewer)) { const e = new Error(`unknown viewer: ${viewer}`); e.code = "UNKNOWN_VIEWER"; throw e; }
  const at = iso(asOf);
  const parent = viewer === "parent", student = viewer === "student", staff = !parent && !student;
  let futureDropped = 0;
  // The boundary is a day, as every asOf in this application is (startOfToday,
  // ?asOf=YYYY-MM-DD): an item dated on the asOf day is within it, whatever
  // its hour; an item dated the day after is not. A plan opened at ten in the
  // morning is part of "today" the way the plan routes already treat it.
  const day = at.slice(0, 10);
  const within = (d) => { if (!d) return true; const ok = iso(d).slice(0, 10) <= day; if (!ok) futureDropped++; return ok; };
  const limitations = new Set();

  // ── ACADEMIC_PROFILE ─────────────────────────────────────────────────────
  // The academic engine (1.0.0) reads the published history whole; the
  // strengths engine above it filters exploration and learning evidence by
  // asOf but takes the academic profile as given. The context follows the
  // engines: the subjects and insights the profile was built from are cited
  // as they are, so a state and its evidence never disagree. The mark dates
  // are carried for the reader; they are not a second filter.
  const academic = [];
  if (academicProfile) {
    for (const s of academicProfile.subjects ?? []) {
      academic.push({
        sourceId: `ACADEMIC_PROFILE:${s.subjectId}`, sourceType: "ACADEMIC_PROFILE", subjectId: s.subjectId, subjectName: s.subjectName ?? null,
        observations: s.observations ?? (s.marks ?? []).length, consistency: s.consistency ?? null,
        ...(parent ? {} : { overallAverage: s.overallAverage ?? null, recentAverage: s.recentAverage ?? null, delta: s.delta ?? null, scale: s.scale ?? 20, belowPass: s.belowPass ?? 0, strongMarks: s.strongMarks ?? 0 }),
        observedAt: iso(s.to?.startDate ?? null),
      });
    }
    for (const i of academicProfile.insights ?? []) {
      academic.push({ sourceId: `ACADEMIC_PROFILE:insight:${i.code}:${i.subjectId ?? "student"}`, sourceType: "ACADEMIC_PROFILE", insight: i.code, type: i.type, subjectId: i.subjectId ?? null, subjectName: i.subjectName ?? null, confidence: i.confidence, observedAt: iso(i.window?.to?.startDate ?? null) });
    }
  } else limitations.add("NO_ACADEMIC_PROFILE");

  // ── STRENGTH_PROFILE ─────────────────────────────────────────────────────
  const strengths = [];
  const readings = [...(strengthProfile?.strengths ?? []), ...(strengthProfile?.emergingAreas ?? []), ...(strengthProfile?.decliningAreas ?? [])];
  for (const d of readings) {
    strengths.push({
      sourceId: `STRENGTH_PROFILE:${d.dimension}`, sourceType: "STRENGTH_PROFILE", dimension: d.dimension, state: d.state, confidence: d.confidence, persistence: d.persistence,
      direction: d.academic?.direction ?? d.baseDirection ?? null, stateSource: d.interpretation?.stateSource ?? d.fused?.stateSource ?? "academic",
      supportingSubjects: names(d.supportingSubjects), decliningSubjects: names(d.decliningSubjects),
      learningRelationship: d.learningEvidence?.relationship ?? d.interpretation?.relationship ?? null,
      independentLearningEvents: d.learningEvidence?.independentEventCount ?? 0, sourceFamilies: d.learningEvidence?.sourceFamilies ?? [],
      explorationEvents: d.fused?.events ?? 0, explorationSupporting: d.fused?.supportingEvents ?? 0, explorationContradicting: d.fused?.contradictingEvents ?? 0,
      teacherObservers: d.fused?.teacherObservers ?? d.corroboration?.teacherObservers ?? 0,
      contradictions: uniq([...(d.fused?.conflicts ?? []).map((c) => c.kind), ...(d.interpretation?.contradictions ?? []).map((c) => c.kind)]),
      limitations: d.limitations ?? [], observedAt: at,
    });
  }
  for (const a of strengthProfile?.explorationAreas ?? []) {
    strengths.push({ sourceId: `STRENGTH_PROFILE:area:${a.area}`, sourceType: "STRENGTH_PROFILE", area: a.area, evidenceLevel: a.evidenceLevel, openedBy: a.openedBy ?? [], supportingSubjects: names(a.supportingSubjects), because: (a.because ?? []).map((b) => ({ dimension: b.dimension, state: b.state })), waysToExplore: a.waysToExplore ?? [], observedAt: at });
  }
  if (!parent) {
    const interest = new Map();
    for (const s of strengthProfile?.interestSignals ?? []) {
      if (!within(s.date)) continue;
      const k = s.area ?? s.dimension ?? "unknown";
      const cur = interest.get(k) ?? { sourceId: `STRENGTH_PROFILE:interest:${k}`, sourceType: "STRENGTH_PROFILE", area: s.area ?? null, dimension: s.dimension ?? null, signals: 0, kinds: [], latestAt: null };
      cur.signals++; cur.kinds = uniq([...cur.kinds, s.kind]).sort(); cur.latestAt = [cur.latestAt, iso(s.date)].filter(Boolean).sort().pop() ?? null;
      interest.set(k, cur);
    }
    for (const v of interest.values()) strengths.push({ ...v, observedAt: v.latestAt });
  }
  for (const s of strengthProfile?.singleSubjectStrengths ?? []) {
    strengths.push({ sourceId: `STRENGTH_PROFILE:subject:${s.subjectId}`, sourceType: "STRENGTH_PROFILE", subjectId: s.subjectId, subjectName: s.subjectName ?? null, state: s.state, persistence: s.persistence, consistency: s.consistency ?? null, direction: s.direction ?? null, observedAt: at });
  }
  if (!strengthProfile) limitations.add("NO_STRENGTH_PROFILE");
  for (const l of strengthProfile?.limitations ?? []) limitations.add(String(l).toUpperCase());

  // ── LEARNING_EVIDENCE ────────────────────────────────────────────────────
  const learning = [];
  if (learningEvidence) {
    for (const s of Object.values(learningEvidence.patterns?.bySubject ?? {})) {
      if (!s.subjectId) continue;
      const q = learningEvidence.quality?.subjects?.[s.subjectId];
      learning.push({
        sourceId: `LEARNING_EVIDENCE:${s.subjectId}`, sourceType: "LEARNING_EVIDENCE", subjectId: s.subjectId,
        formal: s.formal?.pattern ?? null, continuous: s.continuous?.pattern ?? null, practical: s.practical?.pattern ?? null, quiz: s.quiz?.pattern ?? null,
        homework: { pattern: s.homework?.pattern ?? null, submission: s.homework?.submission?.pattern ?? null, ...(parent ? { completed: s.homework?.completed ?? 0, assigned: s.homework?.assigned ?? 0 } : { completed: s.homework?.completed ?? 0, assigned: s.homework?.assigned ?? 0, missing: s.homework?.missing ?? 0 }) },
        directions: { formal: s.formal?.direction ?? null, continuous: s.continuous?.direction ?? null, practical: s.practical?.direction ?? null, quiz: s.quiz?.direction ?? null },
        coverage: q?.level ?? "NO_DATA", independentEvents: q?.independentEvents ?? 0, flags: q?.flags ?? [], observedAt: at,
      });
    }
    const att = learningEvidence.patterns?.attendance?.overall;
    if (att) learning.push({ sourceId: "LEARNING_EVIDENCE:attendance", sourceType: "LEARNING_EVIDENCE", pattern: att.pattern ?? null, present: att.present ?? 0, absent: att.absent ?? 0, late: att.late ?? 0, excused: att.excused ?? 0, observedAt: at });
    for (const c of learningEvidence.quality?.contradictions ?? []) {
      learning.push({ sourceId: `LEARNING_EVIDENCE:contradiction:${c.code}:${c.subjectId ?? "student"}`, sourceType: "LEARNING_EVIDENCE", contradiction: c.code, subjectId: c.subjectId ?? null, observedAt: at });
    }
    for (const c of learningEvidence.concise ?? []) {
      const code = typeof c === "string" ? c : c.code;
      learning.push({ sourceId: `LEARNING_EVIDENCE:concise:${code}:${(typeof c === "string" ? null : c.subjectId) ?? "student"}`, sourceType: "LEARNING_EVIDENCE", concise: code, subjectId: typeof c === "string" ? null : c.subjectId ?? null, observedAt: at });
    }
  } else limitations.add("NO_LEARNING_EVIDENCE");

  // ── DEVELOPMENT_HISTORY ──────────────────────────────────────────────────
  const dev = [];
  if (development) {
    for (const t of development.trajectories ?? []) {
      const obs = (t.observations ?? []).filter((o) => within(o.observedAt));
      const transitions = (t.stateTransitions ?? []).filter((x) => within(x.at));
      const key = t.dimensionId ? t.dimensionId : `subject:${t.subjectId}`;
      dev.push({
        sourceId: `DEVELOPMENT_HISTORY:${key}`, sourceType: "DEVELOPMENT_HISTORY", dimension: t.dimensionId ?? null, subjectId: t.subjectId ?? null, subjectName: t.subjectName ?? null,
        currentState: t.currentState, currentConfidence: t.currentConfidence ?? null, currentRelationship: t.currentRelationship ?? null, trajectory: t.trajectory, direction: t.direction,
        observations: obs.length, independentObservations: t.persistence?.independentObservationCount ?? 0, consecutiveObservations: t.persistence?.consecutiveObservations ?? 0,
        firstObservedAt: iso(t.firstObservedAt), lastObservedAt: iso(t.lastObservedAt),
        stateTransitions: transitions.map((x) => ({ from: x.from, to: x.to, at: iso(x.at) })),
        quality: { coverage: t.quality?.coverage ?? null, recency: t.quality?.recency ?? null, independence: t.quality?.independence ?? null, conflicts: t.quality?.conflicts ?? null },
        missingModalities: t.quality?.missingModalities ?? [], attendanceLimited: Boolean(t.quality?.attendanceLimited),
        ...(parent ? {} : { reasons: t.reasons ?? [], explanation: (t.explanation ?? []).map((e) => e.code) }),
        observedAt: iso(t.lastObservedAt),
      });
    }
    if (!parent) for (const c of development.changes ?? []) {
      if (!within(c.observedAt)) continue;
      dev.push({ sourceId: `DEVELOPMENT_HISTORY:change:${c.changeId}`, sourceType: "DEVELOPMENT_HISTORY", dimension: c.dimensionId ?? null, subjectId: c.subjectId ?? null, observedAt: iso(c.observedAt), previousState: c.previousState ?? null, currentState: c.currentState ?? null, previousRelationship: c.previousRelationship ?? null, currentRelationship: c.currentRelationship ?? null, changeTypes: c.changeTypes ?? [], reasonCodes: c.reasonCodes ?? [] });
    }
    for (const c of development.contradictions ?? []) {
      if (!within(c.firstSeen)) continue;
      dev.push({ sourceId: `DEVELOPMENT_HISTORY:contradiction:${c.dimension}:${c.kind}`, sourceType: "DEVELOPMENT_HISTORY", dimension: c.dimension, kind: c.kind, status: c.status, occurrences: c.occurrences ?? 0, firstSeen: iso(c.firstSeen), lastSeen: iso(c.lastSeen), current: Boolean(c.current), observedAt: iso(c.lastSeen ?? c.firstSeen) });
    }
    if (development.quality?.history === "INSUFFICIENT" || development.history?.sufficient === false) limitations.add("INSUFFICIENT_HISTORY");
  } else limitations.add("NO_DEVELOPMENT_HISTORY");

  // ── EXPLORATION ──────────────────────────────────────────────────────────
  const explorationItems = [];
  for (const e of explorations ?? []) {
    if (!within(e.discoveredAt ?? e.createdAt ?? null)) continue;
    const latest = [e.discoveredAt, e.startedAt, e.submittedAt, e.completedAt, e.closedAt].filter(Boolean).map(iso).sort().pop() ?? null;
    if (latest && latest > at) limitations.add("EXPLORATION_STATE_IS_CURRENT");
    const obs = Array.isArray(e.observations) ? e.observations : [];
    explorationItems.push({
      sourceId: `EXPLORATION:${e.explorationId}`, sourceType: "EXPLORATION", activityId: e.activityId, area: e.area ?? null, level: e.level ?? null, status: e.status, relevance: e.relevance ?? null,
      discoveredAt: iso(e.discoveredAt), startedAt: iso(e.startedAt), completedAt: iso(e.completedAt),
      performanceLevel: e.performance?.level ?? null, pattern: e.pattern ?? null, evidenceKinds: uniq((Array.isArray(e.evidence) ? e.evidence : []).map((v) => (typeof v === "string" ? v : v.kind))).sort(),
      observations: parent ? (typeof e.observations === "number" ? e.observations : obs.length) : obs.map((o) => ({ level: o.level ?? null, codes: o.codes ?? [] })),
      ...(parent ? {} : { reflection: e.reflection ? { interest: e.reflection.interest ?? null, difficulty: e.reflection.difficulty ?? null, continue: e.reflection.continue ?? null } : null }),
      observedAt: iso(e.completedAt ?? e.submittedAt ?? e.startedAt ?? e.discoveredAt ?? null),
    });
  }

  // ── GUIDANCE ─────────────────────────────────────────────────────────────
  const guidanceItems = [];
  for (const i of guidance?.items ?? []) {
    guidanceItems.push({
      sourceId: `GUIDANCE:${i.id}`, sourceType: "GUIDANCE", id: i.id, category: i.category, dimension: i.dimension ?? null, subjectId: i.subjectId ?? null, evidenceQuality: i.evidenceQuality,
      observed: { state: i.evidence?.state ?? null, trajectory: i.evidence?.trajectory ?? null, direction: i.evidence?.direction ?? null, relationship: i.evidence?.relationship ?? null, coverage: i.evidence?.coverage ?? null },
      ...(parent ? {} : { why: { code: i.explanation?.why?.code ?? null, reasons: i.explanation?.why?.reasons ?? i.reasons ?? [] } }),
      uncertain: { missingModalities: i.explanation?.uncertain?.missingModalities ?? [], historySufficient: i.explanation?.uncertain?.historySufficient ?? null, conflicts: i.explanation?.uncertain?.conflicts ?? null },
      suggestedActions: (i.suggestedActions ?? []).map((a) => (typeof a === "string" ? a : a.type ?? a.code ?? null)).filter(Boolean), evidenceToWatch: i.evidenceToWatch ?? [],
      agency: guidance?.agency ?? "INFORMS_ONLY", observedAt: iso(i.asOf ?? guidance?.asOf ?? at),
    });
  }
  if (guidance && guidance.historySufficient === false) limitations.add("GUIDANCE_HISTORY_INSUFFICIENT");

  // ── INTERVENTION ─────────────────────────────────────────────────────────
  const interventionItems = [];
  for (const d of interventions ?? []) {
    if (!within(d.startDate ?? d.createdAt ?? null)) continue;
    if (parent && !AGREED_INTERVENTION.includes(d.lifecycle)) continue;
    interventionItems.push({
      sourceId: `INTERVENTION:${d.interventionId}`, sourceType: "INTERVENTION", dimension: d.dimension ?? null, subjectId: d.subjectId ?? null, trigger: d.trigger ?? null, objective: d.objective ?? null, action: d.action ?? null, ownerRole: d.ownerRole ?? null,
      lifecycle: d.lifecycle ?? null, startDate: iso(d.startDate), reviewDate: iso(d.reviewDate), evidenceToCollect: d.evidenceToCollect ?? [],
      outcome: d.outcome ? { outcome: d.outcome.outcome ?? null, statement: d.outcome.statement?.code ?? null, causal: false } : null,
      reviews: (d.reviews ?? []).filter((r) => within(r.at)).map((r) => ({ at: iso(r.at), outcome: r.outcome ?? null })),
      ...(staff && d.triggerEvidence ? { triggerEvidenceKeys: Object.keys(d.triggerEvidence).sort() } : {}),
      observedAt: iso(d.startDate ?? d.createdAt ?? null),
    });
  }
  if (!parent) for (const t of interventionTriggers ?? []) {
    interventionItems.push({ sourceId: `INTERVENTION:trigger:${t.dimension}:${t.trigger}`, sourceType: "INTERVENTION", dimension: t.dimension, trigger: t.trigger, independentObservations: t.independentObservations ?? 0, evidenceKeys: Object.keys(t.evidence ?? {}).sort(), observedAt: at });
  }

  // ── DEVELOPMENT_PLAN and PLAN_REVIEW ─────────────────────────────────────
  const planItems = [], reviewItems = [];
  for (const p of plans ?? []) {
    if (!p) continue;
    if (!within(p.createdAt ?? p.reviewSchedule?.startDate ?? null)) continue;
    if (parent && ["DRAFT", "DECLINED"].includes(p.status)) continue;
    const ms = p.milestones ?? [];
    planItems.push({
      sourceId: `DEVELOPMENT_PLAN:${p.planId}`, sourceType: "DEVELOPMENT_PLAN", planId: p.planId, dimension: p.dimension ?? null, subjectId: p.subjectId ?? null,
      objective: { category: p.objective?.category ?? null, code: p.objective?.code ?? null }, status: p.status, open: OPEN_PLAN.includes(p.status), ownerRole: p.ownerRole ?? null,
      actions: (p.actions ?? []).filter((a) => !a.replacedAt).map((a) => a.actionType), replacedActions: (p.actions ?? []).filter((a) => a.replacedAt).map((a) => a.actionType),
      milestones: { total: ms.length, completed: ms.filter((m) => m.state === "COMPLETED").length, skipped: ms.filter((m) => m.state === "SKIPPED").length, blocked: ms.filter((m) => m.state === "BLOCKED").length, next: ms.find((m) => m.state === "AVAILABLE" || m.state === "STARTED")?.kind ?? null },
      rationale: { guidanceCategory: parent ? undefined : p.rationale?.guidanceCategory ?? null, observed: p.rationale?.observed ?? null, evidenceQuality: p.rationale?.evidenceQuality ?? null, ...(parent ? {} : { reasons: p.rationale?.reasons ?? [] }) },
      sourceGuidanceIds: parent ? undefined : p.sourceGuidanceIds ?? [],
      reviewSchedule: { startDate: iso(p.reviewSchedule?.startDate), reviewDate: iso(p.reviewSchedule?.reviewDate), intervalDays: p.reviewSchedule?.intervalDays ?? null }, reviewDue: Boolean(p.reviewDue),
      ...(parent ? {} : { reflections: (p.reflections ?? []).filter((r) => within(r.at)).map((r) => ({ at: iso(r.at), codes: r.codes ?? [] })) }),
      constraints: (p.constraints ?? []).filter((c) => within(c.at)).map((c) => ({ code: c.code, at: iso(c.at), resolved: Boolean(c.resolvedAt) })),
      adaptations: (p.adaptations ?? []).filter((a) => within(a.at)).map((a) => ({ at: iso(a.at), previous: (a.previous ?? []).map((x) => (typeof x === "string" ? x : x.actionType)), next: (a.next ?? []).map((x) => (typeof x === "string" ? x : x.actionType)), reason: parent ? undefined : a.reason?.code ?? a.reason?.outcome ?? null })),
      observedAt: iso(p.updatedAt ?? p.createdAt ?? null),
    });
    for (const r of p.reviews ?? []) {
      if (!within(r.at)) continue;
      reviewItems.push({ sourceId: `PLAN_REVIEW:${p.planId}:${r.reviewId ?? iso(r.at)}`, sourceType: "PLAN_REVIEW", planId: p.planId, at: iso(r.at), asOf: iso(r.asOf), outcome: r.outcome ?? null, decision: r.decision ?? null,
        ...(parent ? {} : { reasons: r.reasons ?? [], suggestedActions: r.adaptation?.suggestedActions ?? [] }), ...(staff && r.teacherReview ? { teacherReviewCode: r.teacherReview.code ?? null } : {}), observedAt: iso(r.at) });
    }
    if (p.systemReview && !parent) {
      const s = p.systemReview;
      reviewItems.push({ sourceId: `PLAN_REVIEW:${p.planId}:current`, sourceType: "PLAN_REVIEW", planId: p.planId, at: iso(s.asOf ?? at), current: true, outcome: s.outcome ?? null, reasons: s.reasons ?? [], suggestedActions: s.adaptation?.suggestedActions ?? [],
        contradiction: s.contradiction?.code ?? null, next: s.contract?.next ?? null, causal: false, observedAt: iso(s.asOf ?? at) });
    }
  }

  const sources = {
    academic: academic.sort(byId), strengths: strengths.sort(byId), learning: learning.sort(byId), development: dev.sort(byId), exploration: explorationItems.sort(byId),
    guidance: guidanceItems.sort(byId), interventions: interventionItems.sort(byId), plans: planItems.sort(byId), planReviews: reviewItems.sort(byId),
  };
  const contradictions = [
    ...sources.development.filter((x) => x.kind).map((x) => ({ source: "DEVELOPMENT_HISTORY", dimension: x.dimension, kind: x.kind, status: x.status, sourceId: x.sourceId })),
    ...sources.learning.filter((x) => x.contradiction).map((x) => ({ source: "LEARNING_EVIDENCE", subjectId: x.subjectId, kind: x.contradiction, status: null, sourceId: x.sourceId })),
    ...sources.strengths.filter((x) => x.dimension && (x.contradictions ?? []).length).flatMap((x) => x.contradictions.map((k) => ({ source: "STRENGTH_PROFILE", dimension: x.dimension, kind: k, status: "CURRENT", sourceId: x.sourceId }))),
  ].sort((a, b) => (a.sourceId + a.kind < b.sourceId + b.kind ? -1 : 1));

  const byDimension = {};
  for (const g of sources.guidance) if (g.dimension) byDimension[g.dimension] = g.evidenceQuality;
  const evidenceQuality = {
    profileConfidence: strengthProfile?.confidence ?? "insufficient", coverage: strengthProfile?.fusion?.coverage?.overall ?? "none",
    academicSufficient: Boolean(strengthProfile?.evidenceCoverage?.sufficient ?? academicProfile?.coverage?.sufficient ?? false),
    historySufficient: Boolean(development?.history?.sufficient ?? false), learningCoverage: learningEvidence?.quality?.overall?.level ?? "NO_DATA",
    independentObservations: development?.history?.independentObservationCount ?? 0, byDimension,
  };
  if (futureDropped) limitations.add(`FUTURE_EVIDENCE_EXCLUDED:${futureDropped}`);
  limitations.add(`VIEWER_PROJECTION:${viewer.toUpperCase()}`);

  const versions = {
    academic: strengthProfile?.academicEngineVersion ?? academicProfile?.engine?.version ?? null, strengths: strengthProfile?.strengthEngineVersion ?? null,
    learningIntegration: strengthProfile?.learningIntegrationVersion ?? null, learningEvidence: learningEvidence?.learningEvidenceVersion ?? strengthProfile?.learningEvidenceVersion ?? null,
    development: development?.developmentEngineVersion ?? null, guidance: guidance?.guidanceEngineVersion ?? null, ...engineVersions, advancedIntelligence: V.ADVANCED_INTELLIGENCE_VERSION,
  };
  const sourceTypes = V.SOURCE_TYPES.filter((t) => Object.values(sources).some((list) => list.some((x) => x.sourceType === t)));
  const core = { contextVersion: V.CONTEXT_VERSION, asOf: at, viewer, engineVersions: versions, sourceTypes, sources, contradictions, evidenceQuality, limitations: [...limitations].sort() };
  // The hash names the evidence used. How many later items were dropped is
  // reported, but not hashed: a historical context must hash the same
  // whatever arrived after its day, or "the same asOf twice" would stop
  // being byte-identical the moment the next term's marks were published.
  const hashed = { ...core, limitations: core.limitations.filter((l) => !l.startsWith("FUTURE_EVIDENCE_EXCLUDED")) };
  return { ...core, evidenceBoundaryHash: hashOf(hashed), notInferred: V.NOT_INFERRED, authority: V.AUTHORITY };
};

/** Every item in the context, flat, sorted by id. */
const itemsOf = (context) => Object.values(context?.sources ?? {}).flat().sort(byId);

/** One item by its citation id. */
const itemById = (context, sourceId) => itemsOf(context).find((x) => x.sourceId === sourceId) ?? null;

module.exports = { buildEvidenceContext, itemsOf, itemById, OPEN_PLAN, AGREED_INTERVENTION };
