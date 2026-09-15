// mobile/scripts/check-quiz-bank.js
"use strict";

/**
 * The teacher's quiz workflow: the classes and subjects offered, the question
 * bank behind a quiz, and the SQLite table that used to throw.
 *
 * ── Three faults, one root ────────────────────────────────────────────────
 *
 *   "no classes / no subjects on the quiz screen"   The screen joined
 *   teacher_assignments ⋈ classes ⋈ subjects in the phone's SQLite. A teacher's
 *   mirror holds none of those tables' rows: the sync feed excludes them for
 *   the role and the full assignment pull runs for admins only. The dashboard,
 *   which asks the server, said 7 and 19. The pickers now ask the same server
 *   route every other teacher screen uses (/teacher/my-subjects?grouped=true),
 *   cache the answer, and fall back to the old join last.
 *
 *   "no such column: qa.difficulty_score"           question_analytics was
 *   CREATEd with one shape and read with another. One definition now
 *   (db/quizSchema.js), applied to fresh and existing databases alike.
 *
 *   "called without created_by — all teachers' questions"   The bank was
 *   every question in the school, with the client filtering nothing. It is
 *   now one teacher's questions in one subject, in the WHERE clause.
 *
 * ── Why real SQLite ───────────────────────────────────────────────────────
 *
 * A fake that implements PRAGMA table_info and ALTER TABLE proves nothing
 * about a migration. Node ships node:sqlite; the tables are created, migrated
 * and queried by the real quiz.service code, transformed by the same babel
 * preset the bundler uses.
 *
 *   node scripts/check-quiz-bank.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

const MOBILE = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else bad(label, `expected ${e}\n     got ${a}`);
};
const note = (label) => console.log(`       ${label}`);

/** expo-sqlite's async surface, over a real synchronous SQLite. */
const adapt = (db) => ({
  execAsync:     async (sql) => { db.exec(sql); },
  runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
  getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
});

// ── A module loader that follows relative imports through babel ───────────
//
// quiz.service imports teacherScope.service, which imports ./api — the real
// one wants axios and NetInfo. So relative imports are resolved to absolute
// paths and either answered from `stubs` (keyed by absolute path) or loaded
// the same way, recursively. Packages fall through to Node.
const makeLoader = (stubs) => {
  const cache = new Map();
  const load = (abs) => {
    if (stubs.has(abs)) return stubs.get(abs);
    if (cache.has(abs)) return cache.get(abs).exports;
    const file = fs.existsSync(abs) ? abs : `${abs}.js`;
    const { code } = babel.transformFileSync(file, {
      presets: [require.resolve("babel-preset-expo")],
      caller:  { name: "check", supportsStaticESM: false },
      babelrc: false, configFile: false,
    });
    const mod = { exports: {} };
    cache.set(abs, mod);
    const dir = path.dirname(file);
    const req = (id) => (id.startsWith(".") ? load(path.resolve(dir, id).replace(/\.js$/, "")) : require(id));
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (rel) => load(path.join(MOBILE, rel).replace(/\.js$/, ""));
};

(async () => {
  // ── The fixture: one school, two teachers, three subjects, two classes ──
  const SCHOOL = "sch-1";
  const A = "teacher-a", B = "teacher-b";
  const MATH = "sub-math", PHYS = "sub-phys", BIO = "sub-bio";
  const C1 = "cls-1", C2 = "cls-2";

  // What the server answers to /teacher/my-subjects?grouped=true, per teacher.
  const grouped = {
    [A]: [
      { classId: C1, className: "Form 5A", level: "5", section: "A", isActive: true,
        subjects: [{ _id: MATH, name: "Mathematics", code: "MAT" }, { _id: PHYS, name: "Physics", code: "PHY" }] },
      { classId: C2, className: "Form 4B", level: "4", section: "B", isActive: true,
        subjects: [{ _id: BIO, name: "Biology", code: "BIO" }] },
    ],
    [B]: [
      { classId: C1, className: "Form 5A", subjects: [{ _id: MATH, name: "Mathematics", code: "MAT" }] },
    ],
  };
  const apiState = { online: true, calls: 0, asTeacher: A };
  const fakeApi = {
    get: async (url) => {
      apiState.calls++;
      if (!apiState.online) { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; throw e; }
      if (!url.startsWith("/teacher/my-subjects")) throw new Error(`unexpected ${url}`);
      return { data: { success: true, subjectsByClass: grouped[apiState.asTeacher] ?? [] } };
    },
  };

  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);
  // The mirror tables the pickers join and the scope seeds — as schema.js
  // defines them, minus nothing the code touches.
  raw.exec(`CREATE TABLE classes (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, level TEXT, section TEXT,
    schoolId TEXT, school_id TEXT, classTeacherId TEXT, classTeacherName TEXT, studentCount INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1, _synced INTEGER DEFAULT 0, _synced_at TEXT, deleted_at TEXT, created_at TEXT, updated_at TEXT)`);
  raw.exec(`CREATE TABLE subjects (id TEXT PRIMARY KEY NOT NULL, school_id TEXT, class_id TEXT, teacher_id TEXT,
    name TEXT NOT NULL, code TEXT, _synced INTEGER DEFAULT 0, _synced_at TEXT, deleted_at TEXT, created_at TEXT, updated_at TEXT)`);
  raw.exec(`CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, school_id TEXT, name TEXT, email TEXT, role TEXT)`);
  raw.exec(`INSERT INTO users (id, school_id, name, role) VALUES ('${A}', '${SCHOOL}', 'Teacher A', 'teacher'), ('${B}', '${SCHOOL}', 'Teacher B', 'teacher')`);
  raw.exec(`CREATE TABLE teacher_assignments (id TEXT PRIMARY KEY NOT NULL, school_id TEXT, teacher_id TEXT NOT NULL,
    class_id TEXT NOT NULL, subject_id TEXT NOT NULL, _synced INTEGER DEFAULT 0, _synced_at TEXT, deleted_at TEXT, created_at TEXT, updated_at TEXT)`);

  const stubs = new Map([
    [path.join(MOBILE, "src/db/database"),  { getDatabase: async () => db }],
    [path.join(MOBILE, "src/services/api"), { default: fakeApi, __esModule: true, API_URL: "http://stub" }],
  ]);
  const load  = makeLoader(stubs);
  const Quiz  = load("src/services/quiz.service.js");
  const Scope = load("src/services/teacherScope.service.js");
  const { ensureQuizTables, backfillQuestionSubjects } = load("src/db/quizSchema.js");

  const columnsOf = (table) => raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const indexesOf = (table) => raw.prepare(`PRAGMA index_list(${table})`).all().map((i) => i.name);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 12. a fresh database has every column the code reads ---");
  await ensureQuizTables(db, { log: { warn: () => {}, log: () => {} } });
  const qaCols = columnsOf("question_analytics");
  for (const c of ["difficulty_score", "times_shown", "times_answered", "times_correct", "avg_time_secs", "last_updated"]) {
    check(`question_analytics.${c} exists`, qaCols.includes(c), true);
  }
  check("questions.subject_id exists", columnsOf("questions").includes("subject_id"), true);
  check("the (created_by, subject_id) index exists", indexesOf("questions").includes("idx_questions_owner_subject"), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 13. a phone whose tables predate the columns migrates in place ---");
  const old  = new DatabaseSync(":memory:");
  const odb  = adapt(old);
  // The shapes as syncManager.migrateQuizTables used to CREATE them.
  old.exec(`CREATE TABLE questions (id TEXT PRIMARY KEY, schoolId TEXT, category_id TEXT,
    question_text TEXT NOT NULL, question_type TEXT NOT NULL, media_url TEXT, difficulty TEXT DEFAULT 'medium',
    points REAL DEFAULT 1.0, explanation TEXT, is_active INTEGER DEFAULT 1, created_by TEXT, deleted_at TEXT,
    _synced INTEGER DEFAULT 0, _synced_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  old.exec(`CREATE TABLE question_analytics (id TEXT PRIMARY KEY, question_id TEXT NOT NULL,
    times_seen INTEGER DEFAULT 0, times_correct INTEGER DEFAULT 0, avg_time_secs REAL DEFAULT 0)`);
  old.exec(`CREATE TABLE question_options (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, option_text TEXT NOT NULL,
    is_correct INTEGER DEFAULT 0, match_pair TEXT, display_order INTEGER DEFAULT 0)`);
  old.exec(`CREATE TABLE quizzes (id TEXT PRIMARY KEY, schoolId TEXT, title TEXT NOT NULL, subject_id TEXT, class_id TEXT, created_by TEXT,
    is_published INTEGER DEFAULT 0, deleted_at TEXT, _synced INTEGER DEFAULT 0, _synced_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT)`);
  old.exec(`CREATE TABLE quiz_questions (id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, question_id TEXT NOT NULL, display_order INTEGER DEFAULT 0, points_override REAL)`);
  old.exec(`CREATE TABLE subjects (id TEXT PRIMARY KEY NOT NULL, school_id TEXT, class_id TEXT, teacher_id TEXT, name TEXT NOT NULL, code TEXT, deleted_at TEXT)`);
  // Three legacy questions: one used only in a Mathematics quiz, one in both a
  // Mathematics and a Physics quiz, one in no quiz at all.
  old.exec(`INSERT INTO questions (id, schoolId, question_text, question_type, created_by) VALUES
    ('old-1','${SCHOOL}','What is 2+2?','multiple_choice','${A}'),
    ('old-2','${SCHOOL}','Define force','multiple_choice','${A}'),
    ('old-3','${SCHOOL}','Orphan','true_false','${A}')`);
  old.exec(`INSERT INTO question_analytics (id, question_id, times_seen, times_correct) VALUES ('qa-1','old-1',5,3)`);
  old.exec(`INSERT INTO quizzes (id, schoolId, title, subject_id, class_id, created_by) VALUES
    ('qz-m','${SCHOOL}','Maths quiz','${MATH}','${C1}','${A}'), ('qz-p','${SCHOOL}','Physics quiz','${PHYS}','${C1}','${A}')`);
  old.exec(`INSERT INTO quiz_questions (id, quiz_id, question_id) VALUES ('qq1','qz-m','old-1'), ('qq2','qz-m','old-2'), ('qq3','qz-p','old-2')`);

  let threw = null;
  try { old.prepare("SELECT MAX(qa.difficulty_score) FROM question_analytics qa").get(); } catch (e) { threw = e.message; }
  check("before: the old table really lacks the column", /no such column/.test(threw ?? ""), true);

  await ensureQuizTables(odb, { log: { warn: () => {}, log: () => {} } });
  check("after: difficulty_score exists", columnsOf.call(null, "question_analytics") && old.prepare("PRAGMA table_info(question_analytics)").all().some((c) => c.name === "difficulty_score"), true);
  check("  times_shown and times_answered too", old.prepare("PRAGMA table_info(question_analytics)").all().filter((c) => ["times_shown", "times_answered"].includes(c.name)).length, 2);
  check("  the legacy analytics row survives with its counts", old.prepare("SELECT times_seen, times_correct FROM question_analytics WHERE id = 'qa-1'").get(), { times_seen: 5, times_correct: 3 });
  check("  questions.subject_id exists", old.prepare("PRAGMA table_info(questions)").all().some((c) => c.name === "subject_id"), true);
  check("  the question used only in the Mathematics quiz is now a Mathematics question",
    old.prepare("SELECT subject_id FROM questions WHERE id = 'old-1'").get().subject_id, MATH);
  check("  the one used in two subjects' quizzes is left for the teacher to place",
    old.prepare("SELECT subject_id FROM questions WHERE id = 'old-2'").get().subject_id, null);
  check("  the orphan stays without a subject", old.prepare("SELECT subject_id FROM questions WHERE id = 'old-3'").get().subject_id, null);
  check("  running the migration again changes nothing", await backfillQuestionSubjects(odb), 0);
  check("  every legacy question is still readable", old.prepare("SELECT COUNT(*) AS n FROM questions").get().n, 3);

  // 14. The very query that threw on the phone, against the migrated table.
  stubs.set(path.join(MOBILE, "src/db/database"), { getDatabase: async () => odb });
  const QuizOld = makeLoader(stubs)("src/services/quiz.service.js");
  let rows = null, err = null;
  try { rows = await QuizOld.getQuestions({ schoolId: SCHOOL, created_by: A }); } catch (e) { err = e.message; }
  check("14. getQuestions no longer throws on the migrated database", err, null);
  check("  and returns the legacy questions", (rows ?? []).map((r) => r.id).sort(), ["old-1", "old-2", "old-3"]);
  stubs.set(path.join(MOBILE, "src/db/database"), { getDatabase: async () => db });

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1-4. the teacher's classes and subjects come from their assignments ---");
  apiState.asTeacher = A;
  let classes = await Quiz.getTeacherClasses(A, SCHOOL);
  check("1. assigned classes load (two, by name)", classes.map((c) => c.name), ["Form 4B", "Form 5A"]);
  check("  each with its id, level and section", classes.find((c) => c.id === C1), { id: C1, name: "Form 5A", level: "5", section: "A" });
  let subs = await Quiz.getTeacherSubjectsForClass(A, C1, SCHOOL);
  check("2. assigned subjects for Form 5A load", subs.map((s) => s.name), ["Mathematics", "Physics"]);
  check("  and for Form 4B", (await Quiz.getTeacherSubjectsForClass(A, C2, SCHOOL)).map((s) => s.name), ["Biology"]);
  check("3. a class the teacher is not assigned offers nothing", await Quiz.getTeacherSubjectsForClass(A, "cls-99", SCHOOL), []);
  check("4. Biology is not offered in Form 5A even though the teacher teaches it elsewhere", subs.some((s) => s.id === BIO), false);
  check("  one server call served all of the above (memoised)", apiState.calls, 1);
  check("  the mirror gained the class name it lacked, so quiz joins resolve",
    raw.prepare("SELECT name FROM classes WHERE id = ?").get(C1)?.name, "Form 5A");
  check("  and the subject name", raw.prepare("SELECT name, class_id FROM subjects WHERE id = ?").get(MATH), { name: "Mathematics", class_id: C1 });

  Scope.clearTeacherScopeMemo();
  apiState.online = false;
  classes = await Quiz.getTeacherClasses(A, SCHOOL);
  check("offline: the cached answer serves the pickers", classes.map((c) => c.id).sort(), [C1, C2]);
  check("  subjects too", (await Quiz.getTeacherSubjectsForClass(A, C1, SCHOOL)).map((s) => s.id), [MATH, PHYS]);

  // A phone that has never reached the server since this shipped: the old
  // local join is the last resort, and still only its own assignments.
  raw.exec(`INSERT INTO teacher_assignments (id, school_id, teacher_id, class_id, subject_id) VALUES ('ta-b', '${SCHOOL}', '${B}', '${C1}', '${MATH}')`);
  Scope.clearTeacherScopeMemo();
  check("no cache, no network: the local join answers Teacher B's one assignment",
    (await Quiz.getTeacherSubjectsForClass(B, C1, SCHOOL)).map((s) => s.id), [MATH]);
  check("  and not Physics, which Teacher B does not teach",
    (await Quiz.getTeacherSubjectsForClass(B, C1, SCHOOL)).some((s) => s.id === PHYS), false);
  apiState.online = true;
  Scope.clearTeacherScopeMemo();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the question bank: one teacher, one subject ---");
  const mk = (created_by, subject_id, text) => Quiz.createQuestion({
    schoolId: SCHOOL, subject_id, created_by, question_text: text, question_type: "multiple_choice",
    options: [{ option_text: "yes", is_correct: 1, display_order: 0 }, { option_text: "no", is_correct: 0, display_order: 1 }],
  });
  const q1 = await mk(A, MATH, "A math 1");
  const q2 = await mk(A, MATH, "A math 2");
  const q3 = await mk(A, PHYS, "A physics 1");
  const q4 = await mk(A, PHYS, "A physics 2");
  const q5 = await mk(B, MATH, "B math private");
  // A question with no subject, as legacy rows have.
  raw.exec(`INSERT INTO questions (id, schoolId, question_text, question_type, created_by) VALUES ('q6','${SCHOOL}','A no-subject','true_false','${A}')`);
  const ids = (list) => list.map((q) => q.id).sort();

  let bankErr = null;
  try { await mk(A, null, "no subject"); } catch (e) { bankErr = e.message; }
  check("createQuestion refuses a question without a subject", bankErr !== null, true);
  check("  a saved question carries its subject and its options", [q1.subject_id, q1.options.length], [MATH, 2]);

  const mathA = await Quiz.getQuestionBank({ schoolId: SCHOOL, teacherId: A, subjectId: MATH });
  check("5. Mathematics quiz → Teacher A's Mathematics questions only", ids(mathA), ids([q1, q2]));
  check("  each row names its subject", mathA.every((q) => q.subject_id === MATH && q.subject_name === "Mathematics"), true);
  const physA = await Quiz.getQuestionBank({ schoolId: SCHOOL, teacherId: A, subjectId: PHYS });
  check("6. Physics quiz → Teacher A's Physics questions only", ids(physA), ids([q3, q4]));
  check("7. the Mathematics bank of a teacher who also teaches Physics holds no Physics question",
    mathA.some((q) => [q3.id, q4.id].includes(q.id)), false);
  check("8. Teacher A's Mathematics bank does not hold Teacher B's private Mathematics question",
    mathA.some((q) => q.id === q5.id), false);
  check("  Teacher B's Mathematics bank holds only their own", ids(await Quiz.getQuestionBank({ schoolId: SCHOOL, teacherId: B, subjectId: MATH })), [q5.id]);
  check("  Teacher B has no Physics bank", await Quiz.getQuestionBank({ schoolId: SCHOOL, teacherId: B, subjectId: PHYS }), []);
  check("11. a question with no subject is in no subject's bank", mathA.some((q) => q.id === "q6"), false);
  check("  a bank for a subject nobody has written for is empty, not everything",
    await Quiz.getQuestionBank({ schoolId: SCHOOL, teacherId: A, subjectId: BIO }), []);
  check("  a bank asked for without a subject is empty", await Quiz.getQuestionBank({ schoolId: SCHOOL, teacherId: A }), []);
  check("  or without a teacher", await Quiz.getQuestionBank({ schoolId: SCHOOL, subjectId: MATH }), []);
  check("  the bank's own filters still apply within the scope",
    ids(await Quiz.getQuestionBank({ schoolId: SCHOOL, teacherId: A, subjectId: MATH, search: "math 2" })), [q2.id]);

  const all = await Quiz.getQuestions({ schoolId: SCHOOL, created_by: A });
  check("getQuestions with created_by: Teacher A's five, none of B's", [all.length, all.some((q) => q.id === q5.id)], [5, false]);
  check("  narrowed by subject_id it is the bank", ids(await Quiz.getQuestions({ schoolId: SCHOOL, created_by: A, subject_id: PHYS })), ids([q3, q4]));
  check("getQuestions WITHOUT created_by returns nothing — the school-wide bank is no longer handed out by accident",
    await Quiz.getQuestions({ schoolId: SCHOOL }), []);
  check("  an administrator's screen widens it on purpose", (await Quiz.getQuestions({ schoolId: SCHOOL, includeAllTeachers: true })).length, 6);
  check("  updateQuestion may move a question to another subject", (await Quiz.updateQuestion(q2.id, { subject_id: PHYS })).subject_id, PHYS);
  await Quiz.updateQuestion(q2.id, { subject_id: MATH });

  // 9. Filtered at the database, over the index — not fetched and sifted.
  const plan = raw.prepare(
    `EXPLAIN QUERY PLAN SELECT q.id FROM questions q WHERE q.created_by = ? AND q.subject_id = ? AND q.schoolId = ? AND q.is_active = 1 AND q.deleted_at IS NULL`
  ).all(A, MATH, SCHOOL).map((r) => r.detail).join(" | ");
  note(`query plan: ${plan}`);
  check("9. the bank query uses the (created_by, subject_id) index", /idx_questions_owner_subject/.test(plan), true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- a quiz for a class the mirror does not hold ---");
  raw.exec(`DELETE FROM classes WHERE id = '${C2}'`);   // as on a teacher's phone before the scope seeded it
  Scope.clearTeacherScopeMemo();
  const quiz = await Quiz.createQuiz({ schoolId: SCHOOL, title: "Bio test", class_id: C2, subject_id: BIO, created_by: A });
  check("createQuiz accepts a class the teacher is assigned even when the mirror lacks the row", [quiz.class_id, quiz.subject_id], [C2, BIO]);
  let rejected = null;
  try { await Quiz.createQuiz({ schoolId: SCHOOL, title: "Elsewhere", class_id: "cls-99", subject_id: BIO, created_by: A }); } catch (e) { rejected = e.message; }
  check("  and still refuses a class that is neither in the mirror nor theirs", rejected !== null, true);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the screens use the scoped calls ---");
  const create = fs.readFileSync(path.join(MOBILE, "app/teacher/quizzes/create.js"), "utf8");
  const list   = fs.readFileSync(path.join(MOBILE, "app/teacher/quizzes/index.js"), "utf8");
  check("create.js loads the bank with getQuestionBank, by teacher and subject",
    /getQuestionBank\(\{\s*schoolId,\s*teacherId,\s*subjectId: bankSubjectId\s*\}\)/.test(create), true);
  check("  and no longer asks for every question in the school", /getQuestions\(\{\s*schoolId,\s*limit/.test(create), false);
  check("  a new question is saved under the quiz's subject", /subject_id: quizForm\.subject_id,/.test(create), true);
  check("  the bank says whose subject it is", /quizCreate\.bankSubjectOnly/.test(create), true);
  check("  and has an empty state for a subject with no questions", /quizCreate\.bankEmptyForSubjectTitle/.test(create), true);
  check("index.js asks for the teacher's own questions", /created_by: teacherId\.toString\(\)/.test(list) && /subject_id: subjectId \|\| null/.test(list), true);
  for (const lang of ["en", "fr"]) {
    const j = JSON.parse(fs.readFileSync(path.join(MOBILE, `src/i18n/locales/${lang}.json`), "utf8"));
    check(`${lang}: the new strings exist`,
      ["bankSubjectOnly", "bankNoSubjectTitle", "bankEmptyForSubjectTitle", "bankEmptyForSubjectSub", "bankLoading"].every((k) => typeof j.quizCreate?.[k] === "string")
        && typeof j.quizList?.allSubjects === "string" && typeof j.svcErr?.questionSubjectRequired === "string", true);
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("Harness error:", err); process.exit(1); });
