// mobile/src/services/teacherProfile.service.js
//
/**
 * The signed-in teacher's OWN profile, on the device.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * Two unrelated features were using one table name, `teacher_profiles`, with
 * incompatible schemas:
 *
 *   attendance.service.js   a DIRECTORY of every teacher in the school —
 *                           (id, schoolId, name, email, updated_at), filled
 *                           from sync so the register can list colleagues.
 *
 *   teacher/profile/setup   the signed-in teacher's own personal record —
 *                           teacher_id plus twenty-odd fields: national id,
 *                           qualification, emergency contact, blood group.
 *
 * Only the first one ever created the table. The profile screen just wrote to
 * it, and `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already
 * exists — so whichever feature touched the database first won, and on every
 * real device that was attendance. The profile save then failed with
 *
 *     table teacher_profiles has no column named teacher_id
 *
 * which is what a teacher saw on the last step of Profile Setup. That save has
 * never worked. It could not have.
 *
 * The two are genuinely different things — a roster of colleagues and one
 * person's own record — so they get different tables rather than one wide one
 * with half its columns null. The directory keeps the name it already has on
 * every installed device; this file takes a new one, so nothing has to be
 * migrated, dropped, or raced for.
 *
 * ── Why a service and not a CREATE TABLE in the screen ────────────────────
 *
 * Four places touch this record: the setup form saves it, the setup form reads
 * it back, the dashboard guard asks whether it is complete, and the settings
 * screen displays it. Three of those were reading the colliding table behind a
 * `.catch(() => null)`, so they returned nothing and reported no error — a
 * teacher who completed the form was asked to complete it again, and the
 * settings screen showed an empty profile, with nothing in the log either
 * time. One definition, in one place, is what stops that recurring.
 */

import { getDatabase } from "../db/database";
import { getTableColumns, safeAddColumn } from "../db/dbHelpers";

/**
 * Deliberately NOT `teacher_profiles`.
 *
 * That name is taken, on every device already in the field, by the attendance
 * directory. Renaming that one would mean migrating a working feature to fix a
 * broken one; this record has never been written, so it is the one that moves.
 * The name says whose profile it is, which is the distinction that was missing.
 */
export const TABLE = "teacher_self_profile";

/**
 * Columns added after the first release.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
 * column added to the statement below reaches new installs only. Anything
 * added later belongs here as well — this is the same arrangement
 * examCache.service.js uses, and it exists because the alternative is the bug
 * above, one release later.
 */
const MIGRATIONS = [
  // (none yet — the table is new. Add here, never only to CREATE TABLE.)
];

let ready = false;

export const ensureSchema = async (db) => {
  if (ready) return;

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      teacher_id         TEXT PRIMARY KEY,
      first_name         TEXT,
      last_name          TEXT,
      gender             TEXT,
      date_of_birth      TEXT,
      national_id        TEXT,
      staff_id           TEXT,
      qualification      TEXT,
      employment_type    TEXT,
      join_date          TEXT,
      years_experience   TEXT,
      previous_school    TEXT,
      phone              TEXT,
      alternate_phone    TEXT,
      address            TEXT,
      city               TEXT,
      state              TEXT,
      emergency_name     TEXT,
      emergency_phone    TEXT,
      emergency_relation TEXT,
      blood_group        TEXT,
      medical_conditions TEXT,
      bio                TEXT,
      profile_completed  INTEGER DEFAULT 0,
      updated_at         TEXT
    )
  `);

  if (MIGRATIONS.length) {
    const existing = await getTableColumns(db, TABLE);
    for (const col of MIGRATIONS) {
      if (!existing.includes(col.name)) {
        await safeAddColumn(db, TABLE, col.name, col.def);
      }
    }
  }

  ready = true;
};

/** For tests, and for anything that closes the database underneath us. */
export const resetSchemaCache = () => { ready = false; };

/**
 * Save the teacher's profile locally.
 *
 * Takes the form's camelCase payload and writes the table's snake_case
 * columns, so the mapping lives here rather than in the screen — the screens
 * disagreeing about a column name is the other half of how this broke.
 *
 * Throws. The caller needs to know: on a device with no connection this write
 * IS the save, and a teacher told "saved" over a failed write would lose the
 * lot.
 */
export const saveLocal = async (teacherId, p = {}) => {
  if (!teacherId) throw new Error("saveLocal: no teacher id");

  const db = await getDatabase();
  await ensureSchema(db);

  const now = new Date().toISOString();

  await db.runAsync(
    `INSERT INTO ${TABLE} (
       teacher_id, first_name, last_name, gender, date_of_birth,
       national_id, staff_id, qualification, employment_type,
       join_date, years_experience, previous_school,
       phone, alternate_phone, address, city, state,
       emergency_name, emergency_phone, emergency_relation,
       blood_group, medical_conditions, bio,
       profile_completed, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(teacher_id) DO UPDATE SET
       first_name         = excluded.first_name,
       last_name          = excluded.last_name,
       gender             = excluded.gender,
       date_of_birth      = excluded.date_of_birth,
       national_id        = excluded.national_id,
       staff_id           = excluded.staff_id,
       qualification      = excluded.qualification,
       employment_type    = excluded.employment_type,
       join_date          = excluded.join_date,
       years_experience   = excluded.years_experience,
       previous_school    = excluded.previous_school,
       phone              = excluded.phone,
       alternate_phone    = excluded.alternate_phone,
       address            = excluded.address,
       city               = excluded.city,
       state              = excluded.state,
       emergency_name     = excluded.emergency_name,
       emergency_phone    = excluded.emergency_phone,
       emergency_relation = excluded.emergency_relation,
       blood_group        = excluded.blood_group,
       medical_conditions = excluded.medical_conditions,
       bio                = excluded.bio,
       profile_completed  = excluded.profile_completed,
       updated_at         = excluded.updated_at`,
    [
      String(teacherId),
      p.firstName         ?? null,
      p.lastName          ?? null,
      p.gender            ?? null,
      p.dateOfBirth       ?? null,
      p.nationalId        ?? null,
      p.staffId           ?? null,
      p.qualification     ?? null,
      p.employmentType    ?? null,
      p.joinDate          ?? null,
      p.yearsOfExperience ?? null,
      p.previousSchool    ?? null,
      p.phone             ?? null,
      p.alternatePhone    ?? null,
      p.address           ?? null,
      p.city              ?? null,
      p.state             ?? null,
      p.emergencyName     ?? null,
      p.emergencyPhone    ?? null,
      p.emergencyRelation ?? null,
      p.bloodGroup        ?? null,
      p.medicalConditions ?? null,
      p.bio               ?? null,
      p.profileCompleted ? 1 : 0,
      now,
    ]
  );

  return true;
};

/**
 * The stored profile in the form's own shape, or null.
 *
 * Returned camelCase so a caller never has to know a column name — the setup
 * form and the settings screen were each translating snake_case themselves,
 * which is two chances to get it wrong and no way to notice.
 */
export const getLocal = async (teacherId) => {
  if (!teacherId) return null;

  const db = await getDatabase();
  await ensureSchema(db);

  const row = await db.getFirstAsync(
    `SELECT * FROM ${TABLE} WHERE teacher_id = ? LIMIT 1`,
    [String(teacherId)]
  ).catch(() => null);

  if (!row) return null;

  return {
    firstName:         row.first_name         ?? "",
    lastName:          row.last_name          ?? "",
    gender:            row.gender             ?? "",
    dateOfBirth:       row.date_of_birth      ?? "",
    nationalId:        row.national_id        ?? "",
    staffId:           row.staff_id           ?? "",
    qualification:     row.qualification      ?? "",
    employmentType:    row.employment_type    ?? "",
    joinDate:          row.join_date          ?? "",
    yearsOfExperience: row.years_experience == null ? "" : String(row.years_experience),
    previousSchool:    row.previous_school    ?? "",
    phone:             row.phone              ?? "",
    alternatePhone:    row.alternate_phone    ?? "",
    address:           row.address            ?? "",
    city:              row.city               ?? "",
    state:             row.state              ?? "",
    emergencyName:     row.emergency_name     ?? "",
    emergencyPhone:    row.emergency_phone    ?? "",
    emergencyRelation: row.emergency_relation ?? "",
    bloodGroup:        row.blood_group        ?? "",
    medicalConditions: row.medical_conditions ?? "",
    bio:               row.bio                ?? "",
    profileCompleted:  !!row.profile_completed,
    updatedAt:         row.updated_at         ?? null,
  };
};

/** Has this teacher finished the setup form on this device? */
export const isCompleteLocal = async (teacherId) => {
  if (!teacherId) return false;
  try {
    const db = await getDatabase();
    await ensureSchema(db);
    const row = await db.getFirstAsync(
      `SELECT profile_completed FROM ${TABLE} WHERE teacher_id = ? LIMIT 1`,
      [String(teacherId)]
    ).catch(() => null);
    return !!row?.profile_completed;
  } catch {
    return false;
  }
};

export default { TABLE, ensureSchema, resetSchemaCache, saveLocal, getLocal, isCompleteLocal };
