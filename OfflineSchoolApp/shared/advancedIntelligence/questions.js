// shared/advancedIntelligence/questions.js
"use strict";

/**
 * Question classification — deterministic, before any model.
 *
 * A question is placed in one category by keyword, in a fixed priority:
 * what would be unauthorised or sensitive is decided first and never reaches
 * a model; then the layer the question is about; then the general case.
 * A career question is not refused: it becomes an exploration question,
 * because "what should I become" has an honest answer in this system —
 * "here are the areas your evidence currently supports, and ways to
 * investigate them" — and no honest answer of the form the pupil asked for.
 *
 * The classifier also lifts the topic out of the sentence: a dimension, a
 * subject, a plan id, an exploration area — the handles the deterministic
 * answer needs to choose its facts. A topic it cannot find is null, never
 * guessed.
 */

const { screenInput, isSensitive } = require("./safety");
const { DIMENSIONS } = require("../strengths/taxonomy");

const CAREER = /\b(career|profession|job|occupation|what (should|will|could) i (become|be|do (when|after)|study at university)|become an?|future (work|path)|what am i going to be|which (course|degree|university)|orientation professionnelle|m[ée]tier)\b/i;
const EXPLORE = /\b(explore|exploration|areas?|domains?|fields?|try (out|something|new|next)|investigate|discover|activities|activity|what (could|can|should) i try|next step|what (else|more) (could|can) i|what suits me|what am i good at|interested in)\b/i;
const PLAN = /\b(plan|milestone|adapt|adapted|adaptation|review(ed)?|objective|paused?|why was (my|the|this) plan|plan (created|made|opened))\b/i;
const INTERVENTION = /\b(intervention|support (session|plan|action)|trigger|proposed support|why (was|is) (this|the) support|outcome of)\b/i;
const GUIDANCE = /\b(guidance|advice|advise|suggest(ion|ed)?|recommend(ation|ed)?|what should i do|why (did|does) this (guidance|suggestion|advice) appear)\b/i;
const EVIDENCE = /\b(evidence|missing|support(s|ing)? (this|that|it)|proof|prove|based on|why do you say|where does this come from|how do you know|what (data|information) (do you|did you)|source)\b/i;
const DEVELOPMENT = /\b(what (has )?changed|change[ds]?|trajectory|progress(ed|ing)?|develop(ed|ing|ment)?|over time|history|improv(ed|ing|ement)|declin(ed|ing|e)|since (last|term)|compared to (before|last)|getting (better|worse)|trend)\b/i;
const PROFILE = /\b(strength|strengths|profile|showing|why is this|emerging|established|why (do|did) you say|why does it say|what does .* mean|weak(ness)?|good at|not good at)\b/i;

// The French a pupil on the mobile app types — the other language the
// application speaks. `\b` does not know an accented letter is a letter
// ("changé " has no word boundary after the é), so these are bounded with
// Unicode-aware lookarounds instead. Same topics, French stems.
const fr = (...stems) => new RegExp(`(?<!\\p{L})(?:${stems.join("|")})(?!\\p{L})`, "iu");
const EXPLORE_FR = fr("explor(?:er|ation)", "domaines?", "activit[ée]s?", "essayer", "d[ée]couvrir", "que pourrais-je (?:essayer|explorer)");
const PLAN_FR = fr("jalons?", "adapt[ée]e?", "objectif", "revue", "pourquoi (?:mon|ce|le) plan");
const INTERVENTION_FR = fr("accompagnement", "d[ée]clencheur", "soutien");
const GUIDANCE_FR = fr("orientation", "conseils?", "sugg[ée]r[ée]e?", "que (?:dois|devrais)-je faire");
const EVIDENCE_FR = fr("preuves?", "manque", "appuie(?:nt)?", "pourquoi dites-vous", "d'o[uù] vient");
const DEVELOPMENT_FR = fr("chang[ée]s?", "changement", "trajectoire", "progr[èe]s", "[ée]volu(?:tion|[ée])", "d[ée]veloppement", "historique", "am[ée]lior[ée]e?", "d[ée]clin", "au fil du temps");
const PROFILE_FR = fr("forces?", "profil", "montre", "pourquoi (?:ceci|cela|ça)", "[ée]mergente?", "[ée]tablie?", "que signifie", "faible(?:sse)?");
const either = (en, frRe, q) => en.test(q) || frRe.test(q);
const GENERAL = /\b(how (do|can|should) i (study|revise|learn|prepare|improve|practise|practice|remember|concentrate|focus)|study (tips?|habits?|technique)|revision|exam (tips?|preparation)|homework tips?|note[- ]taking|time management|learning strateg)\b/i;

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const topicOf = (text, { subjects = [], planIds = [], areas = [] } = {}) => {
  const t = norm(text);
  const dimension = DIMENSIONS.find((d) => t.includes(d.replace(/_/g, " ")) || t.includes(d)) ?? null;
  const subject = (subjects ?? []).find((s) => s.subjectName && t.includes(norm(s.subjectName))) ?? null;
  const planId = (planIds ?? []).find((p) => t.includes(norm(p))) ?? null;
  const area = (areas ?? []).find((a) => t.includes(a.replace(/_/g, " ")) || t.includes(a)) ?? null;
  return { dimension, subjectId: subject?.subjectId ?? null, subjectName: subject?.subjectName ?? null, planId, area };
};

const UNAUTHORIZED_THREATS = ["CROSS_STUDENT_REQUEST", "PRIVATE_DATA_REQUEST", "CREDENTIAL_REQUEST", "SYSTEM_PROMPT_EXTRACTION"];

/**
 * Classify one question.
 * @returns {{ category, threats, sensitive, transformed, topic, reason }}
 */
const classifyQuestion = ({ text, subjects = [], planIds = [], areas = [] } = {}) => {
  const q = String(text ?? "").trim();
  const threats = screenInput(q);
  const topic = topicOf(q, { subjects, planIds, areas });
  const out = (category, reason, transformed = null) => ({ category, threats, sensitive: isSensitive(q), transformed, topic, reason });
  if (!q) return out("UNSUPPORTED", "EMPTY_QUESTION");
  if (threats.some((t) => UNAUTHORIZED_THREATS.includes(t))) return out("UNAUTHORIZED", "INPUT_SCREEN");
  if (isSensitive(q)) return out("SENSITIVE", "SENSITIVE_TOPIC");
  if (threats.length) return out("UNSUPPORTED", "INPUT_SCREEN");
  if (CAREER.test(q)) return out("EXPLORATION_QUESTION", "CAREER_QUESTION", "CAREER_TO_EXPLORATION");
  if (either(PLAN, PLAN_FR, q)) return out("PLAN_EXPLANATION", "KEYWORD");
  if (either(INTERVENTION, INTERVENTION_FR, q)) return out("INTERVENTION_EXPLANATION", "KEYWORD");
  if (either(EXPLORE, EXPLORE_FR, q)) return out("EXPLORATION_QUESTION", "KEYWORD");
  if (either(GUIDANCE, GUIDANCE_FR, q)) return out("GUIDANCE_EXPLANATION", "KEYWORD");
  if (either(EVIDENCE, EVIDENCE_FR, q)) return out("EVIDENCE_QUESTION", "KEYWORD");
  if (either(DEVELOPMENT, DEVELOPMENT_FR, q)) return out("DEVELOPMENT_EXPLANATION", "KEYWORD");
  if (either(PROFILE, PROFILE_FR, q)) return out("PROFILE_EXPLANATION", "KEYWORD");
  if (GENERAL.test(q)) return out("GENERAL_EDUCATIONAL", "KEYWORD");
  return out("UNSUPPORTED", "NO_MATCH");
};

module.exports = { classifyQuestion, topicOf, UNAUTHORIZED_THREATS };
