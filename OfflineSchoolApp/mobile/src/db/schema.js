// src/db/schema.js
"use strict";

/**
 * schema.js
 *
 * Single source of truth for every SQLite table definition.
 *
 * Problem solved:
 *  - Tables were defined inline in each service file, causing drift
 *  - Mixed camelCase / snake_case column names broke queries silently
 *  - No way to know what columns existed without reading each service
 *
 * Rules:
 *  - ALL column names are snake_case in the database
 *  - JavaScript code uses camelCase — convert with snakeToCamel() on read
 *  - createTableFromSchema() is the only way tables should be created
 */

// ═════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITIONS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} TableSchema
 * @property {string}                  table   - Exact SQLite table name
 * @property {string}                  pk      - Primary key column name
 * @property {Record<string, string>}  columns - Column name → SQLite type+constraint
 * @property {string[]}                indexes - CREATE INDEX statements
 */

/** @type {Record<string, TableSchema>} */
export const SCHEMAS = {

  users: {
    table: "users",
    pk:    "id",
    columns: {
      id:                  "TEXT PRIMARY KEY NOT NULL",
      school_id:           "TEXT",
      name:                "TEXT",
      email:               "TEXT",
      role:                "TEXT",
      is_active:           "INTEGER DEFAULT 1",
      must_reset_password: "INTEGER DEFAULT 0",
      _synced:             "INTEGER DEFAULT 0",
      _synced_at:          "TEXT",
      deleted_at:          "TEXT",
      created_at:          "TEXT",
      updated_at:          "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email)",
      "CREATE INDEX IF NOT EXISTS idx_users_school ON users(school_id)",
      "CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role)",
    ],
  },

  /**
   * ── Why this entry lists BOTH schoolId and school_id ──────────────────
   *
   * It is not indecision. Every query against this table filters on the
   * camelCase `schoolId` — that is the column the class service, the sync
   * upserts and the admin stats all name — while `school_id` is carried for
   * the rows written by older builds and by the snake_case index below.
   * Listing only one of them, which this entry did, is why nothing used it:
   * creating the table from here produced a table the app could not query.
   *
   * The class teacher is the field that exposed all of this. It was added
   * server-side and had to be added again in four separate places on the
   * device before it appeared on a screen. This is now the only place.
   */
  classes: {
    table: "classes",
    pk:    "id",
    columns: {
      id:               "TEXT PRIMARY KEY NOT NULL",
      name:             "TEXT NOT NULL",
      level:            "TEXT",
      section:          "TEXT",
      schoolId:         "TEXT",
      school_id:        "TEXT",
      classTeacherId:   "TEXT",
      classTeacherName: "TEXT",
      studentCount:     "INTEGER DEFAULT 0",
      is_active:        "INTEGER DEFAULT 1",
      _synced:          "INTEGER DEFAULT 0",
      _synced_at:       "TEXT",
      deleted_at:       "TEXT",
      created_at:       "TEXT",
      updated_at:       "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(schoolId)",
      "CREATE INDEX IF NOT EXISTS idx_classes_school_snake ON classes(school_id)",
    ],
  },

  /**
   * What the school charges, mirrored from the server.
   *
   * The phone had no such table and no way to see a fee structure at all. It
   * pulls from /sync/pull, which returns six collections; the desktop pulls
   * from /sync/changes, which returns thirty-six including this one. So a
   * structure defined in the office reached the desktop and never the bursar's
   * phone.
   *
   * items, classIds and penalty are JSON columns. They are documents on the
   * server and nothing here queries inside them — a structure is read whole,
   * shown whole and sent back whole — so a column each is honest storage
   * rather than a join waiting to be written.
   */
  feeStructures: {
    table: "fee_structures",
    pk:    "id",
    columns: {
      id:           "TEXT PRIMARY KEY NOT NULL",
      schoolId:     "TEXT",
      school_id:    "TEXT",
      academicYear: "TEXT",
      term:         "TEXT",
      // JSON: [{ code, label, amount, isOptional }]
      items:        "TEXT",
      // JSON: string[]. Empty means the whole school.
      classIds:     "TEXT",
      dueDate:      "TEXT",
      // JSON: { mode, amount, graceDays }
      penalty:      "TEXT",
      isActive:     "INTEGER DEFAULT 1",
      _synced:      "INTEGER DEFAULT 1",
      _synced_at:   "TEXT",
      deleted_at:   "TEXT",
      created_at:   "TEXT",
      updated_at:   "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_fee_structures_school ON fee_structures(schoolId)",
      "CREATE INDEX IF NOT EXISTS idx_fee_structures_year ON fee_structures(schoolId, academicYear)",
    ],
  },

  subjects: {
    table: "subjects",
    pk:    "id",
    columns: {
      id:         "TEXT PRIMARY KEY NOT NULL",
      school_id:  "TEXT",
      class_id:   "TEXT",
      teacher_id: "TEXT",
      name:       "TEXT NOT NULL",
      code:       "TEXT",
      _synced:    "INTEGER DEFAULT 0",
      _synced_at: "TEXT",
      deleted_at: "TEXT",
      created_at: "TEXT",
      updated_at: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_subjects_school  ON subjects(school_id)",
      "CREATE INDEX IF NOT EXISTS idx_subjects_class   ON subjects(class_id)",
      "CREATE INDEX IF NOT EXISTS idx_subjects_teacher ON subjects(teacher_id)",
    ],
  },

  teacher_assignments: {
    table: "teacher_assignments",
    pk:    "id",
    columns: {
      id:         "TEXT PRIMARY KEY NOT NULL",
      school_id:  "TEXT",
      teacher_id: "TEXT NOT NULL",
      class_id:   "TEXT NOT NULL",
      subject_id: "TEXT NOT NULL",
      _synced:    "INTEGER DEFAULT 0",
      _synced_at: "TEXT",
      deleted_at: "TEXT",
      created_at: "TEXT",
      updated_at: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ta_school  ON teacher_assignments(school_id)",
      "CREATE INDEX IF NOT EXISTS idx_ta_teacher ON teacher_assignments(teacher_id)",
      "CREATE INDEX IF NOT EXISTS idx_ta_class   ON teacher_assignments(class_id)",
      "CREATE INDEX IF NOT EXISTS idx_ta_subject ON teacher_assignments(subject_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS ux_ta_logical " +
        "ON teacher_assignments(teacher_id, class_id, subject_id) " +
        "WHERE deleted_at IS NULL OR deleted_at = ''",
    ],
  },

  timetable: {
    table: "timetable",
    pk:    "id",
    columns: {
      id:          "TEXT PRIMARY KEY NOT NULL",
      school_id:   "TEXT",
      class_id:    "TEXT",
      subject_id:  "TEXT",
      teacher_id:  "TEXT",
      day_of_week: "TEXT",
      period_id:   "TEXT",
      room:        "TEXT",
      version:     "INTEGER DEFAULT 1",
      _synced:     "INTEGER DEFAULT 0",
      _synced_at:  "TEXT",
      deleted_at:  "TEXT",
      created_at:  "TEXT",
      updated_at:  "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_tt_class   ON timetable(class_id, deleted_at)",
      "CREATE INDEX IF NOT EXISTS idx_tt_teacher ON timetable(teacher_id, day_of_week, period_id)",
      "CREATE INDEX IF NOT EXISTS idx_tt_synced  ON timetable(_synced)",
    ],
  },

  student_applications: {
    table: "student_applications",
    pk:    "id",
    columns: {
      id:            "TEXT PRIMARY KEY NOT NULL",
      school_id:     "TEXT NOT NULL",
      student_name:  "TEXT NOT NULL",
      guardian_name: "TEXT",
      email:         "TEXT",
      phone:         "TEXT",
      class_id:      "TEXT",
      class_name:    "TEXT",
      status:        "TEXT DEFAULT 'pending'",
      notes:         "TEXT",
      documents:     "TEXT",
      reviewed_by:   "TEXT",
      reviewed_at:   "TEXT",
      approved_at:   "TEXT",
      rejected_at:   "TEXT",
      reject_reason: "TEXT",
      student_id:    "TEXT",
      user_id:       "TEXT",
      _synced:       "INTEGER DEFAULT 0",
      _synced_at:    "TEXT",
      deleted_at:    "TEXT",
      created_at:    "TEXT",
      updated_at:    "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_apps_school ON student_applications(school_id)",
      "CREATE INDEX IF NOT EXISTS idx_apps_status ON student_applications(status)",
      "CREATE INDEX IF NOT EXISTS idx_apps_email  ON student_applications(email)",
    ],
  },

  periods: {
    table: "periods",
    pk:    "id",
    columns: {
      id:         "TEXT PRIMARY KEY NOT NULL",
      school_id:  "TEXT",
      name:       "TEXT NOT NULL",
      start_time: "TEXT",
      end_time:   "TEXT",
      sort_order: "INTEGER DEFAULT 0",
      is_active:  "INTEGER DEFAULT 1",
      _synced:    "INTEGER DEFAULT 0",
      _synced_at: "TEXT",
      deleted_at: "TEXT",
      created_at: "TEXT",
      updated_at: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_periods_school ON periods(school_id)",
    ],
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// DDL HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Creates a table and all its indexes from a SCHEMAS entry.
 * Uses IF NOT EXISTS so it is safe to call on every app start.
 *
 * NOTE: expo-sqlite does NOT support multi-statement execAsync strings.
 * Each statement is its own call.
 *
 * @param {any}    db        - SQLite database instance
 * @param {string} schemaKey - Key in SCHEMAS (e.g. "subjects")
 * @throws {Error} If schemaKey is unknown or DDL fails
 */
export const createTableFromSchema = async (db, schemaKey) => {
  const schema = SCHEMAS[schemaKey];
  if (!schema) throw new Error(`[schema] Unknown schema key: "${schemaKey}"`);

  const colDefs = Object.entries(schema.columns)
    .map(([name, def]) => `  ${name} ${def}`)
    .join(",\n");

  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS ${schema.table} (\n${colDefs}\n)`
  );

  // Each index is a separate call
  for (const indexSQL of schema.indexes) {
    await db.execAsync(indexSQL).catch(() => {});
  }

  console.log(`[schema] Table "${schema.table}" ready`);
};

/**
 * Add any column the registry declares and the live table lacks.
 *
 * createTableFromSchema only ever runs CREATE TABLE IF NOT EXISTS, so on a
 * device that has been in use since before a column was added it does
 * nothing at all — the table exists, and it exists without the column. That
 * gap is why each new field ended up hand-written into a migration beside
 * every other definition of the same table.
 *
 * PRIMARY KEY and NOT NULL are stripped from the definition before the
 * ALTER: SQLite cannot add either to a table that already holds rows, and a
 * column being added late is by definition one the existing rows have no
 * value for.
 *
 * @returns {Promise<number>} how many columns were added
 */
export const ensureSchemaColumns = async (db, schemaKey) => {
  const schema = SCHEMAS[schemaKey];
  if (!schema) throw new Error(`[schema] Unknown schema key: "${schemaKey}"`);

  const info = await db
    .getAllAsync(`PRAGMA table_info(${schema.table})`)
    .catch(() => []);

  // No table yet: createTableFromSchema is the right call, not this.
  if (!info?.length) return 0;

  const present = new Set(info.map((c) => c.name));
  let added = 0;

  for (const [name, def] of Object.entries(schema.columns)) {
    if (present.has(name)) continue;

    const alterable = def
      .replace(/PRIMARY KEY/i, "")
      .replace(/NOT NULL/i, "")
      .replace(/\s+/g, " ")
      .trim();

    try {
      await db.execAsync(
        `ALTER TABLE ${schema.table} ADD COLUMN ${name} ${alterable}`
      );
      added++;
      console.log(`[schema] ${schema.table}.${name} added`);
    } catch (err) {
      // A duplicate is the expected race when two callers migrate at once.
      if (!/duplicate column/i.test(err?.message ?? "")) {
        console.warn(`[schema] ${schema.table}.${name}:`, err?.message);
      }
    }
  }

  for (const indexSQL of schema.indexes) {
    await db.execAsync(indexSQL).catch(() => {});
  }

  return added;
};

/**
 * Returns the column names defined for a schema key.
 *
 * @param {string} schemaKey
 * @returns {string[]}
 */
export const getSchemaColumnNames = (schemaKey) => {
  const schema = SCHEMAS[schemaKey];
  if (!schema) return [];
  return Object.keys(schema.columns);
};

// ═════════════════════════════════════════════════════════════════════════════
// CASE CONVERSION
// ═════════════════════════════════════════════════════════════════════════════

const toCamel = (s) =>
  s.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

const toSnake = (s) =>
  s.replace(/([A-Z])/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * Converts all keys in a plain object from snake_case to camelCase.
 * Use when reading rows FROM the database into JavaScript.
 *
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 *
 * @example
 * snakeToCamel({ class_id: "123", teacher_id: "456" })
 * // → { classId: "123", teacherId: "456" }
 */
export const snakeToCamel = (obj) => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const result = {};
  for (const key of Object.keys(obj)) {
    result[toCamel(key)] = obj[key];
  }
  return result;
};

/**
 * Converts all keys in a plain object from camelCase to snake_case.
 * Use when writing JavaScript objects INTO the database.
 *
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 *
 * @example
 * camelToSnake({ classId: "123", teacherId: "456" })
 * // → { class_id: "123", teacher_id: "456" }
 */
export const camelToSnake = (obj) => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const result = {};
  for (const key of Object.keys(obj)) {
    result[toSnake(key)] = obj[key];
  }
  return result;
};