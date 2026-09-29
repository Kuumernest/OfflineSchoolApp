// shared/advancedIntelligence/citations.js
"use strict";

/**
 * Citations: how a sentence points back at the structured evidence it was
 * made from.
 *
 * A citation is `{ claim, sourceType, sourceId, evidenceBoundary, relevance }`.
 * The sourceId is an id the evidence context minted (`STRENGTH_PROFILE:
 * quantitative_reasoning`, `GUIDANCE:quantitative_reasoning:MAINTAIN`, …);
 * the evidenceBoundary is the context's hash, so the citation names not only
 * which item but which day's version of it. "Why did you say that?" is
 * answered by resolving the id in the same context.
 *
 * A citation to an id the context does not contain is not a citation; the
 * validator reports MISSING_CITATION and the answer is discarded. Nothing
 * outside the context can be cited, which is the whole discipline.
 */

const V = require("./version");
const { itemsOf, itemById } = require("./evidenceContext");

/** The ids a claim may cite, sorted. */
const citationIndex = (context) => itemsOf(context).map((x) => x.sourceId);

const sourceTypeOf = (sourceId) => { const t = String(sourceId ?? "").split(":")[0]; return V.SOURCE_TYPES.includes(t) ? t : null; };

/** Build one citation against a context. Returns null when the id is not in the context. */
const cite = (context, sourceId, { claim = null, relevance = "SUPPORTS" } = {}) => {
  const item = itemById(context, sourceId);
  if (!item) return null;
  return { claim, sourceType: item.sourceType, sourceId, evidenceBoundary: context.evidenceBoundaryHash, relevance };
};

const RELEVANCE = Object.freeze(["SUPPORTS", "CONTRADICTS", "CONTEXT", "LIMITS"]);

/**
 * Check a list of citations against a context: every id resolves, every
 * type matches its id, every boundary is this context's, every relevance is
 * in the vocabulary.
 */
const validateCitations = (citations, context) => {
  const index = new Set(citationIndex(context));
  const issues = [];
  (citations ?? []).forEach((c, i) => {
    const id = typeof c === "string" ? c : c?.sourceId;
    if (!id || !index.has(id)) { issues.push({ code: "MISSING_CITATION", citation: i, sourceId: id ?? null }); return; }
    if (typeof c === "object") {
      if (c.sourceType && c.sourceType !== sourceTypeOf(id)) issues.push({ code: "MISSING_CITATION", citation: i, sourceId: id, detail: "SOURCE_TYPE_MISMATCH" });
      if (c.evidenceBoundary && c.evidenceBoundary !== context.evidenceBoundaryHash) issues.push({ code: "FUTURE_EVIDENCE", citation: i, sourceId: id, detail: "BOUNDARY_MISMATCH" });
      if (c.relevance && !RELEVANCE.includes(c.relevance)) issues.push({ code: "MISSING_CITATION", citation: i, sourceId: id, detail: "UNKNOWN_RELEVANCE" });
    }
  });
  return issues;
};

/** Resolve the citations of an answer to the items they point at — the "why did you say that" view. */
const resolve = (context, citations) => (citations ?? []).map((c) => { const id = typeof c === "string" ? c : c?.sourceId; return { sourceId: id, item: itemById(context, id) }; });

module.exports = { citationIndex, sourceTypeOf, cite, validateCitations, resolve, RELEVANCE };
