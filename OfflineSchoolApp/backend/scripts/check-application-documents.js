// backend/scripts/check-application-documents.js
"use strict";

/**
 * An applicant's documents are read by the school that received them, and by
 * nobody else — and the public application form tells a stranger nothing.
 *
 * docs/20-authorization-audit.md X17: the files under uploads/applications
 * used to be served to anyone holding the URL, and the record handed every
 * client the path on disk. Now /uploads/applications answers 404 to all, and
 * the one door — GET /api/students/applications/:id/documents/:key — opens
 * for a signed-in students.admit / students.viewFull holder of the same
 * school, or for a link minted in the answer to such a read (bound to the
 * application and the file, one hour). Another school, another role, a key
 * the application does not list, a traversal: one uniform 404.
 *
 * X22: a duplicate application answers exactly as a new one, so the form
 * cannot be used to learn whether a child is at the school. X23: an anonymous
 * caller never sees an exception's text.
 *
 *   node scripts/check-application-documents.js
 */

const { stopQuietly } = require("./stopQuietly");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");
const fs       = require("fs");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const LEAK = /Cast to|ValidationError|mongo|Mongoose|at path|E11000|TypeError|is not a function|\.js:\d|node_modules|\\uploads|\/uploads\/applications\//i;

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";
  process.env.DISABLE_LOGIN_RATE_LIMIT = "1";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const School             = mongoose.model("School");
  const User               = mongoose.model("User");
  const Class              = mongoose.model("Class");
  const Student            = mongoose.model("Student");
  const StudentApplication = mongoose.model("StudentApplication");
  const applicationDocuments = require(path.join(SRC, "utils/applicationDocuments"));

  const A = "68c0000000000000000000a1";
  const B = "68c0000000000000000000b2";
  await School.create([
    { _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test", applicationsOpen: true },
    { _id: B, name: "Beta College",  code: "BETA",  email: "beta@example.test",  applicationsOpen: true },
  ]);
  const PASSWORD = "Check-only-passw0rd";
  const mkUser = (id, role, schoolId, extra = {}) => User.create({
    _id: id, name: id, email: `${id}@example.test`, password: PASSWORD, role, schoolId, isActive: true, ...extra,
  });
  await Promise.all([
    mkUser("admin-a",   "school_admin", A),
    mkUser("admin-b",   "school_admin", B),
    mkUser("bursar-a",  "bursar",       A),
    mkUser("teacher-a", "teacher",      A),
    mkUser("pupil-a",   "student",      A, { enrollmentNo: "A-0001" }),
    mkUser("root",      "super_admin",  null),
  ]);
  await Class.create([
    { _id: "form3a", schoolId: A, name: "Form 3A" },
    { _id: "form1b", schoolId: B, name: "Form 1B" },
  ]);

  // ── The files, where the upload handler puts them ──────────────────────────
  const DIR = applicationDocuments.APPLICATIONS_DIR;
  fs.mkdirSync(DIR, { recursive: true });
  const files = {
    "check-doc-a.pdf": Buffer.from("%PDF-1.4 alpha birth certificate"),
    "check-doc-b.pdf": Buffer.from("%PDF-1.4 beta id scan"),
    "check-doc-s.jpg": Buffer.from("\xff\xd8\xff alpha pupil photo of a report card"),
  };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(DIR, name), bytes);
  const cleanupFiles = () => { for (const name of Object.keys(files)) { try { fs.unlinkSync(path.join(DIR, name)); } catch {} } };

  await StudentApplication.create([
    {
      _id: "app-a", schoolId: A, studentName: "Alpha Applicant", email: "parent-a@example.test",
      guardianName: "Parent A", phone: "+237600000001", classId: "form3a", status: "pending",
      documents: [{ title: "Birth certificate", filename: "check-doc-a.pdf", path: path.join(DIR, "check-doc-a.pdf"),
                    url: "/uploads/applications/check-doc-a.pdf", type: "birth_certificate", mimeType: "application/pdf", size: 32 }],
    },
    {
      _id: "app-b", schoolId: B, studentName: "Beta Applicant", email: "parent-b@example.test",
      guardianName: "Parent B", phone: "+237600000002", classId: "form1b", status: "pending",
      documents: [{ title: "ID scan", filename: "check-doc-b.pdf", url: "/uploads/applications/check-doc-b.pdf", mimeType: "application/pdf" }],
    },
    {
      _id: "app-a-enrolled", schoolId: A, studentName: "Enrolled Child", email: "parent-e@example.test",
      guardianName: "Parent E", phone: "+237600000003", classId: "form3a", status: "approved",
    },
  ]);
  await Student.create([
    { _id: "st-a1", userId: "pupil-a", schoolId: A, classId: "form3a", studentName: "Pupil One", email: "pupil-one@example.test",
      enrollmentNo: "A-0001", isActive: true, status: "approved",
      documents: [{ title: "Report card", url: "/uploads/applications/check-doc-s.jpg", type: "report_card", mimeType: "image/jpeg" }] },
  ]);

  // ── Mounted as server.js mounts them ───────────────────────────────────────
  const auth = require(path.join(ROOT, "middleware", "auth"));
  const optionalAuthenticate = (req, res, next) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith("Bearer ")) { req.user = null; return next(); }
    return auth.authenticate(req, res, next);
  };
  const studentRoutes = require(path.join(SRC, "routes/students.routes"));
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/uploads/applications", applicationDocuments.blockPublicApplicationsPath);
  app.use("/uploads", express.static(path.join(SRC, "uploads"), { index: false }));
  app.use("/api",          require(path.join(SRC, "routes/public.routes")));
  app.use("/api/students", optionalAuthenticate, studentRoutes);
  app.use("/api/student",  auth.authenticate,    studentRoutes);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, { token, body, raw = false } = {}) => {
    const res = await fetch(url.startsWith("http") ? url : `${ORIGIN}${url}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (raw) return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };
  const sign = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const as = (id, role, schoolId) => {
    const token = sign(id, role, schoolId);
    return {
      get:    (url, o = {}) => call("GET",  url, { token, ...o }),
      post:   (url, body)   => call("POST", url, { token, body }),
    };
  };
  const adminA   = as("admin-a",   "school_admin", A);
  const adminB   = as("admin-b",   "school_admin", B);
  const bursarA  = as("bursar-a",  "bursar",       A);
  const teacherA = as("teacher-a", "teacher",      A);
  const pupilA   = as("pupil-a",   "student",      A);
  const root     = as("root",      "super_admin",  null);
  const anon     = { get: (url, o = {}) => call("GET", url, o), post: (url, body) => call("POST", url, { body }) };

  const DOC_A = "/api/students/applications/app-a/documents/check-doc-a.pdf";
  const hasNoPaths = (docs) => (docs ?? []).every((d) => d.path === undefined && d.filename === undefined);

  try {
    // ═════════════════════════════════════════════════════════════════════════
    console.log("\n--- X17: the upload directory is closed to the public ---");
    let r = await anon.get("/uploads/applications/check-doc-a.pdf", { raw: true });
    check("the raw upload URL → 404", r.status, 404);
    check("  and the file bytes did not leave", r.bytes.includes("birth certificate"), false);

    console.log("\n--- X17: what an authorised read hands out ---");
    r = await adminA.get(`/api/students/pending?schoolId=${A}`);
    const pendingA = (r.body?.students ?? r.body?.data ?? []).find((s) => s._id === "app-a" || s.id === "app-a");
    check("the school's admin lists the application", [r.status, Boolean(pendingA)], [200, true]);
    const presented = pendingA?.documents?.[0];
    check("  the document carries title, type and a link — no path, no filename", [presented?.title, hasNoPaths(pendingA?.documents), typeof presented?.url], ["Birth certificate", true, "string"]);
    const signedUrl = presented?.url || "";
    check("  the link is absolute, points at the API door and is signed", [signedUrl.startsWith(`${ORIGIN}/api/students/applications/app-a/documents/`), /[?&]sig=\d+\.[0-9a-f]{32}/.test(signedUrl)], [true, true]);
    check("  no document in the whole listing carries a path", (r.body?.students ?? r.body?.data ?? []).every((s) => hasNoPaths(s.documents)), true);

    console.log("\n--- X17: the signed link opens the file, and only that file ---");
    r = await anon.get(signedUrl, { raw: true });
    check("the minted link, with no token → 200, the PDF", [r.status, r.headers.get("content-type"), r.bytes.equals(files["check-doc-a.pdf"])], [200, "application/pdf", true]);
    check("  private, not cached, not sniffed", [r.headers.get("cache-control"), r.headers.get("x-content-type-options")], ["private, no-store", "nosniff"]);
    r = await anon.get(signedUrl.replace(/sig=\d+\./, (m) => m).replace(/[0-9a-f]{32}$/, "0".repeat(32)), { raw: true });
    check("a tampered signature → 401", r.status, 401);
    r = await anon.get(signedUrl.replace("app-a/documents/check-doc-a.pdf", "app-b/documents/check-doc-b.pdf"), { raw: true });
    check("the same signature on another application's file → 401", r.status, 401);
    r = await anon.get(signedUrl.replace("app-a/documents/check-doc-a.pdf", "app-a/documents/check-doc-b.pdf"), { raw: true });
    check("  or on another file under the same application → 401", r.status, 401);
    r = await anon.get(DOC_A, { raw: true });
    check("the door with no signature and no token → 401", r.status, 401);
    check("  and no bytes", r.bytes.includes("birth certificate"), false);

    console.log("\n--- X17: a signed-in caller, by school and role ---");
    r = await adminA.get(DOC_A, { raw: true });
    check("the school's admin, with a token → 200", [r.status, r.bytes.equals(files["check-doc-a.pdf"])], [200, true]);
    r = await adminB.get(DOC_A, { raw: true });
    check("another school's admin → 404, not 403", r.status, 404);
    r = await adminB.get(`${DOC_A}?schoolId=${A}`, { raw: true });
    check("  naming Alpha as their school → refused at the door", r.status, 403);
    r = await teacherA.get(DOC_A, { raw: true });
    check("a teacher of the school → 403", r.status, 403);
    r = await bursarA.get(DOC_A, { raw: true });
    check("the bursar (students.view only) → 403", r.status, 403);
    r = await pupilA.get(DOC_A, { raw: true });
    check("a pupil → 403", r.status, 403);
    r = await root.get(`${DOC_A}?schoolId=${A}`, { raw: true });
    check("the super admin, naming the school → 200", r.status, 200);
    r = await root.get(`/api/students/applications/app-b/documents/check-doc-b.pdf?schoolId=${A}`, { raw: true });
    check("  naming Alpha but asking for Beta's application → 404", r.status, 404);

    console.log("\n--- X17: a key is a claim the application must back ---");
    r = await adminA.get("/api/students/applications/app-a/documents/check-doc-b.pdf", { raw: true });
    check("a file that exists but belongs to another application → 404", r.status, 404);
    r = await adminA.get("/api/students/applications/app-b/documents/check-doc-b.pdf", { raw: true });
    check("another school's application by id → 404", r.status, 404);
    r = await adminA.get("/api/students/applications/no-such-app/documents/check-doc-a.pdf", { raw: true });
    check("an application that does not exist → 404", r.status, 404);
    r = await adminA.get("/api/students/applications/app-a/documents/..%2F..%2Fserver.js", { raw: true });
    check("a traversal in the key → 404", r.status, 404);
    r = await adminA.get("/api/students/applications/app-a/documents/%2e%2e%2f%2e%2e%2fpackage.json", { raw: true });
    check("  however encoded → 404", r.status, 404);

    console.log("\n--- X17: a pupil's record that came from an application ---");
    r = await adminA.get("/api/students/st-a1");
    const stDoc = r.body?.student?.documents?.[0];
    check("the record's documents are presented the same way", [r.status, hasNoPaths(r.body?.student?.documents), typeof stDoc?.url], [200, true, "string"]);
    r = await anon.get(stDoc?.url || "/nowhere", { raw: true });
    check("  and its link opens the file", [r.status, r.headers.get("content-type")], [200, "image/jpeg"]);
    r = await bursarA.get("/api/students/st-a1");
    check("the bursar's roster projection carries no documents at all", r.body?.student?.documents, undefined);

    // ═════════════════════════════════════════════════════════════════════════
    console.log("\n--- X22: the public form answers a duplicate as it answers a new application ---");
    const applyBody = { name: "New Child", guardianName: "P", guardianPhone: "+237611111111", email: "new-child@example.test", schoolId: A, classId: "form3a" };
    const first  = await anon.post("/api/students/apply", applyBody);
    const second = await anon.post("/api/students/apply", applyBody);
    check("students /apply: first and second submission → same status and message", [first.status, second.status, first.body?.message === second.body?.message], [201, 201, true]);
    check("  the pending application keeps its id", second.body?.data?.id, first.body?.data?.id);
    check("  and only one record exists", await Student.countDocuments({ schoolId: A, studentName: "New Child" }), 1);
    const enrolled = await anon.post("/api/students/apply", { ...applyBody, name: "Pupil One", email: "pupil-one@example.test" });
    check("an already-enrolled child → the same 201 and message", [enrolled.status, enrolled.body?.message === first.body?.message], [201, true]);
    check("  no 'already enrolled' wording", /already|enrolled|exists/i.test(JSON.stringify(enrolled.body)), false);
    r = await anon.get(`/api/students/application-status/${enrolled.body?.data?.id}?schoolId=${A}`);
    check("  and the id it carries resolves to nothing", r.status, 404);

    const pubBody = { studentName: "Public Child", guardianName: "Q", email: "public-child@example.test", phone: "+237622222222", schoolId: A, classId: "form3a" };
    const p1 = await anon.post("/api/public/students/apply", pubBody);
    const p2 = await anon.post("/api/public/students/apply", pubBody);
    check("public /apply: first and second submission → same status and message", [p1.status, p2.status, p1.body?.message === p2.body?.message], [201, 201, true]);
    check("  no 'already', no detail code", [/already|under review|enrolled/i.test(JSON.stringify(p2.body)), p2.body?.detail ?? null], [false, null]);
    check("  the pending application keeps its id", p2.body?.applicationId, p1.body?.applicationId);
    const pe = await anon.post("/api/public/students/apply", { ...pubBody, studentName: "Enrolled Child", email: "parent-e@example.test" });
    check("an enrolled child through the public form → the same 201 and message", [pe.status, pe.body?.message === p1.body?.message], [201, true]);
    check("  with an id that is not the enrolled application's", pe.body?.applicationId === "app-a-enrolled", false);

    // ═════════════════════════════════════════════════════════════════════════
    console.log("\n--- X23: an anonymous caller never reads an exception ---");
    r = await anon.get("/api/public/schools/not-an-object-id");
    check("a malformed school id → 404 with a plain message", [r.status, LEAK.test(JSON.stringify(r.body))], [404, false]);
    r = await anon.get("/api/public/schools?page=abc&limit=zz");
    check("garbage paging → 200", r.status, 200);
    r = await anon.post("/api/public/students/apply", { ...pubBody, classId: { $gt: "" } });
    check("an operator where a class id belongs → an error that names no internals", [r.status >= 400, LEAK.test(JSON.stringify(r.body))], [true, false]);
    r = await anon.post("/api/public/students/apply", { ...pubBody, schoolId: "not-a-school-id" });
    check("a school id that cannot cast → no cast error text", [r.status >= 400, LEAK.test(JSON.stringify(r.body))], [true, false]);
    r = await anon.post("/api/public/students/apply", { ...pubBody, files: "not-an-array" });
    check("files that are not a list → no internals", LEAK.test(JSON.stringify(r.body)), false);
  } finally {
    cleanupFiles();
  }

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);

  server.close();
  server.closeAllConnections?.();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
