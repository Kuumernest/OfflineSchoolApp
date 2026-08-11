// src/services/homework.service.js

import { getDatabase } from '../db/database';

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const generateId = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

// ─────────────────────────────────────────────────────────────
// ENSURE TABLES EXIST
// ─────────────────────────────────────────────────────────────

export const ensureHomeworkTables = async () => {
  const db = await getDatabase();

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS homework (
      id              TEXT PRIMARY KEY,
      schoolId        TEXT NOT NULL,
      class_id        TEXT NOT NULL,
      subject_id      TEXT NOT NULL,
      created_by      TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT,
      instructions    TEXT,
      due_date        TEXT,
      max_score       REAL    DEFAULT 100,
      allow_late      INTEGER DEFAULT 1,
      late_penalty    REAL    DEFAULT 0,
      status          TEXT    DEFAULT 'active',
      attachment_url  TEXT,
      attachment_name TEXT,
      attachment_type TEXT,
      is_published    INTEGER DEFAULT 0,
      _synced         INTEGER DEFAULT 0,
      created_at      TEXT    DEFAULT (datetime('now')),
      updated_at      TEXT,
      deleted_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS homework_submissions (
      id               TEXT PRIMARY KEY,
      homework_id      TEXT NOT NULL,
      student_id       TEXT NOT NULL,
      student_name     TEXT,
      student_email    TEXT,
      class_id         TEXT,
      submission_text  TEXT,
      attachment_url   TEXT,
      attachment_name  TEXT,
      attachment_type  TEXT,
      score            REAL,
      feedback         TEXT,
      graded_by        TEXT,
      graded_at        TEXT,
      status           TEXT    DEFAULT 'submitted',
      is_late          INTEGER DEFAULT 0,
      _synced          INTEGER DEFAULT 0,
      submitted_at     TEXT    DEFAULT (datetime('now')),
      updated_at       TEXT,
      created_at       TEXT    DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_hw_school_teacher
      ON homework(schoolId, created_by);
    CREATE INDEX IF NOT EXISTS idx_hw_class_subject
      ON homework(class_id, subject_id);
    CREATE INDEX IF NOT EXISTS idx_hw_class_published
      ON homework(class_id, is_published, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_hw_due_date
      ON homework(due_date);
    CREATE INDEX IF NOT EXISTS idx_hw_sub_homework
      ON homework_submissions(homework_id);
    CREATE INDEX IF NOT EXISTS idx_hw_sub_student
      ON homework_submissions(student_id);
    CREATE INDEX IF NOT EXISTS idx_hw_sub_ungraded
      ON homework_submissions(homework_id, score);
    CREATE INDEX IF NOT EXISTS idx_hw_synced
      ON homework(_synced);
    CREATE INDEX IF NOT EXISTS idx_hw_sub_synced
      ON homework_submissions(_synced);
  `);
};

// ─────────────────────────────────────────────────────────────
// STUDENT NAME RESOLVER
// ─────────────────────────────────────────────────────────────

const PLACEHOLDER_NAMES = new Set([
  'student', 'unknown', 'unknown student', 'n/a', 'na', '-', '',
]);

const isPlaceholder = (name) =>
  !name || PLACEHOLDER_NAMES.has(name.trim().toLowerCase());

const resolveStudentName = async (db, userId) => {
  if (!userId) return { name: 'Unknown Student', email: null, class_name: null };

  const resolveClass = async (classId) => {
    if (!classId) return null;
    const row = await db
      .getFirstAsync(`SELECT name FROM classes WHERE id = ? LIMIT 1`, [classId])
      .catch(() => null);
    return row?.name ?? null;
  };

  const classFromRow = async (row) => {
    if (!row) return null;
    return (
      row.class_name ||
      row.className  ||
      (row.classId  ? await resolveClass(row.classId)  : null) ||
      (row.class_id ? await resolveClass(row.class_id) : null)
    );
  };

  // Attempt 1: students.user_id
  try {
    const s = await db
      .getFirstAsync(
        `SELECT * FROM students
         WHERE user_id = ?
           AND (deleted_at IS NULL OR deleted_at = '')
         LIMIT 1`,
        [userId]
      )
      .catch(() => null);

    if (s) {
      const name = s.name?.trim();
      if (name && !isPlaceholder(name)) {
        return { name, email: s.email || null, class_name: await classFromRow(s) };
      }
      const u = await db
        .getFirstAsync(`SELECT name, email FROM users WHERE id = ? LIMIT 1`, [userId])
        .catch(() => null);
      const uName = u?.name?.trim();
      if (uName && !isPlaceholder(uName)) {
        return {
          name:       uName,
          email:      s.email || u?.email || null,
          class_name: await classFromRow(s),
        };
      }
    }
  } catch {}

  // Attempt 2: students.id
  try {
    const s = await db
      .getFirstAsync(
        `SELECT * FROM students
         WHERE id = ?
           AND (deleted_at IS NULL OR deleted_at = '')
         LIMIT 1`,
        [userId]
      )
      .catch(() => null);
    if (s) {
      const name = s.name?.trim();
      if (name && !isPlaceholder(name)) {
        return { name, email: s.email || null, class_name: await classFromRow(s) };
      }
    }
  } catch {}

  // Attempt 3: users.id
  try {
    const u = await db
      .getFirstAsync(`SELECT * FROM users WHERE id = ? LIMIT 1`, [userId])
      .catch(() => null);
    const name = u?.name?.trim();
    if (name && !isPlaceholder(name)) {
      const s = await db
        .getFirstAsync(`SELECT * FROM students WHERE user_id = ? LIMIT 1`, [userId])
        .catch(() => null);
      return {
        name,
        email:      u.email || null,
        class_name: s ? await classFromRow(s) : null,
      };
    }
  } catch {}

  return {
    name:       `Student (${String(userId).slice(-6)})`,
    email:      null,
    class_name: null,
  };
};

// ─────────────────────────────────────────────────────────────
// INTERNAL: Resolve classId for a student
// ─────────────────────────────────────────────────────────────

const resolveStudentClassId = async (db, studentId) => {
  if (!studentId) return null;

  const studentCols = await db
    .getAllAsync(`PRAGMA table_info(students)`)
    .catch(() => []);
  const colNames = new Set(studentCols.map((c) => c.name));

  const classCol =
    colNames.has('classId')  ? 'classId'  :
    colNames.has('class_id') ? 'class_id' :
    colNames.has('class')    ? 'class'    : null;

  if (!classCol) {
    console.warn('[resolveStudentClassId] no class column in students table');
    return null;
  }

  const row = await db
    .getFirstAsync(
      `SELECT "${classCol}" AS resolved_class_id
       FROM   students
       WHERE  (user_id = ? OR id = ?)
         AND  (deleted_at IS NULL OR deleted_at = '')
       LIMIT  1`,
      [String(studentId), String(studentId)]
    )
    .catch(() => null);

  const resolved = row?.resolved_class_id
    ? String(row.resolved_class_id)
    : null;

  console.log(
    `[resolveStudentClassId] studentId="${studentId}"` +
    ` classCol="${classCol}" → "${resolved}"`
  );

  return resolved;
};

// ─────────────────────────────────────────────────────────────
// INTERNAL: Normalise schoolId for comparison
// ─────────────────────────────────────────────────────────────

const normaliseSchoolId = (id) =>
  String(id ?? '').trim().toLowerCase();

// ─────────────────────────────────────────────────────────────
// HOMEWORK CRUD
// ─────────────────────────────────────────────────────────────

export const createHomework = async ({
  schoolId,
  class_id,
  subject_id,
  created_by,
  title,
  description     = null,
  instructions    = null,
  due_date        = null,
  max_score       = 100,
  allow_late      = true,
  late_penalty    = 0,
  attachment_url  = null,
  attachment_name = null,
  attachment_type = null,
  is_published    = false,
}) => {
  if (!schoolId)      throw new Error('schoolId is required');
  if (!class_id)      throw new Error('class_id is required');
  if (!subject_id)    throw new Error('subject_id is required');
  if (!created_by)    throw new Error('Teacher ID is required');
  if (!title?.trim()) throw new Error('Title is required');

  await ensureHomeworkTables();
  const db = await getDatabase();
  const id = generateId();

  const canonicalSchoolId = String(schoolId).trim();

  await db.runAsync(
    `INSERT INTO homework (
       id, schoolId, class_id, subject_id, created_by,
       title, description, instructions, due_date,
       max_score, allow_late, late_penalty,
       attachment_url, attachment_name, attachment_type,
       is_published, _synced, created_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, 0, datetime('now')
     )`,
    [
      id,
      canonicalSchoolId,
      String(class_id),
      String(subject_id),
      String(created_by),
      title.trim(),
      description,
      instructions,
      due_date,
      Number(max_score),
      allow_late  ? 1 : 0,
      Number(late_penalty),
      attachment_url,
      attachment_name,
      attachment_type,
      is_published ? 1 : 0,
    ]
  );

  console.log(
    `[createHomework] ✅ Created id="${id}"` +
    ` schoolId="${canonicalSchoolId}"` +
    ` class_id="${class_id}"` +
    ` is_published=${is_published ? 1 : 0}`
  );

  return getHomeworkById(id);
};

export const getHomeworkById = async (id) => {
  await ensureHomeworkTables();
  const db = await getDatabase();

  const hw = await db.getFirstAsync(
    `SELECT h.*,
            u.name  AS teacher_name,
            c.name  AS class_name,
            s.name  AS subject_name,
            (SELECT COUNT(*) FROM homework_submissions hs
             WHERE hs.homework_id = h.id) AS submission_count,
            (SELECT COUNT(*) FROM homework_submissions hs
             WHERE hs.homework_id = h.id
               AND hs.score IS NOT NULL) AS graded_count
     FROM   homework h
     LEFT JOIN users    u ON u.id = h.created_by
     LEFT JOIN classes  c ON c.id = h.class_id
     LEFT JOIN subjects s ON s.id = h.subject_id
     WHERE  h.id = ? AND h.deleted_at IS NULL`,
    [id]
  );

  return hw || null;
};

export const getHomeworkList = async ({
  schoolId,
  created_by   = null,
  class_id     = null,
  subject_id   = null,
  is_published = null,
  limit        = 100,
  offset       = 0,
} = {}) => {
  if (!schoolId) return [];

  await ensureHomeworkTables();
  const db = await getDatabase();

  const conditions = ['h.schoolId = ?', 'h.deleted_at IS NULL'];
  const params     = [String(schoolId)];

  if (created_by)  { conditions.push('h.created_by = ?');   params.push(String(created_by));  }
  if (class_id)    { conditions.push('h.class_id = ?');      params.push(String(class_id));    }
  if (subject_id)  { conditions.push('h.subject_id = ?');    params.push(String(subject_id));  }
  if (is_published !== null) {
    conditions.push('h.is_published = ?');
    params.push(is_published ? 1 : 0);
  }

  params.push(Number(limit), Number(offset));

  return db.getAllAsync(
    `SELECT h.*,
            u.name AS teacher_name,
            c.name AS class_name,
            s.name AS subject_name,
            (SELECT COUNT(*) FROM homework_submissions hs
             WHERE hs.homework_id = h.id) AS submission_count,
            (SELECT COUNT(*) FROM homework_submissions hs
             WHERE hs.homework_id = h.id
               AND hs.score IS NOT NULL) AS graded_count,
            (SELECT COUNT(*) FROM students st
             WHERE  (st.class_id = h.class_id OR st.classId = h.class_id)
               AND  (st.deleted_at IS NULL OR st.deleted_at = '')) AS class_size
     FROM   homework h
     LEFT JOIN users    u ON u.id = h.created_by
     LEFT JOIN classes  c ON c.id = h.class_id
     LEFT JOIN subjects s ON s.id = h.subject_id
     WHERE  ${conditions.join(' AND ')}
     ORDER  BY h.created_at DESC
     LIMIT  ? OFFSET ?`,
    params
  );
};

export const updateHomework = async (id, updates) => {
  const ALLOWED = [
    'title', 'description', 'instructions', 'due_date',
    'max_score', 'allow_late', 'late_penalty',
    'attachment_url', 'attachment_name', 'attachment_type',
    'is_published', 'status',
  ];

  const fields = Object.keys(updates).filter((k) => ALLOWED.includes(k));
  if (!fields.length) return getHomeworkById(id);

  await ensureHomeworkTables();
  const db = await getDatabase();

  const setClauses = fields.map((f) => `${f} = ?`).join(', ');
  const values     = fields.map((f) => updates[f]);

  await db.runAsync(
    `UPDATE homework
     SET    ${setClauses}, updated_at = datetime('now'), _synced = 0
     WHERE  id = ?`,
    [...values, id]
  );

  return getHomeworkById(id);
};

export const deleteHomework = async (id) => {
  await ensureHomeworkTables();
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE homework
     SET deleted_at = datetime('now'), _synced = 0
     WHERE id = ?`,
    [id]
  );
};

export const publishHomework   = (id) => updateHomework(id, { is_published: 1 });
export const unpublishHomework = (id) => updateHomework(id, { is_published: 0 });

// ─────────────────────────────────────────────────────────────
// SUBMISSIONS — TEACHER SIDE
// ─────────────────────────────────────────────────────────────

export const getSubmissions = async (homeworkId) => {
  if (!homeworkId) return [];

  await ensureHomeworkTables();
  const db = await getDatabase();

  const hw  = await getHomeworkById(homeworkId);
  const raw = await db.getAllAsync(
    `SELECT * FROM homework_submissions
     WHERE  homework_id = ?
     ORDER  BY submitted_at DESC`,
    [homeworkId]
  );

  if (!raw.length) return [];

  const nameCache = new Map();
  return Promise.all(
    raw.map(async (sub) => {
      const uid = sub.student_id;
      if (!nameCache.has(uid)) {
        nameCache.set(uid, await resolveStudentName(db, uid));
      }
      const resolved = nameCache.get(uid);

      let is_late = sub.is_late;
      if (hw?.due_date && sub.submitted_at) {
        is_late = new Date(sub.submitted_at) > new Date(hw.due_date) ? 1 : 0;
      }

      return {
        ...sub,
        student_name:  sub.student_name  || resolved.name,
        student_email: sub.student_email || resolved.email,
        class_name:    resolved.class_name,
        is_late,
      };
    })
  );
};

export const gradeSubmission = async ({
  submissionId,
  score,
  feedback = null,
  gradedBy,
}) => {
  if (!submissionId) throw new Error('submissionId is required');
  if (score == null) throw new Error('score is required');

  await ensureHomeworkTables();
  const db = await getDatabase();

  await db.runAsync(
    `UPDATE homework_submissions
     SET score = ?, feedback = ?, graded_by = ?,
         graded_at = datetime('now'), status = 'graded',
         _synced = 0, updated_at = datetime('now')
     WHERE id = ?`,
    [Number(score), feedback, String(gradedBy), submissionId]
  );
};

export const getStudentsWithoutSubmission = async (homeworkId) => {
  if (!homeworkId) return [];

  await ensureHomeworkTables();
  const db = await getDatabase();

  const hw = await getHomeworkById(homeworkId);
  if (!hw?.class_id) return [];

  const studentCols = await db
    .getAllAsync(`PRAGMA table_info(students)`)
    .catch(() => []);
  const colNames = new Set(studentCols.map((c) => c.name));
  const classCol =
    colNames.has('classId')  ? 'classId'  :
    colNames.has('class_id') ? 'class_id' : null;

  if (!classCol) return [];

  return db.getAllAsync(
    `SELECT s.id, s.name, s.email, s.user_id,
            u.name AS user_name
     FROM   students s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE  s.${classCol} = ?
       AND  (s.deleted_at IS NULL OR s.deleted_at = '')
       AND  s.id NOT IN (
         SELECT student_id FROM homework_submissions
         WHERE  homework_id = ?
       )
       AND  (s.user_id IS NULL OR s.user_id NOT IN (
         SELECT student_id FROM homework_submissions
         WHERE  homework_id = ?
       ))`,
    [hw.class_id, homeworkId, homeworkId]
  );
};

// ─────────────────────────────────────────────────────────────
// SUBMISSIONS — STUDENT SIDE
// ─────────────────────────────────────────────────────────────

export const submitHomework = async ({
  homeworkId,
  studentId,
  submission_text  = null,
  attachment_url   = null,
  attachment_name  = null,
  attachment_type  = null,
}) => {
  if (!homeworkId) throw new Error('homeworkId is required');
  if (!studentId)  throw new Error('studentId is required');

  await ensureHomeworkTables();
  const db = await getDatabase();

  const hw = await getHomeworkById(homeworkId);
  if (!hw) throw new Error('Homework not found');

  const now     = new Date().toISOString();
  const is_late = hw.due_date && now > hw.due_date ? 1 : 0;

  if (is_late && !hw.allow_late) {
    throw new Error('This assignment no longer accepts submissions');
  }

  const existing = await db.getFirstAsync(
    `SELECT id FROM homework_submissions
     WHERE homework_id = ? AND student_id = ?`,
    [homeworkId, String(studentId)]
  );

  if (existing) {
    await db.runAsync(
      `UPDATE homework_submissions
       SET submission_text = ?, attachment_url = ?,
           attachment_name = ?, attachment_type = ?,
           submitted_at = datetime('now'), is_late = ?,
           status = 'submitted', _synced = 0,
           updated_at = datetime('now')
       WHERE id = ?`,
      [
        submission_text, attachment_url,
        attachment_name, attachment_type,
        is_late, existing.id,
      ]
    );
    return existing.id;
  }

  const id = generateId();
  await db.runAsync(
    `INSERT INTO homework_submissions (
       id, homework_id, student_id,
       submission_text, attachment_url, attachment_name, attachment_type,
       is_late, status, _synced, submitted_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 0, datetime('now'), datetime('now'))`,
    [
      id, homeworkId, String(studentId),
      submission_text, attachment_url,
      attachment_name, attachment_type,
      is_late,
    ]
  );

  return id;
};

// ─────────────────────────────────────────────────────────────
// GET STUDENT HOMEWORK
// ─────────────────────────────────────────────────────────────

export const getStudentHomework = async ({
  schoolId,
  studentId,
  classId    = null,
  subject_id = null,
} = {}) => {
  if (!studentId) {
    console.warn('[getStudentHomework] missing studentId');
    return [];
  }

  await ensureHomeworkTables();
  const db = await getDatabase();

  // ── Step 1: Resolve classId ───────────────────────────────
  let resolvedClassId = classId || null;

  if (!resolvedClassId) {
    resolvedClassId = await resolveStudentClassId(db, studentId);
  } else {
    console.log(
      `[getStudentHomework] using provided classId="${resolvedClassId}"`
    );
  }

  if (!resolvedClassId) {
    console.warn(
      '[getStudentHomework] could not resolve classId — returning []'
    );
    return [];
  }

  // ── Step 2: Verify classId exists — warn only, do NOT block ─
  const classRow = await db
    .getFirstAsync(
      `SELECT id FROM classes WHERE id = ? LIMIT 1`,
      [String(resolvedClassId)]
    )
    .catch(() => null);

  if (!classRow) {
    console.warn(
      `[getStudentHomework] classId="${resolvedClassId}" not in classes table` +
      ` — continuing anyway (homework may still exist)`
    );
  }

  // ── Step 3: Build conditions ──────────────────────────────
  const baseConditions = [
    'h.class_id   = ?',
    'h.is_published = 1',
    'h.deleted_at IS NULL',
  ];
  const baseParams = [String(resolvedClassId)];

  if (subject_id) {
    baseConditions.push('h.subject_id = ?');
    baseParams.push(String(subject_id));
  }

  // ── Shared SELECT / FROM / ORDER ─────────────────────────
  const SELECT = `
    SELECT
      h.*,
      u.name AS teacher_name,
      c.name AS class_name,
      s.name AS subject_name,
      sub.id              AS submission_id,
      sub.status          AS submission_status,
      sub.score           AS submission_score,
      sub.feedback        AS submission_feedback,
      sub.submitted_at    AS submission_submitted_at,
      sub.is_late         AS submission_is_late,
      sub.submission_text AS submission_text
    FROM   homework h
    LEFT JOIN users    u   ON u.id = h.created_by
    LEFT JOIN classes  c   ON c.id = h.class_id
    LEFT JOIN subjects s   ON s.id = h.subject_id
    LEFT JOIN homework_submissions sub
           ON sub.homework_id = h.id
          AND (sub.student_id = ? OR sub.student_id = ?)`;

  const ORDER = `
    ORDER BY
      CASE WHEN h.due_date IS NULL THEN 1 ELSE 0 END,
      h.due_date   ASC,
      h.created_at DESC`;

  const selectParams = [String(studentId), String(studentId)];

  // ── Step 4: Try WITH schoolId first ──────────────────────
  let rows = [];

  if (schoolId) {
    rows = await db
      .getAllAsync(
        `${SELECT}
         WHERE  h.schoolId = ?
           AND  ${baseConditions.join(' AND ')}
         ${ORDER}`,
        [...selectParams, String(schoolId), ...baseParams]
      )
      .catch((err) => {
        console.warn('[getStudentHomework] schoolId query error:', err.message);
        return [];
      });

    console.log(
      `[getStudentHomework] with schoolId="${schoolId}": ${rows.length} items`
    );
  }

  // ── Step 5: Fallback — normalised schoolId match ──────────
  if (rows.length === 0 && schoolId) {
    const normTarget = normaliseSchoolId(schoolId);

    const candidates = await db
      .getAllAsync(
        `${SELECT}
         WHERE  ${baseConditions.join(' AND ')}
         ${ORDER}`,
        [...selectParams, ...baseParams]
      )
      .catch((err) => {
        console.warn('[getStudentHomework] normalised fallback error:', err.message);
        return [];
      });

    rows = candidates.filter(
      (r) => normaliseSchoolId(r.schoolId) === normTarget
    );

    if (rows.length > 0) {
      console.warn(
        `[getStudentHomework] ⚠️ schoolId normalised match found` +
        ` — stored="${candidates[0]?.schoolId}" vs provided="${schoolId}"`
      );
    }
  }

  // ── Step 6: Fallback — no schoolId filter at all ─────────
  if (rows.length === 0) {
    console.log(
      '[getStudentHomework] trying without schoolId filter (last resort)'
    );

    rows = await db
      .getAllAsync(
        `${SELECT}
         WHERE  ${baseConditions.join(' AND ')}
         ${ORDER}`,
        [...selectParams, ...baseParams]
      )
      .catch((err) => {
        console.warn('[getStudentHomework] no-schoolId fallback error:', err.message);
        return [];
      });

    console.log(
      `[getStudentHomework] fallback (no schoolId): ${rows.length} items`
    );

    if (rows.length > 0 && schoolId) {
      const storedSchools = [
        ...new Set(rows.map((r) => r.schoolId).filter(Boolean)),
      ];
      console.warn(
        `[getStudentHomework] ⚠️  schoolId mismatch!\n` +
        `  Provided : "${schoolId}"\n` +
        `  Stored   : ${JSON.stringify(storedSchools)}\n` +
        `  Fix      : ensure sync writes schoolId in the same format as auth`
      );
    }
  }

  console.log(
    `[getStudentHomework] ✅ returning ${rows.length} items` +
    ` for classId="${resolvedClassId}"`
  );

  return rows;
};

// ─────────────────────────────────────────────────────────────
// REPAIR SCHOOL ID MISMATCHES
// ─────────────────────────────────────────────────────────────

export const repairSchoolIdMismatch = async (correctSchoolId) => {
  if (!correctSchoolId) return;

  const db        = await getDatabase();
  const canonical = String(correctSchoolId).trim();
  const norm      = normaliseSchoolId(canonical);

  const broken = await db
    .getAllAsync(
      `SELECT id, schoolId FROM homework
       WHERE schoolId != ? AND deleted_at IS NULL`,
      [canonical]
    )
    .catch(() => []);

  const toFix = broken.filter(
    (r) => normaliseSchoolId(r.schoolId) === norm
  );

  if (!toFix.length) {
    console.log('[repairSchoolIdMismatch] nothing to fix');
    return;
  }

  console.log(
    `[repairSchoolIdMismatch] fixing ${toFix.length} rows → "${canonical}"`
  );

  await db.runAsync(
    `UPDATE homework SET schoolId = ?, _synced = 0
     WHERE id IN (${toFix.map(() => '?').join(',')})`,
    [canonical, ...toFix.map((r) => r.id)]
  );
};

// ─────────────────────────────────────────────────────────────
// DEBUG HELPER
// ─────────────────────────────────────────────────────────────

export const debugHomework = async (schoolId, classId) => {
  try {
    const db = await getDatabase();

    console.log('═══════════════════ HOMEWORK DEBUG ═══════════════════');
    console.log('  schoolId :', schoolId  ?? '(none)');
    console.log('  classId  :', classId   ?? '(none)');

    const total = await db
      .getFirstAsync(`SELECT COUNT(*) AS cnt FROM homework`)
      .catch(() => null);
    console.log('  Total homework rows:', total?.cnt ?? 'table missing');

    const allRows = await db
      .getAllAsync(
        `SELECT id, schoolId, class_id, subject_id,
                is_published, deleted_at, title, created_by
         FROM homework LIMIT 20`
      )
      .catch(() => []);
    console.log('  All rows:', JSON.stringify(allRows, null, 2));

    const schools = await db
      .getAllAsync(`SELECT DISTINCT schoolId FROM homework`)
      .catch(() => []);
    console.log('  Distinct schoolIds:', schools.map((r) => r.schoolId));

    const classes = await db
      .getAllAsync(`SELECT DISTINCT class_id FROM homework`)
      .catch(() => []);
    console.log('  Distinct class_ids:', classes.map((r) => r.class_id));

    const published = await db
      .getFirstAsync(
        `SELECT COUNT(*) AS cnt FROM homework WHERE is_published = 1`
      )
      .catch(() => null);
    console.log('  Published count:', published?.cnt ?? 0);

    if (schoolId) {
      const sm = await db
        .getAllAsync(
          `SELECT id, title, class_id, is_published, schoolId
           FROM homework WHERE schoolId = ?`,
          [String(schoolId)]
        )
        .catch(() => []);
      console.log(
        `  Exact schoolId="${schoolId}" matches: ${sm.length}`,
        JSON.stringify(sm)
      );

      const norm    = normaliseSchoolId(schoolId);
      const allHw   = await db
        .getAllAsync(`SELECT id, schoolId FROM homework`)
        .catch(() => []);
      const normMatch = allHw.filter(
        (r) => normaliseSchoolId(r.schoolId) === norm && r.schoolId !== schoolId
      );
      if (normMatch.length) {
        console.warn(
          `  ⚠️  Normalised matches (different case/spacing): ${normMatch.length}`,
          JSON.stringify(normMatch)
        );
      }
    }

    if (classId) {
      const cm = await db
        .getAllAsync(
          `SELECT id, title, schoolId, is_published
           FROM homework WHERE class_id = ?`,
          [String(classId)]
        )
        .catch(() => []);
      console.log(
        `  class_id="${classId}" matches: ${cm.length}`,
        JSON.stringify(cm)
      );
    }

    const studentCols = await db
      .getAllAsync(`PRAGMA table_info(students)`)
      .catch(() => []);
    console.log(
      '  Students columns:',
      studentCols.map((c) => c.name).join(', ')
    );

    console.log('═══════════════════════════════════════════════════════');
  } catch (err) {
    console.warn('[debugHomework] error:', err.message);
  }
};