// mobile/src/db/quizSchema.js

import { safeAddColumn } from "./dbHelpers";

/**
 * The quiz module's local tables — one definition, for the fresh install and
 * for the phone that already has them.
 *
 * ── "no such column: qa.difficulty_score" ──────────────────────────────────
 *
 * The CREATE for question_analytics said `times_seen, times_correct,
 * avg_time_secs`. The service that reads and writes the table says
 * `times_shown, times_answered, difficulty_score, last_updated`
 * (quiz.service: getQuestions, getQuizAnalytics, _updateQuestionAnalytics).
 * Two shapes for one table: every fresh phone got the first and the code asked
 * for the second, so the question bank threw on its LEFT JOIN, and the
 * analytics UPDATE failed silently behind a catch. CREATE TABLE IF NOT EXISTS
 * then preserved the wrong shape for ever, because the table did exist.
 *
 * The fix is one place that knows the whole shape, applied twice: the CREATE
 * below carries every column a fresh database needs, and PATCHES brings a
 * table that predates a column up to the same shape with ADD COLUMN — no row
 * touched, no table dropped. `times_seen` stays: a column nobody reads is
 * harmless, a dropped one is a rebuild.
 *
 * ── subject_id on questions ─────────────────────────────────────────────────
 *
 * A question bank is asked for by subject, and a question had no subject.
 * `subject_id` is Subject._id, exactly as quizzes.subject_id already carries it
 * — not a subject name. Existing questions are given the subject of the quizzes
 * they sit in, but only when that is unambiguous: a question used in a
 * Mathematics quiz is a Mathematics question; one used in quizzes of two
 * subjects is left for its teacher to place.
 */

// The same harness (scripts/check-quiz-bank.js) found the CREATEs for quizzes,
// quiz_attempts, attempt_answers, attempt_answer_selections and quiz_analytics
// short of columns their writers name — each failure swallowed by a catch — so
// those are completed here the same way: in the CREATE, and in PATCHES.
const CREATES = [
  `CREATE TABLE IF NOT EXISTS question_categories (
    id TEXT PRIMARY KEY, schoolId TEXT, name TEXT NOT NULL,
    description TEXT, parent_id TEXT, is_active INTEGER DEFAULT 1,
    deleted_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, schoolId TEXT, category_id TEXT, subject_id TEXT,
    question_text TEXT NOT NULL, question_type TEXT NOT NULL,
    media_url TEXT, difficulty TEXT DEFAULT 'medium', points REAL DEFAULT 1.0,
    explanation TEXT, is_active INTEGER DEFAULT 1, created_by TEXT,
    deleted_at TEXT, _synced INTEGER DEFAULT 0, _synced_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS question_options (
    id TEXT PRIMARY KEY, question_id TEXT NOT NULL,
    option_text TEXT NOT NULL, is_correct INTEGER DEFAULT 0,
    match_pair TEXT, display_order INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS question_analytics (
    id TEXT PRIMARY KEY, question_id TEXT NOT NULL,
    times_seen INTEGER DEFAULT 0, times_shown INTEGER DEFAULT 0,
    times_answered INTEGER DEFAULT 0, times_correct INTEGER DEFAULT 0,
    avg_time_secs REAL DEFAULT 0, difficulty_score REAL, last_updated TEXT)`,
  `CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY, schoolId TEXT, title TEXT NOT NULL,
    description TEXT, instructions TEXT, subject_id TEXT, class_id TEXT,
    created_by TEXT, time_limit_minutes INTEGER, time_per_question INTEGER,
    shuffle_questions INTEGER DEFAULT 0, shuffle_options INTEGER DEFAULT 0,
    questions_per_page INTEGER DEFAULT 1, allow_backtrack INTEGER DEFAULT 1,
    max_attempts INTEGER DEFAULT 1, passing_score REAL DEFAULT 70,
    available_from TEXT, available_until TEXT, password TEXT,
    show_answers_after TEXT DEFAULT 'on_completion',
    show_score INTEGER DEFAULT 1, show_explanation INTEGER DEFAULT 1,
    is_published INTEGER DEFAULT 0, deleted_at TEXT,
    _synced INTEGER DEFAULT 0, _synced_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS quiz_questions (
    id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, question_id TEXT NOT NULL,
    display_order INTEGER DEFAULT 0, points_override REAL)`,
  `CREATE TABLE IF NOT EXISTS quiz_attempts (
    id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, user_id TEXT NOT NULL,
    attempt_number INTEGER DEFAULT 1, status TEXT DEFAULT 'in_progress',
    raw_score REAL DEFAULT 0, max_score REAL DEFAULT 0,
    percentage REAL DEFAULT 0, is_passed INTEGER DEFAULT 0,
    started_at TEXT, submitted_at TEXT, time_taken_secs INTEGER, schoolId TEXT,
    deleted_at TEXT, _synced INTEGER DEFAULT 0, _synced_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS quiz_analytics (
    id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL,
    total_attempts INTEGER DEFAULT 0, total_completions INTEGER DEFAULT 0,
    total_passes INTEGER DEFAULT 0, avg_score REAL DEFAULT 0, pass_rate REAL DEFAULT 0,
    avg_time_secs REAL DEFAULT 0, highest_score REAL DEFAULT 0, lowest_score REAL DEFAULT 0,
    last_updated TEXT)`,
  `CREATE TABLE IF NOT EXISTS attempt_answers (
    id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, question_id TEXT NOT NULL,
    selected_option_id TEXT, text_answer TEXT, time_spent_secs INTEGER,
    is_flagged INTEGER DEFAULT 0, answered_at TEXT,
    time_taken INTEGER, is_correct INTEGER DEFAULT 0, points REAL DEFAULT 0,
    points_earned REAL DEFAULT 0, points_possible REAL DEFAULT 0,
    _synced INTEGER DEFAULT 0, _synced_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS attempt_answer_selections (
    id TEXT PRIMARY KEY, attempt_answer_id TEXT NOT NULL,
    option_id TEXT, selected_option_id TEXT, text_response TEXT, match_response TEXT)`,
];

/** Columns added after devices already had the table. Applied before indexes. */
const PATCHES = {
  questions: [
    ["_synced",    "INTEGER DEFAULT 0"],
    ["_synced_at", "TEXT"],
    ["deleted_at", "TEXT"],
    ["subject_id", "TEXT"],
  ],
  question_analytics: [
    ["times_shown",      "INTEGER DEFAULT 0"],
    ["times_answered",   "INTEGER DEFAULT 0"],
    ["difficulty_score", "REAL"],
    ["last_updated",     "TEXT"],
  ],
  quizzes:         [["_synced", "INTEGER DEFAULT 0"], ["_synced_at", "TEXT"], ["deleted_at", "TEXT"], ["password", "TEXT"]],
  quiz_attempts:   [["_synced", "INTEGER DEFAULT 0"], ["_synced_at", "TEXT"], ["deleted_at", "TEXT"], ["schoolId", "TEXT"]],
  // The writers in quiz.service name these; the first CREATE named others. Same
  // story as question_analytics, caught by the same harness.
  quiz_analytics: [
    ["total_completions", "INTEGER DEFAULT 0"], ["total_passes", "INTEGER DEFAULT 0"],
    ["avg_time_secs", "REAL DEFAULT 0"], ["highest_score", "REAL DEFAULT 0"],
    ["lowest_score", "REAL DEFAULT 0"], ["last_updated", "TEXT"],
  ],
  attempt_answers: [
    ["_synced", "INTEGER DEFAULT 0"], ["_synced_at", "TEXT"],
    ["selected_option_id", "TEXT"], ["text_answer", "TEXT"], ["time_spent_secs", "INTEGER"],
    ["is_flagged", "INTEGER DEFAULT 0"], ["answered_at", "TEXT"],
    ["points_earned", "REAL DEFAULT 0"], ["points_possible", "REAL DEFAULT 0"],
  ],
  attempt_answer_selections: [["selected_option_id", "TEXT"]],
};

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_questions_school    ON questions(schoolId)",
  "CREATE INDEX IF NOT EXISTS idx_questions_category  ON questions(category_id)",
  "CREATE INDEX IF NOT EXISTS idx_questions_synced    ON questions(_synced)",
  // The question bank's own query: this teacher's questions in this subject.
  "CREATE INDEX IF NOT EXISTS idx_questions_owner_subject ON questions(created_by, subject_id)",
  "CREATE INDEX IF NOT EXISTS idx_q_options_question  ON question_options(question_id)",
  "CREATE INDEX IF NOT EXISTS idx_q_analytics_question ON question_analytics(question_id)",
  "CREATE INDEX IF NOT EXISTS idx_quizzes_school      ON quizzes(schoolId)",
  "CREATE INDEX IF NOT EXISTS idx_quizzes_class       ON quizzes(class_id)",
  "CREATE INDEX IF NOT EXISTS idx_quizzes_subject     ON quizzes(subject_id)",
  "CREATE INDEX IF NOT EXISTS idx_quizzes_synced      ON quizzes(_synced)",
  "CREATE INDEX IF NOT EXISTS idx_quiz_q_quiz         ON quiz_questions(quiz_id)",
  "CREATE INDEX IF NOT EXISTS idx_quiz_q_question     ON quiz_questions(question_id)",
  "CREATE INDEX IF NOT EXISTS idx_attempts_quiz       ON quiz_attempts(quiz_id)",
  "CREATE INDEX IF NOT EXISTS idx_attempts_user       ON quiz_attempts(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_attempts_synced     ON quiz_attempts(_synced)",
  "CREATE INDEX IF NOT EXISTS idx_answers_attempt     ON attempt_answers(attempt_id)",
  "CREATE INDEX IF NOT EXISTS idx_answer_sel_answer   ON attempt_answer_selections(attempt_answer_id)",
];

/**
 * Give a question without a subject the subject of the quizzes it sits in —
 * when they all agree. Returns how many were filled in.
 */
export const backfillQuestionSubjects = async (db) => {
  const subjectsOf = `
    SELECT qz.subject_id
    FROM   quiz_questions qq
    JOIN   quizzes qz ON qz.id = qq.quiz_id
    WHERE  qq.question_id = questions.id
      AND  qz.subject_id IS NOT NULL AND qz.subject_id != ''`;
  try {
    const result = await db.runAsync(
      `UPDATE questions
       SET    subject_id = (SELECT MIN(subject_id) FROM (${subjectsOf}))
       WHERE  (subject_id IS NULL OR subject_id = '')
         AND  (SELECT COUNT(DISTINCT subject_id) FROM (${subjectsOf})) = 1`
    );
    return result?.changes ?? 0;
  } catch {
    return 0;
  }
};

/**
 * Bring the quiz tables to the current shape, whatever shape they are in now.
 * Safe to run on every start: every statement is IF NOT EXISTS or ADD COLUMN.
 */
export const ensureQuizTables = async (db, { log = console } = {}) => {
  for (const sql of CREATES) {
    await db.execAsync(sql).catch((err) =>
      log.warn?.("[quizSchema] CREATE failed:", err.message)
    );
  }
  // Columns before indexes: an index over a column the old table lacks fails.
  for (const [table, cols] of Object.entries(PATCHES)) {
    for (const [col, def] of cols) await safeAddColumn(db, table, col, def);
  }
  for (const idx of INDEXES) {
    await db.execAsync(idx).catch(() => {});
  }
  const filled = await backfillQuestionSubjects(db);
  if (filled > 0) {
    log.log?.(`[quizSchema] ${filled} question(s) given the subject of the quiz they sit in`);
  }
};

export default ensureQuizTables;
