// src/services/userCache.service.js
import api from "./api";
import { getDatabase } from "../db/database";

const TABLE = "users"; // Stores teachers/users locally

let schemaVerified = false;

const ensureSchema = async (db) => {
  if (schemaVerified) return;
  try {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS users (
        _id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        role TEXT,
        isActive INTEGER DEFAULT 1,
        last_sync TIMESTAMP,
        UNIQUE(_id)
      );
    `);
    schemaVerified = true;
  } catch (err) {
    console.warn("UserDB schema error:", err.message);
  }
};

// ⚠️ IMPORTANT: This pulls USER DATA for offline usage
export const UserCacheService = {
  /**
   * Fetch users from API (GET /admin/teachers or /admin/users)
   * and save to local SQLite cache
   */
  async pull() {
    try {
      const db = await getDatabase();
      await ensureSchema(db);

      const response = await api.get("/admin/teachers"); // Adjust endpoint to your route
      const users = response.data?.data || response.data || [];

      await db.transaction(async (tx) => {
        for (const user of users) {
          tx.run(
            `INSERT INTO users (_id, name, email, role, isActive, last_sync) 
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(_id) DO UPDATE SET 
               name=excluded.name, email=excluded.email, role=excluded.role, 
               isActive=excluded.isActive, last_sync=excluded.last_sync`,
            [
              user._id || user.id,
              user.name || "",
              user.email || "",
              user.role || "teacher",
              user.isActive !== 0 ? 1 : 0,
              new Date().toISOString(),
            ]
          );
        }
      });

      console.log(`✅ Cached ${users.length} Users`);
      return users;
    } catch (err) {
      console.error("Failed to pull users:", err);
      throw err;
    }
  }
};

export default UserCacheService;