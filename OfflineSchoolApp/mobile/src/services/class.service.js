"use strict";

import { getDatabase }       from "../db/database";
import { ensureTableSchema } from "../db/schemaManager";
import {
  createTableFromSchema,
  ensureSchemaColumns,
} from "../db/schema";
import {
  tableExists,
  getTableColumns,
  NOT_DELETED,
  withFkOff,
} from "../db/dbHelpers";
import { generateLocalId } from "../utils/idHelpers";
import { getCurrentAuth }  from "../utils/authHelpers";
import { API }             from "./apiEndpoints";
import { MutationQueue }   from "./mutationQueue.service";
import api                 from "./api";
import NetInfo             from "@react-native-community/netinfo";
import { appError }        from "../utils/appError";

const TABLE = "classes";

const NOT_DELETED_C =
  "(c.deleted_at IS NULL OR c.deleted_at = '' OR c.deleted_at NOT LIKE '20%')";

// One definition, in SCHEMAS.classes. This function used to carry its own
// CREATE TABLE and its own column list, which is how the class teacher came
// to exist on the server and in two of the four places the device defines
// this table — and therefore nowhere the screens could read it.
const ensureSchema = (db) =>
  ensureTableSchema(
    TABLE,
    async (db) => {
      await createTableFromSchema(db, "classes");
      await ensureSchemaColumns(db, "classes");
    },
    db
  );

const backfillSchoolId = async (db, schoolId) => {
  if (!schoolId) return;
  try {
    await db.runAsync(
      `UPDATE ${TABLE}
       SET schoolId = ?, school_id = ?
       WHERE (schoolId IS NULL OR schoolId = '')
         AND ${NOT_DELETED}`,
      [schoolId, schoolId]
    );
  } catch (err) {
    console.warn("[ClassService] backfillSchoolId failed:", err.message);
  }
};

const extractDate = (value, fallback = null) => {
  if (!value) return fallback;
  if (typeof value === "object" && value.$date) return value.$date;
  return String(value);
};

const fetchServerClasses = async (schoolId, includeInactive = false) => {
  try {
    const response = await api.get(API.admin.classes.list, {
      params:  { schoolId, includeInactive: String(includeInactive) },
      timeout: 15_000,
    });
    return (
      response.data?.classes ||
      response.data?.data    ||
      (Array.isArray(response.data) ? response.data : [])
    );
  } catch (err) {
    console.warn("[ClassService] Could not fetch from server:", err.message);
    return [];
  }
};

const reconcileClassId = async (db, localId, serverId) => {
  if (!localId || !serverId) return localId || serverId;
  if (String(localId) === String(serverId)) {
    await db.runAsync(
      `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
      [new Date().toISOString(), localId]
    ).catch(() => {});
    return serverId;
  }

  await withFkOff(db, async () => {
    const now = new Date().toISOString();

    await db.runAsync(
      `UPDATE subjects SET class_id = ?, classId = ? WHERE class_id = ? OR classId = ?`,
      [serverId, serverId, localId, localId]
    ).catch(() => {});

    await db.runAsync(
      `UPDATE students SET class_id = ? WHERE class_id = ?`,
      [serverId, localId]
    ).catch(() => {});

    await db.runAsync(
      `UPDATE teacher_assignments SET classId = ?, class_id = ? WHERE classId = ? OR class_id = ?`,
      [serverId, serverId, localId, localId]
    ).catch(() => {});

    await db.runAsync(
      `UPDATE timetable SET class_id = ? WHERE class_id = ?`,
      [serverId, localId]
    ).catch(() => {});

    await db.runAsync(
      `UPDATE timetable_slots SET classId = ?, class_id = ? WHERE classId = ? OR class_id = ?`,
      [serverId, serverId, localId, localId]
    ).catch(() => {});

    const serverRow = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} WHERE id = ? LIMIT 1`,
      [serverId]
    ).catch(() => null);

    if (serverRow) {
      await db.runAsync(`DELETE FROM ${TABLE} WHERE id = ?`, [localId]).catch(() => {});
    } else {
      await db.runAsync(
        `UPDATE ${TABLE} SET id = ?, _synced = 1, _synced_at = ? WHERE id = ?`,
        [serverId, now, localId]
      ).catch(() => {});
    }

    await db.runAsync(
      `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
      [now, serverId]
    ).catch(() => {});
  });

  return serverId;
};

const syncServerClassesToLocal = async (db, schoolId, includeInactive = false) => {
  if (!schoolId) return;

  const net = await NetInfo.fetch();
  if (!net.isConnected) return;

  const serverClasses = await fetchServerClasses(schoolId, includeInactive);
  if (!serverClasses.length) return;

  // Step 1: collect server IDs
  const serverIds = serverClasses
    .map(sc => String(sc._id || sc.id || "").trim())
    .filter(Boolean);

  // Step 2: soft-delete stale local rows
  if (serverIds.length) {
    const placeholders = serverIds.map(() => "?").join(",");
    const ts           = new Date().toISOString();

    try {
      const result = await db.runAsync(
        `UPDATE ${TABLE}
         SET deleted_at = ?, updated_at = ?, _synced = 1, _synced_at = ?
         WHERE (schoolId = ? OR schoolId IS NULL OR schoolId = '')
           AND id NOT IN (${placeholders})
           AND (deleted_at IS NULL OR deleted_at = '' OR deleted_at NOT LIKE '20%')`,
        [ts, ts, ts, schoolId, ...serverIds]
      );

      if ((result?.changes ?? 0) > 0) {
        console.log(`[ClassService] Removed ${result.changes} stale class(es)`);
      }
    } catch (err) {
      console.warn("[ClassService] Stale-row cleanup failed:", err.message);
    }
  }

  // Step 3: upsert server classes
  let synced = 0;
  const ts   = new Date().toISOString();

  for (const sc of serverClasses) {
    const serverId = String(sc._id || sc.id || "").trim();
    const name     = String(sc.name || "").trim();
    if (!serverId || !name) continue;

    const schoolIdVal = sc.schoolId || sc.school_id || schoolId;
    const activeValue = (
      sc.isActive  === false || Number(sc.isActive)  === 0 ||
      sc.is_active === false || Number(sc.is_active) === 0
    ) ? 0 : 1;

    const deletedAt = sc.deletedAt  ?? sc.deleted_at  ?? null;
    const createdAt = extractDate(sc.createdAt || sc.created_at) || ts;
    const updatedAt = extractDate(sc.updatedAt || sc.updated_at) || ts;

    try {
      const localDuplicate = await db.getFirstAsync(
        `SELECT id FROM ${TABLE}
         WHERE LOWER(name) = LOWER(?)
           AND id != ?
           AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')
           AND ${NOT_DELETED}
         LIMIT 1`,
        [name, serverId, schoolId]
      ).catch(() => null);

      if (localDuplicate?.id) {
        await reconcileClassId(db, localDuplicate.id, serverId);
      }

      await db.runAsync(
        `INSERT INTO ${TABLE}
           (id, name, level, section, schoolId, school_id, is_active, deleted_at, created_at, updated_at, _synced, _synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           level      = excluded.level,
           section    = excluded.section,
           schoolId   = excluded.schoolId,
           school_id  = excluded.school_id,
           is_active  = excluded.is_active,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at,
           _synced    = 1,
           _synced_at = excluded._synced_at`,
        [serverId, name, sc.level || null, sc.section || "", schoolIdVal, schoolIdVal, activeValue, deletedAt, createdAt, updatedAt, ts]
      );

      // The class teacher. /admin/classes answers with the Mongoose
      // document, so both spellings are read — the mirrored row and the
      // document have differed before.
      await db.runAsync(
        `UPDATE ${TABLE} SET classTeacherId = ?, classTeacherName = ? WHERE id = ?`,
        [
          sc.classTeacherId   ?? sc.class_teacher_id   ?? null,
          sc.classTeacherName ?? sc.class_teacher_name ?? null,
          serverId,
        ]
      ).catch(() => {});

      synced++;
    } catch (err) {
      console.warn(`[ClassService] Failed to cache "${name}":`, err.message);
    }
  }

  console.log(`[ClassService] Cached ${synced} class(es) from server`);
};

function normaliseRow(row) {
  const id = String(row.id ?? "");
  return {
    ...row,
    _id:          id,
    id,
    isActive:     row.isActive == null ? true : Boolean(Number(row.isActive)),
    subjectCount: Number(row.subjectCount ?? 0),
    studentCount: Number(row.studentCount ?? 0),
    classTeacherId:   row.classTeacherId   ?? null,
    classTeacherName: row.classTeacherName ?? null,
  };
}

export const ClassService = {

  async getAll(includeInactive = false) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();

    await ensureSchema(db);
    await backfillSchoolId(db, schoolId);

    if (schoolId) {
      await syncServerClassesToLocal(db, schoolId, includeInactive);
    }

    try {
      const hasSubjects = await tableExists(db, "subjects");
      const hasStudents = await tableExists(db, "students");

      const subjectCols = hasSubjects ? await getTableColumns(db, "subjects") : [];
      const studentCols = hasStudents ? await getTableColumns(db, "students") : [];

      // The class teacher arrived after this table shipped. Selecting a column
      // that does not exist throws, and the catch below turns that into an
      // empty class list — so it is probed rather than assumed. Once the
      // migration in syncManager has run on a device this is always true.
      const classCols = await getTableColumns(db, "classes");
      const teacherExpr = classCols.includes("classTeacherName")
        ? "c.classTeacherId, c.classTeacherName,"
        : "NULL AS classTeacherId, NULL AS classTeacherName,";

      const subjectClassCol =
        subjectCols.includes("class_id") ? "class_id" :
        subjectCols.includes("classId")  ? "classId"  : null;

      const subjectDeletedCol =
        subjectCols.includes("deleted_at") ? "deleted_at" :
        subjectCols.includes("deletedAt")  ? "deletedAt"  : null;

      const studentClassCol =
        studentCols.includes("class_id") ? "class_id" :
        studentCols.includes("classId")  ? "classId"  : null;

      const subjectCountExpr =
        hasSubjects && subjectClassCol
          ? `(SELECT COUNT(*) FROM subjects s WHERE s.${subjectClassCol} = c.id ${
              subjectDeletedCol ? `AND (s.${subjectDeletedCol} IS NULL OR s.${subjectDeletedCol} = '')` : ""
            }) AS subjectCount`
          : "0 AS subjectCount";

      const studentCountExpr =
        hasStudents && studentClassCol
          ? `(SELECT COUNT(*) FROM students st WHERE st.${studentClassCol} = c.id) AS studentCount`
          : "0 AS studentCount";

      const params = [];
      let where = `WHERE ${NOT_DELETED_C}`;

      if (!includeInactive) {
        where += " AND (c.is_active = 1 OR c.is_active IS NULL)";
      }

      if (schoolId) {
        where += " AND (c.schoolId = ? OR c.schoolId IS NULL OR c.schoolId = '')";
        params.push(schoolId);
      }

      const rows = await db.getAllAsync(
        `SELECT
           c.id, c.name, c.level, c.section, c.schoolId,
           c.is_active AS isActive,
           c.created_at AS createdAt,
           c.updated_at AS updatedAt,
           ${teacherExpr}
           ${subjectCountExpr},
           ${studentCountExpr}
         FROM ${TABLE} c
         ${where}
         ORDER BY LOWER(c.name) ASC, c.id ASC`,
        params
      );

      return (rows ?? []).map(normaliseRow);
    } catch (err) {
      console.error("[ClassService] getAll error:", err.message);
      return [];
    }
  },

  async getById(id) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    try {
      const params = [id];
      let where = `WHERE id = ? AND ${NOT_DELETED}`;
      if (schoolId) {
        where += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
        params.push(schoolId);
      }

      const row = await db.getFirstAsync(
        `SELECT id, name, level, section, schoolId, is_active AS isActive,
                classTeacherId, classTeacherName,
                created_at AS createdAt, updated_at AS updatedAt
         FROM ${TABLE}
         ${where}
         LIMIT 1`,
        params
      );

      return row ? normaliseRow(row) : null;
    } catch (err) {
      console.error("[ClassService] getById error:", err.message);
      return null;
    }
  },

  async create(name, level = null, section = "", classTeacher) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    const trimmed       = name?.trim();
    if (!trimmed) throw appError("svcErr.classNameRequired", "Class name is required");
    const trimmedLevel   = level || null;          // the server stores level || null
    const trimmedSection = section?.trim() ?? "";  // the server stores section?.trim() || ""

    const dupParams = [trimmed];
    let dupWhere = `WHERE LOWER(name) = LOWER(?) AND ${NOT_DELETED}`;
    if (schoolId) {
      dupWhere += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
      dupParams.push(schoolId);
    }

    const exists = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} ${dupWhere} LIMIT 1`,
      dupParams
    );
    if (exists) throw appError("svcErr.classNameExists", "A class with this name already exists");

    const localId = generateLocalId();
    const now     = new Date().toISOString();

    await db.runAsync(
      `INSERT INTO ${TABLE}
         (id, name, level, section, is_active, schoolId, school_id, created_at, updated_at, _synced)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 0)`,
      [localId, trimmed, trimmedLevel, trimmedSection, schoolId, schoolId, now, now]
    );

    // The form teacher, guarded the same way update() guards it — these
    // columns post-date the table on devices that have not run the migration.
    if (classTeacher) {
      await db.runAsync(
        `UPDATE ${TABLE} SET classTeacherId = ?, classTeacherName = ? WHERE id = ?`,
        [classTeacher.id ?? null, classTeacher.name ?? null, localId]
      ).catch(() => {});
    }

    const net = await NetInfo.fetch();
    if (!net.isConnected) return localId;

    try {
      const response = await api.post(API.admin.classes.list, {
        id: localId, name: trimmed,
        level:   trimmedLevel,
        section: trimmedSection,
        schoolId,
        // Only sent when set: the server resolves the teacher's name from
        // their User row, and an absent field creates a teacherless class.
        ...(classTeacher?.id ? { classTeacherId: classTeacher.id } : {}),
      });

      const raw =
        response.data?.class?._id || response.data?.class?.id ||
        response.data?.data?._id  || response.data?.data?.id  ||
        response.data?.serverId   || response.data?._id       ||
        response.data?.id         || null;

      const finalId = raw ? String(raw) : localId;

      if (finalId !== localId) {
        await reconcileClassId(db, localId, finalId);
      } else {
        await db.runAsync(
          `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
          [now, localId]
        );
      }

      return finalId;
    } catch (err) {
      if (err?.response?.status === 409) {
        const body = err.response.data;
        const raw  = body?.serverId || body?.class?._id || body?.class?.id || body?._id || body?.id || null;

        if (raw) {
          const finalId = String(raw);
          await reconcileClassId(db, localId, finalId);
          return finalId;
        }

        await db.runAsync(
          `UPDATE ${TABLE} SET _synced = 1, _synced_at = ? WHERE id = ?`,
          [now, localId]
        );
      } else {
        console.warn(`[ClassService] Server push failed: ${err.message}`);
      }
    }

    return localId;
  },

  /**
   * @param {object} [changes]  Only what the caller meant to change — every
   *   field the caller OMITS is left exactly as it is, locally and on the
   *   server. This mirrors PUT /admin/classes/:id, which treats an ABSENT
   *   level / section / classTeacherId as "no change" and a present one as
   *   the new value. Sending a field unconditionally would mean every rename
   *   from this screen silently wiped what the web or desktop console set.
   *
   *   - `level`   — a string or null to set it; omit to leave alone.
   *   - `section` — a string ("" clears it); omit to leave alone.
   *   - `classTeacher` — `{ id, name }` to set one, null to clear; omit to
   *     leave alone.
   */
  async update(id, name, changes = {}) {
    const { level, section, classTeacher } = changes;
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    const trimmed = name?.trim();
    if (!trimmed) throw appError("svcErr.classNameRequired", "Class name is required");

    const existParams = [id];
    let existWhere = `WHERE id = ? AND ${NOT_DELETED}`;
    if (schoolId) {
      existWhere += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
      existParams.push(schoolId);
    }

    const existing = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} ${existWhere} LIMIT 1`,
      existParams
    );
    if (!existing) throw appError("svcErr.classNotFound", "Class not found");

    const dupParams = [trimmed, id];
    let dupWhere = `WHERE LOWER(name) = LOWER(?) AND id != ? AND ${NOT_DELETED}`;
    if (schoolId) {
      dupWhere += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
      dupParams.push(schoolId);
    }

    const duplicate = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} ${dupWhere} LIMIT 1`,
      dupParams
    );
    if (duplicate) throw appError("svcErr.classNameExists", "A class with this name already exists");

    const touchesLevel   = level   !== undefined;
    const touchesSection = section !== undefined;

    const now = new Date().toISOString();
    const setClauses = ["name = ?", "updated_at = ?", "_synced = 0"];
    const setValues  = [trimmed, now];
    if (touchesLevel)   { setClauses.push("level = ?");   setValues.push(level); }
    if (touchesSection) { setClauses.push("section = ?"); setValues.push(section); }
    setValues.push(id);

    await db.runAsync(
      `UPDATE ${TABLE} SET ${setClauses.join(", ")} WHERE id = ?`,
      setValues
    );

    const touchesTeacher = classTeacher !== undefined;
    if (touchesTeacher) {
      await db.runAsync(
        `UPDATE ${TABLE} SET classTeacherId = ?, classTeacherName = ? WHERE id = ?`,
        [classTeacher?.id ?? null, classTeacher?.name ?? null, id]
      ).catch(() => {});
    }

    // Queued, not sent.
    //
    // This used to PUT directly: nothing at all when offline, and on failure a
    // console.warn and a return. So an edit made with no signal, or one whose
    // request lost a socket, was written to this device, marked unsent, and
    // then never retried by anything. A class teacher assigned on the phone
    // could simply never reach the server, and the screen had no way to say so
    // — it had already shown the new name.
    //
    // The outbox retries with backoff, survives a restart, and puts a row that
    // keeps failing on the pending-changes screen where somebody can see it.
    // __local is what clears _synced once the server has taken it, so the flag
    // means what the rest of the app assumes it means.
    await MutationQueue.enqueue({
      // Coalesced per class: editing the same one twice before a sync sends the
      // final state once rather than both states in order.
      entityKey: `class-update:${id}`,
      method:    "PUT",
      endpoint:  API.admin.classes.detail(id),
      payload:   {
        name: trimmed,
        // Each field present only when the caller meant to change it. The
        // server reads an absent level/section as "leave alone", an empty
        // section as "clear", and an absent classTeacherId as "leave alone"
        // with an empty one as "clear".
        ...(touchesLevel   ? { level } : {}),
        ...(touchesSection ? { section } : {}),
        ...(touchesTeacher
          ? { classTeacherId: classTeacher?.id ?? "" }
          : {}),
        __local: { table: TABLE, id },
      },
    });

    return true;
  },

  async toggleActive(id) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    const params = [id];
    let where = `WHERE id = ? AND ${NOT_DELETED}`;
    if (schoolId) {
      where += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
      params.push(schoolId);
    }

    const existing = await db.getFirstAsync(
      `SELECT id, is_active FROM ${TABLE} ${where} LIMIT 1`,
      params
    );
    if (!existing) throw appError("svcErr.classNotFound", "Class not found");

    const now             = new Date().toISOString();
    const newActive       = existing.is_active === 1 ? 0 : 1;
    const newActiveBool   = Boolean(newActive);

    await db.runAsync(
      `UPDATE ${TABLE} SET is_active = ?, updated_at = ?, _synced = 0 WHERE id = ?`,
      [newActive, now, id]
    );

    const net = await NetInfo.fetch();
    if (!net.isConnected) return { _id: id, id, isActive: newActiveBool };

    try {
      const response = await api.patch(
        API.admin.classes.toggleActive
          ? API.admin.classes.toggleActive(id)
          : `/admin/classes/${id}/toggle-active`
      );

      const raw = response.data?.class ?? response.data?.data ?? response.data;
      const serverActive =
        raw?.isActive  !== undefined ? Boolean(raw.isActive)  :
        raw?.is_active !== undefined ? Boolean(Number(raw.is_active)) :
        newActiveBool;

      await db.runAsync(
        `UPDATE ${TABLE} SET is_active = ?, _synced = 1, _synced_at = ? WHERE id = ?`,
        [serverActive ? 1 : 0, now, id]
      );

      return { _id: id, id, isActive: serverActive };
    } catch (err) {
      console.warn(`[ClassService] toggleActive push failed: ${err.message}`);
      return { _id: id, id, isActive: newActiveBool };
    }
  },

  async delete(id) {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();
    await ensureSchema(db);

    const existParams = [id];
    let existWhere = `WHERE id = ? AND ${NOT_DELETED}`;
    if (schoolId) {
      existWhere += " AND (schoolId = ? OR schoolId IS NULL OR schoolId = '')";
      existParams.push(schoolId);
    }

    const existing = await db.getFirstAsync(
      `SELECT id FROM ${TABLE} ${existWhere} LIMIT 1`,
      existParams
    );
    if (!existing) throw appError("svcErr.classNotFound", "Class not found");

    const hasStudents = await db.getFirstAsync(
      `SELECT id FROM students WHERE class_id = ? LIMIT 1`,
      [id]
    ).catch(() => null);

    if (hasStudents) {
      throw appError(
        "svcErr.classHasStudents",
        "Cannot delete a class that has students enrolled. Move or remove students first."
      );
    }

    const now = new Date().toISOString();
    const net = await NetInfo.fetch();

    if (net.isConnected) {
      try {
        const response        = await api.delete(API.admin.classes.detail(id));
        const deletedSubjects = response.data?.deletedSubjects ?? 0;

        await withFkOff(db, async () => {
          await db.runAsync(
            `UPDATE subjects SET deleted_at = ?, updated_at = ?, _synced = 1
             WHERE (class_id = ? OR classId = ?) AND ${NOT_DELETED}`,
            [now, now, id, id]
          ).catch(() => {});

          await db.runAsync(
            `UPDATE teacher_assignments SET deleted_at = ?, updated_at = ?, _synced = 1
             WHERE (classId = ? OR class_id = ?) AND ${NOT_DELETED}`,
            [now, now, id, id]
          ).catch(() => {});

          await db.runAsync(
            `UPDATE timetable_slots SET deleted_at = ?, updated_at = ?, _synced = 1
             WHERE (classId = ? OR class_id = ?) AND ${NOT_DELETED}`,
            [now, now, id, id]
          ).catch(() => {});

          await db.runAsync(
            `UPDATE ${TABLE} SET deleted_at = ?, updated_at = ?, _synced = 1, _synced_at = ? WHERE id = ?`,
            [now, now, now, id]
          );
        });

        return { deletedSubjects };
      } catch (err) {
        if (err?.response?.status === 404) {
          await db.runAsync(
            `UPDATE ${TABLE} SET deleted_at = ?, updated_at = ?, _synced = 1 WHERE id = ?`,
            [now, now, id]
          );
          return { deletedSubjects: 0 };
        }

        if (err?.response?.status === 409) {
          const serverMessage = err.response.data?.message;
          throw serverMessage
            ? new Error(serverMessage)
            : appError(
                "svcErr.classHasStudentsShort",
                "Cannot delete a class that has students enrolled."
              );
        }

        throw err;
      }
    }

    // Offline path
    await withFkOff(db, async () => {
      await db.runAsync(
        `UPDATE subjects SET deleted_at = ?, updated_at = ?, _synced = 0
         WHERE (class_id = ? OR classId = ?) AND ${NOT_DELETED}`,
        [now, now, id, id]
      ).catch(() => {});

      await db.runAsync(
        `UPDATE teacher_assignments SET deleted_at = ?, updated_at = ?, _synced = 0
         WHERE (classId = ? OR class_id = ?) AND ${NOT_DELETED}`,
        [now, now, id, id]
      ).catch(() => {});

      await db.runAsync(
        `UPDATE timetable_slots SET deleted_at = ?, updated_at = ?, _synced = 0
         WHERE (classId = ? OR class_id = ?) AND ${NOT_DELETED}`,
        [now, now, id, id]
      ).catch(() => {});

      await db.runAsync(
        `UPDATE ${TABLE} SET deleted_at = ?, updated_at = ?, _synced = 0 WHERE id = ?`,
        [now, now, id]
      );
    });

    return { deletedSubjects: 0 };
  },

  async debugAll() {
    const db           = await getDatabase();
    const { schoolId } = getCurrentAuth();

    const all = await db.getAllAsync(`SELECT * FROM ${TABLE}`).catch(() => []);

    console.log(`[ClassService] 🔍 All rows (${all.length}), schoolId=${schoolId}:`);
    for (const r of all) {
      const match =
        r.schoolId === schoolId ? "✅ mine"         :
        !r.schoolId             ? "⚠️  no schoolId" :
                                  "❌ foreign";
      console.log(
        `  ${match} | id=${r.id} | name=${r.name} | school=${r.schoolId} | synced=${r._synced} | active=${r.is_active} | deleted=${r.deleted_at}`
      );
    }

    return all;
  },
};