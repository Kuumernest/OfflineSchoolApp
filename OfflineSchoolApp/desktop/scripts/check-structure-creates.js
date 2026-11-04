// desktop/scripts/check-structure-creates.js
"use strict";

/**
 * Creating a class, a subject and a teacher assignment with no connection.
 *
 * ── What is pinned ────────────────────────────────────────────────────────
 *
 *   a create naming its id is answered   or the office cannot add a class,
 *     here, shown and queued together      subject or assignment offline
 *   one outbox row, carrying the id      or the server makes a row under an
 *                                         id this machine has never heard of
 *   the same create sent again answers   or a retry whose answer was lost is
 *     the row already made, queued once    refused, or queued twice
 *   a create with no id goes out         the server mints the id then, and a
 *                                         local row under a guessed one is an
 *                                         orphan
 *   the server's refusals stay its own   name taken, wrong school, no
 *                                         permission, unknown class/teacher
 *   the replay settles each once         or a lost answer becomes two classes
 *
 * The web sends the id (web/src/lib/clientId.ts); before it did, every one of
 * these creates declined and went to a network that was not there.
 *
 * Against a real temp node:sqlite store, the real outbox and sync engine, and
 * a real HTTP server that holds rows under the id it is given, as
 * backend/src/routes/admin.routes.js does.
 *
 *   node scripts/check-structure-creates.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const http = require("http");

const store      = require("../src/main/db/store");
const { outbox } = require("../src/main/db/outbox");
const { client } = require("../src/main/sync/client");
const { engine } = require("../src/main/sync/engine");
const api        = require("../src/main/api");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const dir  = fs.mkdtempSync(path.join(os.tmpdir(), "school-structure-"));
const file = path.join(dir, "school.db");
const cleanup = () => {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (err) { console.log(`  (could not remove ${dir}: ${err.code})`); }
};

// ─────────────────────────────────────────────────────────────────────────────
// The three endpoints, reduced to their id contract
// ─────────────────────────────────────────────────────────────────────────────

const fakeServer = () => {
  const st = { down: false, loseNextResponse: false, rows: { class: [], subject: [], assignment: [] }, posts: [] };
  const KEY = { "/api/admin/classes": ["class", "class"], "/api/admin/subjects": ["subject", "subject"],
    "/api/admin/assignments": ["assignment", "assignment"] };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (st.down) { req.socket.destroy(); return; }
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const p = new URL(req.url, "http://localhost").pathname;
      if (p === "/api/sync/changes") return send(200, { success: true, collections: {}, refused: [] });
      const kind = KEY[p];
      if (!kind || req.method !== "POST") return send(404, { success: false });
      const body = raw ? JSON.parse(raw) : {};
      const list = st.rows[kind[0]];
      // admin.routes.js: a known id is answered with the row it names.
      const already = body.id && list.find((r) => r._id === body.id);
      st.posts.push({ path: p, id: body.id ?? null, deduplicated: Boolean(already) });
      if (already) return send(200, { success: true, [kind[1]]: already, serverId: already._id, clientId: body.id, deduplicated: true });
      const row = { _id: body.id ?? `server-${list.length + 1}`, ...body };
      list.push(row);
      if (st.loseNextResponse) { st.loseNextResponse = false; req.socket.destroy(); return; }
      return send(201, { success: true, [kind[1]]: row, serverId: row._id, clientId: body.id ?? null });
    });
  });
  return { st, server };
};

// ─────────────────────────────────────────────────────────────────────────────

const main = async () => {
  const { st, server } = fakeServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const db    = store.open(file);
  const docs  = store.documents(db);
  const queue = outbox(db);
  const state = store.state(db);
  const meta  = store.meta(db);

  const net = client({ meta });
  net.setServerUrl(base);
  net.setToken("token-admin");

  // What a pull would have brought: a teacher here, and another school's rows.
  docs.put("user",  { _id: "t1", schoolId: "s1", role: "teacher", isActive: true, name: "Mme Abena" });
  docs.put("user",  { _id: "t9", schoolId: "s2", role: "teacher", isActive: true, name: "Elsewhere" });
  docs.put("class", { _id: "cX", schoolId: "s2", name: "Other school", isActive: true, deletedAt: null });

  const ALL = ["classes.manage", "subjects.manage", "teachers.manage"];
  const ctxFor = (session) => ({ docs, meta, queue, state, session });
  const admin = ctxFor({ userId: "admin-1", schoolId: "s1", role: "admin", permissions: ALL });
  const call  = (ctx, method, p, body) => api.handle({ method, path: p, query: {}, body }, ctx);
  const rowsFor = (p) => queue.all().filter((r) => r.path === p);

  st.down = true;

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a class ---");

  check("with no id it goes to the network, as before",
    call(admin, "POST", "/api/admin/classes", { name: "Form 1", schoolId: "s1" }), null);

  const K1 = "0b6c1a52-3f1e-4c55-9a7e-1d2c3b4a5f60";
  const cls = call(admin, "POST", "/api/admin/classes",
    { id: K1, name: "Form 1", level: "F1", section: "A", schoolId: "s1", classTeacherId: "t1" });
  check("with an id it is answered here, created", [cls?.status, cls?.queued, cls?.data?.success], [201, true, true]);
  check("under that id, with the form master's name",
    [cls?.data?.class?._id, cls?.data?.serverId, cls?.data?.class?.classTeacherName], [K1, K1, "Mme Abena"]);
  check("the local row is there, pending", [docs.get("class", K1)?.name, docs.get("class", K1)?._pending], ["Form 1", true]);
  const classRows = rowsFor("/api/admin/classes");
  check("exactly one outbox row", classRows.length, 1);
  check("the real POST, carrying the id, under this account",
    [classRows[0]?.method, JSON.parse(classRows[0]?.body ?? "{}").id, classRows[0]?.doc_id, classRows[0]?.user_id],
    ["POST", K1, K1, "admin-1"]);

  const again = call(admin, "POST", "/api/admin/classes",
    { id: K1, name: "Form 1", level: "F1", section: "A", schoolId: "s1", classTeacherId: "t1" });
  check("the same create again answers the class already made",
    [again?.status, again?.data?.class?._id, again?.data?.deduplicated], [200, K1, true]);
  check("and queues nothing more", rowsFor("/api/admin/classes").length, 1);

  check("another id with the same name (any case) is the server's 409",
    call(admin, "POST", "/api/admin/classes", { id: "k-other", name: "FORM 1", schoolId: "s1" }), null);
  check("another school's id is not answered",
    call(admin, "POST", "/api/admin/classes", { id: "cX", name: "Form 1", schoolId: "s1" }), null);
  check("a form master this machine cannot see goes to the server",
    call(admin, "POST", "/api/admin/classes", { id: "k-t9", name: "Form 2", schoolId: "s1", classTeacherId: "t9" }), null);
  check("a body naming another school is declined",
    call(admin, "POST", "/api/admin/classes", { id: "k-s2", name: "Form 3", schoolId: "s2" }), null);
  check("without classes.manage it is declined",
    call(ctxFor({ userId: "u", schoolId: "s1", permissions: [] }), "POST", "/api/admin/classes", { id: "k-np", name: "Form 4" }), null);
  check("signed out, nothing is answered",
    call(ctxFor(null), "POST", "/api/admin/classes", { id: "k-so", name: "Form 5", schoolId: "s1" }), null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- a subject in it ---");

  const K2 = "6f1d2e3c-4b5a-4968-8776-655443322110";
  check("with no id it goes to the network",
    call(admin, "POST", "/api/admin/subjects", { name: "Maths", classId: K1, schoolId: "s1" }), null);
  const sub = call(admin, "POST", "/api/admin/subjects",
    { id: K2, name: "Maths", code: "MTH", classId: K1, coefficient: 3, schoolId: "s1" });
  check("with an id it is answered here, in the class made offline",
    [sub?.status, sub?.queued, sub?.data?.subject?._id, sub?.data?.subject?.classId, sub?.data?.subject?.coefficient],
    [201, true, K2, K1, 3]);
  check("exactly one outbox row, carrying the id",
    rowsFor("/api/admin/subjects").map((r) => [JSON.parse(r.body).id, r.doc_id]), [[K2, K2]]);
  const subAgain = call(admin, "POST", "/api/admin/subjects",
    { id: K2, name: "Maths", code: "MTH", classId: K1, coefficient: 3, schoolId: "s1" });
  check("the same create again answers the subject already made, queued once",
    [subAgain?.status, subAgain?.data?.deduplicated, rowsFor("/api/admin/subjects").length], [200, true, 1]);
  check("the same name in the same class is the server's 409",
    call(admin, "POST", "/api/admin/subjects", { id: "s-dup", name: "maths", classId: K1, schoolId: "s1" }), null);
  check("a class this school does not have is the server's to refuse",
    call(admin, "POST", "/api/admin/subjects", { id: "s-x", name: "Maths", classId: "cX", schoolId: "s1" }), null);
  check("a coefficient out of range is the server's 400",
    call(admin, "POST", "/api/admin/subjects", { id: "s-c", name: "Art", classId: K1, coefficient: 50, schoolId: "s1" }), null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the teacher assigned to it ---");

  const K3 = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
  const asg = { teacherId: "t1", classId: K1, subjectId: K2, schoolId: "s1" };
  check("with no id it goes to the network",
    call(admin, "POST", "/api/admin/assignments", asg), null);
  const made = call(admin, "POST", "/api/admin/assignments", { ...asg, id: K3 });
  check("with an id it is answered here",
    [made?.status, made?.queued, made?.data?.assignment?._id, made?.data?.assignment?.teacherId], [201, true, K3, "t1"]);
  check("exactly one outbox row, carrying the id, on the screen's path",
    rowsFor("/api/admin/assignments").map((r) => [JSON.parse(r.body).id, r.doc_id]), [[K3, K3]]);
  const asgAgain = call(admin, "POST", "/api/admin/assignments", { ...asg, id: K3 });
  check("the same create again answers the assignment already made, queued once",
    [asgAgain?.status, asgAgain?.data?.deduplicated, rowsFor("/api/admin/assignments").length], [200, true, 1]);
  check("the same teacher, class and subject under another id is the server's 409",
    call(admin, "POST", "/api/admin/assignments", { ...asg, id: "a-dup" }), null);
  check("the other path the server registers answers too, and refuses the same duplicate",
    call(admin, "POST", "/api/admin/teacher-assignments", { ...asg, id: "a-dup2" }), null);
  check("another school's teacher is not assigned here",
    call(admin, "POST", "/api/admin/assignments", { ...asg, teacherId: "t9", id: "a-t9" }), null);
  check("the bulk create stays online-only (the server mints those ids)",
    call(admin, "POST", "/api/admin/assignments/bulk", { teacherId: "t1", assignments: [{ classId: K1, subjectId: K2 }] }), null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- back online: each is created once, under its id ---");

  st.down = false;
  st.loseNextResponse = true;   // the class lands, its answer does not come back
  const eng = engine({ docs, queue, state, client: net, feedCollections: ["student"], currentUser: () => "admin-1" });
  await eng.cycle();
  check("the class POST arrived, and is still queued", [st.posts.map((p) => p.id), queue.all().length], [[K1], 3]);

  db.prepare("UPDATE outbox SET next_try_at = ?").run(new Date(Date.now() - 1000).toISOString());
  await eng.cycle();
  check("the replay is recognised, then subject and assignment go once",
    st.posts.map((p) => [p.path.split("/").pop(), p.id, p.deduplicated]),
    [["classes", K1, false], ["classes", K1, true], ["subjects", K2, false], ["assignments", K3, false]]);
  check("the server holds each once, under the client's id",
    [st.rows.class.map((r) => r._id), st.rows.subject.map((r) => r._id), st.rows.assignment.map((r) => r._id)],
    [[K1], [K2], [K3]]);
  check("the queue is empty", queue.all().length, 0);
  check("the local rows are settled",
    [docs.get("class", K1)?._pending, docs.get("subject", K2)?._pending, docs.get("teacherAssignment", K3)?._pending],
    [false, false, false]);

  await eng.cycle();
  check("another cycle sends nothing more", st.posts.length, 4);

  // A retry arriving after the first had already gone: answered the same way,
  // and its one request is answered by the server's replay, not a second row.
  st.down = true;
  const late = call(admin, "POST", "/api/admin/classes", { id: K1, name: "Form 1", schoolId: "s1" });
  check("a late retry still answers the class, without the local flag",
    [late?.status, late?.data?.deduplicated, "_pending" in (late?.data?.class ?? {})], [200, true, false]);
  st.down = false;
  await eng.cycle();
  check("and settles as a replay, the server still holding one",
    [st.posts[st.posts.length - 1]?.deduplicated, st.rows.class.length, queue.all().length, docs.get("class", K1)?._pending],
    [true, 1, 0, false]);

  server.close();
  db.close();
};

main()
  .catch((err) => { fail++; console.log(`  FAIL threw: ${err.stack}`); })
  .finally(() => {
    cleanup();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
