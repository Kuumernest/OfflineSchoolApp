// backend/scripts/calibration/consistency.js
"use strict";

/**
 * Are the live path and the offline path saying the same thing about a pupil?
 *
 * ── The two paths ─────────────────────────────────────────────────────────
 *
 *   live      academicHistory.service → shared/intelligence     (/insights)
 *   offline   cohortFromDocuments → toEngineInput → runEngine → shared/intelligence
 *             (the exporter's file, the in-app review sheet)
 *
 * Both end in the same engine. What could differ is everything before it: the
 * document loader, the mapping, a filter applied on one side and not the
 * other. The calibration protocol needs the two to be semantically identical,
 * because a review is made against the sheet and a decision is applied to the
 * application; if they disagree, the review was of something the application
 * never said.
 *
 * ── What this does ────────────────────────────────────────────────────────
 *
 * A plain structural diff, path by path, over the two profiles and the two
 * guidance lists — classification codes and confidence, metrics, evidence,
 * coverage, engine version, guidance. It normalises nothing: an ordering
 * difference is a difference, a null against an undefined is a difference, a
 * rounding difference is a difference. The person reading the report decides
 * what a difference means; this file never decides it away.
 *
 * Pure. No database, no HTTP. The server and the check script both call it.
 */

const isObject = (v) => v !== null && typeof v === "object";

/**
 * Every path at which `a` and `b` differ.
 *
 * @returns {Array<{path: string, live: unknown, offline: unknown}>}
 */
const diff = (a, b, path = "$", out = []) => {
  if (a === b) return out;
  if (isObject(a) && isObject(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const p = Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`;
      if (!(k in a)) out.push({ path: p, live: undefined, offline: b[k] });
      else if (!(k in b)) out.push({ path: p, live: a[k], offline: undefined });
      else diff(a[k], b[k], p, out);
    }
    return out;
  }
  // Dates arrive as Date objects from one side and strings from the other
  // only if a caller serialised one of them; both sides here are in-process.
  if (a instanceof Date && b instanceof Date && a.getTime() === b.getTime()) return out;
  out.push({ path, live: a, offline: b });
  return out;
};

/**
 * Compare one pupil across the two paths.
 *
 * @param {object} live     { engineVersion, profile, guidance }
 * @param {object} offline  { engineVersion, profile, guidance }
 */
const compareProfiles = (live, offline) => {
  const differences = [
    ...diff(live.engineVersion, offline.engineVersion, "$.engineVersion"),
    ...diff(live.profile ?? null, offline.profile ?? null, "$.profile"),
    ...diff(live.guidance ?? null, offline.guidance ?? null, "$.guidance"),
  ];
  // A summary a reader can scan before the paths: which of the things the
  // protocol names differ at all.
  const touches = (prefix) => differences.some((d) => d.path.startsWith(prefix));
  return {
    identical: differences.length === 0,
    engineVersion: { live: live.engineVersion ?? null, offline: offline.engineVersion ?? null },
    summary: {
      engineVersion:  touches("$.engineVersion"),
      classification: differences.some((d) => /\.insights\[|\.code$|\.confidence$/.test(d.path)),
      metrics:        differences.some((d) => /\.(recentAverage|priorAverage|overallAverage|delta|spread|consistency|latestStep|belowPass|strongMarks|observations)\b/.test(d.path)),
      evidence:       differences.some((d) => /\.evidence\[/.test(d.path)),
      guidance:       touches("$.guidance"),
      coverage:       differences.some((d) => /\.coverage\./.test(d.path)),
    },
    differences,
  };
};

module.exports = { diff, compareProfiles };
