// mobile/scripts/check-teacher-marks-offline.js
"use strict";

/**
 * A teacher's marks go through the offline queue, like attendance (2026-10-30).
 *
 * The teacher's mark sheet (app/teacher/exams/subjects.js) posted straight to
 * /exams/:id/scores/bulk. Offline that failed with "Save failed" and the marks
 * lived only in an unsent AsyncStorage draft; and the sheet read the server
 * alone, so offline it opened empty. It now loads and saves through
 * ExamService — the path the admin mark sheet already used:
 *
 *   saveBulkScores  writes the sheet to the device, sends it when there is a
 *                   connection, and otherwise queues it on the outbox (one
 *                   entry per exam + class + subject, so a re-save replaces
 *                   the queued one); a refusal from the server undoes the
 *                   local write and throws.
 *   getScores       caches the sheet and reads it back from the device, so
 *                   marks waiting to upload come back offline.
 *
 * Each row shows where its saved mark stands in the queue — pending, or needs
 * attention — and the sheet carries a banner for each (2026-10-30; the queue
 * itself, end to end, is check-marks-offline-queue.js).
 *
 * The screen is checked from its source; the service is run, with the network,
 * the outbox and the device cache stubbed.
 *
 *   node scripts/check-teacher-marks-offline.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");

const MOBILE = path.join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

console.log("--- the teacher's mark sheet ---");
const screen = fs.readFileSync(path.join(MOBILE, "app/teacher/exams/subjects.js"), "utf8");
const code = screen.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
check("no longer posts the sheet straight to the server",
  /api\s*\.post\(\s*`\/exams\/\$\{examId\}\/scores\/bulk`/.test(code), false);
check("saves through ExamService.saveBulkScores", /ExamService\.saveBulkScores\(/.test(code), true);
check("loads through ExamService.getScores (the device copy offline)", /ExamService\s*\.getScores\(/.test(code), true);
check("says so when the sheet was queued rather than sent",
  [/res\?\.queued/.test(code), /savedOfflineTitle/.test(code), /savedOfflineBody/.test(code)], [true, true, true]);
check("each row shows where its mark stands in the queue (ExamCache.sheetSyncState → MarkInputRow syncState)",
  [/ExamCache\.sheetSyncState\(/.test(code), /syncState=\{sheetSync\.byStudent\[item\._id\]/.test(code)], [true, true]);
check("a banner for marks waiting, and one for marks that need attention, with a way to the pending list",
  [/sheetSync\.pending > 0/.test(code), /sheetSync\.attention > 0/.test(code), /router\.push\("\/sync\/pending"\)/.test(code)], [true, true, true]);
check("re-read whenever the queue's counts move", /useSyncStatus\(\)/.test(code) && /queueKey\]/.test(code), true);
const row = fs.readFileSync(path.join(MOBILE, "src/components/MarkInputRow.js"), "utf8");
check("the row draws the badge from syncState and syncLabels", [/syncState = null/.test(row), /syncLabels\?\.\[syncState\]/.test(row)], [true, true]);
for (const lang of ["en", "fr"]) {
  const s = JSON.parse(fs.readFileSync(path.join(MOBILE, `src/i18n/locales/${lang}.json`), "utf8")).teacherExamSubjects;
  check(`${lang}: the queued message exists, with its plural`,
    [Boolean(s.savedOfflineTitle), Boolean(s.savedOfflineBody?.one), Boolean(s.savedOfflineBody?.other)], [true, true, true]);
  check(`${lang}: the row and banner words exist`,
    [s.rowPending, s.rowAttention, s.reviewPending, s.pendingBanner?.one, s.pendingBanner?.other, s.attentionBanner?.one, s.attentionBanner?.other].every(Boolean), true);
}

// ── The service, run ─────────────────────────────────────────────────────────
const loadWith = (stubs) => {
  const cache = new Map();
  const load = (abs) => {
    if (stubs.has(abs)) return stubs.get(abs);
    if (cache.has(abs)) return cache.get(abs).exports;
    const file = fs.existsSync(abs) ? abs : `${abs}.js`;
    const { code: js } = babel.transformFileSync(file, {
      presets: [require.resolve("babel-preset-expo")],
      caller: { name: "check", supportsStaticESM: false },
      babelrc: false, configFile: false,
    });
    const mod = { exports: {} };
    cache.set(abs, mod);
    const dir = path.dirname(file);
    const req = (id) => id.startsWith(".")
      ? load(path.resolve(dir, id).replace(/\.js$/, ""))
      : require(id);
    new Function("module", "exports", "require", js)(mod, mod.exports, req);
    return mod.exports;
  };
  return load(path.join(MOBILE, "src/services/exam.service"));
};

const scenario = async (apiPost) => {
  const calls = { enqueued: [], savedLocal: 0, restored: 0, synced: 0 };
  const stubs = new Map([
    [path.join(MOBILE, "src/services/api"), { __esModule: true, default: { post: apiPost, get: async () => ({ data: {} }) } }],
    [path.join(MOBILE, "src/services/mutationQueue.service"), { MutationQueue: { enqueue: async (m) => { calls.enqueued.push(m); } } }],
    [path.join(MOBILE, "src/services/examCache.service"), {
      snapshotScores: async () => ["before"],
      saveScoresLocal: async ({ scores }) => { calls.savedLocal += scores.length; return scores.map((_, i) => `local-${i}`); },
      restoreScores: async () => { calls.restored += 1; },
      markExamOpened: async () => {},
    }],
    [path.join(MOBILE, "src/db/database"), { getDatabase: async () => ({ runAsync: async () => { calls.synced += 1; } }) }],
  ]);
  const { ExamService } = loadWith(stubs);
  let result, error = null;
  try {
    result = await ExamService.saveBulkScores({
      examId: "zz-exam", classId: "zz-form1", subjectId: "zz-maths", examSubjectId: "zz-es", schoolId: "zz-school",
      scores: [{ studentId: "zz-p1", score: 14, maxScore: 20, isAbsent: false, teacherRemark: null },
               { studentId: "zz-p2", score: null, maxScore: 20, isAbsent: true, teacherRemark: null }],
      enteredBy: "zz-teacher",
    });
  } catch (e) { error = e; }
  return { calls, result, error };
};

(async () => {
  console.log("--- offline: saved on the device and queued ---");
  const offline = await scenario(async () => { const e = new Error("Network Error"); e.isOffline = true; throw e; });
  check("the sheet is written to the device", offline.calls.savedLocal, 2);
  check("and queued, not failed", [offline.error, offline.result?.queued, offline.result?.success], [null, true, true]);
  check("one outbox entry for the sheet, to the bulk endpoint",
    offline.calls.enqueued.map((m) => [m.method, m.endpoint, m.entityKey]),
    [["POST", "/exams/zz-exam/scores/bulk", "exam-scores:zz-exam:zz-form1:zz-maths"]]);
  check("carrying the marks", offline.calls.enqueued[0]?.payload?.scores?.map((s) => s.score), [14, null]);

  console.log("--- online: sent, not queued ---");
  const online = await scenario(async () => ({ data: { saved: 2 } }));
  check("sent at once and nothing queued", [online.result?.queued, online.calls.enqueued.length, online.calls.synced], [false, 0, 1]);

  console.log("--- refused by the server: undone, and the teacher is told ---");
  const refused = await scenario(async () => { const e = new Error("Bad Request"); e.response = { status: 400, data: { message: "invalid" } }; throw e; });
  check("the local write is undone and the error reaches the screen",
    [refused.calls.restored, refused.calls.enqueued.length, Boolean(refused.error)], [1, 0, true]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
