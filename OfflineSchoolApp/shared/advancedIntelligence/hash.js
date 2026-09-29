// shared/advancedIntelligence/hash.js
"use strict";

/**
 * A deterministic content hash with no dependency.
 *
 * The strengths service hashes its evidence boundary with node's crypto; this
 * directory may not require crypto (it must load wherever shared/ loads, and
 * the purity checks scan for it), so the evidence context is hashed here with
 * FNV-1a over a canonical serialisation — keys sorted at every depth, so two
 * contexts that mean the same thing hash the same whatever order they were
 * assembled in. Not a security primitive: it identifies a context, it does
 * not protect one.
 */

const canonical = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
};

const fnv1a = (s, seed) => {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

/** 16 hex characters: two FNV-1a passes with different seeds over the canonical form. */
const hashOf = (value) => { const s = canonical(value); return fnv1a(s, 0x811c9dc5) + fnv1a(s, 0x01000193); };

module.exports = { canonical, hashOf };
