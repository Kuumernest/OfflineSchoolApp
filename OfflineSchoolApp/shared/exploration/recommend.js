// shared/exploration/recommend.js
"use strict";

/**
 * Which activities to put in front of a pupil, and why — deterministically.
 *
 * ── Inputs and output ─────────────────────────────────────────────────────
 *
 * In: the strengths profile (shared/strengths), the pupil's exploration
 * history (what they completed, skipped, declined, have in progress), the
 * resources actually available, and how many suggestions to make. Out: a
 * list of activities each carrying its relevance, its reason codes, the
 * dimensions and subjects behind it, and the versions of the evidence and of
 * this recommender. Nothing here names a career, and nothing is a score of
 * the pupil.
 *
 * ── The diversity rule, stated so it can be tested ────────────────────────
 *
 * Of N suggestions: ceil(N/2) ALIGNED with the areas the pupil's evidence
 * opened (strong first, then emerging); floor(N/4) ADJACENT (areas next to
 * an aligned one, see ADJACENT_AREAS); the rest DISCOVERY (areas with no
 * evidence and the fewest previous explorations first). For six: 3 / 1 / 2.
 * When a bucket has too few candidates the shortfall spills to discovery,
 * then to adjacent, then to aligned, so the list is filled if the catalog
 * can fill it. "Strong in Mathematics → only Mathematics forever" is what this
 * rule exists to prevent.
 *
 * ── History, honoured ─────────────────────────────────────────────────────
 *
 * Completed, abandoned and declined (NOT_INTERESTED) activities are not
 * suggested again. Skipped ones go to the back of their bucket. In-progress
 * ones (discovered, saved, started, submitted) are the pupil's list already
 * and are excluded here. A completed activity in an area moves the area's
 * next suggestion up one level (PREVIOUS_ACTIVITY_FOLLOWUP); nothing about a
 * level is a measure of the pupil.
 *
 * ── Interest, as a reason and never as ability ────────────────────────────
 *
 * An interest signal in an area (from the strengths profile's interestSignals)
 * adds the reason STUDENT_INTEREST and moves the area up within its bucket.
 * It does not move an area from discovery to aligned: interest is not
 * evidence of strength, and the relevance says which one it is.
 */

const { ACTIVITIES, LEVELS, ADJACENT_AREAS, AREAS, EXPLORATION_ENGINE_VERSION } = require("./catalog");
const { EXPLORATION_AREAS } = require("../strengths/taxonomy");

const REASONS = Object.freeze([
  "RECURRING_STRENGTH", "EMERGING_STRENGTH", "RELATED_EXPLORATION", "NEW_DOMAIN_EXPLORATION",
  "STUDENT_INTEREST", "PREVIOUS_ACTIVITY_FOLLOWUP", "RESOURCE_AVAILABLE",
]);

/** The exact proportions. Documented here and asserted in check-exploration.js. */
const quota = (n) => {
  const aligned  = Math.ceil(n / 2);
  const adjacent = Math.floor(n / 4);
  return { aligned, adjacent, discovery: Math.max(0, n - aligned - adjacent) };
};

const CLOSED = new Set(["COMPLETED", "ABANDONED", "NOT_INTERESTED"]);
const OPEN   = new Set(["DISCOVERED", "SAVED", "STARTED", "SUBMITTED", "REVIEW_REQUIRED"]);

const LEVEL_RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]));
const AREA_LEVEL_RANK = { strong: 0, emerging: 1, limited: 2 };

/** The area an interest signal points at, via its dimension when it has no area. */
const areaOfSignal = (s) => {
  if (s.area) return s.area;
  if (!s.dimension) return null;
  return EXPLORATION_AREAS.find((a) => a.openedBy.some((set) => set.includes(s.dimension)))?.code ?? null;
};

/**
 * @param {object} input
 * @param {object} input.strengthProfile   shared/strengths buildStrengthProfile output (or null)
 * @param {object[]} [input.history]       rows { activityId, area, level, status }
 * @param {string[]|null} [input.resources] what is available; null = do not filter
 * @param {number} [input.count]
 */
/**
 * `saturation`: when a number, an aligned area with that many COMPLETED
 * activities yields its slot to adjacent and discovery areas — the pupil can
 * still open it from the catalog; the list stops repeating it. Omitted (the
 * 1.0.0 contract), nothing changes. A suggestion is never justified by having
 * been suggested before: every reason here is an evidence reason.
 */
const recommend = ({ strengthProfile = null, history = [], resources = null, count = 6, saturation = null } = {}) => {
  const n = Math.max(1, Math.min(12, Number(count) || 6));
  const q = quota(n);

  // Areas the evidence opened, strong first; the dimensions and subjects behind each.
  const opened = (strengthProfile?.explorationAreas ?? [])
    .slice()
    .sort((a, b) => AREA_LEVEL_RANK[a.evidenceLevel] - AREA_LEVEL_RANK[b.evidenceLevel] || a.area.localeCompare(b.area));
  const openedByArea = new Map(opened.map((a) => [a.area, a]));
  const alignedAreas = opened.map((a) => a.area);

  const adjacentAreas = [...new Set(alignedAreas.flatMap((a) => ADJACENT_AREAS[a] ?? []))]
    .filter((a) => !openedByArea.has(a)).sort();

  const explorationsByArea = new Map();
  for (const h of history) explorationsByArea.set(h.area, (explorationsByArea.get(h.area) ?? 0) + 1);
  const completedByArea = new Map();
  for (const h of history.filter((x) => x.status === "COMPLETED")) completedByArea.set(h.area, (completedByArea.get(h.area) ?? 0) + 1);
  const saturated = saturation === null ? [] : alignedAreas.filter((a) => (completedByArea.get(a) ?? 0) >= saturation);
  const discoveryAreas = AREAS.filter((a) => !openedByArea.has(a) && !adjacentAreas.includes(a))
    .sort((a, b) => (explorationsByArea.get(a) ?? 0) - (explorationsByArea.get(b) ?? 0) || a.localeCompare(b));

  const interestAreas = new Set((strengthProfile?.interestSignals ?? []).map(areaOfSignal).filter(Boolean));

  const closed  = new Set(history.filter((h) => CLOSED.has(h.status)).map((h) => h.activityId));
  const open    = new Set(history.filter((h) => OPEN.has(h.status)).map((h) => h.activityId));
  const skipped = new Set(history.filter((h) => h.status === "SKIPPED").map((h) => h.activityId));
  const completedLevelByArea = new Map();
  for (const h of history.filter((h) => h.status === "COMPLETED")) {
    const r = LEVEL_RANK[h.level] ?? 0;
    completedLevelByArea.set(h.area, Math.max(completedLevelByArea.get(h.area) ?? -1, r));
  }

  const available = (a) => resources === null || a.resources.every((r) => r === "NO_SPECIAL_RESOURCES" || resources.includes(r));

  /** The one activity to suggest for an area: the next level up from what was completed, available, not closed. */
  const pickFor = (area) => {
    const nextRank = Math.min(LEVELS.length - 1, (completedLevelByArea.get(area) ?? -1) + 1);
    const candidates = ACTIVITIES
      .filter((a) => a.area === area && a.status === "active" && !closed.has(a.activityId) && !open.has(a.activityId) && available(a))
      .sort((a, b) => Math.abs(LEVEL_RANK[a.level] - nextRank) - Math.abs(LEVEL_RANK[b.level] - nextRank)
        || (skipped.has(a.activityId) ? 1 : 0) - (skipped.has(b.activityId) ? 1 : 0)
        || a.activityId.localeCompare(b.activityId));
    return candidates[0] ?? null;
  };

  const item = (a, relevance, area) => {
    const openedArea = openedByArea.get(area);
    const reasons = [];
    if (relevance === "aligned") reasons.push(openedArea.evidenceLevel === "strong" ? "RECURRING_STRENGTH" : "EMERGING_STRENGTH");
    if (relevance === "adjacent") reasons.push("RELATED_EXPLORATION");
    if (relevance === "discovery") reasons.push("NEW_DOMAIN_EXPLORATION");
    if (interestAreas.has(area)) reasons.push("STUDENT_INTEREST");
    if (completedLevelByArea.has(area)) reasons.push("PREVIOUS_ACTIVITY_FOLLOWUP");
    if (resources !== null) reasons.push("RESOURCE_AVAILABLE");
    const related = relevance === "adjacent" ? alignedAreas.filter((x) => (ADJACENT_AREAS[x] ?? []).includes(area)).map((x) => openedByArea.get(x)) : [];
    return {
      activityId: a.activityId, version: a.version, area, level: a.level, category: a.category,
      relevance, reasons,
      supportingDimensions: [...new Set((openedArea?.openedBy ?? related.flatMap((r) => r.openedBy)))],
      supportingSubjects: [...new Map((openedArea?.supportingSubjects ?? related.flatMap((r) => r.supportingSubjects)).map((s) => [s.subjectId, s])).values()],
      relatedTo: related.map((r) => r.area),
      skippedBefore: skipped.has(a.activityId),
      evidenceVersion: strengthProfile?.strengthEngineVersion ?? null,
      explorationEngineVersion: EXPLORATION_ENGINE_VERSION,
    };
  };

  const fill = (areas, relevance, limit, taken) => {
    const out = [];
    // Interest moves an area up within its bucket, and only within it.
    const ordered = areas.slice().sort((x, y) => (interestAreas.has(y) ? 1 : 0) - (interestAreas.has(x) ? 1 : 0));
    for (const area of ordered) {
      if (out.length >= limit) break;
      const a = pickFor(area);
      if (!a || taken.has(a.activityId)) continue;
      taken.add(a.activityId);
      out.push(item(a, relevance, area));
    }
    return out;
  };

  const taken = new Set();
  let aligned   = fill(alignedAreas.filter((a) => !saturated.includes(a)), "aligned", q.aligned, taken);
  let adjacent  = fill(adjacentAreas,  "adjacent",  q.adjacent,  taken);
  let discovery = fill(discoveryAreas, "discovery", q.discovery, taken);
  // Spill: discovery, then adjacent, then aligned — only the shortfall, so the
  // list is full when the catalog allows and never longer than asked.
  const shortfall = () => n - aligned.length - adjacent.length - discovery.length;
  if (shortfall() > 0) discovery = [...discovery, ...fill(discoveryAreas, "discovery", shortfall(), taken)];
  if (shortfall() > 0) adjacent  = [...adjacent,  ...fill(adjacentAreas,  "adjacent",  shortfall(), taken)];
  if (shortfall() > 0) aligned   = [...aligned,   ...fill(alignedAreas,   "aligned",   shortfall(), taken)];

  return {
    explorationEngineVersion: EXPLORATION_ENGINE_VERSION,
    evidenceVersion: strengthProfile?.strengthEngineVersion ?? null,
    quota: q,
    suggestions: [...aligned, ...adjacent, ...discovery],
    // Named so a screen can say why the list is shaped as it is.
    breadth: { aligned: aligned.length, adjacent: adjacent.length, discovery: discovery.length },
    saturated,
  };
};

module.exports = { recommend, quota, REASONS, CLOSED_STATUSES: [...CLOSED], OPEN_STATUSES: [...OPEN] };
