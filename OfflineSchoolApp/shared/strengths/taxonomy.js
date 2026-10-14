// shared/strengths/taxonomy.js
"use strict";

/**
 * The vocabulary of the strengths layer: ten exploration dimensions, how a
 * school subject speaks to them, which combinations open which exploration
 * areas, and what a pupil might do to explore one.
 *
 * ── What a dimension is, and is not ───────────────────────────────────────
 *
 * A dimension is a place where school evidence can recur — "quantitative
 * reasoning" is where Mathematics and Physics marks meet. It is not a trait.
 * Nothing here says a child IS analytical; it says the evidence a school holds
 * is consistent with strength in analytical work. The wording the application
 * uses is fixed by that distinction, and the codes are named so a sentence
 * built from them cannot slide into a diagnosis.
 *
 * ── Subjects are matched by name, deliberately ────────────────────────────
 *
 * Schools name their subjects; there is no platform-wide subject taxonomy and
 * inventing one would be a second source of truth. So a subject reaches a
 * dimension through keywords in its name, English or French, each match
 * carrying a weight (1 = the subject is squarely about it, 0.5 = it draws on
 * it). A subject that matches nothing still counts: it can be a single-subject
 * strength under its own name. Unmatched is not unimportant.
 *
 * ── Areas are exploration, not occupation ─────────────────────────────────
 *
 * An exploration area is a broad domain a pupil might look into next, opened
 * by evidence in one or more dimensions. "Quantitative & scientific" is an
 * area; "engineer" is not, and no code in this file names a profession.
 *
 * ── Frozen by version ─────────────────────────────────────────────────────
 *
 * Changing a keyword, a weight, a combination or an activity changes what a
 * profile says. Any such change increments STRENGTH_ENGINE_VERSION in
 * index.js; the academic engine's version is untouched by it.
 */

/** The ten dimensions, in the order a reader meets them. */
const DIMENSIONS = Object.freeze([
  "quantitative_reasoning",
  "scientific_reasoning",
  "language_communication",
  "reading_interpretation",
  "analytical_reasoning",
  "creative_expression",
  "social_collaborative",
  "technical_applied",
  "organizational_structured",
  "visual_spatial",
]);

/**
 * Subject-name keywords → dimension weights. Lower-cased, accent-insensitive
 * matching; the first entry whose keywords match wins for a given subject.
 * Weight 1 means the subject is about the dimension; 0.5 that it draws on it.
 */
const SUBJECT_KEYWORDS = Object.freeze([
  { keywords: ["further math", "additional math", "pure math"], dims: { quantitative_reasoning: 1, analytical_reasoning: 0.5 } },
  { keywords: ["math", "mathématiques", "mathematiques", "arithm"],  dims: { quantitative_reasoning: 1 } },
  { keywords: ["physic", "physique"],                                dims: { scientific_reasoning: 1, quantitative_reasoning: 0.5 } },
  { keywords: ["chemistry", "chimie"],                               dims: { scientific_reasoning: 1 } },
  { keywords: ["biology", "biologie", "svt", "sciences de la vie", "life science", "human biology"], dims: { scientific_reasoning: 1 } },
  { keywords: ["science"],                                           dims: { scientific_reasoning: 1 } },
  { keywords: ["computer", "informatique", "ict", "programming", "coding"], dims: { technical_applied: 1, quantitative_reasoning: 0.5 } },
  { keywords: ["technical drawing", "dessin technique", "engineering drawing", "graphic"], dims: { visual_spatial: 1, technical_applied: 0.5 } },
  { keywords: ["technolog", "workshop", "woodwork", "metalwork", "electricity", "electronics", "mechanic", "building", "agricultur", "home economics", "food and nutrition"], dims: { technical_applied: 1 } },
  { keywords: ["literature", "littérature", "litterature"],          dims: { reading_interpretation: 1, language_communication: 0.5 } },
  { keywords: ["english", "anglais", "french", "français", "francais", "language", "langue", "spanish", "espagnol", "german", "allemand", "latin", "arabic", "arabe", "chinese", "chinois"], dims: { language_communication: 1, reading_interpretation: 0.5 } },
  { keywords: ["history", "histoire"],                               dims: { reading_interpretation: 1, analytical_reasoning: 0.5 } },
  { keywords: ["geograph", "géographie", "geographie"],              dims: { analytical_reasoning: 0.5, visual_spatial: 0.5, scientific_reasoning: 0.5 } },
  { keywords: ["economic", "économie", "economie", "commerce", "accounting", "comptabilit", "business", "gestion"], dims: { organizational_structured: 1, quantitative_reasoning: 0.5 } },
  { keywords: ["philosoph", "logic", "logique"],                     dims: { analytical_reasoning: 1, reading_interpretation: 0.5 } },
  { keywords: ["citizenship", "civic", "ecm", "éducation civique", "education civique", "religio", "moral"], dims: { social_collaborative: 0.5, reading_interpretation: 0.5 } },
  { keywords: ["art", "drawing", "dessin", "music", "musique", "drama", "theatre", "théâtre", "design", "craft"], dims: { creative_expression: 1, visual_spatial: 0.5 } },
  { keywords: ["physical education", "sport", "eps", "éducation physique", "education physique"], dims: { social_collaborative: 0.5 } },
]);

/**
 * Exploration areas: which dimensions open them, and ways to explore. An area
 * opens on ANY of its `openedBy` dimension sets being present (each set is a
 * conjunction). The activities are ways to look further, never proof of fit.
 */
const EXPLORATION_AREAS = Object.freeze([
  { code: "quantitative_scientific", openedBy: [["quantitative_reasoning", "scientific_reasoning"]],
    activities: ["mathematics_problem_solving", "science_projects", "measurement_and_modelling", "data_exploration"] },
  { code: "mathematical",            openedBy: [["quantitative_reasoning"]],
    activities: ["mathematics_problem_solving", "mathematics_competitions", "logic_puzzles"] },
  { code: "life_sciences",           openedBy: [["scientific_reasoning"]],
    activities: ["science_projects", "nature_and_environment_studies", "laboratory_practice"] },
  { code: "computational_technical", openedBy: [["technical_applied"], ["quantitative_reasoning", "technical_applied"]],
    activities: ["programming_projects", "electronics_or_making", "computer_clubs"] },
  { code: "language_media",          openedBy: [["language_communication"], ["language_communication", "reading_interpretation"]],
    activities: ["writing_and_essays", "public_speaking_and_debate", "school_newspaper_or_radio", "additional_languages"] },
  // Opens on reading alone too: a primary subject (History, Literature) or two
  // secondary ones can establish it; English alone cannot (see engine.js).
  { code: "humanities_social",       openedBy: [["reading_interpretation", "analytical_reasoning"], ["reading_interpretation"]],
    activities: ["reading_and_research_projects", "history_and_geography_clubs", "debate"] },
  { code: "creative_arts",           openedBy: [["creative_expression"], ["creative_expression", "visual_spatial"]],
    activities: ["art_design_or_media_projects", "music_or_drama", "creative_writing"] },
  { code: "design_spatial",          openedBy: [["visual_spatial"], ["visual_spatial", "technical_applied"]],
    activities: ["technical_drawing_and_modelling", "design_projects", "maps_and_construction_activities"] },
  { code: "organisation_enterprise", openedBy: [["organizational_structured"]],
    activities: ["school_enterprise_or_cooperative", "event_organisation", "budgeting_exercises"] },
  { code: "collaborative_service",   openedBy: [["social_collaborative"]],
    activities: ["team_projects", "peer_tutoring", "community_service_activities"] },
]);

/** Unicode-insensitive lower-casing for matching. */
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * The dimension weights a subject name speaks to. Empty when nothing matches —
 * the subject is then a candidate single-subject strength under its own name.
 */
const dimensionsForSubject = (subjectName) => {
  const n = norm(subjectName);
  if (!n) return {};
  const hit = SUBJECT_KEYWORDS.find((e) => e.keywords.some((k) => n.includes(norm(k))));
  return hit ? { ...hit.dims } : {};
};

module.exports = { DIMENSIONS, SUBJECT_KEYWORDS, EXPLORATION_AREAS, dimensionsForSubject, norm };
