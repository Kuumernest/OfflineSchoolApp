// mobile/scripts/check-offline-admin-edits.js
"use strict";

/**
 * Pupil edits, suspend / restore / move / delete, subject create and edit,
 * and teacher assignments work offline, through the outbox.
 *
 * Each of these used to call the API directly and was disabled while the
 * phone was offline ("needs internet"). Now the phone's copy changes at once,
 * the request waits in the outbox, and it is sent once on reconnect.
 *
 * The REAL services, the REAL SyncManager.syncAll the app runs on reconnect,
 * the real outbox, over a real SQLite — against a fake server that records
 * what it is sent (pattern: check-offline-p0.js). What is asserted is the
 * local state straight after the change and the wire after reconnecting.
 *
 *   1. a correction: the phone's copy at once; two corrections merged into one
 *      PATCH carrying the version it was made against (baseUpdatedAt)
 *   2. suspend, move, delete: one request each; delete hides the pupil at once
 *      and a 404 on it counts as done
 *   3. suspend then restore before sending: nothing sent
 *   4. a pupil enrolled offline, corrected, suspended and removed before any
 *      sync: nothing sent at all, nothing left behind
 *   5. a subject created offline and a teacher assigned to it offline: the
 *      subject first, the assignment naming it, under client ids, once each;
 *      a subject edited offline (one PUT), one created and edited before
 *      sending (one POST with the edit, no PUT)
 *   6. a refusal (403) parks the change as failed with the server's reason
 *      and puts the phone's copy back; the screen can say so
 *   7. a roster fetch never overwrites a pupil whose change is still queued
 *   8. the screens: no needs-internet gating left on these actions, and still
 *      present on the approved online-only list
 *
 *   node scripts/check-offline-admin-edits.js
 */

const fs   = require("fs");
const path = require("path");
const { bootPhone, quietly } = require("./offline-harness");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

(async () => {
  const S  = "school-a";
  const T0 = "2026-10-01T08:00:00.000Z";

  // ── The fake server ──────────────────────────────────────────────────────
  const sent = [];
  const refuse = new Map();      // "METHOD url" → status
  let roster = [];               // what GET /admin/students answers
  let phone = null;
  const handle = async ({ method, url, data }) => {
    const m = String(method).toUpperCase();
    if (!phone.net.connected) { const e = new Error("No internet connection"); e.isOffline = true; throw e; }
    if (m === "GET") {
      if (url === "/admin/students") return { status: 200, data: { students: roster } };
      return { status: 200, data: {} };
    }
    const body = data ?? {};
    sent.push({ method: m, url, data: body });
    const no = refuse.get(`${m} ${url}`);
    if (no) {
      const e = new Error(`Request failed with status code ${no}`);
      e.response = { status: no, data: { success: false, message: no === 403 ? "You do not have permission to manage students" : "Student not found" } };
      throw e;
    }
    const ok = (status, d) => ({ status, data: { success: true, ...d } });
    if (m === "POST" && url === "/admin/subjects")            return ok(201, { subject: { _id: body.id, ...body } });
    if (m === "POST" && url === "/admin/teacher-assignments") return ok(201, { assignment: { _id: body.id, ...body } });
    if (/^\/students\//.test(url)) return ok(200, { data: { _id: url.split("/")[2], updatedAt: new Date().toISOString() } });
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
  const { StudentService } = load("src/services/student.service");
  const subjects  = load("src/services/subject.service");
  const assigns   = load("src/services/assignment.service");
  const { enrollStudentLocally } = load("src/services/studentEnroll.service");

  const reconnect = quietly(async () => { net.connected = true; await SyncManager.syncAll({ force: true }); });
  const offline   = () => { net.connected = false; };
  const wire      = (re) => sent.filter((r) => re.test(`${r.method} ${r.url}`));
  const unsent    = () => q(`SELECT entity_key, status FROM mutation_outbox WHERE status != 'synced'`);
  const pupil     = (id) => one(`SELECT * FROM students WHERE id = ?`, [id]);
  // An action that throws is a failure, not the end of the check (offline,
  // the old direct API calls threw "No internet connection").
  const run       = (fn) => quietly(fn)().catch((err) => {
    fail++; console.log(`  FAIL an action threw: ${err?.message}`); return {};
  });

  // What the phone already holds from the server. Two siblings share their
  // guardian's email (CLAUDE.md: one guardian, many children).
  const kids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].map((id, i) => ({
    _id: id, schoolId: S, classId: "cls-a", name: `Pupil ${i + 1}`, studentName: `Pupil ${i + 1}`,
    email: i < 2 ? "parent@family.test" : `kid${i}@family.test`, status: "approved", isActive: true, updatedAt: T0,
  }));
  await run(async () => {
    await SyncManager.syncClasses([
      { _id: "cls-a", schoolId: S, name: "Form 1", isActive: true },
      { _id: "cls-b", schoolId: S, name: "Form 2", isActive: true },
    ]);
    await SyncManager.syncSubjects([{ _id: "sub-srv", schoolId: S, name: "Maths", classId: "cls-a" }]);
    await SyncManager.syncTeachers([{ _id: "tea-1", schoolId: S, name: "Ama Owusu", email: "ama@school.test", role: "teacher", isActive: true }]);
    await SyncManager.syncStudents(kids);
  });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. a correction, offline ---");
  offline();
  await run(() => StudentService.updateStudent("p1", { firstName: "Abena", lastName: "Mensah" }, { baseUpdatedAt: T0 }));
  check("the phone's copy is corrected at once",
    [pupil("p1").firstName, pupil("p1").lastName, pupil("p1").name], ["Abena", "Mensah", "Abena Mensah"]);
  check("  and the pupil shows a change on its way", (await run(() => StudentService.getPendingState("p1")))?.state, "pending");
  // The guardian's email, which a sibling already has: valid, never refused.
  await run(() => StudentService.updateStudent("p1", { guardianEmail: "parent@family.test" }, { baseUpdatedAt: "2099-01-01T00:00:00.000Z" }));
  check("a second correction is merged into the first (one outbox row)",
    unsent().filter((r) => r.entity_key === "student-edit:p1").length, 1);
  const form = await run(() => StudentService.getStudentForEdit("p1"));
  check("the correction form, offline, reads the phone's copy and the original version",
    [form.firstName, form.guardianEmail, form.updatedAt], ["Abena", "parent@family.test", T0]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. suspend, move, delete, offline ---");
  await run(() => StudentService.suspend("p2", { baseUpdatedAt: T0 }));
  check("suspended at once", [pupil("p2").status, pupil("p2").is_active], ["suspended", 0]);
  await run(() => StudentService.moveToClass("p4", "cls-b", { baseUpdatedAt: T0 }));
  check("moved at once", [pupil("p4").class_id, pupil("p4").classId], ["cls-b", "cls-b"]);
  await run(() => StudentService.delete("p5", { baseUpdatedAt: T0 }));
  const listed = (await run(() => StudentService.getStudentsLocal())).map((s) => s.id);
  check("deleted: gone from the roster at once", listed.includes("p5"), false);
  refuse.set("DELETE /students/p6", 404);
  await run(() => StudentService.delete("p6"));

  console.log("\n--- 3. suspend then restore before sending ---");
  await run(() => StudentService.suspend("p3"));
  await run(() => StudentService.restore("p3"));
  check("the pupil is active again and nothing is queued for it",
    [pupil("p3").status, unsent().filter((r) => r.entity_key.endsWith(":p3")).length], ["approved", 0]);

  console.log("\n--- 4. enrolled, corrected, suspended and removed before any sync ---");
  const ghost = (await run(() => enrollStudentLocally({ schoolId: S, classId: "cls-a", firstName: "Ghost", lastName: "Pupil", guardianEmail: "parent@family.test" }))).id ?? "no-ghost";
  await run(() => StudentService.updateStudent(ghost, { lastName: "Child" }));
  await run(() => StudentService.suspend(ghost));
  const dropped = await run(() => StudentService.delete(ghost));
  check("dropped on the phone, with every change queued for it", [dropped.dropped, pupil(ghost), unsent().filter((r) => r.entity_key.includes(ghost))], [true, null, []]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. subjects and assignments, offline ---");
  const sub = await run(() => subjects.SubjectService.create({ name: "Physics", classId: "cls-a", code: "PHY", coefficient: "3", schoolId: S }));
  const asg = await run(() => assigns.createAssignment({ teacherId: "tea-1", classId: "cls-a", subjectId: sub.id }));
  check("the assignment is on the phone at once, unsent",
    one("SELECT subject_id, _synced FROM teacher_assignments WHERE id = ?", [asg.assignment?.id ?? null]), { subject_id: sub.id, _synced: 0 });
  await run(() => subjects.SubjectService.update("sub-srv", { name: "Mathematics" }));
  check("an existing subject renamed at once", one("SELECT name, _synced FROM subjects WHERE id = 'sub-srv'"), { name: "Mathematics", _synced: 0 });
  const sub2 = await run(() => subjects.SubjectService.create({ name: "Chemsitry", classId: "cls-b", schoolId: S }));
  await run(() => subjects.SubjectService.update(sub2.id, { name: "Chemistry" }));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- 6. a refusal ---");
  refuse.set("PATCH /students/p7/suspend", 403);
  await run(() => StudentService.suspend("p7"));

  console.log("\n--- 7. a roster fetch while a change is queued ---");
  roster = kids.map((k) => ({ ...k }));      // the server's copy, before p1's correction
  net.connected = true;
  await run(() => StudentService.getStudents());
  check("the queued correction is not overwritten by the fetched roster", pupil("p1").name, "Abena Mensah");
  check("  nor the queued move", pupil("p4").class_id, "cls-b");
  offline();

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- reconnect ---");
  await reconnect();

  const edits = wire(/^PATCH \/students\/p1$/);
  check("one PATCH for p1, both corrections, made against the original version",
    edits.map((r) => [r.data.firstName, r.data.lastName, r.data.guardianEmail, r.data.baseUpdatedAt]),
    [["Abena", "Mensah", "parent@family.test", T0]]);
  check("one suspend for p2, with its base version",
    wire(/\/students\/p2/).map((r) => [r.method, r.url, r.data.baseUpdatedAt]), [["PATCH", "/students/p2/suspend", T0]]);
  check("one move for p4, to the new class",
    wire(/\/students\/p4/).map((r) => [r.method, r.url, r.data.classId]), [["PATCH", "/students/p4/move", "cls-b"]]);
  check("one DELETE for p5; the tombstone is gone after it", [wire(/\/students\/p5/).map((r) => `${r.method} ${r.url}`), pupil("p5")], [["DELETE /students/p5"], null]);
  check("a DELETE answered 404 counts as done", [wire(/\/students\/p6/).length, pupil("p6")], [1, null]);
  check("nothing at all sent for p3 (suspended and restored) or the dropped pupil",
    sent.filter((r) => r.url.includes("/p3") || r.url.includes(ghost) || JSON.stringify(r.data).includes(ghost)).length, 0);

  const subjPosts = wire(/^POST \/admin\/subjects$/);
  const asgPosts  = wire(/^POST \/admin\/teacher-assignments$/);
  check("the subject is created once, under its client id, with its coefficient",
    subjPosts.filter((r) => r.data.id === sub.id).map((r) => [r.data.name, r.data.coefficient]), [["Physics", 3]]);
  check("the assignment is created once, under its client id, naming that subject",
    asgPosts.map((r) => [r.data.id, r.data.teacherId, r.data.subjectId]), [[asg.assignment?.id, "tea-1", sub.id]]);
  check("  and after the subject (dependency order)",
    sent.findIndex((r) => r.data?.id === sub.id) < sent.findIndex((r) => r.data?.id === asg.assignment?.id), true);
  check("the existing subject: one PUT with the new name, no create",
    [wire(/^PUT \/admin\/subjects\/sub-srv$/).map((r) => r.data.name), subjPosts.some((r) => r.data.id === "sub-srv")], [["Mathematics"], false]);
  check("created and renamed before sending: one POST with the new name, no PUT",
    [subjPosts.filter((r) => r.data.id === sub2.id).map((r) => r.data.name), wire(new RegExp(`^PUT /admin/subjects/${sub2.id}$`)).length], [["Chemistry"], 0]);
  check("the subject and the assignment are clean on the phone",
    [one("SELECT _synced FROM subjects WHERE id = ?", [sub.id])._synced, one("SELECT _synced FROM teacher_assignments WHERE id = ?", [asg.assignment?.id ?? null])?._synced], [1, 1]);

  const refused = q(`SELECT status, error, last_status FROM mutation_outbox WHERE entity_key = 'student-suspend:p7'`);
  check("the refused suspend is parked as failed with the server's reason",
    refused, [{ status: "failed", error: "You do not have permission to manage students", last_status: 403 }]);
  check("  the phone shows the pupil as the school holds it again", [pupil("p7").status, pupil("p7").is_active], ["approved", 1]);
  check("  and the pupil says a change was refused", (await run(() => StudentService.getPendingState("p7")))?.state, "failed");
  check("everything else settled; only the refusal is left", unsent().map((r) => r.entity_key), ["student-suspend:p7"]);
  check("p1 is clean (no change left on its way)", await run(() => StudentService.getPendingState("p1")), null);

  const before = sent.length;
  await reconnect();
  check("a second sync sends nothing again", sent.length - before, 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n--- 8. the screens ---");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const GATE = /useNeedsInternet|NeedsInternetNote|requireOnline|needsConnection|!isOnline/;
  for (const rel of ["app/admin/students/detail.js", "app/admin/students/edit.js",
                     "app/admin/subjects/add.js", "app/admin/assignments/assign.js"]) {
    check(`${rel}: no needs-internet gating`, GATE.test(read(rel)), false);
  }
  check("these screens no longer call the API to write",
    ["app/admin/students/edit.js", "app/admin/subjects/add.js", "app/admin/assignments/assign.js"]
      .filter((rel) => /api\.(post|put|patch|delete)\(/.test(read(rel))), []);
  check("the services queue them (no direct student write calls left)",
    /api\.(patch|delete)\(/.test(read("src/services/student.service.js").split("// ── SUSPEND / RESTORE")[1].split("/** A pupil's correction history")[0]), false);
  check("assignment create no longer posts directly",
    /api\.post\(/.test(read("src/services/assignment.service.js")), false);
  const ONLINE_ONLY = {
    "settings":                  ["app/admin/settings/index.js", /needsInternetFailureText/],
    "publishing/processing results": ["app/admin/components/ResultsProcessingCard.js", /needsInternetErrorText/],
    "PDFs (report generation)":  ["app/admin/reports/generate/index.js", /needsInternetErrorText/],
    "exports":                   ["app/admin/exports/index.js", /exp\.onlineOnly/],
    "payroll":                   ["app/admin/finance/payroll.js", /payroll\.offlineRuns/],
    "new chats":                 ["app/messages/new.js", /msgMobile\.needsConnection/],
  };
  for (const [what, [rel, re]] of Object.entries(ONLINE_ONLY)) {
    check(`still online-only, and says so: ${what}`, re.test(read(rel)), true);
  }
  for (const lang of ["en", "fr"]) {
    const d = JSON.parse(read(`src/i18n/locales/${lang}.json`));
    check(`${lang}: the pending / refused strings`,
      [d.common?.notSentYet, d.studentRecord?.changePending, d.studentRecord?.changeRefused, d.studentEdit?.queuedNote]
        .every((v) => typeof v === "string" && v.trim()), true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
