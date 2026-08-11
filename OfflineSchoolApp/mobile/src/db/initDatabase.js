// src/db/initDatabase.js
"use strict";

import { getDatabase } from "./database";

/**
 * Initialise the SQLite database.
 * Triggers the migration runner automatically via getDatabase().
 * Call this once at app startup before any DB operations.
 */
export async function initDatabase() {
  await getDatabase();
  console.log("✅ DB initialized");
}