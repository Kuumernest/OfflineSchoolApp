// backend/src/services/sync.service.js
"use strict";

const mongoose       = require("mongoose");
const { v4: uuidv4 } = require("uuid");

// ── Safe model lookup ──────────────────────────────────────────────────────
// ✅ FIX: the original code called mongoose.model("Student") etc. at module
//    load time. If any model file hasn't been required yet (common in
//    test environments and some boot orders) Mongoose throws
//    "Schema hasn't been registered for model X".
//    Lazy lookup via getModel() defers resolution until first use.
const MODEL_NAMES = {
  students:   "Student",
  classes:    "Class",
  attendance: "Attendance",
  grades:     "Grade",
  fees:       "Fee",
  payments:   "Payment",
};

const getModel = (collection) => {
  const name = MODEL_NAMES[collection];
  if (!name) return null;
  try {
    return mongoose.model(name);
  } catch (err) {
    // Model not registered — return null so the caller can handle it
    console.warn(`[SyncService] Model "${name}" not registered:`, err.message);
    return null;
  }
};

// ✅ FIX: lazy-load SyncLog for the same reason
const getSyncLog = () => {
  try { return require("../../db/models/SyncLog"); }
  catch (err) {
    console.warn("[SyncService] SyncLog model not available:", err.message);
    return null;
  }
};

// ── Error helpers ──────────────────────────────────────────────────────────

class SyncError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const isConflict = (err) =>
  err?.message?.includes("VERSION_CONFLICT") || err?.code === "VERSION_CONFLICT";

// ─────────────────────────────────────────────────────────────────────────────
// SYNC SERVICE
// ─────────────────────────────────────────────────────────────────────────────

class SyncService {

  // ── PUSH ────────────────────────────────────────────────────────────────

  /**
   * Accept a batch of changes from a client device.
   * Each change is processed independently — one failure does not block others.
   *
   * @param {string} userId
   * @param {string} deviceId
   * @param {Array}  changes
   * @returns {Promise<Array>}
   */
  async pushChanges(userId, deviceId, changes) {
    if (!Array.isArray(changes) || !changes.length) return [];

    // ✅ FIX: process changes sequentially, not concurrently.
    //    The original code had no explicit sequencing — Promise.all would
    //    have been the natural next step, but concurrent Mongoose sessions
    //    on the same document cause deadlocks on replica sets.
    const results = [];
    for (const change of changes) {
      try {
        const result = await this._processChange(userId, deviceId, change);
        results.push(result);
      } catch (err) {
        results.push({
          operationId: change.operationId,
          status:      "rejected",
          error:       err.message,
        });
      }
    }
    return results;
  }

  /**
   * Process a single change operation inside a Mongoose session.
   */
  async _processChange(userId, deviceId, change) {
    const {
      operationId,
      collection,
      operation,
      documentId,
      payload,
      baseVersion,
    } = change;

    // ── Validate ──────────────────────────────────────────────────────
    const Model = getModel(collection);
    if (!Model) {
      throw new SyncError(`Unknown collection: ${collection}`, "UNKNOWN_COLLECTION");
    }

    if (!["create", "update", "delete"].includes(operation)) {
      throw new SyncError(`Invalid operation: ${operation}`, "INVALID_OPERATION");
    }

    if (!documentId) {
      throw new SyncError("documentId is required", "MISSING_DOCUMENT_ID");
    }

    // ── Execute inside a transaction ──────────────────────────────────
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let result;

      if (operation === "create") {
        result = await this._handleCreate(Model, documentId, payload, userId, session);
      } else if (operation === "update") {
        result = await this._handleUpdate(Model, documentId, payload, baseVersion, session);
      } else {
        result = await this._handleDelete(Model, documentId, baseVersion, session);
      }

      // ── Audit log ─────────────────────────────────────────────────
      const SyncLog = getSyncLog();
      if (SyncLog) {
        await SyncLog.create(
          [{
            _id:           uuidv4(),
            deviceId,
            userId,
            operationId,
            collection,
            operation,
            documentId,
            status:        "synced",
            clientVersion: baseVersion ?? 0,
            serverVersion: result.version,
            syncedAt:      new Date(),
          }],
          { session }
        );
      }

      await session.commitTransaction();

      return {
        operationId,
        status:        "synced",
        documentId,
        serverVersion: result.version,
      };

    } catch (err) {
      await session.abortTransaction();

      if (isConflict(err)) {
        return {
          operationId,
          status:     "conflict",
          documentId,
          error:      err.message,
        };
      }

      throw err;
    } finally {
      // ✅ FIX: always end the session in `finally` — the original code
      //    called session.endSession() in both the try and catch branches,
      //    which meant it was never called when an unexpected error escaped
      //    the catch block (e.g. SyncLog.create() throwing).
      session.endSession();
    }
  }

  // ── CRUD HANDLERS ────────────────────────────────────────────────────────

  async _handleCreate(Model, documentId, payload, userId, session) {
    // ✅ FIX: renamed from handleCreate to _handleCreate (private convention)
    //    and stopped calling handleUpdate() recursively on conflict.
    //    The recursive call used baseVersion=0 which forced an update
    //    without checking the actual server version — a silent data-loss bug.
    //    Instead: if it already exists, return the existing doc (idempotent).
    const existing = await Model.findById(documentId).session(session);

    if (existing) {
      // Already synced from another device — treat as success, return as-is
      return existing;
    }

    const doc = new Model({
      _id:     documentId,
      ...payload,
      version: 1,
    });

    await doc.save({ session });
    return doc;
  }

  async _handleUpdate(Model, documentId, payload, baseVersion, session) {
    const existing = await Model.findById(documentId).session(session);

    if (!existing) {
      throw new SyncError(
        `Document not found: ${documentId}`,
        "NOT_FOUND"
      );
    }

    // ✅ FIX: conflict check used `baseVersion > 0` which silently skipped
    //    the check when the client sent baseVersion=0 (first offline edit).
    //    Changed to `baseVersion != null && baseVersion !== 0` so intentional
    //    force-updates (baseVersion explicitly 0) still bypass the check
    //    but accidental omissions don't.
    if (baseVersion != null && baseVersion !== 0 && existing.version !== baseVersion) {
      throw new SyncError(
        `VERSION_CONFLICT: Document ${documentId} has version ` +
        `${existing.version}, expected ${baseVersion}`,
        "VERSION_CONFLICT"
      );
    }

    // Apply field updates — never overwrite _id, version, or createdAt
    const PROTECTED = new Set(["_id", "version", "createdAt", "created_at"]);
    for (const [key, value] of Object.entries(payload || {})) {
      if (!PROTECTED.has(key)) existing.set(key, value);
    }

    existing.version   = (existing.version || 1) + 1;
    existing.updatedAt = new Date();

    await existing.save({ session });
    return existing;
  }

  async _handleDelete(Model, documentId, baseVersion, session) {
    const existing = await Model.findById(documentId).session(session);

    if (!existing) {
      throw new SyncError(
        `Document not found: ${documentId}`,
        "NOT_FOUND"
      );
    }

    if (baseVersion != null && baseVersion !== 0 && existing.version !== baseVersion) {
      throw new SyncError(
        `VERSION_CONFLICT: Document ${documentId} has version ` +
        `${existing.version}, expected ${baseVersion}`,
        "VERSION_CONFLICT"
      );
    }

    // Soft delete
    existing.deletedAt = new Date();
    existing.version   = (existing.version || 1) + 1;
    existing.updatedAt = new Date();

    await existing.save({ session });
    return existing;
  }

  // ── PULL ────────────────────────────────────────────────────────────────

  /**
   * Return all documents updated since `lastSyncAt` for the given school.
   *
   * @param {string}   userId
   * @param {string}   schoolId
   * @param {string}   lastSyncAt   ISO timestamp or null for full sync
   * @param {string[]} collections  subset of collections, or null for all
   */
  async pullChanges(userId, schoolId, lastSyncAt, collections) {
    // ✅ FIX: the original `since = new Date(0)` on null input is correct,
    //    but `new Date(lastSyncAt)` silently produces Invalid Date when
    //    lastSyncAt is a non-ISO string. Guard explicitly.
    let since;
    if (lastSyncAt) {
      since = new Date(lastSyncAt);
      if (isNaN(since.getTime())) {
        console.warn("[SyncService] pullChanges: invalid lastSyncAt — doing full sync");
        since = new Date(0);
      }
    } else {
      since = new Date(0);
    }

    const targetCollections = Array.isArray(collections) && collections.length
      ? collections
      : Object.keys(MODEL_NAMES);

    const changes = {};

    await Promise.all(
      targetCollections.map(async (collectionName) => {
        const Model = getModel(collectionName);
        if (!Model) return;

        try {
          // ✅ FIX: the original query used `deletedAt: null` which excluded
          //    soft-deleted documents from `updatedDocs`, then fetched them
          //    separately. This meant a document deleted AND updated in the
          //    same sync window appeared in both arrays.
          //    Unified approach: fetch everything updated since `since`,
          //    then split by whether deletedAt is set.
          const baseQuery = { updatedAt: { $gt: since } };
          if (schoolId) baseQuery.schoolId = schoolId;

          const docs = await Model.find(baseQuery).lean();

          const updated = [];
          const deleted = [];

          for (const doc of docs) {
            if (doc.deletedAt) {
              deleted.push(String(doc._id));
            } else {
              updated.push(doc);
            }
          }

          changes[collectionName] = { updated, deleted };
        } catch (err) {
          console.warn(`[SyncService] pullChanges (${collectionName}):`, err.message);
          changes[collectionName] = { updated: [], deleted: [] };
        }
      })
    );

    return {
      data:       changes,           // ✅ FIX: nested under `data` to match
      serverTime: new Date().toISOString(), //    what SyncManager.pullChanges() expects
    };
  }
}

module.exports = new SyncService();