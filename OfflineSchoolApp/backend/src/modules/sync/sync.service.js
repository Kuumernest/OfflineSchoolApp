const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const SyncLog = require("../../db/models/SyncLog");

// Map collection names to Mongoose models
const modelMap = {
  students: mongoose.model("Student"),
  classes: mongoose.model("Class"),
  attendance: mongoose.model("Attendance"),
  grades: mongoose.model("Grade"),
  fees: mongoose.model("Fee"),
  payments: mongoose.model("Payment"),
};

class SyncService {
  /**
   * Push: Accept changes from client devices
   */
  async pushChanges(userId, deviceId, changes) {
    const results = [];

    for (const change of changes) {
      try {
        const result = await this.processChange(
          userId,
          deviceId,
          change
        );
        results.push(result);
      } catch (error) {
        results.push({
          operationId: change.operationId,
          status: "rejected",
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Process a single change
   */
  async processChange(userId, deviceId, change) {
    const {
      operationId,
      collection,
      operation,
      documentId,
      payload,
      baseVersion,
    } = change;

    // Validate collection
    const Model = modelMap[collection];
    if (!Model) {
      throw new Error(`Unknown collection: ${collection}`);
    }

    // Validate operation
    if (!["create", "update", "delete"].includes(operation)) {
      throw new Error(`Invalid operation: ${operation}`);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      let result;

      if (operation === "create") {
        result = await this.handleCreate(
          Model,
          documentId,
          payload,
          userId,
          session
        );
      } else if (operation === "update") {
        result = await this.handleUpdate(
          Model,
          documentId,
          payload,
          baseVersion,
          session
        );
      } else if (operation === "delete") {
        result = await this.handleDelete(
          Model,
          documentId,
          baseVersion,
          session
        );
      }

      // Log the sync
      await SyncLog.create(
        [
          {
            _id: uuidv4(),
            deviceId,
            userId,
            operationId,
            collection,
            operation,
            documentId,
            status: "synced",
            clientVersion: baseVersion,
            serverVersion: result.version,
            syncedAt: new Date(),
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      return {
        operationId,
        status: "synced",
        documentId,
        serverVersion: result.version,
      };
    } catch (error) {
      await session.abortTransaction();
      session.endSession();

      // Check if conflict
      if (error.message.includes("VERSION_CONFLICT")) {
        return {
          operationId,
          status: "conflict",
          documentId,
          error: error.message,
        };
      }

      throw error;
    }
  }

  /**
   * Handle create operation
   */
  async handleCreate(Model, documentId, payload, userId, session) {
    // Check if document already exists
    const existing = await Model.findById(documentId).session(session);

    if (existing) {
      // Document already synced from another device
      // Treat as update instead
      return this.handleUpdate(
        Model,
        documentId,
        payload,
        0, // Force update
        session
      );
    }

    // Create new document
    const doc = new Model({
      _id: documentId,
      ...payload,
      version: 1,
    });

    await doc.save({ session });
    return doc;
  }

  /**
   * Handle update operation
   */
  async handleUpdate(Model, documentId, payload, baseVersion, session) {
    const existing = await Model.findById(documentId).session(session);

    if (!existing) {
      throw new Error(
        `Document not found: ${documentId}`
      );
    }

    // Conflict detection
    if (baseVersion > 0 && existing.version !== baseVersion) {
      throw new Error(
        `VERSION_CONFLICT: Document ${documentId} ` +
        `has version ${existing.version}, ` +
        `expected ${baseVersion}`
      );
    }

    // Apply changes
    Object.keys(payload).forEach((key) => {
      if (key !== "_id" && key !== "version" && key !== "createdAt") {
        existing.set(key, payload[key]);
      }
    });

    existing.version = existing.version + 1;
    existing.updatedAt = new Date();

    await existing.save({ session });
    return existing;
  }

  /**
   * Handle delete operation (soft delete)
   */
  async handleDelete(Model, documentId, baseVersion, session) {
    const existing = await Model.findById(documentId).session(session);

    if (!existing) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (baseVersion > 0 && existing.version !== baseVersion) {
      throw new Error(
        `VERSION_CONFLICT: Document ${documentId} ` +
        `has version ${existing.version}, ` +
        `expected ${baseVersion}`
      );
    }

    existing.deletedAt = new Date();
    existing.version = existing.version + 1;
    existing.updatedAt = new Date();

    await existing.save({ session });
    return existing;
  }

  /**
   * Pull: Get changes since a timestamp
   */
  async pullChanges(userId, schoolId, lastSyncAt, collections) {
    const changes = {};
    const since = lastSyncAt
      ? new Date(lastSyncAt)
      : new Date(0);

    const targetCollections = collections || Object.keys(modelMap);

    for (const collectionName of targetCollections) {
      const Model = modelMap[collectionName];
      if (!Model) continue;

      // Find all documents updated since last sync
      const query = {
        updatedAt: { $gt: since },
        deletedAt: null,
      };

      // Add schoolId filter if provided
      if (schoolId) {
        query.schoolId = schoolId;
      }

      // Also include recently deleted items
      const deletedQuery = {
        deletedAt: { $gt: since, $ne: null },
      };
      if (schoolId) {
        deletedQuery.schoolId = schoolId;
      }

      const updatedDocs = await Model.find(query).lean();
      const deletedDocs = await Model.find(deletedQuery)
        .select({ _id: 1, deletedAt: 1 })
        .lean();

      // Combine active and deleted
      changes[collectionName] = {
        updated: updatedDocs,
        deleted: deletedDocs.map((d) => d._id),
      };
    }

    return {
      changes,
      serverTime: new Date().toISOString(),
    };
  }
}

module.exports = new SyncService();