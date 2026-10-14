// web/src/services/guidanceGrouping.js
//
// Presentation grouping for the guidance a class row carries. Pure, framework
// free, plain JavaScript on purpose: the web checks import it directly and
// prove the transformation without a browser.
//
// The guidance engine emits one item per insight, and the academic engine may
// legitimately say two things about one subject — "recent academic
// performance has declined" and "a recent performance change was observed"
// are two rules on two windows, not one fact twice. Rendered one badge each,
// a student card repeated the subject name with two near-identical sentences
// for every such subject. This groups the items by subject so each subject is
// named once with every distinct finding beneath it. Nothing is dropped and
// nothing is merged across subjects: a finding stays a finding, a strength
// stays a strength, and an exact repeat of the same code on the same subject
// (which the engine does not produce today) would collapse to one line rather
// than two.

const PRIORITY_RANK = { high: 3, moderate: 2, low: 1 };

/**
 * @typedef {object} GuidanceLike
 * @property {string|null} [subjectId]
 * @property {string|null} [subjectName]
 * @property {string} rationaleCode
 * @property {"high"|"moderate"|"low"} priority
 * @property {string} [type]
 */

/**
 * @typedef {object} GuidanceGroup
 * @property {string} key                 stable React key: subject id, or the code for a general item
 * @property {string|null} subjectId
 * @property {string|null} subjectName
 * @property {"high"|"moderate"|"low"} priority   the highest priority among the group's findings
 * @property {string[]} rationaleCodes    distinct, in first-seen order
 * @property {string[]} types             distinct guidance types present (risk, strength, …)
 * @property {GuidanceLike[]} items       the original items, untouched
 */

/**
 * Group guidance items by subject. Items without a subject are general
 * findings and stay one group per code. Input order is preserved: the first
 * subject seen is the first group, and the server's priority order survives.
 *
 * @param {GuidanceLike[]} items
 * @returns {GuidanceGroup[]}
 */
export function groupGuidanceBySubject(items) {
  /** @type {Map<string, GuidanceGroup>} */
  const groups = new Map();
  for (const item of items ?? []) {
    if (!item || typeof item.rationaleCode !== "string") continue;
    const subjectId = item.subjectId ? String(item.subjectId) : null;
    const key = subjectId ? `subject:${subjectId}` : `general:${item.rationaleCode}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, subjectId, subjectName: item.subjectName ?? null, priority: item.priority, rationaleCodes: [], types: [], items: [] };
      groups.set(key, g);
    }
    if (!g.rationaleCodes.includes(item.rationaleCode)) g.rationaleCodes.push(item.rationaleCode);
    if (item.type && !g.types.includes(item.type)) g.types.push(item.type);
    if ((PRIORITY_RANK[item.priority] ?? 0) > (PRIORITY_RANK[g.priority] ?? 0)) g.priority = item.priority;
    if (!g.subjectName && item.subjectName) g.subjectName = item.subjectName;
    g.items.push(item);
  }
  return [...groups.values()];
}
