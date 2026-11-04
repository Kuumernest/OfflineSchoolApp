// mobile/scripts/check-pupil-sync.js
"use strict";

/**
 * Pupils and the sync flag: a pulled pupil is synced, a pupil with an unsent
 * change is never written over by a pull, and an admin phone sends an
 * admission decision only for one made on it.
 *
 * Before: syncStudents wrote pupils without `_synced`, the column's default
 * is 0, so every pulled pupil read as unsent. The student-decision sweep took
 * status 'approved' + dirty as "approved offline" and an admin phone PUT
 * /admin/students/:id/approve for every pupil it had ever pulled (200 "already
 * approved"; for a pupil with no class, 400 "classId is required" — parked as
 * needing attention). And because the flag meant nothing, pupils had no pull
 * protection: an offline correction or suspension was written over by a pull
 * that had left the server before it.
 *
 * The REAL services, SyncManager and outbox over node:sqlite
 * (offline-harness.js), against a fake server that records what it is sent:
 *
 *   1. pulled pupils are written synced; an admin sync sends no approve
 *   2. a phone an older build left behind (pulled pupils at 0, a parked
 *      stray 400, offline decisions from before the marker, an unsent
 *      enrolment, a queued suspension) is repaired: no approve for a pulled
 *      pupil, the stray is gone, each genuine change is sent once
 *   3. a genuine offline approve and reject are sent once, then settle
 *   4. an offline correction and suspension survive a pull carrying an older
 *      server copy (and a server removal), then land; the next pull refreshes
 *   5. a pupil removed on the server leaves a clean local roster
 *   6. a teacher's phone keeps only its classes' pupils (taught or form
 *      class), keeps one with an unsent change, and touches nothing on an
 *      admin phone or with no assignments stored
 *
 *   node scripts/check-pupil-sync.js
 */

const { bootPhone, quietly } = require("./offline-harness");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

const S = "school-p";
const pupil = (id, extra = {}) => ({
  _id: id, id, schoolId: S, classId: "cls-1", name: `Pupil ${id}`, studentName: `Pupil ${id}`,
  status: "approved", isActive: true, updatedAt: "2026-11-01T00:00:00.000Z", ...extra,
});

/** A phone and a fake server recording each write. */
const makePhone = async (user) => {
  const sent = [];
  let phone = null;
  const handle = async ({ method, url, data }) => {
    const m = String(method).toUpperCase();
    if (!phone.net.connected) { const e = new Error("No internet connection"); e.isOffline = true; throw e; }
    if (m === "GET") return { status: 200, data: {} };
    const body = data ?? {};
    sent.push({ method: m, url, data: body });
    // The real route's order: a missing class is refused before anything.
    if (m === "PUT" && /\/approve$/.test(url) && !body.classId) {
      const e = new Error("Request failed with status code 400");
      e.response = { status: 400, data: { success: false, message: "classId is required" } };
      throw e;
    }
    if (m === "POST" && url === "/students") return { status: 201, data: { success: true, student: { _id: body.id, enrollmentNo: "ENR-9" } } };
    return { status: 200, data: { success: true, data: { updatedAt: "2026-11-04T12:00:00.000Z" } } };
  };
  const api = {
    request: handle,
    get:    (url, cfg = {}) => handle({ method: "GET", url, ...cfg }),
    post:   (url, data) => handle({ method: "POST", url, data }),
    put:    (url, data) => handle({ method: "PUT", url, data }),
    patch:  (url, data) => handle({ method: "PATCH", url, data }),
    delete: (url) => handle({ method: "DELETE", url }),
  };
  phone = await quietly(bootPhone)({ api, user });
  return { ...phone, sent };
};

const admin = { _id: "adm-1", id: "adm-1", role: "school_admin", schoolId: S, name: "Head" };

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1. pulled pupils are synced; an admin sync sends no approve ---");
  {
    const p = await makePhone(admin);
    const { SyncManager, load, q } = p;
    // The column as the applications code adds it on a real phone.
    await quietly(() => load("src/services/studentApplications.service").StudentApplicationsService.getEnrollmentNo("x"))();
    await p.db.execAsync("ALTER TABLE students ADD COLUMN _synced INTEGER DEFAULT 0").catch(() => {});
    await quietly(() => SyncManager.migrateStudentEnrollColumns())();
    await quietly(() => SyncManager.syncStudents([pupil("a1"), pupil("a2"), pupil("a3", { classId: null })]))();
    check("each pulled pupil is written synced",
      q("SELECT id, _synced FROM students ORDER BY id"), [{ id: "a1", _synced: 1 }, { id: "a2", _synced: 1 }, { id: "a3", _synced: 1 }]);
    await quietly(() => SyncManager.syncAll({ force: true }))();
    check("an admin sync sends nothing for them (no approve)", p.sent.map((r) => `${r.method} ${r.url}`), []);
    check("  and the outbox stays empty", q("SELECT entity_key FROM mutation_outbox"), []);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 2. an install the old pull left behind is repaired ---");
  {
    const p = await makePhone(admin);
    const { SyncManager, load, q, one, net, raw } = p;
    // The table as an older build had it: the flag column (DEFAULT 0), the
    // enrolment and review columns — and no decision marker.
    for (const [c, d] of [["_synced", "INTEGER DEFAULT 0"], ["_operation", "TEXT"], ["reviewed_at", "TEXT"],
                          ["approved_at", "TEXT"], ["rejected_at", "TEXT"], ["rejection_reason", "TEXT"]]) {
      try { raw.exec(`ALTER TABLE students ADD COLUMN ${c} ${d}`); } catch { /* there */ }
    }
    check("(the old table has no decision marker)",
      q("PRAGMA table_info(students)").some((c) => c.name === "_local_decision"), false);
    const ins = raw.prepare(`INSERT INTO students (id, schoolId, classId, class_id, name, status, is_active, _synced,
      _operation, reviewed_at, approved_at, rejected_at, rejection_reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, '2026-11-01')`);
    // Pulled by the old code: no flag written, so 0.
    for (const id of ["old1", "old2", "old3"]) ins.run(id, S, "cls-1", "cls-1", id, "approved", null, null, null, null, null);
    ins.run("nocls", S, null, null, "No Class", "approved", null, null, null, null, null);
    // Decided offline by an older build: the review stamps, no marker.
    ins.run("legacy-ok", S, "cls-1", "cls-1", "Legacy Ok", "approved", null, "2026-11-02", "2026-11-02", null, null);
    ins.run("legacy-no", S, null, null, "Legacy No", "rejected", null, "2026-11-02", null, "2026-11-02", "incomplete");
    // Enrolled here, never sent.
    ins.run("local-new", S, "cls-1", "cls-1", "Local New", "approved", "create", null, null, null, null);
    // The stray the old sweep parked for the class-less pupil.
    await quietly(() => load("src/services/mutationQueue.service").MutationQueue.getStats())();
    raw.prepare(`INSERT INTO mutation_outbox (id, entity_key, method, endpoint, payload, status, retry_count, created_at, error, last_status, owner_id)
      VALUES ('stray', 'student-decision:nocls', 'PUT', '/admin/students/nocls/approve', ?, 'failed', 0, '2026-11-02', 'classId is required', 400, 'adm-1')`)
      .run(JSON.stringify({ classId: null, __reconcile: { kind: "studentDecision", localId: "nocls", table: "students" } }));
    // A suspension queued offline by this build, waiting.
    net.connected = false;
    await quietly(() => load("src/services/student.service").StudentService.suspend("old3"))();
    net.connected = true;

    await quietly(() => SyncManager.syncAll({ force: true }))();
    const wire = p.sent.map((r) => `${r.method} ${r.url}`).sort();
    check("only the genuine changes went out, each once", wire, [
      "PATCH /students/old3/suspend",
      "POST /students",
      "PUT /admin/students/legacy-no/reject",
      "PUT /admin/students/legacy-ok/approve",
    ]);
    check("  the legacy approval carried its class", p.sent.find((r) => r.url.endsWith("legacy-ok/approve"))?.data?.classId, "cls-1");
    check("the parked stray 400 is gone", one("SELECT COUNT(*) AS n FROM mutation_outbox WHERE id = 'stray'").n, 0);
    check("nothing waits or needs attention", q("SELECT entity_key FROM mutation_outbox WHERE status != 'synced'"), []);
    check("every pupil is clean, no marker left",
      q("SELECT id, _synced, _local_decision FROM students WHERE _synced != 1 OR _synced IS NULL OR _local_decision IS NOT NULL"), []);
    const before = p.sent.length;
    await quietly(() => SyncManager.syncAll({ force: true }))();
    check("a second sync sends nothing", p.sent.slice(before).map((r) => `${r.method} ${r.url}`), []);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 3. a genuine offline approve / reject is sent once ---");
  {
    const p = await makePhone(admin);
    const { SyncManager, load, q, one, net } = p;
    const apps = load("src/services/studentApplications.service").StudentApplicationsService;
    await quietly(() => SyncManager.syncClasses([{ _id: "cls-1", schoolId: S, name: "Form 1", isActive: true }]))();
    await quietly(() => SyncManager.migrateStudentEnrollColumns())();
    // Two applications on the phone (as the applications list caches them).
    await quietly(() => apps.getEnrollmentNo("x"))();
    for (const id of ["app-yes", "app-no"]) {
      await p.db.runAsync(`INSERT INTO students (id, schoolId, name, status, is_active, _synced) VALUES (?, ?, ?, 'pending', 1, 1)`, [id, S, id]);
    }
    net.connected = false;
    await quietly(() => apps.approveApplication("app-yes", "cls-1"))();
    await quietly(() => apps.rejectApplication("app-no", "duplicate"))();
    check("offline: the decisions are marked as made here",
      q("SELECT id, status, _synced, _local_decision FROM students ORDER BY id"),
      [{ id: "app-no", status: "rejected", _synced: 0, _local_decision: "rejected" },
       { id: "app-yes", status: "approved", _synced: 0, _local_decision: "approved" }]);
    // A pull carrying the application as the server still has it lands first.
    await quietly(() => SyncManager.syncStudents([pupil("app-yes", { status: "pending", classId: null })]))();
    check("  a pull does not undo the offline approval",
      one("SELECT status, class_id FROM students WHERE id = 'app-yes'"), { status: "approved", class_id: "cls-1" });
    net.connected = true;
    await quietly(() => SyncManager.syncAll({ force: true }))();
    await quietly(() => SyncManager.syncAll({ force: true }))();
    check("each decision went once",
      p.sent.map((r) => `${r.method} ${r.url} ${r.data.classId ?? ""}${r.data.reason ?? ""}`).sort(),
      ["PUT /admin/students/app-no/reject duplicate", "PUT /admin/students/app-yes/approve cls-1"]);
    check("  and both rows settled",
      q("SELECT id, _synced, _local_decision FROM students ORDER BY id"),
      [{ id: "app-no", _synced: 1, _local_decision: null }, { id: "app-yes", _synced: 1, _local_decision: null }]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 4. an offline correction / suspension survives an older pull ---");
  {
    const p = await makePhone(admin);
    const { SyncManager, load, one, net } = p;
    const svc = load("src/services/student.service").StudentService;
    await quietly(() => SyncManager.migrateStudentEnrollColumns())();
    await quietly(() => SyncManager.syncStudents([pupil("ed"), pupil("su"), pupil("gone")]))();
    net.connected = false;
    await quietly(() => svc.updateStudent("ed", { lastName: "Mensah-Corrected", firstName: "Ama" }))();
    await quietly(() => svc.suspend("su"))();
    await quietly(() => svc.updateStudent("gone", { firstName: "Kept" }))();
    // The pull that left the server before those changes lands after them.
    await quietly(() => SyncManager.syncStudents([
      pupil("ed", { name: "Ama Mensah" }), pupil("su"),
      { _id: "gone", id: "gone", schoolId: S, deletedAt: "2026-11-04T09:00:00.000Z" },
    ]))();
    check("the correction is kept", one("SELECT name, _synced FROM students WHERE id = 'ed'"), { name: "Ama Mensah-Corrected", _synced: 0 });
    check("the suspension is kept", one("SELECT status, is_active FROM students WHERE id = 'su'"), { status: "suspended", is_active: 0 });
    check("a server removal waits for the unsent change", one("SELECT deleted_at FROM students WHERE id = 'gone'").deleted_at, null);
    net.connected = true;
    await quietly(() => SyncManager.syncAll({ force: true }))();
    check("then they land, once each",
      p.sent.map((r) => `${r.method} ${r.url}`).sort(),
      ["PATCH /students/ed", "PATCH /students/gone", "PATCH /students/su/suspend"]);
    check("  the correction carried the new surname", p.sent.find((r) => r.url === "/students/ed")?.data?.lastName, "Mensah-Corrected");
    check("  the rows are clean", one("SELECT COUNT(*) AS n FROM students WHERE _synced != 1").n, 0);
    await quietly(() => SyncManager.syncStudents([
      pupil("ed", { name: "Ama Mensah-Corrected", updatedAt: "2026-11-04T13:00:00.000Z" }),
      { _id: "gone", id: "gone", schoolId: S, deletedAt: "2026-11-04T09:00:00.000Z" },
    ]))();
    check("the next pull refreshes them, the removal applies",
      [one("SELECT updated_at FROM students WHERE id = 'ed'").updated_at, !!one("SELECT deleted_at FROM students WHERE id = 'gone'").deleted_at],
      ["2026-11-04T13:00:00.000Z", true]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 5. a pupil removed on the server leaves a clean roster ---");
  {
    const p = await makePhone(admin);
    const { SyncManager, load, one } = p;
    await quietly(() => SyncManager.syncStudents([pupil("r1"), pupil("r2")]))();
    await quietly(() => SyncManager.syncStudents([{ _id: "r1", id: "r1", schoolId: S, deletedAt: "2026-11-04T10:00:00.000Z" }]))();
    check("the removed pupil is gone", one("SELECT deleted_at, is_active FROM students WHERE id = 'r1'"), { deleted_at: "2026-11-04T10:00:00.000Z", is_active: 0 });
    const roster = await quietly(() => load("src/services/student.service").StudentService.getStudentsLocal())();
    const ids = (roster?.students ?? roster?.data ?? roster ?? []).map((s) => String(s.id ?? s._id));
    check("  and not on the roster", [ids.includes("r1"), ids.includes("r2")], [false, true]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 6. a teacher's phone keeps only its own classes' pupils ---");
  const ME = "tea-me";
  const loadSchool = async (p, { assignments = true } = {}) => {
    const { SyncManager } = p;
    await quietly(() => SyncManager.migrateStudentEnrollColumns())();
    await quietly(() => SyncManager.syncClasses([
      { _id: "c-taught", schoolId: S, name: "Taught", isActive: true },
      { _id: "c-form",   schoolId: S, name: "Form",   isActive: true, classTeacherId: ME },
      { _id: "c-off",    schoolId: S, name: "Switched off", isActive: true },
      { _id: "c-other",  schoolId: S, name: "Other",  isActive: true },
    ]))();
    if (assignments) {
      await quietly(() => SyncManager.syncAssignments([
        { _id: "as-1", schoolId: S, teacher: ME, class: "c-taught", subject: "sub-1" },
        { _id: "as-2", schoolId: S, teacher: ME, class: "c-off", subject: "sub-2", isActive: false },
        { _id: "as-3", schoolId: S, teacher: "tea-x", class: "c-other", subject: "sub-3" },
      ]))();
    }
    await quietly(() => SyncManager.syncStudents([
      pupil("in-taught", { classId: "c-taught" }), pupil("in-form", { classId: "c-form" }),
      pupil("in-off", { classId: "c-off" }), pupil("in-other", { classId: "c-other" }),
      pupil("in-other-unsent", { classId: "c-other" }), pupil("no-class", { classId: null }),
    ]))();
    await p.db.runAsync("UPDATE students SET _synced = 0, _operation = 'create' WHERE id = 'in-other-unsent'");
  };
  const left = (p) => p.q("SELECT id FROM students ORDER BY id").map((r) => r.id);
  {
    const p = await makePhone({ _id: ME, id: ME, role: "teacher", schoolId: S, name: "Teacher" });
    await loadSchool(p);
    const removed = await quietly(() => p.SyncManager.purgeOutOfScopePupils())();
    check("taught and form class kept, others removed, the unsent one kept",
      [removed, left(p)], [3, ["in-form", "in-other-unsent", "in-taught"]]);
    check("the purge runs after the pull", /await this\.purgeOutOfScopePupils\(\)/.test(
      require("fs").readFileSync(require("path").join(__dirname, "../src/services/syncManager.js"), "utf8")), true);
  }
  {
    const p = await makePhone({ _id: ME, id: ME, role: "teacher", schoolId: S, name: "Teacher" });
    await loadSchool(p, { assignments: false });
    const removed = await quietly(() => p.SyncManager.purgeOutOfScopePupils())();
    check("no assignments stored yet: nothing removed", [removed, left(p).length], [0, 6]);
  }
  {
    const p = await makePhone(admin);
    await loadSchool(p);
    const removed = await quietly(() => p.SyncManager.purgeOutOfScopePupils())();
    check("an admin phone: nothing removed", [removed, left(p).length], [0, 6]);
  }
  {
    const p = await makePhone({ _id: "bur", id: "bur", role: "bursar", schoolId: S, name: "Bursar" });
    await loadSchool(p);
    const removed = await quietly(() => p.SyncManager.purgeOutOfScopePupils())();
    check("a bursar phone: nothing removed", [removed, left(p).length], [0, 6]);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
