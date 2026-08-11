import NetInfo from "@react-native-community/netinfo";
import { SyncQueueService } from "./syncQueue";

const API_BASE = "http://10.0.2.2:5000/api";

const BATCH_SIZE = 20;

export class SyncEngine {
  static isSyncing = false;

  // MAIN ENTRY
  static async syncAll(token) {
    if (this.isSyncing) return { success: true, skipped: true };

    const net = await NetInfo.fetch();
    if (!net.isConnected) {
      console.log("📴 Offline - sync skipped");
      return { success: false, reason: "offline" };
    }

    try {
      this.isSyncing = true;

      const pendingOps = await SyncQueueService.getPendingOperations();

      if (!pendingOps.length) {
        return { success: true, synced: 0 };
      }

      console.log(`🔄 Syncing ${pendingOps.length} operations...`);

      const batches = this.createBatches(pendingOps, BATCH_SIZE);

      let synced = 0;
      let failed = 0;

      for (const batch of batches) {
        const result = await this.sendBatch(batch, token);

        synced += result.synced;
        failed += result.failed;
      }

      console.log(`✅ Sync done | synced: ${synced}, failed: ${failed}`);

      return {
        success: failed === 0,
        synced,
        failed,
      };
    } catch (err) {
      console.error("❌ Sync engine crash:", err.message);
      return { success: false, error: err.message };
    } finally {
      this.isSyncing = false;
    }
  }

  // BATCH SENDER
  static async sendBatch(batch, token) {
    try {
      const response = await fetch(`${API_BASE}/sync/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          deviceId: "mobile-device",
          changes: batch,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      for (const op of batch) {
        await SyncQueueService.markSynced(op.id);
      }

      return { synced: batch.length, failed: 0 };
    } catch (error) {
      console.error("Batch sync failed:", error.message);

      for (const op of batch) {
        await SyncQueueService.markFailed(op.id, error.message);
      }

      return { synced: 0, failed: batch.length };
    }
  }

  // CREATE BATCHES
  static createBatches(data, size) {
    const batches = [];

    for (let i = 0; i < data.length; i += size) {
      batches.push(data.slice(i, i + size));
    }

    return batches;
  }

  // STATUS CHECK
  static async hasPendingOperations() {
    return (await SyncQueueService.getPendingCount()) > 0;
  }
}