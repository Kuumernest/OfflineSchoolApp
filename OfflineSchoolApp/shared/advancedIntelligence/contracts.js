// shared/advancedIntelligence/contracts.js
"use strict";

/**
 * The contracts: what a structured answer is, what a citation is, and what
 * a provider must accept and return.
 *
 * A model's output is never taken as text. It is an object of this shape or
 * it is nothing; the shape check runs before the grounding validator so a
 * malformed reply cannot be half-read. The same object is what the
 * deterministic explanation produces, so a client renders one shape whether
 * or not a model was involved and cannot tell the difference by structure —
 * only by the `mode` the application stamps beside it.
 */

const V = require("./version");

const LIMITS = Object.freeze({ answerChars: 4000, claims: 30, claimChars: 600, citationsPerClaim: 12, limitations: 20, suggestedQuestions: 6, questionChars: 200 });

/** JSON Schema for a provider's structured output. */
const OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: {
    answer: { type: "string", description: "The explanation, in plain language, made only from the supplied context. No sentence may state a fact that is not in the context." },
    claims: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          text: { type: "string" },
          type: { type: "string", enum: [...V.CLAIM_TYPES] },
          citations: { type: "array", items: { type: "string" }, description: "sourceIds from the supplied citationIndex. OBSERVED and INFERRED_BY_DETERMINISTIC_ENGINE claims need at least one." },
        },
        required: ["text", "type", "citations"],
      },
    },
    uncertainty: { type: "string", description: "What the evidence does not settle." },
    limitations: { type: "array", items: { type: "string" } },
    suggestedQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "claims", "uncertainty", "limitations", "suggestedQuestions"],
});

/** The citation contract, as a document. */
const CITATION_CONTRACT = Object.freeze({ claim: "string|null", sourceType: V.SOURCE_TYPES, sourceId: "<SOURCE_TYPE>:<key> from the context", evidenceBoundary: "the context's evidenceBoundaryHash", relevance: ["SUPPORTS", "CONTRADICTS", "CONTEXT", "LIMITS"] });

/** What a provider must implement. Operations receive one request object and return one output object of OUTPUT_SCHEMA. */
const PROVIDER_CONTRACT = Object.freeze({
  operations: ["explain", "summarize", "answer"],
  request: ["operation", "system", "input", "outputSchema", "constraints"],
  response: Object.keys(OUTPUT_SCHEMA.properties),
  meta: ["provider", "model"],
  tools: [],
  autonomousActions: [],
});

const isStr = (x, max) => typeof x === "string" && x.length <= max;
const isStrArr = (x, n, max) => Array.isArray(x) && x.length <= n && x.every((s) => typeof s === "string" && s.length <= max);

/** The shape check. Returns issues; empty means the object is an answer. */
const validateOutputShape = (o) => {
  const issues = [];
  const bad = (detail) => issues.push({ code: "MALFORMED_OUTPUT", detail });
  if (!o || typeof o !== "object" || Array.isArray(o)) { bad("NOT_AN_OBJECT"); return issues; }
  for (const k of Object.keys(o)) if (!OUTPUT_SCHEMA.properties[k]) bad(`UNKNOWN_KEY:${k}`);
  if (!isStr(o.answer, LIMITS.answerChars) || !o.answer.trim()) bad("ANSWER");
  if (!Array.isArray(o.claims) || o.claims.length > LIMITS.claims) bad("CLAIMS");
  else o.claims.forEach((c, i) => {
    if (!c || typeof c !== "object") { bad(`CLAIM:${i}`); return; }
    for (const k of Object.keys(c)) if (!["text", "type", "citations"].includes(k)) bad(`CLAIM:${i}:UNKNOWN_KEY:${k}`);
    if (!isStr(c.text, LIMITS.claimChars) || !c.text.trim()) bad(`CLAIM:${i}:TEXT`);
    if (!V.CLAIM_TYPES.includes(c.type)) bad(`CLAIM:${i}:TYPE`);
    if (!isStrArr(c.citations, LIMITS.citationsPerClaim, 200)) bad(`CLAIM:${i}:CITATIONS`);
  });
  if (!isStr(o.uncertainty, LIMITS.answerChars)) bad("UNCERTAINTY");
  if (!isStrArr(o.limitations, LIMITS.limitations, 200)) bad("LIMITATIONS");
  if (!isStrArr(o.suggestedQuestions, LIMITS.suggestedQuestions, LIMITS.questionChars)) bad("SUGGESTED_QUESTIONS");
  return issues;
};

/** True when any forbidden key appears anywhere in an object tree (keys only, case-insensitive). */
const hasForbiddenKey = (value, keys = V.FORBIDDEN_KEYS) => {
  const set = new Set(keys.map((k) => k.toLowerCase()));
  const walk = (v) => {
    if (!v || typeof v !== "object") return false;
    if (Array.isArray(v)) return v.some(walk);
    return Object.keys(v).some((k) => set.has(k.toLowerCase()) || walk(v[k]));
  };
  return walk(value);
};

module.exports = { LIMITS, OUTPUT_SCHEMA, CITATION_CONTRACT, PROVIDER_CONTRACT, validateOutputShape, hasForbiddenKey };
