// backend/src/services/academicPolicy.service.js
"use strict";

/**
 * Freezing a school's academic rules (docs/39 §6.3, Phase 2b).
 *
 *   resolve({ schoolId, academicYear })  → the snapshot of the rules in force now
 *   get(hash, { schoolId })              → a snapshot by its hash, in that school only
 *   hashOf(policy)                       → the content hash
 *
 * resolve() reads the documents the calculations read, with the filters they
 * read them by — the year's AcademicStructure as termGrading.loadTermContext
 * finds it, the school's GradingConfig, the classes' promotion bars as
 * promotion.generateRun finds them — builds the canonical policy
 * (shared/academicPolicy.js) and stores it once under its hash.
 *
 * ── Nothing calls this yet ────────────────────────────────────────────────
 *
 * Phase 2b adds the snapshot and nothing that depends on it. Phase 2c stamps
 * its hash on newly computed results. Until then no result, card or screen
 * can differ because this file exists.
 *
 * ── A school, always ──────────────────────────────────────────────────────
 *
 * Both entry points refuse a missing school rather than reading across
 * schools: the caller resolves the school (utils/tenant.resolveSchoolId) and
 * a super_admin who named none has none.
 */

const crypto = require("crypto");

const AcademicPolicySnapshot = require("../db/models/AcademicPolicySnapshot");
const AcademicStructure      = require("../db/models/AcademicStructure");
const GradingConfig          = require("../db/models/GradingConfig");
const Class                  = require("../db/models/Class");

const { resolvePolicy, canonicalJson } = require("../../../shared/academicPolicy");

const required = (code, message) => {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
};

const isDuplicateKey = (err) => err && (err.code === 11000 || err.code === 11001);

/** SHA-256 of the canonical policy. */
const hashOf = (policy) =>
  crypto.createHash("sha256").update(canonicalJson(policy)).digest("hex");

/*
 * Snapshots are immutable, so one read by hash is good for the life of the
 * process. Bounded so a long-lived server holding many schools' history does
 * not grow without limit; the oldest entry goes first.
 */
const CACHE_LIMIT = 500;
const cache = new Map();
const remember = (doc) => {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(doc._id, doc);
  return doc;
};

/**
 * The snapshot of the rules in force for this school and year, created the
 * first time those exact rules are seen.
 *
 * Safe under concurrency: two callers resolving the same rules race on the
 * `_id` index, one insert wins, and the other reads the winner.
 *
 * @param {object} input
 * @param {string} input.schoolId
 * @param {string} input.academicYear
 * @param {string} [input.createdBy]
 * @returns {Promise<object>} the snapshot (plain object)
 */
async function resolve({ schoolId, academicYear, createdBy = null } = {}) {
  if (!schoolId)     throw required("SCHOOL_REQUIRED", "A school must be selected");
  if (!academicYear) throw required("ACADEMIC_YEAR_REQUIRED", "An academic year is required");
  schoolId = String(schoolId);
  academicYear = String(academicYear);

  const [structure, gradingConfig, classes] = await Promise.all([
    AcademicStructure.findOne({ schoolId, academicYear, deletedAt: null }).lean(),
    GradingConfig.findOne({ schoolId }).lean(),
    Class.find({ schoolId, deletedAt: null }).select("_id promotionAverage").lean(),
  ]);

  const policy = resolvePolicy({ schoolId, academicYear, structure, gradingConfig, classes });
  const json   = canonicalJson(policy);
  const hash   = crypto.createHash("sha256").update(json).digest("hex");

  if (cache.has(hash)) return cache.get(hash);

  const existing = await AcademicPolicySnapshot.findById(hash).lean();
  if (existing) return remember(existing);

  try {
    const created = await AcademicPolicySnapshot.create({
      _id:          hash,
      schoolId,
      academicYear,
      format:       policy.format,
      calcVersion:  policy.calcVersion,
      // Stored as the canonical form, so what is kept is byte-for-byte what
      // was hashed, and get() can re-verify it.
      policy:       JSON.parse(json),
      sources: {
        structureId:            structure?._id ? String(structure._id) : null,
        structureUpdatedAt:     structure?.updatedAt ?? null,
        gradingConfigUpdatedAt: gradingConfig?.updatedAt ?? null,
      },
      createdBy: createdBy ? String(createdBy) : null,
    });
    return remember(created.toObject());
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const winner = await AcademicPolicySnapshot.findById(hash).lean();
    if (!winner) throw err;
    return remember(winner);
  }
}

/**
 * A snapshot by its hash, only if it is this school's.
 *
 * @returns {Promise<object|null>}
 */
async function get(hash, { schoolId } = {}) {
  if (!schoolId) throw required("SCHOOL_REQUIRED", "A school must be selected");
  if (!hash) return null;
  const hit = cache.get(String(hash));
  const doc = hit || await AcademicPolicySnapshot.findById(String(hash)).lean();
  if (!doc || doc.schoolId !== String(schoolId)) return null;
  return hit ? doc : remember(doc);
}

/** Does this snapshot's stored policy still hash to its id? */
const verify = (doc) => !!doc && hashOf(doc.policy) === doc._id;

/** Tests only: forget every cached snapshot. */
const _resetCache = () => cache.clear();

module.exports = { resolve, get, hashOf, verify, _resetCache };
