// mobile/scripts/check-offline-p0.js
"use strict";

/**
 * Work done offline reaches the server, once, with everything in it.
 *
 * The launch-blocking offline-sync bugs (docs/launch-fixes.md, offline P0),
 * each run through the REAL services, the REAL SyncManager.syncAll the app
 * runs on reconnect, and the real outbox, over a real SQLite — against a fake
 * server that only records what it is sent. What is asserted is the wire:
 * which requests left the phone, with what, and how many times.
 *
 *   #1  a class / subject created, edited, toggled or deleted offline was
 *       dropped: the sync marked every dirty class and subject synced before
 *       anything queued them (markOrphanedRecordsAsSynced), create and toggle
 *       queued nothing offline, the backfill sent only id/name/level, and an
 *       edited class was POSTed as a create on top of its PUT
 *   #2B attendance went twice: the service queues under attendance:class:…,
 *       the backfill looked for attendance:<row id>
 *   #3  a quiz or question edit (and every publish) was POSTed as a create —
 *       a duplicate quiz, the original unchanged, never published
 *   #4  an announcement created offline then edited, pinned or deleted was
 *       turned into a PUT / DELETE of an id the server never had
 *   #5  a period edited offline was POSTed (a second period); one deleted
 *       offline was never deleted
 *
 * The outbox's own behaviour offline (#2: no sends, no retry budget spent,
 * single flight, re-arm) is in check-outbox-drain.js; the same scenarios
 * against the real backend are in check-offline-e2e.js.
 *
 *   node scripts/check-offline-p0.js
 */

const nodeCrypto = require("crypto");
const { bootPhone, quietly } = require("./offline-harness");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

(async () => {
  const S = "school-a";
  const oid = () => nodeCrypto.randomBytes(12).toString("hex");

  // ── The fake server: records every write, answers like the real routes ───
  const sent = [];
  let phone = null;
  const handle = async ({ method, url, data }) => {
    const m = String(method).toUpperCase();
    // api.js refuses locally while NetInfo says offline — no response.
    if (!phone.net.connected) { const e = new Error("No internet connection"); e.isOffline = true; throw e; }
    if (m === "GET") return { status: 200, data: {} };
    const body = data ?? {};
    sent.push({ method: m, url, data: body });
    const ok = (status, d) => ({ status, data: { success: true, ...d } });
    if (m === "POST" && url === "/admin/classes")  return ok(201, { class: { _id: body.id, ...body } });
    if (m === "POST" && url === "/admin/subjects") return ok(201, { subject: { _id: body.id, ...body } });
    if (m === "POST" && url === "/quiz/questions") return ok(201, { question: { _id: oid(), client_id: body.id } });
    if (m === "POST" && url === "/quiz/quizzes")   return ok(201, { quiz: { _id: oid(), client_id: body.id, is_published: false } });
    if (m === "POST" && url === "/admin/periods")  return ok(201, { data: { _id: nodeCrypto.randomUUID(), ...body } });
    if (m === "PUT"  && url.startsWith("/admin/periods/")) return ok(200, { data: { _id: url.split("/").pop(), ...body } });
    return ok(m === "POST" ? 201 : 200, {});
  };
  const api = {
    request: handle,
    get:    (url, cfg = {}) => handle({ method: "GET", url, ...cfg }),
    post:   (url, data) => handle({ method: "POST", url, data }),
    put:    (url, data) => handle({ method: "PUT", url, data }),
    patch:  (url, data) => handle({ method: "PATCH", url, data }),
    delete: (url) => handle({ method: "DELETE", url }),
  };

  phone = await quietly(bootPhone)({ api, user: { _id: "adm-1", id: "adm-1", role: "school_admin", schoolId: S, name: "Head" } });
  const { load, q, one, net, SyncManager } = phone;
  const { MutationQueue } = load("src/services/mutationQueue.service");
  const { ClassService }  = load("src/services/class.service");
  const subjects          = load("src/services/subject.service");
  const attendance        = load("src/services/attendance.service").AttendanceService;
  const quiz              = load("src/services/quiz.service");
  const ann               = load("src/services/announcement.service");
  const { PeriodsService } = load("src/services/periods.service");

  // What the app runs when the network comes back (SyncManager's NetInfo
  // listener): a full sync, which backfills and drains the outbox.
  const reconnect = quietly(async () => { net.connected = true; await SyncManager.syncAll({ force: true }); });
  const offline   = () => { net.connected = false; };
  const wire      = (re) => sent.filter((r) => re.test(`${r.method} ${r.url}`));
  const unsent    = () => q(`SELECT entity_key, status FROM mutation_outbox WHERE status != 'synced'`);

  // What the phone already holds from the server.
  await quietly(async () => {
    await SyncManager.syncClasses([{ _id: "cls-srv", schoolId: S, name: "Form 5", isActive: true }]);
    await SyncManager.syncSubjects([
      { _id: "sub-srv",  schoolId: S, name: "Maths",   classId: "cls-srv" },
      { _id: "sub-gone", schoolId: S, name: "Latin",   classId: "cls-srv" },
    ]);
    await SyncManager.syncPeriods([
      { _id: "per-1", schoolId: S, name: "P1", startTime: "08:00", endTime: "09:00" },
      { _id: "per-2", schoolId: S, name: "P2", startTime: "09:00", endTime: "10:00" },
    ]);
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- #1 classes and subjects, offline ---");
  offline();
  const cid = await quietly(() => ClassService.create("Form 1", "F1", "A", { id: "tea-1", name: "T One" }))();
  await quietly(() => ClassService.toggleActive(cid))();
  await quietly(() => ClassService.update(cid, "Form 1", { section: "B" }))();
  await quietly(() => ClassService.update("cls-srv", "Form 5", { level: "F5" }))();
  await quietly(() => ClassService.toggleActive("cls-srv"))();
  const sid = (await quietly(() => subjects.createSubject({ name: "Physics", classId: cid, code: "PHY", schoolId: S }))()).id;
  await quietly(() => subjects.deleteSubject("sub-gone"))();
  // Created and deleted before any sync: nothing should ever be sent for it.
  const ghost = await quietly(() => ClassService.create("Ghost", null, ""))();
  await quietly(() => ClassService.delete(ghost))();
  const ghostSub = (await quietly(() => subjects.createSubject({ name: "Ghost", classId: "cls-srv", schoolId: S }))()).id;
  await quietly(() => subjects.deleteSubject(ghostSub))();
  await reconnect();

  const classPosts = wire(/^POST \/admin\/classes$/);
  check("the offline class is created upstream once, with section, level and class teacher",
    classPosts.map((r) => [r.data.id, r.data.name, r.data.level, r.data.section, r.data.classTeacherId]),
    [[cid, "Form 1", "F1", "A", "tea-1"]]);
  check("  its toggle and its edit follow as PUTs to that id (isActive false, section B)",
    wire(new RegExp(`^PUT /admin/classes/${cid}$`)).map((r) => r.data), [{ isActive: false }, { name: "Form 1", section: "B" }]);
  check("an existing class edited offline: one PUT with the edit, one with the toggle, no create",
    [wire(/^PUT \/admin\/classes\/cls-srv$/).map((r) => r.data), classPosts.some((r) => r.data.id === "cls-srv")],
    [[{ name: "Form 5", level: "F5" }, { isActive: false }], false]);
  check("the offline subject is created upstream once, under its class",
    wire(/^POST \/admin\/subjects$/).map((r) => [r.data.id, r.data.name, r.data.classId]), [[sid, "Physics", cid]]);
  check("the existing subject deleted offline is deleted upstream once",
    wire(/^DELETE \/admin\/subjects\//).map((r) => r.url), ["/admin/subjects/sub-gone"]);
  check("a class and a subject created and deleted offline: nothing sent, nothing left behind",
    [sent.some((r) => r.url.includes(ghost) || r.data?.id === ghost || r.url.includes(ghostSub) || r.data?.id === ghostSub),
     one("SELECT COUNT(*) AS n FROM classes WHERE id = ?", [ghost]).n],
    [false, 0]);
  check("  the outbox is empty", unsent(), []);
  check("  and the rows are clean", [one("SELECT _synced FROM classes WHERE id = ?", [cid])._synced,
    one("SELECT _synced FROM classes WHERE id = 'cls-srv'")._synced, one("SELECT _synced FROM subjects WHERE id = ?", [sid])._synced], [1, 1, 1]);

  sent.length = 0;
  await reconnect();
  check("a second sync sends nothing more", sent, []);

  // An existing class deleted offline.
  offline();
  await quietly(() => ClassService.delete("cls-srv"))();
  await reconnect();
  check("an existing class deleted offline is deleted upstream once",
    wire(/^DELETE \/admin\/classes\//).map((r) => r.url), ["/admin/classes/cls-srv"]);
  check("  and nothing is left in the outbox", unsent(), []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- #2B attendance is sent once ---");
  sent.length = 0;
  offline();
  await quietly(() => attendance.markClassAttendanceBulk({
    schoolId: S, classId: cid, date: "2026-11-02",
    records: [{ studentId: "st-1", status: "present" }, { studentId: "st-2", status: "absent" }],
  }))();
  await quietly(() => attendance.markStudentAttendance({ schoolId: S, classId: cid, studentId: "st-3", date: "2026-11-02", status: "late" }))();
  // Re-marked: the existing row is updated, not a new one.
  await quietly(() => attendance.markStudentAttendance({ schoolId: S, classId: cid, studentId: "st-3", date: "2026-11-02", status: "present" }))();
  await quietly(() => attendance.markTeacherAttendance({ schoolId: S, teacherId: "tea-1", date: "2026-11-02", status: "present" }))();
  await reconnect();
  check("the register goes once, as the bulk the service queued — never again per row",
    [wire(/^POST \/attendance\/students\/bulk$/).length, wire(/^POST \/attendance\/students$/).length], [1, 1]);
  check("  the single mark carries the correction (present), sent once",
    wire(/^POST \/attendance\/students$/).map((r) => r.data.status), ["present"]);
  check("  teacher attendance once", wire(/^POST \/attendance\/teachers$/).length, 1);
  check("  every row clean, the outbox empty",
    [q("SELECT _synced FROM attendance").every((r) => r._synced === 1), q("SELECT _synced FROM teacher_attendance").every((r) => r._synced === 1), unsent()],
    [true, true, []]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- #3 quizzes and questions ---");
  sent.length = 0;
  await quietly(() => SyncManager.syncClasses([{ _id: "cls-q", schoolId: S, name: "Form 6", isActive: true }]))();
  offline();
  const question = await quietly(() => quiz.createQuestion({
    schoolId: S, subject_id: "sub-srv", question_text: "2 + 2?", question_type: "multiple_choice",
    created_by: "adm-1", options: [{ option_text: "4", is_correct: true }, { option_text: "5" }],
  }))();
  const made = await quietly(() => quiz.createQuiz({
    schoolId: S, title: "Draft", class_id: "cls-q", subject_id: "sub-srv", created_by: "adm-1", questionIds: [question.id],
  }))();
  await quietly(() => quiz.updateQuiz(made.id, { title: "Sums" }))();
  await quietly(() => quiz.publishQuiz(made.id))();
  const doomed = await quietly(() => quiz.createQuiz({ schoolId: S, title: "Doomed", class_id: "cls-q", subject_id: "sub-srv", created_by: "adm-1" }))();
  await quietly(() => quiz.deleteQuiz(doomed.id))();
  await reconnect();

  const qPosts = wire(/^POST \/quiz\/quizzes$/);
  const serverQuestionId = one("SELECT id FROM questions WHERE question_text = '2 + 2?'").id;
  const serverQuizId     = one("SELECT id FROM quizzes WHERE title = 'Sums'")?.id;
  check("one question create, one quiz create — with the edited title, the question by its server id",
    [wire(/^POST \/quiz\/questions$/).length, qPosts.map((r) => [r.data.title, r.data.questions?.[0]?.question_id])],
    [1, [["Sums", serverQuestionId]]]);
  check("  the publish follows as a PUT to the quiz's server id",
    wire(/^PUT \/quiz\/quizzes\//).map((r) => [r.url, r.data.is_published]), [[`/quiz/quizzes/${serverQuizId}`, true]]);
  check("  the local quiz took the server id and is clean",
    [/^[0-9a-f]{24}$/.test(serverQuizId ?? ""), one("SELECT _synced FROM quizzes WHERE id = ?", [serverQuizId])?._synced], [true, 1]);
  check("a quiz created and deleted offline: nothing sent, the row gone",
    [qPosts.some((r) => r.data.title === "Doomed"), sent.some((r) => r.url.includes(doomed.id)), one("SELECT COUNT(*) AS n FROM quizzes WHERE id = ?", [doomed.id]).n],
    [false, false, 0]);

  sent.length = 0;
  offline();
  await quietly(() => quiz.updateQuiz(serverQuizId, { title: "Sums, revised" }))();
  await quietly(() => quiz.updateQuestion(serverQuestionId, { question_text: "2 + 3?" }))();
  await reconnect();
  check("editing the synced quiz and question offline: PUTs to their server ids, no create",
    [wire(/^POST \/quiz\//).length, wire(/^PUT \/quiz\//).map((r) => [r.url, r.data.title ?? r.data.question_text])],
    [0, [[`/quiz/questions/${serverQuestionId}`, "2 + 3?"], [`/quiz/quizzes/${serverQuizId}`, "Sums, revised"]]]);
  check("  the outbox is empty", unsent(), []);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- #4 announcements ---");
  sent.length = 0;
  offline();
  const a1 = await quietly(() => ann.createAnnouncement({ title: "Sports day", body: "Friday" }))();
  await quietly(() => ann.updateAnnouncement(a1.id, { body: "Saturday, 9am" }))();
  await quietly(() => ann.togglePin(a1.id))();
  const a2 = await quietly(() => ann.createAnnouncement({ title: "Typo", body: "oops" }))();
  await quietly(() => ann.deleteAnnouncement(a2.id))();
  await reconnect();
  check("created then edited and pinned offline: ONE create, carrying the edit and the pin",
    [wire(/\/announcements/).map((r) => [r.method, r.url]), wire(/^POST \/announcements$/).map((r) => [r.data.id, r.data.body, r.data.isPinned])],
    [[["POST", "/announcements"]], [[a1.id, "Saturday, 9am", true]]]);
  check("created then deleted offline: nothing sent, the row gone",
    [sent.some((r) => r.url.includes(a2.id) || r.data?.id === a2.id), one("SELECT COUNT(*) AS n FROM announcements WHERE id = ?", [a2.id]).n], [false, 0]);
  check("  the outbox is empty", unsent(), []);

  sent.length = 0;
  offline();
  await quietly(() => ann.updateAnnouncement(a1.id, { title: "Sports day (moved)" }))();
  await reconnect();
  check("an announcement the server has, edited offline: a PUT, no create",
    wire(/\/announcements/).map((r) => [r.method, r.url, r.data.title]), [["PUT", `/announcements/${a1.id}`, "Sports day (moved)"]]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- #5 periods ---");
  sent.length = 0;
  offline();
  const p3 = await quietly(() => PeriodsService.create({ name: "P3", startTime: "10:00", endTime: "11:00", schoolId: S }))();
  await quietly(() => PeriodsService.update(p3.id, { name: "Period 3" }))();
  await quietly(() => PeriodsService.update("per-1", { name: "Registration", endTime: "08:30" }))();
  await quietly(() => PeriodsService.delete("per-2"))();
  const p4 = await quietly(() => PeriodsService.create({ name: "P4", startTime: "12:00", endTime: "13:00", schoolId: S }))();
  await quietly(() => PeriodsService.delete(p4.id))();
  await reconnect();
  check("created then edited offline: one POST with the edited name",
    wire(/^POST \/admin\/periods$/).map((r) => [r.data.name, r.data.startTime]), [["Period 3", "10:00"]]);
  check("an existing period edited offline: a PUT to it, not a POST",
    wire(/^PUT \/admin\/periods\//).map((r) => [r.url, r.data.name, r.data.endTime]), [["/admin/periods/per-1", "Registration", "08:30"]]);
  check("an existing period deleted offline: a DELETE",
    wire(/^DELETE \/admin\/periods\//).map((r) => r.url), ["/admin/periods/per-2"]);
  check("created and deleted offline: nothing sent for it",
    sent.some((r) => r.url.includes(p4.id) || r.data?.name === "P4"), false);
  check("  the new period took the server's id; nothing dirty, the outbox empty",
    [one("SELECT COUNT(*) AS n FROM periods WHERE id = ?", [p3.id]).n, q("SELECT id FROM periods WHERE dirty = 1"), unsent()], [0, [], []]);

  sent.length = 0;
  await reconnect();
  check("a further sync sends nothing", sent, []);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
