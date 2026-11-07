// mobile/scripts/check-offline-e2e.js
"use strict";

/**
 * Offline work, end to end: the REAL phone against the REAL server.
 *
 * check-offline-p0.js proves what leaves the phone. This proves what LANDS:
 * the real mobile services, the real SyncManager.syncAll the app runs on
 * reconnect, and the real outbox over a real SQLite (node:sqlite), talking
 * HTTP (axios, as api.js does) to the real backend routes and middleware —
 * authenticate with a signed JWT, the Idempotency-Key middleware, the admin,
 * period, quiz, announcement and sync routers — over an in-memory MongoDB.
 * The assertions read MongoDB.
 *
 * Per launch blocker (docs/launch-fixes.md, offline P0):
 *   #1  a class created offline lands once, with section and class teacher,
 *       toggled inactive; a subject with it; an existing class's edit lands
 *   #2  twenty drains with no network spend nothing; when it returns
 *       everything lands and nothing is parked as failed
 *   #3  one quiz, published, with the edited title — not two drafts; a later
 *       offline edit lands on the same quiz
 *   #4  an announcement created then edited and pinned offline is created
 *       once with the edit; one created and deleted offline never exists
 *   #5  periods: created+edited lands once with the edit, an edit lands on the
 *       existing period, a delete deletes it, created+deleted never exists
 *
 * What is not the production process: the app is assembled here from the
 * same routers and middleware src/server.js mounts, in the same order, rather
 * than by requiring server.js — that file listens on a fixed port and starts
 * mail, storage and scheduled jobs at import. Nothing between the phone and a
 * route handler is skipped.
 *
 *   node scripts/check-offline-e2e.js
 */

const path   = require("path");
const Module = require("module");
const { bootPhone, quietly } = require("./offline-harness");

const BACKEND = path.join(__dirname, "..", "..", "backend");
// The backend's own copies of express, mongoose and friends — the models and
// routes must share one mongoose with this script.
const breq = Module.createRequire(path.join(BACKEND, "package.json"));

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret";
  process.env.NODE_ENV   = process.env.NODE_ENV   || "test";

  const express  = breq("express");
  const mongoose = breq("mongoose");
  const jwt      = breq("jsonwebtoken");
  const { MongoMemoryServer } = breq("mongodb-memory-server");

  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180_000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "offline-e2e" });

  const S = "5c0e2e000000000000000001";   // School is ObjectId-keyed

  // ── The server ───────────────────────────────────────────────────────────
  const { app, models } = await quietly(async () => {
    breq(path.join(BACKEND, "src/db/models"));
    const models = {
      User:         mongoose.model("User"),
      Class:        mongoose.model("Class"),
      Subject:      mongoose.model("Subject"),
      Announcement: breq(path.join(BACKEND, "src/db/models/Announcement")),
      Period:       breq(path.join(BACKEND, "src/db/models/Period")),
      ...(() => { const { Quiz, Question } = breq(path.join(BACKEND, "src/db/models/QuizModule")); return { Quiz, Question }; })(),
    };
    await breq(path.join(BACKEND, "src/db/ensureStudentIndexes")).ensureIdempotencyIndex();
    await Promise.all([models.Class.syncIndexes(), models.Subject.syncIndexes(), models.Quiz.syncIndexes(), models.Question.syncIndexes()]);

    const auth = breq(path.join(BACKEND, "middleware/auth"));
    const app = express();
    app.use(express.json());
    // As src/server.js: idempotency across /api ahead of every router (there
    // with optionalAuthenticate; every route here is authenticated anyway).
    app.use("/api", auth.authenticate, breq(path.join(BACKEND, "middleware/idempotency")));
    app.use("/api/sync",          auth.authenticate, breq(path.join(BACKEND, "src/routes/sync.routes")));
    app.use("/api/announcements", auth.authenticate, breq(path.join(BACKEND, "src/routes/announcement.routes")));
    app.use("/api/quiz",          auth.authenticate, breq(path.join(BACKEND, "src/routes/quiz.routes")));
    app.use("/api/admin/periods", auth.authenticate, breq(path.join(BACKEND, "src/routes/periods.routes")));
    app.use("/api/admin",         auth.authenticate, breq(path.join(BACKEND, "src/routes/admin.routes")));
    app.use((req, res) => res.status(404).json({ success: false, message: "not mounted in this check" }));
    app.use(breq(path.join(BACKEND, "middleware/errorHandler")));   // server.js's global handler
    return { app, models };
  })();

  const { User, Class, Subject, Announcement, Period, Quiz, Question } = models;
  await User.create({
    _id: "adm-e2e", name: "Head", email: "head@e2e.test", password: "check-only-password",
    role: "school_admin", schoolId: S, isActive: true,
  });
  await User.create({
    _id: "tea-e2e", name: "Ama Owusu", email: "ama@e2e.test", password: "check-only-password",
    role: "teacher", schoolId: S, isActive: true,
  });
  // What the server already holds, and the phone pulls before going offline.
  await Class.create({ _id: "cls-old", schoolId: S, name: "Form 5", section: "", isActive: true });
  await Subject.create({ _id: "sub-old", schoolId: S, name: "Maths", class: "cls-old", classId: "cls-old" });
  const [per1, per2] = await Period.create([
    { schoolId: S, name: "P1", startTime: "08:00", endTime: "09:00", sortOrder: 1 },
    { schoolId: S, name: "P2", startTime: "09:00", endTime: "10:00", sortOrder: 2 },
  ]);

  const server = app.listen(0);
  const port   = server.address().port;
  const token  = jwt.sign({ id: "adm-e2e", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });

  // ── The phone ────────────────────────────────────────────────────────────
  // axios, as api.js builds it. Its request interceptor stands in for api.js's
  // two ways a send gets no answer: NetInfo reporting offline (api.js refuses
  // locally) and a link that is up but reaches nothing (`link.reachable`).
  const axios = require("axios");
  const http  = axios.create({ baseURL: `http://127.0.0.1:${port}/api`, timeout: 15_000 });
  const link  = { reachable: true, attempts: 0 };
  let phone = null;
  http.interceptors.request.use((cfg) => {
    const write = !["get", "head"].includes(String(cfg.method).toLowerCase());
    if (write) link.attempts++;
    if (!phone.net.connected || !link.reachable) {
      const e = new Error("Network Error"); e.code = "ERR_NETWORK"; e.isOffline = !phone.net.connected;
      throw e;
    }
    cfg.headers.Authorization = `Bearer ${token}`;
    return cfg;
  });

  phone = await quietly(bootPhone)({ api: http, token, user: { _id: "adm-e2e", id: "adm-e2e", role: "school_admin", schoolId: S, name: "Head" } });
  const { load, q, one, net, SyncManager } = phone;
  const { MutationQueue }  = load("src/services/mutationQueue.service");
  const { ClassService }   = load("src/services/class.service");
  const subjects           = load("src/services/subject.service");
  const quiz               = load("src/services/quiz.service");
  const ann                = load("src/services/announcement.service");
  const { PeriodsService } = load("src/services/periods.service");

  const sync = quietly(() => SyncManager.syncAll({ force: true }));
  const reconnect = async () => { net.connected = true; link.reachable = true; await sync(); };
  const outbox = () => q(`SELECT entity_key, status, retry_count, error FROM mutation_outbox WHERE status != 'synced'`);

  // First sync online: the phone mirrors the server.
  await sync();
  check("the phone starts with the server's class, subject and periods",
    [one("SELECT COUNT(*) AS n FROM classes WHERE id = 'cls-old'").n, one("SELECT COUNT(*) AS n FROM subjects WHERE id = 'sub-old'").n,
     one("SELECT COUNT(*) AS n FROM periods WHERE id IN (?, ?)", [String(per1._id), String(per2._id)]).n], [1, 1, 2]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- offline: a morning's admin work with no network ---");
  net.connected = false;
  const writesBefore = link.attempts;

  // #1 classes and subjects
  const cid = await quietly(() => ClassService.create("Form 1", "F1", "A", { id: "tea-e2e", name: "Ama Owusu" }))();
  await quietly(() => ClassService.toggleActive(cid))();
  const sid = (await quietly(() => subjects.createSubject({ name: "Physics", classId: cid, code: "PHY", schoolId: S }))()).id;
  await quietly(() => ClassService.update("cls-old", "Form 5", { section: "Blue" }))();
  const ghostClass = await quietly(() => ClassService.create("Ghost", null, ""))();
  await quietly(() => ClassService.delete(ghostClass))();

  // #3 a quiz written, retitled and published offline
  const question = await quietly(() => quiz.createQuestion({
    schoolId: S, subject_id: "sub-old", question_text: "2 + 2?", question_type: "multiple_choice",
    created_by: "adm-e2e", options: [{ option_text: "4", is_correct: true }, { option_text: "5", is_correct: false }],
  }))();
  const draft = await quietly(() => quiz.createQuiz({
    schoolId: S, title: "Draft", class_id: "cls-old", subject_id: "sub-old", created_by: "adm-e2e", questionIds: [question.id],
  }))();
  await quietly(() => quiz.updateQuiz(draft.id, { title: "Sums" }))();
  await quietly(() => quiz.publishQuiz(draft.id))();

  // #4 announcements
  const a1 = await quietly(() => ann.createAnnouncement({ title: "Sports day", body: "Friday" }))();
  await quietly(() => ann.updateAnnouncement(a1.id, { body: "Saturday, 9am" }))();
  await quietly(() => ann.togglePin(a1.id))();
  const a2 = await quietly(() => ann.createAnnouncement({ title: "Typo", body: "oops" }))();
  await quietly(() => ann.deleteAnnouncement(a2.id))();

  // #5 periods
  const p3 = await quietly(() => PeriodsService.create({ name: "P3", startTime: "10:00", endTime: "11:00", schoolId: S }))();
  await quietly(() => PeriodsService.update(p3.id, { name: "Period 3" }))();
  await quietly(() => PeriodsService.update(String(per1._id), { name: "Registration", endTime: "08:30" }))();
  await quietly(() => PeriodsService.delete(String(per2._id)))();
  const p4 = await quietly(() => PeriodsService.create({ name: "P4", startTime: "12:00", endTime: "13:00", schoolId: S }))();
  await quietly(() => PeriodsService.delete(p4.id))();

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- #2 draining with no network spends nothing ---");
  // The radio says connected, but nothing answers (a captive portal, the
  // server down): every send is attempted and gets no response. Twenty
  // drains, each after the row's backoff has elapsed.
  await quietly(() => SyncManager.backfillOutbox())();     // the sweep is local; it runs offline too
  net.connected = true; link.reachable = false;
  await quietly(async () => {
    for (let i = 0; i < 20; i++) {
      phone.raw.prepare(`UPDATE mutation_outbox SET next_attempt_at = NULL WHERE status = 'retrying'`).run();
      await MutationQueue.drain({ includeUploads: false });
    }
  })();
  const unanswered = link.attempts - writesBefore;
  check("twenty unanswered drains: sends attempted, nothing failed, retry budget untouched",
    [unanswered > 0, outbox().filter((r) => r.status === "failed" || r.retry_count > 0)], [true, []]);

  // Then the radio drops. Every screen still drains straight after writing
  // (the gate, a register, the explorations screen): twenty of them.
  net.connected = false;
  await quietly(async () => {
    for (let i = 0; i < 20; i++) await MutationQueue.drain({ includeUploads: false });
  })();
  check("twenty drains while NetInfo says offline: not one request attempted", link.attempts - writesBefore, unanswered);
  check("  still nothing parked as failed, no retry spent",
    outbox().filter((r) => r.status === "failed" || r.retry_count > 0), []);
  check("the server has received nothing yet",
    [await Class.countDocuments({ _id: cid }), await Quiz.countDocuments({}), await Announcement.countDocuments({})], [0, 0, 0]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- the network comes back: SyncManager.syncAll, as on reconnect ---");
  await reconnect();
  check("the outbox is empty — nothing failed, nothing in conflict, nothing pending", outbox(), []);

  console.log("\n--- #1 on the server ---");
  const cls = await Class.findById(cid).lean();
  check("the offline class exists once, with level, section and class teacher, inactive",
    [await Class.countDocuments({ schoolId: S, name: "Form 1" }), cls?.level, cls?.section, cls?.classTeacherId, cls?.classTeacherName, cls?.isActive],
    [1, "F1", "A", "tea-e2e", "Ama Owusu", false]);
  check("  its subject exists once, under it",
    [(await Subject.find({ schoolId: S, name: "Physics" }).lean()).map((s) => [String(s._id), s.classId])], [[[sid, cid]]]);
  check("the existing class carries the offline edit", (await Class.findById("cls-old").lean())?.section, "Blue");
  check("a class created and deleted offline never existed upstream", await Class.countDocuments({ _id: ghostClass }), 0);

  console.log("\n--- #3 on the server ---");
  const quizzes = await Quiz.find({ schoolId: S }).lean();
  check("one quiz — not a draft plus a duplicate — titled as edited, published",
    quizzes.map((z) => [z.title, z.is_published, z.client_id]), [["Sums", true, draft.id]]);
  const questions = await Question.find({ schoolId: S }).lean();
  check("  its one question, linked by the server's id",
    [questions.length, String(quizzes[0]?.questions?.[0]?.question_id), questions[0]?.options?.length], [1, String(questions[0]?._id), 2]);
  const localQuizId = one("SELECT id FROM quizzes WHERE title = 'Sums'")?.id;
  check("  the phone now knows the quiz by the server's id", localQuizId, String(quizzes[0]?._id));

  // A later offline edit of the synced quiz lands on it.
  net.connected = false;
  await quietly(() => quiz.updateQuiz(localQuizId, { title: "Sums, revised" }))();
  await reconnect();
  check("an offline edit of the synced quiz lands on the same quiz (still one, still published)",
    (await Quiz.find({ schoolId: S }).lean()).map((z) => [z.title, z.is_published]), [["Sums, revised", true]]);

  console.log("\n--- #4 on the server ---");
  const anns = await Announcement.find({ schoolId: S }).lean();
  check("one announcement: created with the offline edit and the pin",
    anns.map((a) => [String(a._id), a.title, a.body, a.isPinned]), [[a1.id, "Sports day", "Saturday, 9am", true]]);
  check("  the one created and deleted offline never existed upstream", await Announcement.countDocuments({ _id: a2.id }), 0);

  console.log("\n--- #5 on the server ---");
  const periods = await Period.find({ schoolId: S }).sort({ startTime: 1 }).lean();
  check("periods: P1 edited, P2 deleted, the offline one created once with its edit, P4 never",
    periods.map((p) => [p.name, p.startTime, p.endTime, !!p.deletedAt]),
    [["Registration", "08:00", "08:30", false], ["P2", "09:00", "10:00", true], ["Period 3", "10:00", "11:00", false]]);
  check("  the phone adopted the server's id for the new period, nothing dirty",
    [one("SELECT COUNT(*) AS n FROM periods WHERE id = ?", [String(periods[2]?._id)]).n, q("SELECT id FROM periods WHERE dirty = 1")], [1, []]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- and again: nothing is sent twice ---");
  const counts = async () => [
    await Class.countDocuments({}), await Subject.countDocuments({}), await Quiz.countDocuments({}),
    await Question.countDocuments({}), await Announcement.countDocuments({}), await Period.countDocuments({}),
  ];
  const before = await counts();
  const attemptsBefore = link.attempts;
  await reconnect();
  await reconnect();
  check("two more syncs: no new documents, no writes sent", [await counts(), link.attempts - attemptsBefore], [before, 0]);
  check("  the outbox is still empty", outbox(), []);

  server.close();
  await mongoose.disconnect();
  await mongo.stop().catch(() => {});

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
