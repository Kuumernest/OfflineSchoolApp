// backend/src/db/plugins/syncTombstones.js
"use strict";

/**
 * Tombstones for a hard-deleted model (models/SyncTombstone.js).
 *
 *   schema.plugin(syncTombstones, { entity: "subject" });
 *
 * 1. Every hard delete — Model.deleteOne / deleteMany / findOneAndDelete /
 *    findByIdAndDelete, and doc.deleteOne() — records a tombstone for each row
 *    it is about to remove. On the model, not in the routes, so a delete path
 *    added later is covered without anyone remembering to.
 *
 *    Written BEFORE the delete. Written after, a crash between the two would
 *    lose the deletion for every device for good. Written before, the worst
 *    case is a tombstone for a row that still exists (the delete failed or
 *    the process died first), and GET /sync/pull never sends a tombstone whose
 *    row exists — so that case costs nothing. A delete that throws removes
 *    the tombstones it wrote.
 *
 * 2. A NEW document whose _id has a tombstone is refused: 410 RECORD_DELETED.
 *    Several create routes accept the client's _id, so a stale queued create
 *    from a device that has not yet heard of the deletion would otherwise
 *    bring the record back under its old id. Covered: save/create, and the
 *    bulk paths that skip save middleware — Model.insertMany, and
 *    Model.bulkWrite's insertOne and upserts filtered on _id. A batch holding
 *    a deleted id is refused WHOLE, naming the ids (err.deletedIds): dropping
 *    those rows silently would lose data nobody knows about, and an import
 *    of new ids is unaffected. Not covered: writes through Model.collection
 *    (the raw driver), which bypass mongoose entirely.
 */

const tombstoneModel = () => require("../models/SyncTombstone");

/** The rows a delete will remove, as [{ _id, schoolId }]. */
async function candidates(query, single) {
  const filter = query.getFilter();
  if (single) {
    const sort = query.getOptions()?.sort;
    const one = await query.model.findOne(filter).sort(sort || {}).select("_id schoolId").lean();
    return one ? [one] : [];
  }
  return query.model.find(filter).select("_id schoolId").lean();
}

async function writeTombstones(entity, rows) {
  if (!rows.length) return;
  const now = new Date();
  await tombstoneModel().bulkWrite(rows.map((r) => ({
    updateOne: {
      filter: { entity, docId: String(r._id) },
      update: { $set: { schoolId: r.schoolId != null ? String(r.schoolId) : null, deletedAt: now } },
      upsert: true,
    },
  })), { ordered: false });
}

async function withdrawTombstones(entity, rows) {
  if (!rows.length) return;
  await tombstoneModel().deleteMany({ entity, docId: { $in: rows.map((r) => String(r._id)) } }).catch(() => {});
}

async function deletedAmong(entity, ids) {
  if (!ids.length) return [];
  const rows = await tombstoneModel().find({ entity, docId: { $in: [...new Set(ids)] } }).select("docId").lean();
  return rows.map((r) => r.docId);
}

function refuse(entity, ids) {
  const err = new Error(
    `${ids.length === 1 ? `This ${entity} was` : `${ids.length} ${entity} records were`} deleted and cannot be ` +
    `recreated under the same id${ids.length > 1 ? `: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}` : ""}.`);
  err.statusCode = 410;
  err.code = "RECORD_DELETED";
  err.deletedIds = ids;
  return err;
}

module.exports = function syncTombstones(schema, { entity }) {
  if (!entity) throw new Error("syncTombstones: entity is required");

  const queryHook = (single) => async function pre() {
    const rows = await candidates(this, single);
    this._syncTombstoneRows = rows;
    await writeTombstones(entity, rows);
  };
  schema.pre("deleteMany", { query: true, document: false }, queryHook(false));
  schema.pre("deleteOne", { query: true, document: false }, queryHook(true));
  schema.pre("findOneAndDelete", { query: true, document: false }, queryHook(true));

  const queryUndo = function undo(err, _res, next) {
    withdrawTombstones(entity, this._syncTombstoneRows || []).finally(() => next(err));
  };
  schema.post("deleteMany", { query: true, document: false }, queryUndo);
  schema.post("deleteOne", { query: true, document: false }, queryUndo);
  schema.post("findOneAndDelete", { query: true, document: false }, queryUndo);

  schema.pre("deleteOne", { document: true, query: false }, async function preDoc() {
    await writeTombstones(entity, [{ _id: this._id, schoolId: this.schoolId }]);
  });
  schema.post("deleteOne", { document: true, query: false }, function undoDoc(err, _res, next) {
    withdrawTombstones(entity, [{ _id: this._id }]).finally(() => next(err));
  });

  schema.pre("save", async function refuseDeletedId() {
    if (!this.isNew || this._id == null) return;
    const hit = await deletedAmong(entity, [String(this._id)]);
    if (hit.length) throw refuse(entity, hit);
  });

  // Mongoose 9 hands insertMany's pre hook the documents, bulkWrite's the ops.
  schema.pre("insertMany", async function refuseDeletedIds(docs) {
    const ids = (Array.isArray(docs) ? docs : [docs])
      .map((d) => d?._id).filter((v) => v != null).map(String);
    const hit = await deletedAmong(entity, ids);
    if (hit.length) throw refuse(entity, hit);
  });
  schema.pre("bulkWrite", async function refuseDeletedIdsInOps(ops) {
    const ids = [];
    for (const op of ops || []) {
      if (op?.insertOne?.document?._id != null) ids.push(String(op.insertOne.document._id));
      for (const kind of ["updateOne", "updateMany", "replaceOne"]) {
        const o = op?.[kind];
        if (o?.upsert && o.filter && (typeof o.filter._id === "string" || typeof o.filter._id === "number")) {
          ids.push(String(o.filter._id));
        }
      }
    }
    const hit = await deletedAmong(entity, ids);
    if (hit.length) throw refuse(entity, hit);

    // bulkWrite's deleteOne/deleteMany skip query middleware too: their
    // tombstones are written here, before the batch, on the same terms as
    // above (a tombstone for a row that survives is never sent by the pull).
    const doomed = [];
    for (const op of ops || []) {
      if (op?.deleteMany?.filter) doomed.push(...await this.find(op.deleteMany.filter).select("_id schoolId").lean());
      if (op?.deleteOne?.filter) {
        const one = await this.findOne(op.deleteOne.filter).select("_id schoolId").lean();
        if (one) doomed.push(one);
      }
    }
    await writeTombstones(entity, doomed);
  });
};
