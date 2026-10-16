// backend/src/services/intelligence/analysisCode.js
"use strict";

/**
 * The analysis code a stored report depends on, by content (docs/38 §4).
 *
 * The fingerprint carries a digest of this code, so a deploy that changes any
 * of it changes every fingerprint and a report computed by older code is never
 * served as current. The file set used to be a hand-kept list
 * (shared/intelligence/**, three calibration scripts and the worker), and it
 * missed two files the worker actually loads: shared/caAssessment.js
 * (through cohortSchema.js) and shared/gradeScale.js (through
 * shared/intelligence/subjectInsights.js). It is now derived from the module
 * graph, starting at the worker and analyseCohort.js, so a new require is
 * covered the day it is written.
 *
 * ── How the graph is read ─────────────────────────────────────────────────
 *
 * Statically, as scripts/check-orphans.js reads the server's graph: every
 * relative string literal ("./x", "../x"), resolved as Node would ("", .js,
 * .json, dir/index.js). The analysis code also builds paths, and those are
 * followed too: path.join(__dirname, "a", "b") and path.join(NAME, "a"), where
 * NAME is a constant declared in the same file as a path.join of __dirname or
 * of another such constant. A path that resolves to a file in the project is
 * covered; one that does not (a directory, a module in node_modules) is not.
 * Over-inclusion only makes a deploy look like a change; under-inclusion is
 * what check:analysis tests against the worker's real require.cache.
 *
 * Pure, apart from reading files: given the same tree, the same answer, in
 * any process.
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

/** The project root: backend/ and shared/ are both under it. */
const PROJECT = path.join(__dirname, "..", "..", "..", "..");

/** Where the analysis starts, relative to the project root. */
const ENTRIES = Object.freeze([
  "backend/src/services/intelligence/analysisWorker.js",
  "backend/scripts/calibration/analyseCohort.js",
]);

const EXTS = ["", ".js", ".json"];

/** A path as Node would resolve it to a file, or null. Never into node_modules. */
const resolveFile = (target) => {
  if (target.split(path.sep).includes("node_modules")) return null;
  for (const e of EXTS) {
    const p = target + e;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  const idx = path.join(target, "index.js");
  return fs.existsSync(idx) ? idx : null;
};

const SPEC_RE  = /["'`](\.{1,2}\/[^"'`\n]+)["'`]/g;
const JOIN_RE  = /path\.join\(\s*([A-Za-z_$][\w$]*)\s*((?:,\s*["'][^"'\n]+["']\s*)*)\)/g;
const CONST_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\(\s*([A-Za-z_$][\w$]*)\s*((?:,\s*["'][^"'\n]+["']\s*)*)\)/g;
const segsOf   = (s) => [...s.matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]);

/** Every project file a file can reach by require, as this module reads it. */
const referencesOf = (file) => {
  const text = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const bases = new Map([["__dirname", dir]]);
  // Constants built from __dirname or from each other, in declaration order.
  for (const m of text.matchAll(CONST_RE)) {
    const base = bases.get(m[2]);
    if (base) bases.set(m[1], path.join(base, ...segsOf(m[3])));
  }
  const out = new Set();
  for (const m of text.matchAll(SPEC_RE)) {
    const hit = resolveFile(path.resolve(dir, m[1]));
    if (hit) out.add(hit);
  }
  for (const m of text.matchAll(JOIN_RE)) {
    const base = bases.get(m[1]);
    if (!base) continue;
    const hit = resolveFile(path.join(base, ...segsOf(m[2])));
    if (hit) out.add(hit);
  }
  return out;
};

/**
 * The files reachable from the entries, absolute and sorted.
 *
 * @param {string} [root]  the project root (a temporary copy in tests)
 */
const codeFiles = (root = PROJECT) => {
  const seen = new Set();
  const queue = ENTRIES.map((e) => path.join(root, e));
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!f.endsWith(".js")) continue;        // a .json is covered, not walked
    for (const r of referencesOf(f)) if (!seen.has(r) && r.startsWith(root + path.sep)) queue.push(r);
  }
  return [...seen].sort((a, b) => (path.relative(root, a) < path.relative(root, b) ? -1 : 1));
};

/**
 * SHA-256 over each file's project-relative path and content, in path order.
 *
 * @param {string} [root]
 */
const codeDigestOf = (root = PROJECT) => {
  const h = crypto.createHash("sha256");
  for (const f of codeFiles(root)) {
    h.update(path.relative(root, f).split(path.sep).join("/")).update("\0").update(fs.readFileSync(f)).update("\0");
  }
  return h.digest("hex");
};

module.exports = { PROJECT, ENTRIES, codeFiles, codeDigestOf, referencesOf };
