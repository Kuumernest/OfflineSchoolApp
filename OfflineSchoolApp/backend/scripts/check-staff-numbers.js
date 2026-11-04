// backend/scripts/check-staff-numbers.js
"use strict";

/**
 * Every teacher has a staff number, CODE-STF-NNN, issued by the server.
 *
 *   the format, and one sequence per school
 *   twenty creates at once take twenty different numbers
 *   a replayed create returns the number it already has and takes no new one
 *   a phone's offline create (its own id, an Idempotency-Key) is numbered when
 *     it arrives, and its retry returns the same number
 *   a create that fails after taking a number leaves a gap, not a duplicate
 *   a removed teacher brought back keeps their number
 *   an administrator's override: validated, upper-cased, unique in the school
 *     (409), permission-checked, audited, never cleared, and one in the
 *     generated shape moves the sequence past it
 *   the backfill: teachers with numbers untouched, the rest numbered oldest
 *     first per school (inactive included), and a re-run changes nothing
 *   the unique index built on an existing database, and refused (backfill
 *     skipped) while duplicates exist
 *   delivered: teacher list and detail, the teacher's own profile, the login
 *     and /auth/me payloads, the phone's /sync/pull and the desktop's
 *     /sync/changes — and not to a pupil
 *
 * Real routes over HTTP, real auth, in-memory MongoDB.
 *
 *   node scripts/check-staff-numbers.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write(`  ok   ${label}\n`); }
  else { fail++; process.stdout.write(`  FAIL ${label}\n       got      ${a}\n       expected ${e}\n`); }
};
// Depth-counted, so overlapping calls (the twenty at once) restore the
// console exactly once, after the last of them.
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let quietDepth = 0;
const quiet = async (fn) => {
  if (quietDepth++ === 0) { console.log = () => {}; console.warn = () => {}; console.error = () => {}; }
  try { return await fn(); } finally {
    if (--quietDepth === 0) Object.assign(console, realConsole);
  }
};

const main = async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "check-only-refresh-secret";
  process.env.NODE_ENV = "test";
  process.env.DISABLE_LOGIN_RATE_LIMIT = "1";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri(), { dbName: "staff-numbers" });
  require("../src/db/models");
  const M = (n) => mongoose.model(n);
  const User = M("User");
  await Promise.all([User.init(), M("IdempotencyKey").init(), M("Counter").init()]);
  const { ensureStaffNoIndex, ensureStaffNumbers } = require("../src/db/ensureStaffNoIndex");
  const svc = require("../src/services/staffNumber.service");

  // No mail leaves the process.
  const emailService = require("../src/services/email.service");
  emailService.sendEmail = async () => ({ success: true });

  const express = require("express");
  const jwt     = require("jsonwebtoken");
  const auth    = require("../middleware/auth");

  const A = new mongoose.Types.ObjectId().toString();
  const B = new mongoose.Types.ObjectId().toString();
  await M("School").create([
    { _id: A, name: "Alpha", code: "GVA00", email: "a@example.test" },
    { _id: B, name: "Beta",  code: "BETA",  email: "b@example.test" },
  ]);
  const PW = "Check-only-passw0rd";
  const mk = (id, role, schoolId, extra = {}) => User.create({
    _id: id, name: `${id} name`, email: `${id}@example.test`, password: PW, role, schoolId, isActive: true, ...extra,
  });
  await mk("adm-a", "school_admin", A);
  await mk("adm-b", "school_admin", B);
  await mk("bursar-a", "bursar", A);
  await mk("pupil-a", "student", A, { enrollmentNo: "GVA00-2026-001", email: "parent@example.test" });

  const app = express();
  app.use(express.json());
  app.use("/api/auth",    require("../src/routes/auth.routes"));
  app.use("/api",         auth.authenticate, require("../middleware/idempotency"));
  app.use("/api/admin",   auth.authenticate, require("../src/routes/admin.routes"));
  app.use("/api/teacher", auth.authenticate, require("../src/routes/teacher.routes"));
  app.use("/api/sync",    require("../src/routes/sync.routes"));
  app.use(require("../middleware/errorHandler"));
  const server = app.listen(0);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout   = 121_000;
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const tokenFor = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call = async (method, url, body, { as = ["adm-a", "school_admin", A], key } = {}) => {
    const r = await fetch(`${API}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokenFor(...as)}`, "Content-Type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, body: json ?? {} };
  };
  let n = 0;
  const create = (school = A, extra = {}, opts = {}) => {
    n += 1;
    const as = school === A ? ["adm-a", "school_admin", A] : ["adm-b", "school_admin", B];
    return quiet(() => call("POST", "/admin/teachers", { name: `Teacher ${n}`, email: `t${n}@example.test`, ...extra }, { as, ...opts }));
  };
  const staffNoOf = async (id) => (await User.findById(id).select("staffNo").lean())?.staffNo ?? null;
  const counterOf = async (school, code) => (await M("Counter").findById(`staffNo:${school}:${code}`).lean())?.seq ?? 0;

  try {
    console.log("--- the index, at boot ---");
    check("built on a database that has users and no index", await quiet(() => ensureStaffNoIndex()), true);
    check("and again: a no-op", await quiet(() => ensureStaffNoIndex()), true);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- the format and the sequence ---");
    check("three digits", svc.formatStaffNo("GVA00", 1), "GVA00-STF-001");
    check("and more past 999", svc.formatStaffNo("GVA00", 1234), "GVA00-STF-1234");
    check("only this shape is read",
      ["GVA00-STF-007", "gva00-stf-12", "GVA00-2026-003", "BETA-STF-009", "GVA00-STF-", "X-GVA00-STF-1"]
        .map((v) => svc.sequenceOf(v, "GVA00")), [7, 12, null, null, null, null]);

    let r = await create(A);
    check("a teacher created on the console is numbered in the same request",
      [r.status, r.body.teacher?.staffNo], [201, "GVA00-STF-001"]);
    check("  and the number is stored", await staffNoOf(r.body.teacher?._id), "GVA00-STF-001");
    r = await create(A);
    check("the next is 002", r.body.teacher?.staffNo, "GVA00-STF-002");
    r = await create(B);
    check("another school is another sequence", r.body.teacher?.staffNo, "BETA-STF-001");
    r = await create(A);
    check("and Alpha's carries on", r.body.teacher?.staffNo, "GVA00-STF-003");

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- twenty creates at once ---");
    const many = await Promise.all(Array.from({ length: 20 }, () => create(A)));
    const nums = many.map((x) => x.body.teacher?.staffNo);
    check("all twenty created", many.map((x) => x.status).every((s) => s === 201), true);
    check("twenty different numbers", new Set(nums).size, 20);
    check("all in the shape", nums.every((v) => /^GVA00-STF-\d{3,}$/.test(v)), true);
    check("exactly 004 … 023 (no gaps when nothing failed)",
      nums.map((v) => svc.sequenceOf(v, "GVA00")).sort((a, b) => a - b),
      Array.from({ length: 20 }, (_, i) => i + 4));

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- a replayed create ---");
    const first = many[0].body.teacher;
    const before = await counterOf(A, "GVA00");
    r = await create(A, { id: first._id, name: "Renamed", email: "renamed@example.test" });
    check("answers as a replay with the number it already has",
      [r.status, r.body.replay, r.body.teacher?.staffNo], [200, true, first.staffNo]);
    check("  takes no new number", await counterOf(A, "GVA00"), before);
    check("  and the stored number is unchanged", await staffNoOf(first._id), first.staffNo);

    // A teacher from before numbers existed, replayed: still unchanged.
    await User.collection.insertOne({ _id: "legacy-replay", name: "Legacy", email: "legacy-replay@example.test",
      password: "x".repeat(60), role: "teacher", schoolId: A, isActive: true, createdAt: new Date(), updatedAt: new Date() });
    r = await create(A, { id: "legacy-replay", name: "Legacy", email: "legacy-replay@example.test" });
    check("a numberless teacher's replay changes nothing either (the backfill numbers them)",
      [r.body.replay, r.body.teacher?.staffNo ?? null, await staffNoOf("legacy-replay"), await counterOf(A, "GVA00")],
      [true, null, null, before]);
    await User.deleteOne({ _id: "legacy-replay" });

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- a phone's offline create, synced ---");
    const phoneId = "8a1f0c52-1b7e-4c3a-9d11-0000000000aa";
    r = await create(A, { id: phoneId, name: "Offline Teacher", email: "offline@example.test", role: "teacher", schoolId: A },
      { key: "phone-create-1" });
    const offlineNo = r.body.teacher?.staffNo;
    check("created under the phone's id, numbered by the server",
      [r.status, r.body.teacher?._id, /^GVA00-STF-\d{3,}$/.test(offlineNo)], [201, phoneId, true]);
    await new Promise((res) => setTimeout(res, 150));   // the key settles
    const c1 = await counterOf(A, "GVA00");
    r = await create(A, { id: phoneId, name: "Offline Teacher", email: "offline@example.test" }, { key: "phone-create-1" });
    check("the phone's retry (same key) returns the same number",
      [r.body.teacher?.staffNo ?? r.body.data?.staffNo], [offlineNo]);
    r = await create(A, { id: phoneId, name: "Offline Teacher", email: "offline@example.test" }, { key: "phone-create-2" });
    check("a second outbox entry for it (new key) is a replay with the same number",
      [r.body.replay, r.body.teacher?.staffNo], [true, offlineNo]);
    check("  neither took a number", await counterOf(A, "GVA00"), c1);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- a create that fails after taking a number ---");
    const c2 = await counterOf(A, "GVA00");
    r = await create(A, { name: "x".repeat(150) });
    check("refused (name too long)", [r.status >= 400, r.body.teacher], [true, undefined]);
    check("  the number it took is a gap", await counterOf(A, "GVA00"), c2 + 1);
    r = await create(A);
    check("  and the next teacher takes the one after: no duplicate",
      svc.sequenceOf(r.body.teacher?.staffNo, "GVA00"), c2 + 2);
    check("  nobody holds the gap", await User.countDocuments({ staffNo: svc.formatStaffNo("GVA00", c2 + 1) }), 0);

    // withStaffNo takes another number when its write meets the index.
    let tries = 0;
    const got = await svc.withStaffNo(A, async (staffNo) => {
      tries += 1;
      await User.create({ name: "Clash", email: `clash${tries}@example.test`, password: PW, role: "teacher", schoolId: A,
        staffNo: tries === 1 ? "GVA00-STF-001" : staffNo });
      return staffNo;
    });
    check("a write that meets the unique index retries with a fresh number",
      [tries, (await User.findOne({ email: "clash2@example.test" }).lean())?.staffNo === got], [2, true]);
    check("  and an E11000 on email is NOT retried",
      await svc.withStaffNo(A, async (staffNo) => {
        tries = 0;
        await User.create({ name: "Dup", email: "clash2@example.test", password: PW, role: "teacher", schoolId: A, staffNo });
      }).then(() => "created", (e) => `refused ${e.statusCode ?? e.code}`), "refused 409");

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- a removed teacher brought back ---");
    const gone = many[1].body.teacher;
    await quiet(() => call("DELETE", `/admin/teachers/${gone._id}`));
    const c3 = await counterOf(A, "GVA00");
    r = await create(A, { name: gone.name, email: gone.email });
    check("restored with the number they had", [r.body.restored, r.body.teacher?.staffNo], [true, gone.staffNo]);
    check("  and no new number taken", await counterOf(A, "GVA00"), c3);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- an administrator's override ---");
    const t = many[2].body.teacher;
    const put = (body, as) => quiet(() => call("PUT", `/admin/teachers/${t._id}`, body, as ? { as } : {}));
    for (const [label, value, want] of [
      ["empty", "", "cannot be removed"], ["null", null, "cannot be removed"], ["spaces", "   ", "cannot be removed"],
      ["too long", "A".repeat(33), "at most 32"], ["bad characters", "GVA 00#1", "only letters"],
    ]) {
      r = await put({ staffNo: value });
      check(`${label}: 400`, [r.status, String(r.body.message).includes(want)], [400, true]);
    }
    check("  and nothing changed", await staffNoOf(t._id), t.staffNo);

    r = await put({ staffNo: "  hr/2019-07 " });
    check("trimmed and upper-cased", [r.status, r.body.data?.staffNo, await staffNoOf(t._id)], [200, "HR/2019-07", "HR/2019-07"]);
    const audit = await M("AuditLog").findOne({ action: "teacher.staffNoChanged", resourceId: t._id }).lean();
    check("  audited, with before and after", [audit?.before, audit?.after, audit?.actorId],
      [{ staffNo: t.staffNo }, { staffNo: "HR/2019-07" }, "adm-a"]);

    r = await put({ staffNo: many[3].body.teacher.staffNo });
    check("another teacher's number: 409 naming who holds it",
      [r.status, r.body.code, String(r.body.message).includes(many[3].body.teacher.name)], [409, "STAFF_NO_TAKEN", true]);
    r = await put({ staffNo: "hr/2019-07" });
    check("its own number again: fine, no new audit row",
      [r.status, await M("AuditLog").countDocuments({ action: "teacher.staffNoChanged", resourceId: t._id })], [200, 1]);

    // Another school may hold the same string.
    const bTeacher = (await create(B)).body.teacher;
    r = await quiet(() => call("PUT", `/admin/teachers/${bTeacher._id}`, { staffNo: "HR/2019-07" }, { as: ["adm-b", "school_admin", B] }));
    check("the same number in another school is allowed", [r.status, r.body.data?.staffNo], [200, "HR/2019-07"]);
    r = await quiet(() => call("PUT", `/admin/teachers/${bTeacher._id}`, { staffNo: "X1" }));
    check("another school's teacher cannot be overridden from here", r.status, 404);

    r = await put({ staffNo: "X1" }, ["bursar-a", "bursar", A]);
    check("a bursar may not override", r.status, 403);
    const tTeacher = many[4].body.teacher;
    r = await put({ staffNo: "X1" }, [tTeacher._id, "teacher", A]);
    check("a teacher may not override (their own or anyone's)", r.status, 403);
    check("  still the administrator's value", await staffNoOf(t._id), "HR/2019-07");

    r = await put({ name: "Name Only", email: t.email });
    check("an edit that does not name staffNo (a phone's queued PUT) leaves it", [r.status, await staffNoOf(t._id)], [200, "HR/2019-07"]);

    r = await put({ staffNo: "gva00-stf-050" });
    check("an override in the generated shape", [r.status, await staffNoOf(t._id)], [200, "GVA00-STF-050"]);
    r = await create(A);
    check("  moves the sequence past it: the next is 051", r.body.teacher?.staffNo, "GVA00-STF-051");
    r = await put({ staffNo: "GVA00-STF-040" });
    check("an override below the sequence does not lower it", r.status, 200);
    r = await create(A);
    check("  the next is 052", r.body.teacher?.staffNo, "GVA00-STF-052");
    // Written behind the API's back (an import): still counted.
    await User.updateOne({ _id: many[5].body.teacher._id }, { $set: { staffNo: "GVA00-STF-0090" } });
    r = await create(A);
    check("a number in the shape the counter never saw is still counted: 091", r.body.teacher?.staffNo, "GVA00-STF-091");

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- the backfill ---");
    const C = new mongoose.Types.ObjectId().toString();
    const D = new mongoose.Types.ObjectId().toString();
    await M("School").create([
      { _id: C, name: "Gamma", code: "GAM", email: "c@example.test" },
      { _id: D, name: "Delta", code: "DEL", email: "d@example.test" },
    ]);
    const raw = (id, school, at, extra = {}) => User.collection.insertOne({
      _id: id, name: id, email: `${id}@example.test`, password: "x".repeat(60), role: "teacher",
      schoolId: school, isActive: true, createdAt: new Date(at), updatedAt: new Date(at), ...extra,
    });
    await raw("c-old",       C, "2020-01-01");
    await raw("c-has",       C, "2020-06-01", { staffNo: "GAM-STF-005" });
    await raw("c-inactive",  C, "2021-01-01", { isActive: false });
    await raw("c-null",      C, "2022-01-01", { staffNo: null });
    await raw("c-tie-b",     C, "2023-01-01");
    await raw("c-tie-a",     C, "2023-01-01");
    await raw("c-custom",    C, "2019-01-01", { staffNo: "OLD-77" });
    await raw("d-one",       D, "2024-01-01");
    await raw("d-two",       D, "2024-02-01", { isActive: false });
    await User.collection.insertOne({ _id: "c-bursar", name: "b", email: "cb@example.test", password: "x".repeat(60),
      role: "bursar", schoolId: C, isActive: true, createdAt: new Date("2018-01-01") });
    await User.collection.insertOne({ _id: "c-pupil", name: "p", email: "cp@example.test", password: "x".repeat(60),
      role: "student", schoolId: C, isActive: true, createdAt: new Date("2018-01-01") });
    const updatedBefore = (await User.findById("c-has").lean()).updatedAt.getTime();

    const dry = await svc.backfillStaffNumbers({ dryRun: true });
    check("a dry run counts and writes nothing",
      [dry.bySchool[C], dry.bySchool[D], await staffNoOf("c-old")], [5, 2, null]);
    const ran = await quiet(() => ensureStaffNumbers({ log: () => {}, error: () => {} }));
    check("the boot step builds/keeps the index and numbers them",
      [ran.indexed, ran.backfill?.assigned, ran.backfill?.failed], [true, 7, 0]);
    const after = {};
    for (const id of ["c-custom", "c-old", "c-has", "c-inactive", "c-null", "c-tie-a", "c-tie-b", "d-one", "d-two", "c-bursar", "c-pupil"]) {
      after[id] = await staffNoOf(id);
    }
    check("oldest first, after the highest already held (005), ties by _id; inactive included",
      after, {
        "c-custom": "OLD-77", "c-old": "GAM-STF-006", "c-has": "GAM-STF-005", "c-inactive": "GAM-STF-007",
        "c-null": "GAM-STF-008", "c-tie-a": "GAM-STF-009", "c-tie-b": "GAM-STF-010",
        "d-one": "DEL-STF-001", "d-two": "DEL-STF-002", "c-bursar": null, "c-pupil": null,
      });
    check("a teacher who had a number was not written (updatedAt unchanged)",
      (await User.findById("c-has").lean()).updatedAt.getTime(), updatedBefore);
    check("a numbered teacher's updatedAt moves (so the sync feeds carry it)",
      (await User.findById("c-old").lean()).updatedAt.getTime() > new Date("2020-01-01").getTime(), true);
    const again = await svc.backfillStaffNumbers();
    check("a re-run finds nobody and changes nothing", [again.missing, again.assigned, await staffNoOf("c-old")], [0, 0, "GAM-STF-006"]);
    check("every teacher of every school has a number now",
      await User.countDocuments({ role: "teacher", $or: [{ staffNo: null }, { staffNo: { $exists: false } }] }), 0);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- the index on an existing database with duplicates ---");
    await User.collection.dropIndex("schoolId_staffNo_unique_present");
    await User.collection.updateOne({ _id: "d-two" }, { $set: { staffNo: "DEL-STF-001" } });
    await raw("d-new", D, "2025-01-01");
    const errs = [];
    const blocked = await ensureStaffNumbers({ log: () => {}, error: (l) => errs.push(l) });
    check("not built, said loudly with the duplicates counted, and the backfill skipped",
      [blocked.indexed, blocked.backfill, errs.some((l) => l.includes("Duplicate staff numbers already stored: 1")),
       await staffNoOf("d-new")], [false, null, true, null]);
    await User.collection.updateOne({ _id: "d-two" }, { $set: { staffNo: "DEL-STF-002" } });
    const fixed = await ensureStaffNumbers({ log: () => {}, error: () => {} });
    check("once corrected: built, and the waiting teacher numbered",
      [fixed.indexed, await staffNoOf("d-new")], [true, "DEL-STF-003"]);
    const ix = (await User.collection.indexes()).find((i) => i.name === "schoolId_staffNo_unique_present");
    check("the live index is unique and partial on a string staffNo",
      [ix?.unique, ix?.partialFilterExpression], [true, { staffNo: { $type: "string" } }]);
    const { verifyDeclaredIndexes } = require("../src/services/indexCheck.service");
    const ver = await verifyDeclaredIndexes({ log: () => {} });
    check("and the boot index check agrees it is the declared one",
      ver.missing.concat(ver.incompatible).filter((m) => m.collection === "users").length, 0);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("--- delivered to every client ---");
    const known = many[6].body.teacher;
    r = await quiet(() => call("GET", "/admin/teachers"));
    check("the teacher list", r.body.teachers?.find((x) => x._id === known._id)?.staffNo, known.staffNo);
    r = await quiet(() => call("GET", `/admin/teachers/${known._id}`));
    check("one teacher", r.body.data?.staffNo, known.staffNo);

    await User.updateOne({ _id: known._id }, { $set: { mustResetPassword: false } });
    const pw = await User.findById(known._id).select("+password");
    pw.password = PW; await pw.save();
    r = await quiet(async () => {
      const res = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: known.email, password: PW }) });
      return { status: res.status, body: await res.json() };
    });
    check("the teacher's sign-in payload", [r.status, r.body.user?.staffNo], [200, known.staffNo]);
    const tTok = [known._id, "teacher", A];
    r = await quiet(() => call("GET", "/auth/me", undefined, { as: tTok }));
    check("/auth/me", r.body.user?.staffNo, known.staffNo);
    r = await quiet(() => call("GET", "/teacher/profile", undefined, { as: tTok }));
    check("the teacher's own profile", r.body.teacher?.staffNo, known.staffNo);
    r = await quiet(() => call("GET", `/sync/pull?schoolId=${A}`, undefined, { as: tTok }));
    check("the phone's /sync/pull teachers", r.body.data?.teachers?.find((x) => x._id === known._id)?.staffNo, known.staffNo);
    r = await quiet(() => call("GET", `/sync/pull?schoolId=${A}`, undefined, { as: ["pupil-a", "student", A] }));
    check("  but not to a pupil's phone",
      [r.status, (r.body.data?.teachers ?? []).length > 0, (r.body.data?.teachers ?? []).some((x) => "staffNo" in x)], [200, true, false]);
    r = await quiet(() => call("GET", "/sync/changes?collections=user"));
    check("the desktop's /sync/changes users", r.body.collections?.user?.documents?.find((x) => x._id === known._id)?.staffNo, known.staffNo);

    // The payroll export, where a staff identifier belongs on paper.
    await M("SalaryPayment").create({ schoolId: A, userId: known._id, periodMonth: "2026-10", status: "paid",
      payslipNo: "PSL-2026-10-0001", baseAmount: 100000, gross: 100000, net: 100000 });
    const { EXPORTS } = require("../src/export/exports");
    const { labelsFor } = require("../src/export/labels");
    for (const lang of ["en", "fr"]) {
      const L = labelsFor(lang);
      const sheet = (await EXPORTS.payroll.build({ schoolId: A, query: { periodMonth: "2026-10" }, L })).sheets[0];
      const col = sheet.columns.find((c) => c.label === L.staffNo);
      check(`the payroll export has a "${L.staffNo}" column with the number (${lang})`,
        col ? col.cell(sheet.rows[0]).value : "no column", known.staffNo);
    }
  } finally {
    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
};

main().catch((err) => { console.error("check failed:", err); process.exit(1); });
