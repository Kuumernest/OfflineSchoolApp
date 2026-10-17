// backend/scripts/provision-indexes.js
"use strict";

/**
 * Provision the indexes the models declare, deliberately, before a release.
 *
 * Why this exists: production connects with autoIndex off
 * (src/config/database.js), and mongoose's Model.init() then builds nothing.
 * Only three indexes are built at boot (gateToken, IdempotencyKey,
 * IntelligenceAnalysisRun); indexCheck.service only REPORTS the rest, and
 * compares key patterns alone. So the unique indexes that keep a receipt
 * number, a mark or an attendance row from being written twice exist only if
 * somebody created them. This creates them — and nothing else.
 *
 * What it does, per declared index:
 *   present       an index with the same key and the same unique / sparse /
 *                 partial / TTL options exists              → nothing
 *   incompatible  the same key with other options, or the declared name on
 *                 another key                               → reported, never touched
 *   missing       → for a unique index, the duplicates it would refuse are
 *              counted first (read-only aggregation, respecting its partial
 *              filter / sparse rule / array fields)
 *
 * Modes:
 *   (default)  PLAN: reads only. Prints the table and exits 0 when nothing is
 *              missing, incompatible or legacy, 2 otherwise. Legacy = a live
 *              unique/TTL index no model declares (still enforced).
 *              Incompatible unique indexes get the duplicate count too.
 *   --apply    creates the missing indexes that have no duplicates and are
 *              not incompatible, one at a time, continuing past a failure. Never drops
 *              an index, never calls syncIndexes / cleanIndexes / diffIndexes'
 *              toDrop. Exits 1 if anything failed or was skipped.
 *   --only=A,B limit to these model names.
 *
 * The connection string is read from PROVISION_MONGODB_URI (never MONGODB_URI,
 * so a server's own environment is never picked up by accident) and is never
 * printed: only the host and database name are. Run against STAGING first
 * (docs/17, "Index provisioning"):
 *
 *   PROVISION_MONGODB_URI='mongodb+srv://…/staging_db' node scripts/provision-indexes.js
 *   PROVISION_MONGODB_URI='mongodb+srv://…/staging_db' node scripts/provision-indexes.js --apply
 *
 * Building on a large collection takes time and load: run it off-peak.
 */

const mongoose = require("mongoose");

const OPTION_KEYS = ["unique", "sparse", "partialFilterExpression", "expireAfterSeconds"];

// One definition of "present", shared with the boot check, so the two never
// disagree about an index.
const { compareIndex, enforcing, keyOf } = require("../src/services/indexCheck.service");
const liveKeyOf = (ix) => (ix.key?._fts === "text" ? "text" : keyOf(ix.key));

/** The read-only pipeline that finds what a unique index would refuse. */
function duplicatePipeline(model, key, opts) {
  const fields = Object.keys(key);
  const pipeline = [];
  if (opts.partialFilterExpression) pipeline.push({ $match: opts.partialFilterExpression });
  // A sparse single-field index skips documents without the field (but not a
  // field set to null). A compound sparse one skips only documents missing
  // every field.
  if (opts.sparse) {
    pipeline.push({ $match: { $or: fields.map((f) => ({ [f]: { $exists: true } })) } });
  }
  for (const f of fields) {
    const path = model.schema.path(f);
    if (path && path.$isMongooseArray) pipeline.push({ $unwind: `$${f}` });
  }
  // A case-insensitive collation (strength 1 or 2) treats "Biology" and
  // "biology" as one value: so must the count, or it would call clean an index
  // that then fails to build. Strings are folded; anything else is as stored.
  // $toLower folds ASCII reliably; a clash only in accented capitals ("É"/"é")
  // can slip past this count, and the build then FAILS, reported as such.
  const fold = opts.collation && (opts.collation.strength ?? 3) <= 2;
  const value = (f) => (fold
    ? { $cond: [{ $eq: [{ $type: `$${f}` }, "string"] }, { $toLower: `$${f}` }, `$${f}`] }
    : `$${f}`);
  pipeline.push(
    { $group: { _id: Object.fromEntries(fields.map((f) => [f.replace(/\./g, "_"), value(f)])), n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $group: { _id: null, groups: { $sum: 1 }, rows: { $sum: "$n" } } },
  );
  return pipeline;
}

/** Schema defaults that a sparse unique index will NOT skip: null is indexed. */
function sparseNullHazard(model, key, opts) {
  if (!opts.unique || !opts.sparse || opts.partialFilterExpression) return null;
  const nullDefault = Object.keys(key).filter((f) => model.schema.path(f)?.defaultValue === null);
  return nullDefault.length ? nullDefault : null;
}

/**
 * @returns {Promise<{ rows: object[], failed: number, skipped: number, created: number }>}
 */
async function provision({ connection = mongoose.connection, apply = false, only = null, log = console.log } = {}) {
  const rows = [];
  let failed = 0, skipped = 0, created = 0;
  const legacy = [];

  for (const name of connection.modelNames().sort()) {
    if (only && !only.includes(name)) continue;
    const model = connection.model(name);
    const declared = model.schema.indexes();
    if (!declared.length) continue;

    let live = [];
    try { live = await model.collection.indexes(); } catch { live = []; }   // no collection yet

    for (const [key, rawOpts] of declared) {
      const opts = { ...rawOpts };
      const row = { model: name, collection: model.collection.collectionName, key, unique: Boolean(opts.unique), name: opts.name ?? null };

      const cmp = compareIndex(key, opts, live);
      row.status = cmp.status;
      if (cmp.detail) row.detail = cmp.detail;
      // Missing, or there in another shape: either way, the duplicates the
      // declared unique index would refuse are what stands between it and
      // being built.
      if (row.status === "missing" || row.status === "incompatible") {
        if (opts.unique) {
          try {
            const [dup] = await model.collection.aggregate(duplicatePipeline(model, key, opts), { allowDiskUse: true }).toArray();
            row.duplicates = dup ? { groups: dup.groups, rows: dup.rows } : { groups: 0, rows: 0 };
          } catch (err) {
            row.duplicates = { error: err.message };
          }
        }
      }
      const hazard = sparseNullHazard(model, key, opts);
      if (hazard) row.warning = `sparse does not skip null: ${hazard.join(", ")} default to null, so a second row with null is refused`;

      if (apply && row.status === "missing") {
        const dirty = row.duplicates && (row.duplicates.error || row.duplicates.groups > 0);
        if (dirty) {
          row.outcome = "skipped (duplicates must be resolved first)";
          skipped++;
        } else {
          const createOpts = { ...Object.fromEntries(OPTION_KEYS.filter((k) => opts[k] !== undefined).map((k) => [k, opts[k]])) };
          for (const k of ["name", "collation", "weights", "default_language", "language_override"]) {
            if (opts[k] !== undefined) createOpts[k] = opts[k];
          }
          try {
            await model.collection.createIndex(key, createOpts);
            row.outcome = "created";
            created++;
          } catch (err) {
            row.outcome = `failed: ${err.codeName || err.code || ""} ${err.message}`.trim();
            failed++;
          }
        }
      } else if (apply && row.status === "incompatible") {
        row.outcome = "skipped (incompatible: resolve by hand, nothing is dropped)";
        skipped++;
      }
      rows.push(row);
    }

    // Live unique/TTL indexes no model declares: an index a schema used to
    // declare and no longer does still enforces its old rule on every write
    // (e.g. a sparse unique over a null default left beside its partial
    // replacement). Reported, never dropped.
    for (const ix of live) {
      if (ix.name === "_id_" || !(ix.unique || ix.expireAfterSeconds != null)) continue;
      const declaredHere = declared.some(([k, o]) => keyOf(k) === liveKeyOf(ix) && enforcing(o) === enforcing(ix));
      if (declaredHere) continue;
      legacy.push({ model: name, collection: model.collection.collectionName, name: ix.name, key: ix.key,
        unique: Boolean(ix.unique), sparse: Boolean(ix.sparse), partial: ix.partialFilterExpression ?? null,
        ttl: ix.expireAfterSeconds ?? null });
    }
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  for (const r of rows.filter((x) => x.status !== "present" || x.warning)) {
    const dup = r.duplicates
      ? (r.duplicates.error ? ` duplicates: check failed (${r.duplicates.error})` : ` duplicates: ${r.duplicates.groups} group(s), ${r.duplicates.rows} row(s)`)
      : "";
    log(`  ${r.status.padEnd(8)} ${r.collection} ${JSON.stringify(r.key)}${r.unique ? " unique" : ""}` +
        `${r.name ? ` (${r.name})` : ""}${dup}${r.detail ? ` — ${r.detail}` : ""}` +
        `${r.outcome ? ` → ${r.outcome}` : ""}${r.warning ? `\n           warning: ${r.warning}` : ""}`);
  }
  for (const l of legacy) {
    log(`  legacy   ${l.collection} ${JSON.stringify(l.key)} (${l.name})${l.unique ? " unique" : ""}${l.sparse ? " sparse" : ""}` +
        `${l.partial ? ` partial ${JSON.stringify(l.partial)}` : ""}${l.ttl != null ? ` ttl ${l.ttl}s` : ""}` +
        " — declared by no model, still enforced; review, then drop by hand if superseded");
  }
  log(`\n  declared ${rows.length}: present ${count("present")}, missing ${count("missing")} ` +
      `(unique ${rows.filter((r) => r.status === "missing" && r.unique).length}), incompatible ${count("incompatible")}; ` +
      `undeclared unique/TTL (legacy) ${legacy.length}` +
      (apply ? ` — created ${created}, skipped ${skipped}, failed ${failed}` : " — plan only, nothing written"));
  return { rows, legacy, failed, skipped, created };
}

module.exports = { provision, duplicatePipeline };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const onlyArg = args.find((a) => a.startsWith("--only="));
    const only = onlyArg ? onlyArg.slice(7).split(",").map((s) => s.trim()).filter(Boolean) : null;
    const uri = process.env.PROVISION_MONGODB_URI;
    if (!uri) {
      console.error("PROVISION_MONGODB_URI is not set. Point it at the database to provision (staging first).");
      process.exit(64);
    }
    require("../src/db/models");
    // autoIndex off: connecting must not build anything behind the plan's back.
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
    const { host, name: db } = mongoose.connection;
    console.log(`${apply ? "APPLY" : "PLAN (read-only)"} against host ${host}, database ${db}\n`);
    const out = await provision({ apply, only });
    await mongoose.disconnect();
    const unresolved = out.legacy.length > 0 ||
      out.rows.some((r) => r.status === "incompatible" || (r.status === "missing" && r.outcome !== "created"));
    process.exit(apply ? (out.failed || out.skipped ? 1 : 0) : (unresolved ? 2 : 0));
  })().catch(async (err) => {
    console.error(`provision-indexes: ${err.message}`);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });
}
