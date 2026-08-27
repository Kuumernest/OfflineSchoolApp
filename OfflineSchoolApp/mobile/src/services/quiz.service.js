// src/services/quiz.service.js

import { getDatabase } from '../db/database';
import { appError } from "../utils/appError";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const generateId = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

const shuffleArray = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ─────────────────────────────────────────────────────────────
// SCHEMA INTROSPECTION
// ─────────────────────────────────────────────────────────────

const getTableColumns = async (db, tableName) => {
  try {
    const rows = await db.getAllAsync(`PRAGMA table_info(${tableName})`, []);
    return new Set((rows ?? []).map((r) => r.name));
  } catch {
    return new Set();
  }
};

const pickCol = (cols, ...candidates) => {
  for (const c of candidates) {
    if (cols.has(c)) return c;
  }
  return null;
};

// ─────────────────────────────────────────────────────────────
// ID NORMALISATION
// ─────────────────────────────────────────────────────────────

const sameId = (a, b) =>
  a && b &&
  String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// ─────────────────────────────────────────────────────────────
// IN-FLIGHT GUARDS
// ─────────────────────────────────────────────────────────────

const _inflightQuestions = new Set();
const _inflightQuizzes   = new Set();

// ─────────────────────────────────────────────────────────────
// PLACEHOLDER NAME DETECTION
// ─────────────────────────────────────────────────────────────

const PLACEHOLDER_NAMES = new Set([
  'student', 'unknown', 'unknown student', 'n/a', 'na', '-', '',
]);

const isPlaceholder = (name) =>
  !name || PLACEHOLDER_NAMES.has(name.trim().toLowerCase());

// ─────────────────────────────────────────────────────────────
// STUDENT NAME RESOLVER
// ─────────────────────────────────────────────────────────────

const resolveStudentName = async (db, userId) => {
  if (!userId) {
    return {
      student_name:  'Unknown Student',
      student_email: null,
      student_class: null,
    };
  }

  const resolveClassName = async (classId) => {
    if (!classId) return null;
    const cls = await db
      .getFirstAsync(`SELECT name FROM classes WHERE id = ? LIMIT 1`, [classId])
      .catch(() => null);
    return cls?.name ?? null;
  };

  const getClassFromRow = async (row) => {
    if (!row) return null;
    return (
      row.class_name ||
      row.className  ||
      (row.classId  ? await resolveClassName(row.classId)  : null) ||
      (row.class_id ? await resolveClassName(row.class_id) : null)
    );
  };

  // Attempt 1: students WHERE user_id = userId
  try {
    const stuRow = await db
      .getFirstAsync(
        `SELECT * FROM students
         WHERE  user_id = ?
           AND  (deleted_at IS NULL OR deleted_at = '')
         LIMIT  1`,
        [userId]
      )
      .catch(() => null);

    if (stuRow) {
      const name = stuRow.name?.trim();
      if (name && !isPlaceholder(name)) {
        return {
          student_name:  name,
          student_email: stuRow.email || null,
          student_class: await getClassFromRow(stuRow),
        };
      }

      const student_class = await getClassFromRow(stuRow);
      const student_email = stuRow.email || null;

      const userRow = await db
        .getFirstAsync(
          `SELECT name, email FROM users WHERE id = ? LIMIT 1`,
          [userId]
        )
        .catch(() => null);

      const userName = userRow?.name?.trim();
      if (userName && !isPlaceholder(userName)) {
        return {
          student_name:  userName,
          student_email: student_email || userRow?.email || null,
          student_class,
        };
      }
    }
  } catch (err) {
    console.warn('[resolveStudentName] attempt 1 error:', err?.message);
  }

  // Attempt 2: students WHERE id = userId
  try {
    const stuRow = await db
      .getFirstAsync(
        `SELECT * FROM students
         WHERE  id = ?
           AND  (deleted_at IS NULL OR deleted_at = '')
         LIMIT  1`,
        [userId]
      )
      .catch(() => null);

    if (stuRow) {
      const name = stuRow.name?.trim();
      if (name && !isPlaceholder(name)) {
        return {
          student_name:  name,
          student_email: stuRow.email || null,
          student_class: await getClassFromRow(stuRow),
        };
      }
    }
  } catch (err) {
    console.warn('[resolveStudentName] attempt 2 error:', err?.message);
  }

  // Attempt 3: users WHERE id = userId
  try {
    const userRow = await db
      .getFirstAsync(
        `SELECT * FROM users WHERE id = ? LIMIT 1`,
        [userId]
      )
      .catch(() => null);

    const userName = userRow?.name?.trim();
    if (userName && !isPlaceholder(userName)) {
      const stuRow = await db
        .getFirstAsync(
          `SELECT * FROM students WHERE user_id = ? LIMIT 1`,
          [userId]
        )
        .catch(() => null);

      return {
        student_name:  userName,
        student_email: userRow.email || null,
        student_class: stuRow ? await getClassFromRow(stuRow) : null,
      };
    }
  } catch (err) {
    console.warn('[resolveStudentName] attempt 3 error:', err?.message);
  }

  // Attempt 4: email cross-lookup
  try {
    const userRow = await db
      .getFirstAsync(
        `SELECT name, email FROM users WHERE id = ? LIMIT 1`,
        [userId]
      )
      .catch(() => null);

    if (userRow?.email) {
      const stuRow = await db
        .getFirstAsync(
          `SELECT * FROM students WHERE email = ? LIMIT 1`,
          [userRow.email]
        )
        .catch(() => null);

      const name = stuRow?.name?.trim();
      if (name && !isPlaceholder(name)) {
        return {
          student_name:  name,
          student_email: userRow.email,
          student_class: await getClassFromRow(stuRow),
        };
      }
    }
  } catch (err) {
    console.warn('[resolveStudentName] attempt 4 error:', err?.message);
  }

  console.warn(
    `[resolveStudentName] ❌ all attempts failed for userId: ${userId}`
  );
  return {
    student_name:  `Student (${String(userId).slice(-6)})`,
    student_email: null,
    student_class: null,
  };
};

// ─────────────────────────────────────────────────────────────
// RESOLVE STUDENT CLASS ID  (internal helper)
// ─────────────────────────────────────────────────────────────

const resolveStudentClassIdInternal = async (db, studentId) => {
  if (!studentId) return null;

  const cols = await getTableColumns(db, 'students');

  const classCol =
    cols.has('classId')  ? 'classId'  :
    cols.has('class_id') ? 'class_id' :
    cols.has('class')    ? 'class'    : null;

  if (!classCol) {
    console.warn('[resolveStudentClassIdInternal] no class column in students table');
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
    `[resolveStudentClassIdInternal]` +
    ` studentId="${studentId}" col="${classCol}" → "${resolved}"`
  );

  return resolved;
};

// ─────────────────────────────────────────────────────────────
// SHARED SELECT FRAGMENT
// ─────────────────────────────────────────────────────────────

const QUIZ_SELECT = `
  SELECT  q.id, q.schoolId, q.title, q.description, q.instructions,
          q.subject_id, q.class_id, q.created_by, q.time_limit_minutes,
          q.time_per_question, q.shuffle_questions, q.shuffle_options,
          q.questions_per_page, q.allow_backtrack, q.max_attempts,
          q.passing_score, q.available_from, q.available_until,
          q.show_answers_after, q.show_score, q.show_explanation,
          q.is_published, q._synced, q.created_at, q.updated_at,
          u.name  AS teacher_name,
          s.name  AS subject_name,
          c.name  AS class_name,
          CAST(COALESCE(qa.total_attempts, 0) AS TEXT) AS total_attempts_raw,
          qa.avg_score,
          (SELECT COUNT(*)
           FROM   quiz_questions qq2
           WHERE  qq2.quiz_id = q.id) AS question_count
  FROM      quizzes        q
  LEFT JOIN users          u  ON u.id = q.created_by
  LEFT JOIN subjects       s  ON s.id = q.subject_id
  LEFT JOIN classes        c  ON c.id = q.class_id
  LEFT JOIN quiz_analytics qa ON qa.quiz_id = q.id`;

const normaliseQuizRows = (rows) =>
  rows.map((r) => ({
    ...r,
    total_attempts: r.total_attempts_raw != null
      ? Number(r.total_attempts_raw)
      : 0,
  }));

// ─────────────────────────────────────────────────────────────
// CATEGORIES
// ─────────────────────────────────────────────────────────────

export const createCategory = async ({
  schoolId,
  name,
  description = null,
  parent_id   = null,
}) => {
  if (!schoolId)     throw new Error('schoolId is required');
  if (!name?.trim()) throw appError("svcErr.categoryNameRequired", 'Category name is required');

  const db = await getDatabase();
  const id = generateId();

  await db.runAsync(
    `INSERT INTO question_categories
       (id, schoolId, name, description, parent_id, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`,
    [id, String(schoolId), name.trim(), description, parent_id]
  );

  return { id, schoolId, name: name.trim(), description, parent_id };
};

export const getCategories = async (schoolId) => {
  const safeSchoolId = schoolId ? String(schoolId) : null;
  if (!safeSchoolId) {
    console.warn('[getCategories] called without a schoolId — returning []');
    return [];
  }

  const db = await getDatabase();

  return db.getAllAsync(
    `SELECT *
     FROM   question_categories
     WHERE  schoolId  = ?
       AND  is_active = 1
       AND  deleted_at IS NULL
     ORDER  BY name ASC`,
    [safeSchoolId]
  );
};

// ─────────────────────────────────────────────────────────────
// QUESTIONS
// ─────────────────────────────────────────────────────────────

export const createQuestion = async ({
  schoolId,
  category_id,
  question_text,
  question_type,
  media_url   = null,
  difficulty  = 'medium',
  points      = 1.0,
  explanation = null,
  created_by,
  options     = [],
}) => {
  if (!schoolId)              throw new Error('schoolId is required');
  if (!question_text?.trim()) throw appError("svcErr.questionTextRequired", 'Question text is required');
  if (!question_type)         throw appError("svcErr.questionTypeRequired", 'Question type is required');
  if (!created_by)            throw new Error('Teacher ID is required');

  const dedupeKey = [
    schoolId,
    question_text.trim(),
    question_type,
    created_by,
  ].join('::');

  if (_inflightQuestions.has(dedupeKey)) {
    console.warn('[createQuestion] duplicate call blocked:', dedupeKey);
    throw appError("svcErr.questionSaving", 'This question is already being saved. Please wait.');
  }
  _inflightQuestions.add(dedupeKey);

  try {
    const db = await getDatabase();
    const id = generateId();

    await db.runAsync(
      `INSERT INTO questions (
         id, schoolId, category_id, question_text, question_type,
         media_url, difficulty, points, explanation,
         is_active, created_by, _synced, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, datetime('now'))`,
      [
        id,
        String(schoolId),
        category_id ? String(category_id) : null,
        question_text.trim(),
        question_type,
        media_url,
        difficulty,
        Number(points),
        explanation,
        String(created_by),
      ]
    );

    for (const opt of options) {
      await db.runAsync(
        `INSERT INTO question_options
           (id, question_id, option_text, is_correct, match_pair, display_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          generateId(),
          id,
          opt.option_text,
          opt.is_correct    ? 1 : 0,
          opt.match_pair    ?? null,
          opt.display_order ?? 0,
        ]
      );
    }

    await db
      .runAsync(
        `INSERT OR IGNORE INTO question_analytics (id, question_id)
         VALUES (?, ?)`,
        [generateId(), id]
      )
      .catch(() => {});

    return getQuestionById(id);
  } finally {
    _inflightQuestions.delete(dedupeKey);
  }
};

export const getQuestionById = async (id) => {
  const db       = await getDatabase();
  const question = await db.getFirstAsync(
    `SELECT * FROM questions WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  if (!question) return null;

  question.options = await db.getAllAsync(
    `SELECT *
     FROM   question_options
     WHERE  question_id = ?
     ORDER  BY display_order ASC`,
    [id]
  );

  return question;
};

export const getQuestions = async ({
  schoolId,
  category_id   = null,
  difficulty    = null,
  question_type = null,
  search        = null,
  created_by    = null,
  limit         = 50,
  offset        = 0,
} = {}) => {
  const safeSchoolId  = schoolId   ? String(schoolId)   : null;
  const safeCreatedBy = created_by ? String(created_by) : null;
  const safeLimit     = Number.isFinite(Number(limit))  ? Number(limit)  : 50;
  const safeOffset    = Number.isFinite(Number(offset)) ? Number(offset) : 0;

  if (!safeSchoolId) {
    console.warn('[getQuestions] called without a schoolId — returning []');
    return [];
  }

  if (!safeCreatedBy) {
    console.warn(
      '[getQuestions] ⚠️  called without created_by — ' +
      'all teachers\' questions will be returned.'
    );
  }

  const db         = await getDatabase();
  const conditions = ['q.schoolId = ?', 'q.is_active = 1', 'q.deleted_at IS NULL'];
  const params     = [safeSchoolId];

  if (category_id)   { conditions.push('q.category_id = ?');     params.push(String(category_id));   }
  if (difficulty)    { conditions.push('q.difficulty = ?');       params.push(String(difficulty));    }
  if (question_type) { conditions.push('q.question_type = ?');    params.push(String(question_type)); }
  if (search)        { conditions.push('q.question_text LIKE ?'); params.push(`%${search}%`);         }
  if (safeCreatedBy) { conditions.push('q.created_by = ?');       params.push(safeCreatedBy);         }

  params.push(safeLimit, safeOffset);

  const rows = await db.getAllAsync(
    `SELECT
       q.id, q.schoolId, q.category_id, q.question_text, q.question_type,
       q.media_url, q.difficulty, q.points, q.explanation, q.is_active,
       q.created_by, q._synced, q.created_at, q.updated_at,
       qc.name                  AS category_name,
       MAX(qa.difficulty_score) AS difficulty_score,
       MAX(qa.times_shown)      AS times_shown
     FROM      questions           q
     LEFT JOIN question_categories qc ON qc.id = q.category_id
     LEFT JOIN question_analytics  qa ON qa.question_id = q.id
     WHERE     ${conditions.join(' AND ')}
     GROUP BY  q.id
     ORDER BY  q.created_at DESC
     LIMIT ? OFFSET ?`,
    params
  );

  const withOptions = await Promise.all(
    rows.map(async (q) => {
      q.options = await db.getAllAsync(
        `SELECT *
         FROM   question_options
         WHERE  question_id = ?
         ORDER  BY display_order ASC`,
        [q.id]
      );
      return q;
    })
  );

  return withOptions;
};

export const updateQuestion = async (id, updates) => {
  const ALLOWED = [
    'question_text', 'question_type', 'category_id', 'difficulty',
    'points', 'explanation', 'media_url', 'is_active',
  ];

  const fields = Object.keys(updates).filter((k) => ALLOWED.includes(k));
  if (fields.length === 0) return getQuestionById(id);

  const db         = await getDatabase();
  const setClauses = fields.map((f) => `${f} = ?`).join(', ');
  const values     = fields.map((f) => updates[f]);

  await db.runAsync(
    `UPDATE questions
     SET    ${setClauses}, updated_at = datetime('now'), _synced = 0
     WHERE  id = ?`,
    [...values, id]
  );

  return getQuestionById(id);
};

export const updateQuestionOptions = async (questionId, options = []) => {
  const db = await getDatabase();

  await db.runAsync(
    `DELETE FROM question_options WHERE question_id = ?`,
    [questionId]
  );

  for (const opt of options) {
    await db.runAsync(
      `INSERT INTO question_options
         (id, question_id, option_text, is_correct, match_pair, display_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        questionId,
        opt.option_text,
        opt.is_correct    ? 1 : 0,
        opt.match_pair    ?? null,
        opt.display_order ?? 0,
      ]
    );
  }

  // ✅ Mark the question as unsynced so SyncManager pushes it
  await db.runAsync(
    `UPDATE questions SET _synced = 0, updated_at = datetime('now') WHERE id = ?`,
    [questionId]
  );
};

export const deleteQuestion = async (id) => {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE questions
     SET deleted_at = datetime('now'), _synced = 0
     WHERE id = ?`,
    [id]
  );
};

// ─────────────────────────────────────────────────────────────
// TEACHER HELPERS
// ─────────────────────────────────────────────────────────────

export const getTeacherClasses = async (teacherId, schoolId) => {
  if (!teacherId) return [];

  const db = await getDatabase();

  try {
    const taCols = await getTableColumns(db, 'teacher_assignments');
    if (taCols.size === 0) return [];

    const tidCol = pickCol(taCols, 'teacherId', 'teacher_id');
    const sidCol = pickCol(taCols, 'schoolId',  'school_id');
    const clsCol = pickCol(taCols, 'classId',   'class_id');

    if (!tidCol || !clsCol) return [];

    const delFilter = taCols.has('deleted_at')
      ? `AND (ta.deleted_at IS NULL OR ta.deleted_at = '')`
      : '';
    const sidFilter = sidCol && schoolId ? `AND ta."${sidCol}" = ?` : '';
    const params    = sidCol && schoolId
      ? [String(teacherId), String(schoolId)]
      : [String(teacherId)];

    return await db
      .getAllAsync(
        `SELECT DISTINCT c.id, c.name, c.level, c.section
         FROM   teacher_assignments ta
         JOIN   classes             c  ON c.id = ta."${clsCol}"
         WHERE  ta."${tidCol}" = ?
           ${sidFilter}
           ${delFilter}
           AND c.deleted_at IS NULL
           AND c.is_active  = 1
         ORDER  BY c.name ASC`,
        params
      )
      .catch(() => []);
  } catch (err) {
    console.warn('[getTeacherClasses] failed:', err?.message);
    return [];
  }
};

export const getTeacherSubjectsForClass = async (teacherId, classId, schoolId) => {
  if (!teacherId || !classId) return [];

  const db = await getDatabase();

  try {
    const taCols = await getTableColumns(db, 'teacher_assignments');
    if (taCols.size === 0) return [];

    const tidCol = pickCol(taCols, 'teacherId', 'teacher_id');
    const sidCol = pickCol(taCols, 'schoolId',  'school_id');
    const clsCol = pickCol(taCols, 'classId',   'class_id');
    const subCol = pickCol(taCols, 'subjectId', 'subject_id');

    if (!tidCol || !clsCol || !subCol) return [];

    const delFilter = taCols.has('deleted_at')
      ? `AND (ta.deleted_at IS NULL OR ta.deleted_at = '')`
      : '';
    const sidFilter = sidCol && schoolId ? `AND ta."${sidCol}" = ?` : '';
    const params    = sidCol && schoolId
      ? [String(teacherId), String(classId), String(schoolId)]
      : [String(teacherId), String(classId)];

    return await db
      .getAllAsync(
        `SELECT DISTINCT s.id, s.name, s.code
         FROM   teacher_assignments ta
         JOIN   subjects            s  ON s.id = ta."${subCol}"
         WHERE  ta."${tidCol}" = ?
           AND  ta."${clsCol}" = ?
           ${sidFilter}
           ${delFilter}
           AND  s.deleted_at IS NULL
         ORDER  BY s.name ASC`,
        params
      )
      .catch(() => []);
  } catch (err) {
    console.warn('[getTeacherSubjectsForClass] failed:', err?.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────
// QUIZZES
// ─────────────────────────────────────────────────────────────

export const createQuiz = async ({
  schoolId,
  title,
  class_id,
  subject_id,
  created_by,
  description        = null,
  instructions       = null,
  time_limit_minutes = null,
  time_per_question  = null,
  shuffle_questions  = false,
  shuffle_options    = false,
  questions_per_page = 1,
  allow_backtrack    = true,
  max_attempts       = 1,
  passing_score      = 70.0,
  available_from     = null,
  available_until    = null,
  password           = null,
  show_answers_after = 'on_completion',
  show_score         = true,
  show_explanation   = true,
  questionIds        = [],
}) => {
  if (!title?.trim())  throw appError("svcErr.quizTitleRequired", 'Quiz title is required');
  if (!class_id)       throw appError("svcErr.quizClassRequired", 'Please select a class for this quiz');
  if (!subject_id)     throw appError("svcErr.quizSubjectRequired", 'Please select a subject for this quiz');
  if (!created_by)     throw new Error('Teacher ID is required');
  if (!schoolId)       throw new Error('School ID is required');

  const dedupeKey = [schoolId, title.trim(), class_id, created_by].join('::');

  if (_inflightQuizzes.has(dedupeKey)) {
    console.warn('[createQuiz] duplicate call blocked:', dedupeKey);
    throw appError("svcErr.quizSaving", 'This quiz is already being saved. Please wait.');
  }
  _inflightQuizzes.add(dedupeKey);

  try {
    const db = await getDatabase();
    const id = generateId();

    const classRow = await db
      .getFirstAsync(
        `SELECT id FROM classes WHERE id = ? AND deleted_at IS NULL`,
        [String(class_id)]
      )
      .catch(() => null);

    if (!classRow) {
      throw appError(
        "svcErr.quizClassNotSynced",
        `Class [${class_id}] not found in local database. ` +
        `Please sync before creating a quiz.`
      );
    }

    await db.runAsync(
      `INSERT INTO quizzes (
         id, schoolId, title, description, instructions,
         subject_id, class_id, created_by,
         time_limit_minutes, time_per_question,
         shuffle_questions, shuffle_options, questions_per_page,
         allow_backtrack, max_attempts, passing_score,
         available_from, available_until, password,
         show_answers_after, show_score, show_explanation,
         is_published, _synced, created_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?,
         0, 0, datetime('now')
       )`,
      [
        id,
        String(schoolId),
        title.trim(),
        description,
        instructions,
        String(subject_id),
        String(class_id),
        String(created_by),
        time_limit_minutes != null ? Number(time_limit_minutes) : null,
        time_per_question  != null ? Number(time_per_question)  : null,
        shuffle_questions  ? 1 : 0,
        shuffle_options    ? 1 : 0,
        Number(questions_per_page),
        allow_backtrack    ? 1 : 0,
        Number(max_attempts),
        Number(passing_score),
        available_from,
        available_until,
        password,
        show_answers_after,
        show_score       ? 1 : 0,
        show_explanation ? 1 : 0,
      ]
    );

    for (let i = 0; i < questionIds.length; i++) {
      const qOwner = await db
        .getFirstAsync(
          `SELECT created_by FROM questions WHERE id = ? AND deleted_at IS NULL`,
          [String(questionIds[i])]
        )
        .catch(() => null);

      if (!qOwner) {
        console.warn(`[createQuiz] question ${questionIds[i]} not found — skipped`);
        continue;
      }

      if (!sameId(qOwner.created_by, created_by)) {
        console.warn(
          `[createQuiz] question ${questionIds[i]} belongs to another teacher — skipped`
        );
        continue;
      }

      await db.runAsync(
        `INSERT OR IGNORE INTO quiz_questions
           (id, quiz_id, question_id, display_order)
         VALUES (?, ?, ?, ?)`,
        [generateId(), id, String(questionIds[i]), i]
      );
    }

    await db
      .runAsync(
        `INSERT OR IGNORE INTO quiz_analytics (id, quiz_id) VALUES (?, ?)`,
        [generateId(), id]
      )
      .catch(() => {});

    const created = await getQuizById(id);

    if (!created?.class_id) {
      throw new Error('Quiz was created but class_id was not saved correctly.');
    }

    return created;
  } finally {
    _inflightQuizzes.delete(dedupeKey);
  }
};

export const getQuizById = async (id, { includeQuestions = false } = {}) => {
  const db = await getDatabase();

  const quiz = await db.getFirstAsync(
    `SELECT   q.*,
              u.name  AS teacher_name,
              s.name  AS subject_name,
              c.name  AS class_name,
              qa.total_attempts,
              qa.avg_score
     FROM     quizzes        q
     LEFT JOIN users         u  ON u.id = q.created_by
     LEFT JOIN subjects      s  ON s.id = q.subject_id
     LEFT JOIN classes       c  ON c.id = q.class_id
     LEFT JOIN quiz_analytics qa ON qa.quiz_id = q.id
     WHERE    q.id = ?
       AND    q.deleted_at IS NULL`,
    [id]
  );

  if (!quiz) return null;

  if (includeQuestions) {
    quiz.questions = await getQuizQuestions(id);
  }

  return quiz;
};

// ─────────────────────────────────────────────────────────────
// GET QUIZZES
// ✅ Student path — 3 fallback layers:
//   Layer 1: WITH schoolId + classId + availability + is_published
//   Layer 2: WITHOUT schoolId (format mismatch)
//   Layer 3: Via attempt history — NO is_published / window filter
// ─────────────────────────────────────────────────────────────

export const getQuizzes = async ({
  schoolId,
  class_id     = null,
  subject_id   = null,
  is_published = null,
  created_by   = null,
  student_id   = null,
  limit        = 50,
  offset       = 0,
} = {}) => {
  const safeSchoolId  = schoolId   ? String(schoolId)   : null;
  const safeCreatedBy = created_by ? String(created_by) : null;
  const safeStudentId = student_id ? String(student_id) : null;
  const safeClassId   = class_id   ? String(class_id)   : null;
  const safeSubjectId = subject_id ? String(subject_id) : null;
  const safeLimit     = Number.isFinite(Number(limit))  ? Number(limit)  : 50;
  const safeOffset    = Number.isFinite(Number(offset)) ? Number(offset) : 0;

  if (!safeSchoolId) {
    console.warn('[getQuizzes] called without a schoolId — returning []');
    return [];
  }

  const db = await getDatabase();

  // ── STUDENT VIEW ─────────────────────────────────────────
  if (safeStudentId) {
    let resolvedClassId = safeClassId;
    if (!resolvedClassId) {
      resolvedClassId = await resolveStudentClassIdInternal(db, safeStudentId);
    }

    if (!resolvedClassId) {
      console.warn(
        `[getQuizzes] student="${safeStudentId}" — could not resolve classId`
      );
    }

    const now = new Date().toISOString();

    const publishedConditions = [
      'q.deleted_at   IS NULL',
      'q.is_published  = 1',
      ...(resolvedClassId ? ['q.class_id = ?'] : []),
      '(q.available_from  IS NULL OR q.available_from  <= ?)',
      '(q.available_until IS NULL OR q.available_until >= ?)',
    ];

    const baseParams = [
      ...(resolvedClassId ? [resolvedClassId] : []),
      now,
      now,
    ];

    // ── Layer 1: WITH schoolId ──────────────────────────────
    let rows = await db
      .getAllAsync(
        `${QUIZ_SELECT}
         WHERE  q.schoolId = ?
           AND  ${publishedConditions.join(' AND ')}
         GROUP  BY q.id
         ORDER  BY q.created_at DESC
         LIMIT  ? OFFSET ?`,
        [safeSchoolId, ...baseParams, safeLimit, safeOffset]
      )
      .catch((err) => {
        console.warn('[getQuizzes] layer1 error:', err.message);
        return [];
      });

    console.log(
      `[getQuizzes] layer1 (schoolId + classId + window) → ${rows.length} quiz(zes)`
    );

    // ── Layer 2: WITHOUT schoolId ───────────────────────────
    if (rows.length === 0) {
      console.warn('[getQuizzes] layer1 returned 0 — trying without schoolId filter');

      rows = await db
        .getAllAsync(
          `${QUIZ_SELECT}
           WHERE  ${publishedConditions.join(' AND ')}
           GROUP  BY q.id
           ORDER  BY q.created_at DESC
           LIMIT  ? OFFSET ?`,
          [...baseParams, safeLimit, safeOffset]
        )
        .catch((err) => {
          console.warn('[getQuizzes] layer2 error:', err.message);
          return [];
        });

      console.log(`[getQuizzes] layer2 (no schoolId) → ${rows.length} quiz(zes)`);

      if (rows.length > 0) {
        const storedSchools = [
          ...new Set(rows.map((r) => r.schoolId).filter(Boolean)),
        ];
        console.warn(
          `[getQuizzes] ⚠️  schoolId mismatch detected!\n` +
          `  Provided : "${safeSchoolId}"\n` +
          `  Stored   : ${JSON.stringify(storedSchools)}`
        );
      }
    }

    // ── Layer 3: attempt history ────────────────────────────
    // ✅ NO is_published filter — student already attempted it
    // ✅ NO availability window filter
    // ✅ NO schoolId filter
    if (rows.length === 0) {
      console.warn(
        '[getQuizzes] layer2 returned 0 — checking attempt history' +
        ' (quiz may be outside availability window)'
      );

      const attemptParams = [safeStudentId];
      const classFilter   = resolvedClassId
        ? 'AND q.class_id = ?'
        : '';
      if (resolvedClassId) attemptParams.push(resolvedClassId);

      rows = await db
        .getAllAsync(
          `${QUIZ_SELECT}
           WHERE  q.deleted_at IS NULL
             AND  q.id IN (
               SELECT DISTINCT quiz_id
               FROM   quiz_attempts
               WHERE  user_id = ?
             )
             ${classFilter}
           GROUP  BY q.id
           ORDER  BY q.created_at DESC`,
          attemptParams
        )
        .catch((err) => {
          console.warn('[getQuizzes] layer3 error:', err.message);
          return [];
        });

      if (rows.length > 0) {
        console.log(
          `[getQuizzes] layer3 ✅ ${rows.length} quiz(zes) via attempt history` +
          ` (is_published=${rows.map((r) => r.is_published).join(',')})` +
          ` — showing for result viewing`
        );
      } else {
        console.log('[getQuizzes] layer3 → 0 — no quizzes found via any method');
      }
    }

    return normaliseQuizRows(rows);
  }

  // ── TEACHER / ADMIN VIEW ──────────────────────────────────
  const conditions = ['q.schoolId = ?', 'q.deleted_at IS NULL'];
  const params     = [safeSchoolId];

  if (safeCreatedBy) {
    conditions.push('q.created_by = ?');
    params.push(safeCreatedBy);
  }

  if (safeClassId) {
    conditions.push('q.class_id = ?');
    params.push(safeClassId);
  }

  if (safeSubjectId) {
    conditions.push('q.subject_id = ?');
    params.push(safeSubjectId);
  }

  if (is_published !== null) {
    conditions.push('q.is_published = ?');
    params.push(is_published ? 1 : 0);
  }

  params.push(safeLimit, safeOffset);

  const rows = await db.getAllAsync(
    `${QUIZ_SELECT}
     WHERE  ${conditions.join(' AND ')}
     GROUP  BY q.id
     ORDER  BY q.created_at DESC
     LIMIT  ? OFFSET ?`,
    params
  );

  return normaliseQuizRows(rows);
};

export const getQuizQuestions = async (quizId) => {
  const db = await getDatabase();

  const rows = await db.getAllAsync(
    `SELECT  q.id, q.schoolId, q.category_id, q.question_text, q.question_type,
             q.media_url, q.difficulty, q.points, q.explanation, q.is_active,
             q.created_by, q._synced, q.created_at, q.updated_at,
             qq.display_order, qq.points_override,
             qc.name AS category_name
     FROM      quiz_questions      qq
     JOIN      questions           q  ON q.id  = qq.question_id
     LEFT JOIN question_categories qc ON qc.id = q.category_id
     WHERE  qq.quiz_id    = ?
       AND  q.deleted_at IS NULL
     GROUP  BY q.id
     ORDER  BY qq.display_order ASC`,
    [quizId]
  );

  for (const row of rows) {
    row.options = await db.getAllAsync(
      `SELECT *
       FROM   question_options
       WHERE  question_id = ?
       ORDER  BY display_order ASC`,
      [row.id]
    );
  }

  return rows;
};

export const updateQuiz = async (id, updates) => {
  const ALLOWED = [
    'title', 'description', 'instructions', 'subject_id', 'class_id',
    'time_limit_minutes', 'time_per_question', 'shuffle_questions',
    'shuffle_options', 'questions_per_page', 'allow_backtrack',
    'max_attempts', 'passing_score', 'available_from', 'available_until',
    'password', 'show_answers_after', 'show_score', 'show_explanation',
    'is_published',
  ];

  const fields = Object.keys(updates).filter((k) => ALLOWED.includes(k));
  if (fields.length === 0) return getQuizById(id);

  const db         = await getDatabase();
  const setClauses = fields.map((f) => `${f} = ?`).join(', ');
  const values     = fields.map((f) => updates[f]);

  await db.runAsync(
    `UPDATE quizzes
     SET    ${setClauses}, updated_at = datetime('now'), _synced = 0
     WHERE  id = ?`,
    [...values, id]
  );

  return getQuizById(id);
};

export const publishQuiz   = (id) => updateQuiz(id, { is_published: 1 });
export const unpublishQuiz = (id) => updateQuiz(id, { is_published: 0 });

export const addQuestionToQuiz = async (
  quizId,
  questionId,
  order     = null,
  teacherId = null
) => {
  const db = await getDatabase();

  if (teacherId) {
    const question = await db
      .getFirstAsync(
        `SELECT created_by FROM questions
         WHERE  id = ? AND deleted_at IS NULL`,
        [String(questionId)]
      )
      .catch(() => null);

    if (!question) {
      throw appError("svcErr.questionNotFound", `Question ${questionId} not found.`);
    }

    if (!sameId(question.created_by, teacherId)) {
      throw appError("svcErr.onlyOwnQuestions", 'You can only add your own questions to a quiz.');
    }
  }

  if (order === null) {
    const result = await db.getFirstAsync(
      `SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order
       FROM   quiz_questions
       WHERE  quiz_id = ?`,
      [quizId]
    );
    order = result.next_order;
  }

  await db.runAsync(
    `INSERT OR IGNORE INTO quiz_questions (id, quiz_id, question_id, display_order)
     VALUES (?, ?, ?, ?)`,
    [generateId(), quizId, String(questionId), order]
  );

  await db.runAsync(
    `UPDATE quizzes
     SET _synced = 0, updated_at = datetime('now')
     WHERE id = ?`,
    [quizId]
  );
};

export const removeQuestionFromQuiz = async (quizId, questionId) => {
  const db = await getDatabase();

  await db.runAsync(
    `DELETE FROM quiz_questions WHERE quiz_id = ? AND question_id = ?`,
    [quizId, String(questionId)]
  );

  await db.runAsync(
    `UPDATE quizzes SET _synced = 0, updated_at = datetime('now') WHERE id = ?`,
    [quizId]
  );
};

export const reorderQuizQuestions = async (quizId, orderedQuestionIds = []) => {
  const db = await getDatabase();

  for (let i = 0; i < orderedQuestionIds.length; i++) {
    await db.runAsync(
      `UPDATE quiz_questions
       SET    display_order = ?
       WHERE  quiz_id = ? AND question_id = ?`,
      [i, quizId, String(orderedQuestionIds[i])]
    );
  }

  await db.runAsync(
    `UPDATE quizzes SET _synced = 0, updated_at = datetime('now') WHERE id = ?`,
    [quizId]
  );
};

export const deleteQuiz = async (id) => {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE quizzes SET deleted_at = datetime('now'), _synced = 0 WHERE id = ?`,
    [id]
  );
};

export const checkAttemptEligibility = async (quizId, userId) => {
  const db   = await getDatabase();
  const quiz = await getQuizById(quizId);

  if (!quiz)              return { canAttempt: false, reason: 'Quiz not found',        reasonKey: 'svcErr.quizNotFound' };
  if (!quiz.is_published) return { canAttempt: false, reason: 'Quiz is not published', reasonKey: 'svcErr.quizNotPublished' };

  const now = new Date().toISOString();

  if (quiz.available_from  && now < quiz.available_from)
    return { canAttempt: false, reason: 'Quiz has not started yet', reasonKey: 'svcErr.quizNotStarted' };
  if (quiz.available_until && now > quiz.available_until)
    return { canAttempt: false, reason: 'Quiz has ended', reasonKey: 'svcErr.quizEnded' };

  if (quiz.max_attempts !== null) {
    const row = await db.getFirstAsync(
      `SELECT COUNT(*) AS count
       FROM   quiz_attempts
       WHERE  quiz_id = ? AND user_id = ? AND status != 'abandoned'`,
      [quizId, userId]
    );
    if (row.count >= quiz.max_attempts) {
      return {
        canAttempt: false,
        reason:     `Maximum attempts (${quiz.max_attempts}) reached`,
        reasonKey:  'svcErr.quizMaxAttempts',
      };
    }
  }

  return { canAttempt: true, reason: null, reasonKey: null };
};

// ─────────────────────────────────────────────────────────────
// ATTEMPTS
// ─────────────────────────────────────────────────────────────

export const startAttempt = async (quizId, userId) => {
  const db = await getDatabase();

  const { canAttempt, reason, reasonKey } = await checkAttemptEligibility(quizId, userId);
  if (!canAttempt) throw appError(reasonKey, reason);

  const countRow = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM quiz_attempts WHERE quiz_id = ? AND user_id = ?`,
    [quizId, userId]
  );

  const attemptId      = generateId();
  const attempt_number = countRow.count + 1;

  await db.runAsync(
    `INSERT INTO quiz_attempts
       (id, quiz_id, user_id, attempt_number, status, _synced, started_at)
     VALUES (?, ?, ?, ?, 'in_progress', 0, datetime('now'))`,
    [attemptId, quizId, userId, attempt_number]
  );

  const quiz      = await getQuizById(quizId);
  let   questions = await getQuizQuestions(quizId);

  if (quiz.shuffle_questions) {
    questions = shuffleArray(questions);
  }

  if (quiz.shuffle_options) {
    questions = questions.map((q) => ({
      ...q,
      options: q.question_type !== 'matching'
        ? shuffleArray(q.options)
        : q.options,
    }));
  }

  // ✅ Strip is_correct — students cannot read answers
  questions = questions.map((q) => ({
    ...q,
    options: q.options.map(({ is_correct, ...opt }) => opt),
  }));

  const max_score = questions.reduce(
    (sum, q) => sum + (q.points_override ?? q.points ?? 1),
    0
  );

  await db.runAsync(
    `UPDATE quiz_attempts SET max_score = ? WHERE id = ?`,
    [max_score, attemptId]
  );

  return { attemptId, attempt_number, quiz, questions, max_score };
};

export const saveAnswer = async ({
  attemptId,
  questionId,
  selected_option_id  = null,
  selected_option_ids = [],
  text_answer         = null,
  time_spent_secs     = null,
  is_flagged          = false,
}) => {
  const db       = await getDatabase();
  const existing = await db.getFirstAsync(
    `SELECT id FROM attempt_answers WHERE attempt_id = ? AND question_id = ?`,
    [attemptId, questionId]
  );

  let answerId;

  if (existing) {
    answerId = existing.id;
    await db.runAsync(
      `UPDATE attempt_answers
       SET    selected_option_id = ?, text_answer = ?,
              time_spent_secs = ?, is_flagged = ?,
              answered_at = datetime('now')
       WHERE  id = ?`,
      [selected_option_id, text_answer, time_spent_secs, is_flagged ? 1 : 0, answerId]
    );
    await db.runAsync(
      `DELETE FROM attempt_answer_selections WHERE attempt_answer_id = ?`,
      [answerId]
    );
  } else {
    answerId = generateId();
    await db.runAsync(
      `INSERT INTO attempt_answers
         (id, attempt_id, question_id, selected_option_id, text_answer,
          time_spent_secs, is_flagged, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        answerId, attemptId, questionId, selected_option_id,
        text_answer, time_spent_secs, is_flagged ? 1 : 0,
      ]
    );
  }

  for (const optId of selected_option_ids) {
    await db.runAsync(
      `INSERT INTO attempt_answer_selections
         (id, attempt_answer_id, selected_option_id)
       VALUES (?, ?, ?)`,
      [generateId(), answerId, optId]
    );
  }

  return { answerId, saved: true };
};

export const toggleFlag = async (attemptId, questionId) => {
  const db       = await getDatabase();
  const existing = await db.getFirstAsync(
    `SELECT id, is_flagged
     FROM   attempt_answers
     WHERE  attempt_id = ? AND question_id = ?`,
    [attemptId, questionId]
  );

  if (!existing) return;

  await db.runAsync(
    `UPDATE attempt_answers SET is_flagged = ? WHERE id = ?`,
    [existing.is_flagged ? 0 : 1, existing.id]
  );
};

export const getAttemptProgress = async (attemptId) => {
  const db      = await getDatabase();
  const attempt = await db.getFirstAsync(
    `SELECT * FROM quiz_attempts WHERE id = ?`,
    [attemptId]
  );
  if (!attempt) return null;

  const answers = await db.getAllAsync(
    `SELECT question_id, is_flagged,
            CASE
              WHEN selected_option_id IS NOT NULL THEN 1
              WHEN text_answer        IS NOT NULL THEN 1
              ELSE 0
            END AS is_answered
     FROM   attempt_answers
     WHERE  attempt_id = ?`,
    [attemptId]
  );

  const totalRow = await db.getFirstAsync(
    `SELECT COUNT(*) AS count FROM quiz_questions WHERE quiz_id = ?`,
    [attempt.quiz_id]
  );

  return {
    attempt,
    total_questions: totalRow.count,
    answered_count:  answers.filter((a) => a.is_answered).length,
    flagged_count:   answers.filter((a) => a.is_flagged).length,
    answers,
  };
};

export const submitAttempt = async (attemptId) => {
  const db      = await getDatabase();
  const attempt = await db.getFirstAsync(
    `SELECT * FROM quiz_attempts WHERE id = ?`,
    [attemptId]
  );

  if (!attempt)                          throw appError("svcErr.attemptNotFound", 'Attempt not found');
  if (attempt.status !== 'in_progress') throw new Error(`Attempt already ${attempt.status}`);

  await db.runAsync(
    `UPDATE quiz_attempts
     SET    status          = 'submitted',
            submitted_at    = datetime('now'),
            time_taken_secs = CAST(
              (julianday('now') - julianday(started_at)) * 86400 AS INTEGER
            ),
            _synced = 0
     WHERE  id = ?`,
    [attemptId]
  );

  return gradeAttempt(attemptId);
};

export const timeoutAttempt = async (attemptId) => {
  const db = await getDatabase();

  await db.runAsync(
    `UPDATE quiz_attempts
     SET    status       = 'timed_out',
            submitted_at = datetime('now'),
            _synced      = 0
     WHERE  id = ? AND status = 'in_progress'`,
    [attemptId]
  );

  return gradeAttempt(attemptId);
};

export const getAttemptResult = async (attemptId) => {
  const db = await getDatabase();

  const attempt = await db.getFirstAsync(
    `SELECT qa.*,
            q.title, q.passing_score, q.show_answers_after,
            q.show_explanation, q.show_score
     FROM   quiz_attempts qa
     JOIN   quizzes        q ON q.id = qa.quiz_id
     WHERE  qa.id = ?`,
    [attemptId]
  );
  if (!attempt) return null;

  const answers = await db.getAllAsync(
    `SELECT aa.*, q.question_text, q.question_type, q.explanation, q.points
     FROM   attempt_answers aa
     JOIN   questions        q ON q.id = aa.question_id
     WHERE  aa.attempt_id = ?`,
    [attemptId]
  );

  for (const answer of answers) {
    answer.options = await db.getAllAsync(
      `SELECT *
       FROM   question_options
       WHERE  question_id = ?
       ORDER  BY display_order ASC`,
      [answer.question_id]
    );

    if (answer.question_type === 'multiple_select') {
      answer.selected_options = await db.getAllAsync(
        `SELECT qo.*
         FROM   attempt_answer_selections aas
         JOIN   question_options          qo ON qo.id = aas.selected_option_id
         WHERE  aas.attempt_answer_id = ?`,
        [answer.id]
      );
    }
  }

  return { attempt, answers };
};

export const getUserAttempts = async (userId, quizId = null) => {
  if (!userId) return [];

  const db         = await getDatabase();
  const conditions = ['qa.user_id = ?'];
  const params     = [String(userId)];

  if (quizId) {
    conditions.push('qa.quiz_id = ?');
    params.push(String(quizId));
  }

  const rows = await db
    .getAllAsync(
      `SELECT qa.*,
              q.title, q.passing_score, q.class_id, q.subject_id,
              c.name AS class_name,
              s.name AS subject_name
       FROM   quiz_attempts qa
       JOIN   quizzes        q ON q.id = qa.quiz_id
       LEFT JOIN classes     c ON c.id = q.class_id
       LEFT JOIN subjects    s ON s.id = q.subject_id
       WHERE  ${conditions.join(' AND ')}
       ORDER  BY qa.started_at DESC`,
      params
    )
    .catch((err) => {
      console.warn('[getUserAttempts] query error:', err.message);
      return [];
    });

  console.log(
    `[getUserAttempts] userId="${userId}"` +
    (quizId ? ` quizId="${quizId}"` : '') +
    ` → ${rows.length} attempt(s)`
  );

  return rows;
};

// ─────────────────────────────────────────────────────────────
// GET QUIZ ATTEMPTS WITH STUDENT INFO  (teacher view)
// ─────────────────────────────────────────────────────────────

export const getQuizAttemptsByQuizId = async (quizId) => {
  if (!quizId) return [];

  const db = await getDatabase();

  try {
    const rawAttempts = await db.getAllAsync(
      `SELECT id, quiz_id, user_id, attempt_number, status,
              raw_score, max_score, percentage, is_passed,
              started_at, submitted_at, time_taken_secs
       FROM   quiz_attempts
       WHERE  quiz_id = ?
         AND  status IN ('submitted', 'timed_out')
       ORDER  BY submitted_at DESC`,
      [quizId]
    );

    if (!rawAttempts.length) return [];

    const nameCache = new Map();

    const enriched = await Promise.all(
      rawAttempts.map(async (attempt) => {
        const uid = attempt.user_id;
        if (!nameCache.has(uid)) {
          nameCache.set(uid, await resolveStudentName(db, uid));
        }
        return { ...attempt, ...nameCache.get(uid) };
      })
    );

    return enriched;
  } catch (err) {
    console.warn('[getQuizAttemptsByQuizId] failed:', err?.message);
    return [];
  }
};

// ─────────────────────────────────────────────────────────────
// GRADING  (private)
// ─────────────────────────────────────────────────────────────

const gradeAttempt = async (attemptId) => {
  const db = await getDatabase();

  const attempt = await db.getFirstAsync(
    `SELECT qa.*, q.passing_score
     FROM   quiz_attempts qa
     JOIN   quizzes        q ON q.id = qa.quiz_id
     WHERE  qa.id = ?`,
    [attemptId]
  );

  const answers = await db.getAllAsync(
    `SELECT aa.*, q.question_type, q.points, qq.points_override
     FROM   attempt_answers aa
     JOIN   questions        q  ON q.id  = aa.question_id
     JOIN   quiz_questions   qq ON qq.question_id = aa.question_id
                                AND qq.quiz_id     = ?
     WHERE  aa.attempt_id = ?`,
    [attempt.quiz_id, attemptId]
  );

  let raw_score = 0;
  let max_score = 0;

  for (const answer of answers) {
    const pointsPossible = answer.points_override ?? answer.points ?? 1;
    max_score += pointsPossible;

    let pointsEarned = 0;
    let isCorrect    = false;

    switch (answer.question_type) {
      case 'multiple_choice':
      case 'true_false': {
        if (!answer.selected_option_id) break;
        const opt = await db.getFirstAsync(
          `SELECT is_correct FROM question_options WHERE id = ?`,
          [answer.selected_option_id]
        );
        isCorrect    = opt?.is_correct === 1;
        pointsEarned = isCorrect ? pointsPossible : 0;
        break;
      }

      case 'multiple_select': {
        const allOpts = await db.getAllAsync(
          `SELECT id, is_correct FROM question_options WHERE question_id = ?`,
          [answer.question_id]
        );
        const correctIds = new Set(
          allOpts.filter((o) => o.is_correct).map((o) => o.id)
        );
        const selections = await db.getAllAsync(
          `SELECT selected_option_id
           FROM   attempt_answer_selections
           WHERE  attempt_answer_id = ?`,
          [answer.id]
        );
        const selectedIds = new Set(selections.map((s) => s.selected_option_id));

        let correct = 0;
        let wrong   = 0;
        for (const sid of selectedIds) {
          correctIds.has(sid) ? correct++ : wrong++;
        }
        const missed = correctIds.size - correct;
        const net    = Math.max(0, correct - wrong - missed);
        pointsEarned = correctIds.size > 0
          ? (net / correctIds.size) * pointsPossible
          : 0;
        isCorrect = correct === correctIds.size && wrong === 0;
        break;
      }

      case 'fill_in_the_blank': {
        if (!answer.text_answer) break;
        const correctOpt = await db.getFirstAsync(
          `SELECT option_text
           FROM   question_options
           WHERE  question_id = ? AND is_correct = 1
           LIMIT  1`,
          [answer.question_id]
        );
        if (correctOpt) {
          isCorrect =
            answer.text_answer.trim().toLowerCase() ===
            correctOpt.option_text.trim().toLowerCase();
          pointsEarned = isCorrect ? pointsPossible : 0;
        }
        break;
      }

      case 'matching': {
        if (!answer.selected_option_id) break;
        const opt = await db.getFirstAsync(
          `SELECT is_correct FROM question_options WHERE id = ?`,
          [answer.selected_option_id]
        );
        isCorrect    = opt?.is_correct === 1;
        pointsEarned = isCorrect ? pointsPossible : 0;
        break;
      }

      default:
        break;
    }

    raw_score += pointsEarned;

    await db.runAsync(
      `UPDATE attempt_answers
       SET    is_correct      = ?,
              points_earned   = ?,
              points_possible = ?
       WHERE  id = ?`,
      [isCorrect ? 1 : 0, pointsEarned, pointsPossible, answer.id]
    );

    await _updateQuestionAnalytics(answer.question_id, {
      wasAnswered: true,
      wasCorrect:  isCorrect,
      timeSpent:   answer.time_spent_secs,
    });
  }

  const percentage = max_score > 0
    ? Math.round((raw_score / max_score) * 100 * 100) / 100
    : 0;

  const is_passed = percentage >= attempt.passing_score;

  await db.runAsync(
    `UPDATE quiz_attempts
     SET    raw_score   = ?,
            max_score   = ?,
            percentage  = ?,
            is_passed   = ?,
            _synced     = 0
     WHERE  id = ?`,
    [raw_score, max_score, percentage, is_passed ? 1 : 0, attemptId]
  );

  await _updateQuizAnalytics(attempt.quiz_id, {
    percentage,
    is_passed,
    time_taken_secs: attempt.time_taken_secs,
  });

  return { attemptId, raw_score, max_score, percentage, is_passed };
};

// ─────────────────────────────────────────────────────────────
// ANALYTICS  (private)
// ─────────────────────────────────────────────────────────────

const _updateQuestionAnalytics = async (
  questionId,
  { wasAnswered = false, wasCorrect = false, timeSpent = null }
) => {
  const db = await getDatabase();
  try {
    await db.runAsync(
      `UPDATE question_analytics
       SET
         times_shown      = times_shown + 1,
         times_answered   = times_answered  + ?,
         times_correct    = times_correct   + ?,
         avg_time_secs    = CASE
                              WHEN ? IS NOT NULL
                              THEN ROUND(
                                (avg_time_secs * times_answered + ?) /
                                (times_answered + 1),
                                2
                              )
                              ELSE avg_time_secs
                            END,
         difficulty_score = CAST(times_correct AS REAL) /
                            NULLIF(times_shown + 1, 0),
         last_updated     = datetime('now')
       WHERE question_id = ?`,
      [
        wasAnswered ? 1 : 0,
        wasCorrect  ? 1 : 0,
        timeSpent,
        timeSpent,
        questionId,
      ]
    );
  } catch {
    // Non-fatal
  }
};

const _updateQuizAnalytics = async (
  quizId,
  { percentage, is_passed, time_taken_secs = null }
) => {
  const db = await getDatabase();
  try {
    await db.runAsync(
      `UPDATE quiz_analytics
       SET
         total_attempts    = total_attempts    + 1,
         total_completions = total_completions + 1,
         total_passes      = total_passes      + ?,
         avg_score         = ROUND(
           (avg_score * total_completions + ?) /
           (total_completions + 1),
           2
         ),
         avg_time_secs     = CASE
                               WHEN ? IS NOT NULL
                               THEN ROUND(
                                 (avg_time_secs * total_completions + ?) /
                                 (total_completions + 1),
                                 2
                               )
                               ELSE avg_time_secs
                             END,
         highest_score     = MAX(highest_score, ?),
         lowest_score      = CASE
                               WHEN total_completions = 0 THEN ?
                               ELSE MIN(lowest_score, ?)
                             END,
         last_updated      = datetime('now')
       WHERE quiz_id = ?`,
      [
        is_passed ? 1 : 0,
        percentage,
        time_taken_secs,
        time_taken_secs,
        percentage,
        percentage,
        percentage,
        quizId,
      ]
    );
  } catch {
    // Non-fatal
  }
};

// ─────────────────────────────────────────────────────────────
// ANALYTICS  (public)
// ─────────────────────────────────────────────────────────────

export const getQuizAnalytics = async (quizId) => {
  if (!quizId) return null;

  const db = await getDatabase();

  const summary = await db.getFirstAsync(
    `SELECT  qa.*,
             q.title, q.passing_score, q.class_id, q.subject_id,
             c.name AS class_name,
             s.name AS subject_name,
             u.name AS teacher_name
     FROM    quiz_analytics  qa
     JOIN    quizzes          q ON q.id = qa.quiz_id
     LEFT JOIN classes        c ON c.id = q.class_id
     LEFT JOIN subjects       s ON s.id = q.subject_id
     LEFT JOIN users          u ON u.id = q.created_by
     WHERE   qa.quiz_id = ?`,
    [quizId]
  );

  const hardestQuestions = await db.getAllAsync(
    `SELECT  q.question_text, q.difficulty,
             qa.times_shown, qa.times_correct,
             qa.difficulty_score, qa.avg_time_secs
     FROM    question_analytics qa
     JOIN    questions          q  ON q.id  = qa.question_id
     JOIN    quiz_questions     qq ON qq.question_id = q.id
     WHERE   qq.quiz_id     = ?
       AND   qa.times_shown > 0
     ORDER   BY qa.difficulty_score ASC
     LIMIT   5`,
    [quizId]
  );

  return { summary, hardestQuestions };
};

// ─────────────────────────────────────────────────────────────
// ONE-TIME REPAIR
// ─────────────────────────────────────────────────────────────

export const repairStudentNamesFromUsers = async () => {
  const db = await getDatabase();

  console.log('[repairStudentNamesFromUsers] starting…');

  const broken = await db
    .getAllAsync(
      `SELECT s.id, s.user_id, s.name
       FROM   students s
       WHERE  s.user_id IS NOT NULL
         AND  (
           s.name IS NULL
           OR s.name = ''
           OR LOWER(TRIM(s.name)) = 'student'
           OR LOWER(TRIM(s.name)) = 'unknown'
           OR LOWER(TRIM(s.name)) = 'unknown student'
         )`,
      []
    )
    .catch(() => []);

  console.log(`[repairStudentNamesFromUsers] ${broken.length} rows need repair`);

  let fixed = 0;

  for (const row of broken) {
    const userRow = await db
      .getFirstAsync(
        `SELECT name, email FROM users WHERE id = ? LIMIT 1`,
        [row.user_id]
      )
      .catch(() => null);

    const realName = userRow?.name?.trim();

    if (realName && !isPlaceholder(realName)) {
      await db.runAsync(
        `UPDATE students SET name = ? WHERE id = ?`,
        [realName, row.id]
      );
      fixed++;
    }
  }

  console.log(
    `[repairStudentNamesFromUsers] ✅ repaired ${fixed} / ${broken.length} rows`
  );
  return fixed;
};