// shared/advancedIntelligence/explanation.js
"use strict";

/**
 * Explanation: the deterministic answer facts, the deterministic answer,
 * and the grounding validator.
 *
 * ── The pipeline this file serves ─────────────────────────────────────────
 *
 *   question → authorise (routes) → evidence context → answer facts (here)
 *   → optional model narration (application) → claim validation (here)
 *   → citation validation (here) → safety filter (here) → reader
 *
 * The facts are chosen from the context by the question's category and
 * topic; every fact carries its claim type and its citations. The
 * deterministic answer puts the facts into fixed sentences — the answer a
 * pupil gets offline, and the answer everybody gets when a model is
 * unavailable, times out, replies with something malformed, or says
 * something the validator rejects. A model that is present is asked to put
 * the same facts into better words; it is not asked to find facts.
 *
 * ── The validator ─────────────────────────────────────────────────────────
 *
 * Reads a structured output against the context it was made from and names
 * what is wrong: a claim of fact with no citation, a citation to something
 * not in the context, a boundary that is not this one, a date after asOf, a
 * term the viewer may not see, a state word that contradicts the engine's
 * state, and the five forbidden shapes of sentence. One issue discards the
 * answer. Deterministic engine wins; it is the only rule.
 */

const V = require("./version");
const { itemById } = require("./evidenceContext");
const { validateCitations, citationId } = require("./citations");
const { screenOutput } = require("./safety");
const { validateOutputShape, hasForbiddenKey, LIMITS } = require("./contracts");
const { explorationCandidates } = require("./exploration/candidates");

const human = (code) => String(code ?? "").toLowerCase().replace(/_/g, " ");
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const list = (xs, lang) => { const a = (xs ?? []).filter(Boolean); if (!a.length) return lang === "fr" ? "aucun" : "none"; return a.length === 1 ? a[0] : `${a.slice(0, -1).join(", ")} ${lang === "fr" ? "et" : "and"} ${a[a.length - 1]}`; };
const subjectNames = (subs) => (subs ?? []).map((s) => s.subjectName ?? s.subjectId).filter(Boolean);

const STATE_WORD = {
  en: { ESTABLISHED: "an established strength", EMERGING: "an emerging strength", DECLINING: "declining", INSUFFICIENT: "insufficient to read", NOT_AVAILABLE: "not available" },
  fr: { ESTABLISHED: "une force établie", EMERGING: "une force émergente", DECLINING: "en déclin", INSUFFICIENT: "insuffisant pour être lu", NOT_AVAILABLE: "non disponible" },
};
const TRAJ_WORD = {
  en: { INSUFFICIENT_HISTORY: "too short to read", STABLE_ESTABLISHED: "stable and established", STABLE_EMERGING: "stable and emerging", STABLE_DECLINING: "stable at a declining reading", STABLE_INSUFFICIENT: "stable but insufficient", EMERGING: "emerging", STRENGTHENING: "strengthening", WEAKENING: "weakening", DECLINING: "declining", RECOVERING: "recovering", VARIABLE: "variable" },
  fr: { INSUFFICIENT_HISTORY: "trop court pour être lu", STABLE_ESTABLISHED: "stable et établi", STABLE_EMERGING: "stable et émergent", STABLE_DECLINING: "stable à une lecture en déclin", STABLE_INSUFFICIENT: "stable mais insuffisant", EMERGING: "émergent", STRENGTHENING: "en renforcement", WEAKENING: "en affaiblissement", DECLINING: "en déclin", RECOVERING: "en reprise", VARIABLE: "variable" },
};
const SOURCE_WORD = {
  en: { ACADEMIC: "formal assessment", LEARNING_EVIDENCE: "learning evidence (homework, quizzes, coursework, practical work)", EXPLORATION: "exploration activities", TEACHER_OBSERVATION: "teacher observation" },
  fr: { ACADEMIC: "l'évaluation formelle", LEARNING_EVIDENCE: "les preuves d'apprentissage (devoirs, quiz, travaux, pratique)", EXPLORATION: "les activités d'exploration", TEACHER_OBSERVATION: "l'observation de l'enseignant" },
};

// ─────────────────────────────────────────────────────────────────────────────
// THE FACTS
// ─────────────────────────────────────────────────────────────────────────────

const F = (code, type, values, citations) => ({ code, type, values, citations: [...new Set(citations.filter(Boolean))].sort() });
const INF = "INFERRED_BY_DETERMINISTIC_ENGINE";

const dimensionFacts = (context, synthesis, d, { states = true, trajectory = true, change = true, cross = true, contradictions = true, evidence = false } = {}) => {
  const S = context.sources, out = [];
  const s = S.strengths.find((x) => x.dimension === d.dimension && x.state), h = S.development.find((x) => x.dimension === d.dimension && x.trajectory);
  if (states && (s || h)) out.push(F("DIMENSION_STATE", INF, { dimension: d.dimension, state: d.academicState, confidence: d.confidence, persistence: d.persistence, supportingSubjects: subjectNames(d.supportingSubjects) }, [s?.sourceId, h?.sourceId, ...d.supportingSubjects.map((x) => `ACADEMIC_PROFILE:${x.subjectId}`).filter((id) => itemById(context, id))]));
  if (cross && d.crossDomain.relationship !== "INSUFFICIENT") out.push(F("CROSS_DOMAIN", INF, { dimension: d.dimension, ...d.crossDomain }, [s?.sourceId, h?.sourceId, ...d.supportingSubjects.map((x) => `LEARNING_EVIDENCE:${x.subjectId}`).filter((id) => itemById(context, id))]));
  if (trajectory && h) out.push(F("TRAJECTORY", INF, { dimension: d.dimension, trajectory: d.trajectory, direction: d.developmentDirection, independentObservations: d.independentObservations, firstObservedAt: h.firstObservedAt, lastObservedAt: h.lastObservedAt }, [h.sourceId]));
  if (change) {
    const latest = S.development.filter((x) => x.dimension === d.dimension && x.changeTypes).sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1))[0] ?? null;
    out.push(F("RECENT_CHANGE", h ? INF : "NOT_AVAILABLE", { dimension: d.dimension, recentChange: d.recentChange, latest: latest ? { observedAt: latest.observedAt, previousState: latest.previousState, currentState: latest.currentState, changeTypes: latest.changeTypes } : null }, [latest?.sourceId, h?.sourceId]));
  }
  if (contradictions) for (const c of S.development.filter((x) => x.dimension === d.dimension && x.kind)) out.push(F("CONTRADICTION", INF, { dimension: d.dimension, kind: c.kind, status: c.status, occurrences: c.occurrences }, [c.sourceId]));
  if (evidence) {
    out.push(F("EVIDENCE_SUPPORTING", "OBSERVED", { dimension: d.dimension, sources: d.crossDomain.supportingSources, subjects: subjectNames(d.supportingSubjects), independentLearningEvents: d.independentLearningEvents, sourceFamilies: d.sourceFamilies, explorationEvents: d.explorations.total, teacherObservers: s?.teacherObservers ?? 0, independentObservations: d.independentObservations }, [s?.sourceId, h?.sourceId, ...d.citations.filter((id) => id.startsWith("ACADEMIC_PROFILE:") || id.startsWith("LEARNING_EVIDENCE:") || id.startsWith("EXPLORATION:"))]));
    out.push(F("EVIDENCE_MISSING", INF, { dimension: d.dimension, missingModalities: d.missingModalities, quality: d.quality, evidenceQuality: d.evidenceQuality, limitations: s?.limitations ?? [] }, [s?.sourceId, h?.sourceId]));
  }
  return out;
};

/** Which dimensions a question is about: the topic's, the subject's, or every read one (bounded). */
const dimensionsFor = (synthesis, topic) => {
  if (topic?.dimension) return synthesis.dimensions.filter((d) => d.dimension === topic.dimension);
  if (topic?.subjectId) { const m = synthesis.dimensions.filter((d) => d.supportingSubjects.some((s) => s.subjectId === topic.subjectId)); if (m.length) return m; }
  return synthesis.dimensions.slice(0, 6);
};

/** The facts for one question, by category and topic. Pure. */
const answerFacts = ({ context, synthesis, classification, lang = "en" } = {}) => {
  if (!context || !synthesis || !classification) { const e = new Error("context, synthesis and classification are required"); e.code = "CONTEXT_REQUIRED"; throw e; }
  const S = context.sources, topic = classification.topic ?? {}, facts = [];
  const none = (layer) => F("NOT_AVAILABLE_LAYER", "NOT_AVAILABLE", { layer, asOf: context.asOf }, []);
  switch (classification.category) {
    case "PROFILE_EXPLANATION": {
      const dims = dimensionsFor(synthesis, topic);
      if (!dims.length) facts.push(none("strength profile"));
      for (const d of dims) facts.push(...dimensionFacts(context, synthesis, d, { trajectory: false, change: false, contradictions: true }));
      break;
    }
    case "DEVELOPMENT_EXPLANATION": {
      const dims = dimensionsFor(synthesis, topic).filter((d) => d.trajectory);
      if (!dims.length || !S.development.length) facts.push(none("development history"));
      for (const d of dims) facts.push(...dimensionFacts(context, synthesis, d, { states: false, cross: false }));
      break;
    }
    case "GUIDANCE_EXPLANATION": {
      const items = S.guidance.filter((g) => (!topic.dimension || g.dimension === topic.dimension) && (!topic.subjectId || g.subjectId === topic.subjectId));
      if (!items.length) facts.push(none("guidance"));
      for (const g of items.slice(0, 8)) facts.push(F("GUIDANCE_ITEM", INF, { id: g.id, category: g.category, dimension: g.dimension, subjectId: g.subjectId, evidenceQuality: g.evidenceQuality, observed: g.observed, reasons: g.why?.reasons ?? [], suggestedActions: g.suggestedActions, evidenceToWatch: g.evidenceToWatch, agency: g.agency }, [g.sourceId, g.dimension ? `DEVELOPMENT_HISTORY:${g.dimension}` : null].filter((id) => id && itemById(context, id))));
      break;
    }
    case "INTERVENTION_EXPLANATION": {
      const docs = S.interventions.filter((x) => x.lifecycle && (!topic.dimension || x.dimension === topic.dimension)), triggers = S.interventions.filter((x) => !x.lifecycle && x.trigger && (!topic.dimension || x.dimension === topic.dimension));
      if (!docs.length && !triggers.length) facts.push(none("intervention"));
      for (const d of docs) facts.push(F("INTERVENTION_ITEM", INF, { dimension: d.dimension, trigger: d.trigger, objective: d.objective, action: d.action, ownerRole: d.ownerRole, lifecycle: d.lifecycle, startDate: d.startDate, reviewDate: d.reviewDate, outcome: d.outcome }, [d.sourceId]));
      for (const t of triggers) facts.push(F("INTERVENTION_TRIGGER", INF, { dimension: t.dimension, trigger: t.trigger, independentObservations: t.independentObservations }, [t.sourceId, `DEVELOPMENT_HISTORY:${t.dimension}`].filter((id) => itemById(context, id))));
      break;
    }
    case "PLAN_EXPLANATION": {
      const plans = S.plans.filter((p) => (!topic.planId || p.planId === topic.planId) && (!topic.dimension || p.dimension === topic.dimension));
      if (!plans.length) facts.push(none("development plan"));
      for (const p of plans.slice(0, 6)) {
        const reviews = S.planReviews.filter((r) => r.planId === p.planId);
        facts.push(F("PLAN_ITEM", INF, { planId: p.planId, dimension: p.dimension, objective: p.objective, status: p.status, milestones: p.milestones, rationale: { guidanceCategory: p.rationale?.guidanceCategory ?? null, observed: p.rationale?.observed ?? null, evidenceQuality: p.rationale?.evidenceQuality ?? null }, actions: p.actions, ownerRole: p.ownerRole }, [p.sourceId, ...(p.sourceGuidanceIds ?? []).map((g) => `GUIDANCE:${g}`).filter((id) => itemById(context, id))]));
        for (const a of p.adaptations ?? []) facts.push(F("PLAN_ADAPTATION", "OBSERVED", { planId: p.planId, at: a.at, previous: a.previous, next: a.next, reason: a.reason ?? null }, [p.sourceId]));
        for (const r of reviews.filter((x) => !x.current).slice(-2)) facts.push(F("PLAN_REVIEW", INF, { planId: p.planId, at: r.at, outcome: r.outcome, decision: r.decision, reasons: r.reasons ?? [] }, [r.sourceId]));
        const cur = reviews.find((x) => x.current); if (cur) facts.push(F("PLAN_CURRENT_READING", INF, { planId: p.planId, outcome: cur.outcome, reasons: cur.reasons ?? [], suggestedActions: cur.suggestedActions ?? [], contradiction: cur.contradiction ?? null }, [cur.sourceId]));
      }
      break;
    }
    case "EVIDENCE_QUESTION": {
      const dims = dimensionsFor(synthesis, topic);
      if (!dims.length) facts.push(none("evidence"));
      for (const d of dims.slice(0, 4)) facts.push(...dimensionFacts(context, synthesis, d, { states: true, trajectory: false, change: false, cross: true, contradictions: true, evidence: true }));
      break;
    }
    case "EXPLORATION_QUESTION": {
      const c = explorationCandidates({ context, synthesis, lang });
      if (classification.transformed === "CAREER_TO_EXPLORATION") facts.push(F("CAREER_TRANSFORMED", "NOT_AVAILABLE", { code: "CAREER_QUESTION_TRANSFORMED_TO_EXPLORATION" }, []));
      if (!c.candidates.length) facts.push(F("EXPLORATION_NONE", "NOT_AVAILABLE", { notSupported: c.notSupported.map((x) => ({ domain: x.domain, reason: x.reason })) }, []));
      for (const cand of c.candidates) facts.push(F("EXPLORATION_DOMAIN", "SUGGESTED_EXPLORATION", { domain: cand.domain, label: cand.label, description: cand.description, whyItAppeared: cand.whyItAppeared.map((w) => w.code + (w.dimension ? `:${w.dimension}` : w.area ? `:${w.area}` : "")), contradictory: cand.contradictoryEvidence.map((x) => x.code), evidenceQuality: cand.evidenceQuality, activities: cand.activities.slice(0, 3).map((a) => ({ activityId: a.activityId, title: a.title, level: a.level })), questions: cand.questionsToInvestigate.slice(0, 2), limitations: cand.limitations }, cand.citations));
      if (c.candidates.length) facts.push(F("NO_RANKING", "UNCERTAIN", { ordering: c.ordering, count: c.candidates.length }, []));
      break;
    }
    case "GENERAL_EDUCATIONAL": facts.push(F("GENERAL_NOT_FROM_EVIDENCE", "NOT_AVAILABLE", {}, [])); break;
    default: break;
  }
  return facts;
};

// ─────────────────────────────────────────────────────────────────────────────
// THE DETERMINISTIC ANSWER
// ─────────────────────────────────────────────────────────────────────────────

const sentence = (f, lang) => {
  const v = f.values, fr = lang === "fr", dim = human(v.dimension);
  switch (f.code) {
    case "DIMENSION_STATE": return fr ? `Vos preuves en ${dim} se lisent actuellement comme ${STATE_WORD.fr[v.state] ?? human(v.state)} (confiance : ${v.confidence} ; persistance : ${v.persistence ?? "non lue"}), appuyées par ${list(v.supportingSubjects, "fr")}.`
      : `Your evidence in ${dim} currently reads as ${STATE_WORD.en[v.state] ?? human(v.state)} (confidence: ${v.confidence}; persistence: ${v.persistence ?? "unread"}), supported by ${list(v.supportingSubjects, "en")}.`;
    case "CROSS_DOMAIN": {
      const supp = v.supportingSources.map((s) => SOURCE_WORD[fr ? "fr" : "en"][s] ?? human(s)), conf = v.conflictingSources.map((s) => SOURCE_WORD[fr ? "fr" : "en"][s] ?? human(s));
      if (v.relationship === "CORROBORATED_ACROSS_SOURCES") return fr ? `Cette lecture en ${dim} est appuyée par plusieurs sources indépendantes : ${list(supp, "fr")}.` : `This reading in ${dim} is supported by more than one independent source: ${list(supp, "en")}.`;
      if (v.relationship === "SINGLE_SOURCE") return fr ? `Cette lecture en ${dim} repose pour l'instant sur une seule source : ${list(supp, "fr")}.` : `This reading in ${dim} rests on one source so far: ${list(supp, "en")}.`;
      return fr ? `Les sources pour ${dim} ne concordent pas entièrement : ${list(supp, "fr")} l'appuient tandis que ${list(conf.length ? conf : v.contradictionKinds.map(human), "fr")} vont dans l'autre sens ; les moteurs conservent les preuves d'origine et enregistrent la contradiction.`
        : `The sources for ${dim} do not fully agree: ${list(supp, "en")} support it while ${list(conf.length ? conf : v.contradictionKinds.map(human), "en")} point the other way; the engines keep the original evidence and record the contradiction.`;
    }
    case "TRAJECTORY": return fr ? `Sur ${v.independentObservations} observation(s) indépendante(s) entre ${day(v.firstObservedAt)} et ${day(v.lastObservedAt)}, ${dim} a suivi une trajectoire ${TRAJ_WORD.fr[v.trajectory] ?? human(v.trajectory)}.`
      : `Over ${v.independentObservations} independent observation(s) between ${day(v.firstObservedAt)} and ${day(v.lastObservedAt)}, ${dim} has followed a trajectory that is ${TRAJ_WORD.en[v.trajectory] ?? human(v.trajectory)}.`;
    case "RECENT_CHANGE": {
      const l = v.latest;
      if (v.recentChange === "STATE_CHANGED" && l) return fr ? `Le changement le plus récent, observé le ${day(l.observedAt)}, a fait passer ${dim} de ${human(l.previousState)} à ${human(l.currentState)}.` : `The most recent change, observed on ${day(l.observedAt)}, moved ${dim} from ${human(l.previousState)} to ${human(l.currentState)}.`;
      if (v.recentChange === "CONTRADICTION") return fr ? `Le changement le plus récent en ${dim} a enregistré une contradiction entre sources.` : `The most recent change in ${dim} recorded a contradiction between sources.`;
      if (v.recentChange === "EVIDENCE_ADDED") return fr ? `De nouvelles preuves ont été ajoutées pour ${dim} sans changer son état.` : `New evidence was added for ${dim} without changing its state.`;
      if (v.recentChange === "RELATIONSHIP_CHANGED") return fr ? `La relation entre preuves académiques et preuves d'apprentissage pour ${dim} a changé.` : `The relationship between academic and learning evidence for ${dim} changed.`;
      if (v.recentChange === "INSUFFICIENT_HISTORY") return fr ? `Il n'y a pas encore assez d'historique pour dire ce qui a changé en ${dim}.` : `There is not yet enough history to say what changed in ${dim}.`;
      return fr ? `Aucun changement significatif en ${dim} n'a été enregistré dans la période récente.` : `No meaningful change in ${dim} has been recorded in the recent window.`;
    }
    case "CONTRADICTION": return fr ? `Une contradiction de type ${human(v.kind)} est enregistrée pour ${dim} (statut ${human(v.status)}, vue ${v.occurrences} fois) ; les preuves d'origine sont conservées et la lecture n'est pas écrasée.`
      : `A contradiction of kind ${human(v.kind)} is on record for ${dim} (status ${human(v.status)}, seen ${v.occurrences} time(s)); the original evidence is kept and the reading is not overwritten.`;
    case "GUIDANCE_ITEM": {
      const where = v.dimension ? human(v.dimension) : v.subjectId ? v.subjectId : (fr ? "le profil" : "the profile");
      const base = fr ? `L'orientation « ${human(v.category)} » pour ${where} est apparue sur une lecture du développement ${human(v.observed?.state)} avec une trajectoire ${human(v.observed?.trajectory)} (qualité des preuves ${human(v.evidenceQuality)}). Elle informe ; elle ne décide pas.`
        : `The guidance "${human(v.category)}" for ${where} appeared on a development reading of ${human(v.observed?.state)} with a ${human(v.observed?.trajectory)} trajectory (evidence quality ${human(v.evidenceQuality)}). It informs; it does not decide.`;
      const reasons = v.reasons?.length ? (fr ? ` Raisons enregistrées : ${list(v.reasons.map(human), "fr")}.` : ` Reasons recorded: ${list(v.reasons.map(human), "en")}.`) : "";
      const actions = v.suggestedActions?.length ? (fr ? ` Actions suggérées : ${list(v.suggestedActions.map(human), "fr")}.` : ` Suggested actions: ${list(v.suggestedActions.map(human), "en")}.`) : "";
      return base + reasons + actions;
    }
    case "INTERVENTION_ITEM": {
      const base = fr ? `Une intervention pour ${dim} a été proposée sur le déclencheur ${human(v.trigger)} : objectif « ${v.objective ?? human(v.trigger)} », action ${human(v.action)} ; elle est actuellement ${human(v.lifecycle)}.`
        : `An intervention for ${dim} was proposed on the trigger ${human(v.trigger)}: objective "${v.objective ?? human(v.trigger)}", action ${human(v.action)}; it is currently ${human(v.lifecycle)}.`;
      const o = v.outcome?.outcome ? (fr ? ` Le résultat observé après la période est ${human(v.outcome.outcome)} ; c'est ce qui a été observé, pas une cause.` : ` The outcome observed after the period is ${human(v.outcome.outcome)}; this is what was observed, not a cause.`) : "";
      return base + o;
    }
    case "INTERVENTION_TRIGGER": return fr ? `L'historique actuel appuie un déclencheur ${human(v.trigger)} pour ${dim} (${v.independentObservations} observations indépendantes) ; rien n'en a été créé.` : `The current history supports a ${human(v.trigger)} trigger for ${dim} (${v.independentObservations} independent observations); nothing has been created from it.`;
    case "PLAN_ITEM": {
      const base = fr ? `Le plan ${v.planId} pour ${dim} a l'objectif « ${v.objective?.code ?? human(v.objective?.category)} » (${human(v.objective?.category)}) et est ${human(v.status)} ; ${v.milestones?.completed ?? 0} jalon(s) sur ${v.milestones?.total ?? 0} atteint(s).`
        : `Plan ${v.planId} for ${dim} has the objective "${v.objective?.code ?? human(v.objective?.category)}" (${human(v.objective?.category)}) and is ${human(v.status)}; ${v.milestones?.completed ?? 0} of ${v.milestones?.total ?? 0} milestones completed.`;
      const why = v.rationale?.guidanceCategory ? (fr ? ` Il a été créé à partir de la catégorie d'orientation ${human(v.rationale.guidanceCategory)}, quand la lecture était ${human(v.rationale.observed?.state)} avec une qualité des preuves ${human(v.rationale.evidenceQuality)}.` : ` It was created from the guidance category ${human(v.rationale.guidanceCategory)}, when the reading was ${human(v.rationale.observed?.state)} with evidence quality ${human(v.rationale.evidenceQuality)}.`) : "";
      return base + why;
    }
    case "PLAN_ADAPTATION": return fr ? `Le ${day(v.at)}, le plan a été adapté : ${list(v.previous.map(human), "fr")} remplacé par ${list(v.next.map(human), "fr")}${v.reason ? ` (raison ${human(v.reason)})` : ""}. Une personne a choisi l'adaptation ; le moteur l'a suggérée.`
      : `On ${day(v.at)} the plan was adapted: ${list(v.previous.map(human), "en")} replaced by ${list(v.next.map(human), "en")}${v.reason ? ` (reason ${human(v.reason)})` : ""}. A person chose the adaptation; the engine suggested it.`;
    case "PLAN_REVIEW": return fr ? `La revue du ${day(v.at)} a lu ${human(v.outcome)}${v.reasons?.length ? ` (${list(v.reasons.map(human), "fr")})` : ""} et la décision enregistrée a été « ${v.decision} ».` : `The review on ${day(v.at)} read ${human(v.outcome)}${v.reasons?.length ? ` (${list(v.reasons.map(human), "en")})` : ""} and the decision recorded was "${v.decision}".`;
    case "PLAN_CURRENT_READING": return fr ? `La lecture actuelle du système pour le plan ${v.planId} est ${human(v.outcome)}${v.contradiction ? `, avec une contradiction (${human(v.contradiction)})` : ""} ; une personne décide de la suite.` : `The current system reading of plan ${v.planId} is ${human(v.outcome)}${v.contradiction ? `, with a contradiction (${human(v.contradiction)})` : ""}; a person decides what follows.`;
    case "EVIDENCE_SUPPORTING": return fr ? `Ce qui appuie ${dim} : ${list(v.sources.map((s) => SOURCE_WORD.fr[s] ?? human(s)), "fr")} ; matières ${list(v.subjects, "fr")} ; ${v.independentLearningEvents} événement(s) d'apprentissage indépendant(s) (${list(v.sourceFamilies, "fr")}) ; ${v.explorationEvents} exploration(s) ; ${v.teacherObservers} observateur(s) enseignant(s) ; ${v.independentObservations} observation(s) indépendante(s) dans le temps.`
      : `What supports ${dim}: ${list(v.sources.map((s) => SOURCE_WORD.en[s] ?? human(s)), "en")}; subjects ${list(v.subjects, "en")}; ${v.independentLearningEvents} independent learning event(s) (${list(v.sourceFamilies, "en")}); ${v.explorationEvents} exploration(s); ${v.teacherObservers} teacher observer(s); ${v.independentObservations} independent observation(s) over time.`;
    case "EVIDENCE_MISSING": return fr ? `Ce qui manque pour ${dim} : ${v.missingModalities.length ? list(v.missingModalities.map(human), "fr") : "aucune modalité manquante enregistrée"} ; couverture ${human(v.quality?.coverage ?? "non lue")}, récence ${human(v.quality?.recency ?? "non lue")}, indépendance ${human(v.quality?.independence ?? "non lue")} ; qualité des preuves ${human(v.evidenceQuality)}.`
      : `What is missing for ${dim}: ${v.missingModalities.length ? list(v.missingModalities.map(human), "en") : "no missing modality recorded"}; coverage ${human(v.quality?.coverage ?? "unread")}, recency ${human(v.quality?.recency ?? "unread")}, independence ${human(v.quality?.independence ?? "unread")}; evidence quality ${human(v.evidenceQuality)}.`;
    case "CAREER_TRANSFORMED": return fr ? `Ce service ne prédit ni ne recommande de métier. Voici plutôt les domaines que vos preuves actuelles appuient, sans classement, et des façons de les explorer. Le choix vous appartient.` : `This service does not predict or recommend a career. Instead, here are the areas your current evidence supports, unranked, and ways to investigate them. The choice is yours.`;
    case "EXPLORATION_NONE": return fr ? `Aucun domaine d'exploration n'est encore appuyé par les preuves actuelles ; il faut davantage de preuves avant qu'un domaine n'apparaisse.` : `No exploration area is supported by the current evidence yet; more evidence is needed before any area appears.`;
    case "EXPLORATION_DOMAIN": return fr ? `${v.label} est un domaine que vos preuves appuient actuellement (${list(v.whyItAppeared.map(human), "fr")}${v.contradictory.length ? ` ; en sens contraire : ${list(v.contradictory.map(human), "fr")}` : ""} ; qualité des preuves ${human(v.evidenceQuality)}). Activités pour l'explorer : ${list(v.activities.map((a) => a.title), "fr")}. À investiguer : ${v.questions[0] ?? ""}`
      : `${v.label} is an area your evidence currently supports (${list(v.whyItAppeared.map(human), "en")}${v.contradictory.length ? `; pointing the other way: ${list(v.contradictory.map(human), "en")}` : ""}; evidence quality ${human(v.evidenceQuality)}). Activities you could use to investigate it: ${list(v.activities.map((a) => a.title), "en")}. To investigate: ${v.questions[0] ?? ""}`;
    case "NO_RANKING": return fr ? `Ces ${v.count} domaines sont listés par ordre alphabétique, sans classement ; aucun n'est « le meilleur ».` : `These ${v.count} areas are listed alphabetically, not ranked; none is "best".`;
    case "GENERAL_NOT_FROM_EVIDENCE": return fr ? `C'est une question générale d'étude ; rien dans vos preuves enregistrées n'y répond. Ce service ne peut décrire que ce que vos preuves montrent.` : `This is a general study question; nothing in your recorded evidence answers it. This service can only describe what your recorded evidence shows.`;
    case "NOT_AVAILABLE_LAYER": return fr ? `Aucune donnée « ${v.layer} » n'est disponible pour cet élève au ${day(v.asOf)}.` : `No ${v.layer} is available for this student as of ${day(v.asOf)}.`;
    default: return null;
  }
};

const SUGGESTED = {
  en: { PROFILE_EXPLANATION: ["What changed?", "What evidence supports this?", "What areas should I explore?"], DEVELOPMENT_EXPLANATION: ["Why is this showing on my profile?", "What evidence is missing?"], GUIDANCE_EXPLANATION: ["Why was this plan created?", "What evidence supports this?"], INTERVENTION_EXPLANATION: ["Why did this guidance appear?", "What changed?"], PLAN_EXPLANATION: ["Why was my plan adapted?", "What evidence supports this?"], EVIDENCE_QUESTION: ["What changed?", "What areas should I explore?"], EXPLORATION_QUESTION: ["What evidence supports this?", "Why do you say this is a strength?"], GENERAL_EDUCATIONAL: ["Why is this showing on my profile?", "What areas should I explore?"], default: ["Why is this showing on my profile?", "What changed?", "What areas should I explore?"] },
  fr: { PROFILE_EXPLANATION: ["Qu'est-ce qui a changé ?", "Quelles preuves appuient cela ?", "Quels domaines pourrais-je explorer ?"], DEVELOPMENT_EXPLANATION: ["Pourquoi cela apparaît-il sur mon profil ?", "Quelles preuves manquent ?"], GUIDANCE_EXPLANATION: ["Pourquoi ce plan a-t-il été créé ?", "Quelles preuves appuient cela ?"], INTERVENTION_EXPLANATION: ["Pourquoi cette orientation est-elle apparue ?", "Qu'est-ce qui a changé ?"], PLAN_EXPLANATION: ["Pourquoi mon plan a-t-il été adapté ?", "Quelles preuves appuient cela ?"], EVIDENCE_QUESTION: ["Qu'est-ce qui a changé ?", "Quels domaines pourrais-je explorer ?"], EXPLORATION_QUESTION: ["Quelles preuves appuient cela ?", "Pourquoi dites-vous que c'est une force ?"], GENERAL_EDUCATIONAL: ["Pourquoi cela apparaît-il sur mon profil ?", "Quels domaines pourrais-je explorer ?"], default: ["Pourquoi cela apparaît-il sur mon profil ?", "Qu'est-ce qui a changé ?", "Quels domaines pourrais-je explorer ?"] },
};

const uncertaintyOf = (context, synthesis, lang) => {
  const fr = lang === "fr", parts = [];
  if (!synthesis.overall.historySufficient) parts.push(fr ? "l'historique est encore court" : "the history is still short");
  if (synthesis.overall.openContradictions) parts.push(fr ? `${synthesis.overall.openContradictions} contradiction(s) reste(nt) ouverte(s)` : `${synthesis.overall.openContradictions} contradiction(s) remain open`);
  const missing = [...new Set(synthesis.dimensions.flatMap((d) => d.missingModalities))];
  if (missing.length) parts.push(fr ? `modalités non disponibles : ${list(missing.map(human), "fr")}` : `unavailable modalities: ${list(missing.map(human), "en")}`);
  if (context.limitations.some((l) => l.startsWith("FUTURE_EVIDENCE_EXCLUDED"))) parts.push(fr ? "les preuves postérieures à la date demandée sont exclues" : "evidence after the requested date is excluded");
  return parts.length ? (fr ? `Ce que les preuves ne tranchent pas : ${parts.join(" ; ")}.` : `What the evidence does not settle: ${parts.join("; ")}.`) : (fr ? "Aucune incertitude particulière au-delà des limites listées." : "No particular uncertainty beyond the listed limitations.");
};

/** The refusal or the deterministic answer, as one contract object. */
const refusalAnswer = ({ classification, lang = "en" } = {}) => {
  const fr = lang === "fr", t = classification.threats ?? [];
  let answer;
  if (classification.category === "UNAUTHORIZED") answer = fr ? `Cette demande porte sur des informations qui ne vous sont pas accessibles ici (${list(t.map(human), "fr")}). Le service d'explication ne décrit que vos propres preuves enregistrées.` : `This request asks for information that is not available to you here (${list(t.map(human), "en")}). The explanation service only describes your own recorded evidence.`;
  else if (classification.category === "SENSITIVE") answer = fr ? "Cette question touche à quelque chose pour lequel ce service n'est pas conçu. Parlez-en à un enseignant, à un parent ou à un adulte de confiance à l'école. Le service peut toujours expliquer vos preuves d'apprentissage enregistrées si vous l'interrogez à ce sujet." : "This question raises something this service is not built to help with. Please speak to a teacher, a parent or a trusted adult at school. The service can still explain your recorded learning evidence if you ask about it.";
  else if (t.length) answer = fr ? `La question contenait des instructions que le service ne suit pas (${list(t.map(human), "fr")}). Il répond uniquement aux questions sur vos preuves enregistrées.` : `The question contained instructions the service does not follow (${list(t.map(human), "en")}). It answers questions about your recorded evidence only.`;
  else answer = fr ? "Le service n'a pas pu déterminer sur quoi porte cette question. Il peut expliquer votre profil, ce qui a changé, pourquoi une orientation, une intervention ou un plan est apparu, quelles preuves appuient ou manquent, et quels domaines vous pourriez explorer." : "The service could not tell what this question asks about. It can explain your profile, what changed, why guidance, interventions or plans appeared, what evidence supports or is missing, and which areas you could explore.";
  return { answer, claims: [{ text: answer, type: "NOT_AVAILABLE", citations: [] }], uncertainty: "", limitations: [`QUESTION_${classification.category}`, ...t.map((x) => `INPUT_${x}`)], suggestedQuestions: SUGGESTED[fr ? "fr" : "en"].default };
};

const deterministicAnswer = ({ context, synthesis, classification, facts, lang = "en" } = {}) => {
  if (!V.NARRATABLE_CATEGORIES.includes(classification?.category)) return refusalAnswer({ classification, lang });
  const fr = lang === "fr";
  const claims = [];
  for (const f of facts ?? []) { const text = sentence(f, lang); if (text) claims.push({ text, type: f.type, citations: f.citations }); if (claims.length >= LIMITS.claims) break; }
  let answer = claims.map((c) => c.text).join(" ");
  while (answer.length > LIMITS.answerChars && claims.length > 1) { claims.pop(); answer = claims.map((c) => c.text).join(" "); }
  if (!answer) { answer = fr ? "Aucune preuve structurée n'est disponible pour répondre à cette question." : "No structured evidence is available to answer this question."; claims.push({ text: answer, type: "NOT_AVAILABLE", citations: [] }); }
  return { answer, claims, uncertainty: uncertaintyOf(context, synthesis, lang), limitations: context.limitations.slice(0, LIMITS.limitations), suggestedQuestions: SUGGESTED[fr ? "fr" : "en"][classification.category] ?? SUGGESTED[fr ? "fr" : "en"].default };
};

// ─────────────────────────────────────────────────────────────────────────────
// THE GROUNDING VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

const DECLINING_WORDS = /\b(declin(e|ed|ing)|weaken(ed|ing)?|getting worse|dropp(ed|ing)|falling|en d[ée]clin|s'affaibli)/i;
const STRONG_WORDS = /\b(established strength|consistently strong|remained strong|remains strong|well[- ]established|force [ée]tablie|reste(nt)? (fort|solide))/i;
const CATEGORY_TOKENS = /\b(SEEK_SUPPORT|CHANGE_APPROACH|REFLECT|BUILD_EVIDENCE|MONITOR|MAINTAIN|DEEPEN|EXPLORE|PRACTICE|REVISIT)\b/g;
const DATE_TOKENS = /\b(20\d\d-\d\d-\d\d)\b/g;
const PLAN_STATUS_WORDS = /\bplan (is|was|has been) (completed|closed|paused|declined)\b/i;

const contradicts = (text, item, context) => {
  if (!item) return null;
  if (item.sourceType === "STRENGTH_PROFILE" && item.state && item.dimension) {
    const h = itemById(context, `DEVELOPMENT_HISTORY:${item.dimension}`);
    const decliningSomewhere = item.direction === "declining" || (item.decliningSubjects ?? []).length > 0 || ["DECLINING", "WEAKENING", "STABLE_DECLINING"].includes(h?.trajectory);
    if (DECLINING_WORDS.test(text) && ["ESTABLISHED", "EMERGING"].includes(item.state) && !decliningSomewhere) return `STATE:${item.state}`;
    if (STRONG_WORDS.test(text) && ["DECLINING", "INSUFFICIENT"].includes(item.state)) return `STATE:${item.state}`;
  }
  if (item.sourceType === "DEVELOPMENT_HISTORY" && item.trajectory && item.dimension) {
    const s = itemById(context, `STRENGTH_PROFILE:${item.dimension}`);
    if (DECLINING_WORDS.test(text) && ["STABLE_ESTABLISHED", "STRENGTHENING", "STABLE_EMERGING", "EMERGING", "RECOVERING"].includes(item.trajectory) && item.direction !== "declining" && !(s?.decliningSubjects ?? []).length) return `TRAJECTORY:${item.trajectory}`;
    if (STRONG_WORDS.test(text) && ["DECLINING", "WEAKENING", "STABLE_DECLINING", "INSUFFICIENT_HISTORY"].includes(item.trajectory)) return `TRAJECTORY:${item.trajectory}`;
  }
  if (item.sourceType === "GUIDANCE" && item.category) {
    const named = [...new Set((text.match(CATEGORY_TOKENS) ?? []))];
    if (named.length && !named.includes(item.category)) return `CATEGORY:${item.category}`;
  }
  if (item.sourceType === "DEVELOPMENT_PLAN" && item.status) {
    const m = text.match(PLAN_STATUS_WORDS);
    if (m && m[2].toUpperCase() !== item.status) return `PLAN_STATUS:${item.status}`;
  }
  return null;
};

/**
 * Validate a structured output against the context it was made from.
 * @returns {{ valid: boolean, issues: Array<{code, claim?, detail?}> }}
 */
const validateExplanation = ({ output, context, unauthorizedTerms = [] } = {}) => {
  const issues = validateOutputShape(output);
  if (issues.length) return { valid: false, issues };
  if (hasForbiddenKey(output)) issues.push({ code: "MALFORMED_OUTPUT", detail: "FORBIDDEN_KEY" });
  const texts = [["answer", output.answer], ["uncertainty", output.uncertainty], ...output.claims.map((c, i) => [`claim:${i}`, c.text]), ...output.suggestedQuestions.map((q, i) => [`question:${i}`, q])];
  const terms = (unauthorizedTerms ?? []).map((t) => String(t ?? "").trim().toLowerCase()).filter((t) => t.length >= 3);
  for (const [where, text] of texts) {
    for (const code of screenOutput(text)) issues.push({ code, where });
    const lower = String(text).toLowerCase();
    for (const t of terms) if (lower.includes(t)) issues.push({ code: "UNAUTHORIZED_DATA", where });
    for (const d of String(text).match(DATE_TOKENS) ?? []) if (`${d}T00:00:00.000Z` > context.asOf) issues.push({ code: "FUTURE_EVIDENCE", where, detail: d });
  }
  output.claims.forEach((c, i) => {
    if (V.CITED_CLAIM_TYPES.includes(c.type) && !c.citations.length) issues.push({ code: "UNSUPPORTED_CLAIM", claim: i });
    for (const issue of validateCitations(c.citations, context)) issues.push({ ...issue, claim: i });
    for (const c0 of c.citations) { const id = citationId(c0); const why = contradicts(c.text, itemById(context, id), context); if (why) issues.push({ code: "CONTRADICTS_EVIDENCE", claim: i, sourceId: id, detail: why }); }
  });
  const seen = new Set();
  const unique = issues.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; });
  return { valid: unique.length === 0, issues: unique };
};

module.exports = { answerFacts, deterministicAnswer, refusalAnswer, validateExplanation, sentence, dimensionsFor, SUGGESTED };
