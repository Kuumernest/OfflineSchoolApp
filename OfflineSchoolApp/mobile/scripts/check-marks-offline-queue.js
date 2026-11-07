// mobile/scripts/check-marks-offline-queue.js
"use strict";

/**
 * A teacher's marks, offline, end to end through the one unsent-changes queue
 * attendance uses (2026-10-30).
 *
 * Runs the real ExamService, ExamCache and MutationQueue against a real SQLite
 * database (node:sqlite); only the server is faked. ZZ Test data throughout.
 *
 *   offline save    the sheet is written to the phone and queued: every row
 *                   reads "pending", and the pending count goes up by one
 *   kill + reopen   fresh modules over the same database: the marks and their
 *                   pending state are still there
 *   reconnect       the drain uploads the sheet (with an Idempotency-Key, no
 *                   new sign-in): the rows settle, the count goes back down
 *   refused         the server answers 423 (sheet locked / published): the
 *                   rows read "needs attention" with the server's reason, the
 *                   marks stay on the phone, the entry is on the pending list,
 *                   and an attendance register queued behind it still goes
 *   conflict        a 409 is "needs attention" too, never silently dropped
 *
 *   node scripts/check-marks-offline-queue.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

const MOBILE = path.join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

const adapt = (db) => ({
  execAsync:     async (sql) => { db.exec(sql); },
  runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
  getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  withTransactionAsync: async (fn) => { await fn(); },
});

// A fresh module graph each call — "the app was killed and reopened".
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
    const req = (id) => (id.startsWith(".")
      ? load(path.resolve(dir, id).replace(/\.js$/, ""))
      : id === "@react-native-community/netinfo"
        ? { __esModule: true, default: { addEventListener: () => () => {}, fetch: async () => ({ isConnected: true }) } }
        : require(id));
    new Function("module", "exports", "require", code)(mod, mod.exports, req);
    return mod.exports;
  };
  return (rel) => load(path.join(MOBILE, rel).replace(/\.js$/, ""));
};

(async () => {
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);

  // ── The fake server ────────────────────────────────────────────────────
  const server = { mode: "offline", perUrl: new Map(), log: [] };
  const httpError = (status, data) => { const e = new Error(`HTTP ${status}`); e.response = { status, data }; return e; };
  const answer = ({ method, url, data, headers }) => {
    server.log.push({ method, url, data, headers });
    const mode = server.perUrl.get(url) ?? server.mode;
    if (mode === "offline") { const e = new Error("Network Error"); e.code = "ERR_NETWORK"; throw e; }
    if (mode === "423") throw httpError(423, { code: "RESULTS_LOCKED", message: "Results for this exam are locked — they have been approved." });
    if (mode === "409") throw httpError(409, { code: "VERSION_CONFLICT", message: "This mark sheet was changed by someone else." });
    return { status: 201, data: { success: true, saved: (data?.scores ?? []).length } };
  };
  const fakeApi = {
    request: async (cfg) => answer(cfg),
    post:    async (url, data) => answer({ method: "POST", url, data }),
    get:     async (url) => { if (server.mode === "offline") return answer({ method: "GET", url }); return { data: { scores: [] } }; },
  };

  const stubs = new Map([
    [path.join(MOBILE, "src/db/database"), { getDatabase: async () => db }],
    [path.join(MOBILE, "src/db/dbService"), { DB: { query: async (sql, p = []) => raw.prepare(sql).all(...(p ?? [])), queryFirst: async (sql, p = []) => raw.prepare(sql).get(...(p ?? [])) ?? null } }],
    [path.join(MOBILE, "src/services/api"), { default: fakeApi, __esModule: true, API_URL: "http://stub" }],
    [path.join(MOBILE, "src/services/content.service"), { processPendingUploads: async () => ({ succeeded: 0, failed: 0 }) }],
    [path.join(MOBILE, "src/utils/authHelpers"), {
      isAuthenticated: () => true,
      getCurrentAuth:  () => ({ user: { _id: "zz-teacher", role: "teacher", schoolId: "zz-school" }, token: "t", role: "teacher", schoolId: "zz-school" }),
    }],
  ]);
  const boot = () => {
    const load = makeLoader(stubs);
    return {
      ExamService: load("src/services/exam.service.js").ExamService,
      ExamCache:   load("src/services/examCache.service.js"),
      MutationQueue: load("src/services/mutationQueue.service.js").MutationQueue,
    };
  };

  const SHEET = { examId: "zz-exam", classId: "zz-form1", subjectId: "zz-maths", examSubjectId: "zz-es", schoolId: "zz-school" };
  const PUPILS = ["zz-p1", "zz-p2", "zz-p3"];
  const sheet = (scores) => PUPILS.map((studentId, i) => ({
    studentId, score: scores[i] === "abs" ? null : scores[i], maxScore: 20, isAbsent: scores[i] === "abs", teacherRemark: null,
  }));
  const unsent = async (MQ) => { const s = await MQ.getStats(); return s.pending + s.retrying + s.failed + s.conflict; };

  // ── Offline save ───────────────────────────────────────────────────────
  console.log("--- offline: saved on the phone, pending ---");
  let app = boot();
  const before = await unsent(app.MutationQueue);
  const saved = await app.ExamService.saveBulkScores({ ...SHEET, scores: sheet([14, "abs", 9]), enteredBy: "zz-teacher" });
  check("the save is queued, not failed", [saved.success, saved.queued, saved.saved], [true, true, 3]);
  let st = await app.ExamCache.sheetSyncState(SHEET);
  check("every row on the sheet reads pending", PUPILS.map((p) => st.byStudent[p]), ["pending", "pending", "pending"]);
  check("the pending count goes up by one (one entry per sheet)", (await unsent(app.MutationQueue)) - before, 1);
  // A re-save before upload replaces the queued entry rather than stacking another.
  await app.ExamService.saveBulkScores({ ...SHEET, scores: sheet([15, "abs", 9]), enteredBy: "zz-teacher" });
  check("a second offline save of the same sheet still one entry", (await unsent(app.MutationQueue)) - before, 1);

  // ── Kill and reopen ────────────────────────────────────────────────────
  console.log("--- the app killed and reopened (offline) ---");
  app = boot();
  const reopened = await app.ExamService.getScores(SHEET);
  const bySid = Object.fromEntries(reopened.scores.map((r) => [r.studentId, r]));
  check("the marks come back from the phone", [bySid["zz-p1"]?.score, bySid["zz-p2"]?.isAbsent, bySid["zz-p3"]?.score, reopened.isStale], [15, true, 9, true]);
  st = await app.ExamCache.sheetSyncState(SHEET);
  check("still pending after the restart", [st.pending, st.attention], [3, 0]);

  // ── Reconnect ──────────────────────────────────────────────────────────
  console.log("--- reconnect: uploaded by the sync, no new sign-in ---");
  server.mode = "ok"; server.log.length = 0;
  await app.MutationQueue.drain({ limit: 100, includeUploads: false });
  const sent = server.log.find((r) => r.url === "/exams/zz-exam/scores/bulk");
  check("the sheet reached the server with the latest marks", sent?.data?.scores?.map((s) => s.score), [15, null, 9]);
  check("sent once, with an Idempotency-Key", [server.log.filter((r) => r.url === "/exams/zz-exam/scores/bulk").length, Boolean(sent?.headers?.["Idempotency-Key"])], [1, true]);
  st = await app.ExamCache.sheetSyncState(SHEET);
  check("the rows settle: nothing pending, nothing to attend to", [st.pending, st.attention, Object.keys(st.byStudent).length], [0, 0, 0]);
  check("and the pending count is back down", await unsent(app.MutationQueue), before);

  // ── Refused: locked / approved ─────────────────────────────────────────
  console.log("--- refused by the server (sheet locked): needs attention ---");
  server.mode = "offline";
  const LOCKED = { ...SHEET, subjectId: "zz-french", examSubjectId: "zz-es2" };
  await app.ExamService.saveBulkScores({ ...LOCKED, scores: sheet([12, 11, 10]), enteredBy: "zz-teacher" });
  // An attendance register queued behind it, as attendance.service queues one.
  await app.MutationQueue.enqueue({
    entityKey: "attendance:zz-form1:2026-10-30", method: "POST", endpoint: "/attendance/students/bulk",
    payload: { classId: "zz-form1", date: "2026-10-30", records: [{ studentId: "zz-p1", status: "present" }] },
  });
  server.mode = "ok"; server.perUrl.set("/exams/zz-exam/scores/bulk", "423");
  await app.MutationQueue.drain({ limit: 100, includeUploads: false });
  st = await app.ExamCache.sheetSyncState(LOCKED);
  check("every row of the refused sheet reads needs attention", PUPILS.map((p) => st.byStudent[p]), ["attention", "attention", "attention"]);
  check("with the server's reason", st.reasons.some((r) => /locked/i.test(r)), true);
  const kept = await app.ExamService.getScores(LOCKED).catch(() => ({ scores: [] }));
  check("the marks are still on the phone, not silently dropped", kept.scores.map((r) => r.score).sort(), [10, 11, 12]);
  const unresolved = await app.MutationQueue.listUnresolved();
  check("and on the pending-changes list", unresolved.some((r) => r.endpoint === "/exams/zz-exam/scores/bulk" && r.status === "failed"), true);
  check("the attendance register behind it still went (the queue is not blocked)",
    server.log.some((r) => r.url === "/attendance/students/bulk"), true);

  // ── Conflict ───────────────────────────────────────────────────────────
  console.log("--- a conflicting change: needs attention too ---");
  server.mode = "offline"; server.perUrl.clear();
  const CONFLICT = { ...SHEET, subjectId: "zz-english", examSubjectId: "zz-es3" };
  await app.ExamService.saveBulkScores({ ...CONFLICT, scores: sheet([8, 7, 6]), enteredBy: "zz-teacher" });
  server.mode = "ok"; server.perUrl.set("/exams/zz-exam/scores/bulk", "409");
  await app.MutationQueue.drain({ limit: 100, includeUploads: false });
  st = await app.ExamCache.sheetSyncState(CONFLICT);
  check("a 409 reads needs attention, with its reason", [st.attention, st.reasons.some((r) => /changed by someone else/i.test(r))], [3, true]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
