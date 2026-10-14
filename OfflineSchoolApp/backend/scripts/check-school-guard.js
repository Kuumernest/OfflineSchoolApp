// backend/scripts/check-school-guard.js
"use strict";

/**
 * The missing-school guard on the exam, template, issued-card and results
 * routers (docs/39 §17.2, Phase 2e).
 *
 * Through the real routers and auth, over HTTP, on two synthetic schools:
 *
 *   1. A request that resolves to no school — a super_admin who named none,
 *      or a school account whose own schoolId is empty — is refused with 400
 *      SCHOOL_REQUIRED on every exam, template and issued-card route, and
 *      nothing is written.
 *   2. The results router keeps the super_admin's documented platform-wide
 *      read (docs/20 Info-A), and refuses a schoolless school account.
 *   3. A school's own admin and teacher work as before.
 *   4. Another school's exam, template or issued card is not read, changed
 *      or deleted by id, and naming that school is refused.
 *   5. A super_admin who names a school acts inside that school only.
 *   6. The Phase 2(d) layout routes answer exactly as before; the two
 *      school-free vocabularies stay readable without a school.
 *
 *   node scripts/check-school-guard.js
 */

const { stopQuietly } = require("./stopQuietly");

const mongoose = require("mongoose");

const main = async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require("../src/db/models");

  const express = require("express");
  const jwt     = require("jsonwebtoken");
  const auth    = require("../middleware/auth");
  const M       = (n) => mongoose.model(n);

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  // ── Two schools ─────────────────────────────────────────────────────────

  const YEAR = "2026/2027";
  const SCHOOLS = { A: new mongoose.Types.ObjectId().toString(), B: new mongoose.Types.ObjectId().toString() };
  const user = (id, role, schoolId) => M("User").create({
    _id: id, name: id, email: `${id}@example.test`, password: "check-only-password", role, schoolId, isActive: true,
  });
  await user("sup", "super_admin", null);
  // A school account with no school: corrupt or half-provisioned data, which
  // the door lets through because there is no school of theirs to be closed.
  await user("orphan", "school_admin", null);

  await M("School").createIndexes();
  for (const [k, S] of Object.entries(SCHOOLS)) {
    await M("School").create({ _id: S, name: `Synthetic School ${k}`, email: `school-${k.toLowerCase()}@example.test` });
    await user(`adm-${k}`, "school_admin", S);
    await user(`tea-${k}`, "teacher", S);
    await M("GradingConfig").create({ schoolId: S, caEnabled: false });
    await M("Class").create({ _id: `${k}-cls`, schoolId: S, name: "Form 1" });
    await M("Subject").create({ _id: `${k}-sub`, schoolId: S, name: "Maths", code: `MAT-${k}` });
    await M("Student").create({
      _id: `${k}-p1`, userId: `usr-${k}-p1`, schoolId: S, classId: `${k}-cls`, className: "Form 1",
      studentName: `Pupil ${k}`, enrollmentNo: `ENR-${k}-1`, status: "approved", isActive: true,
    });
    await M("Exam").create({
      _id: `${k}-ex1`, schoolId: S, name: `Sequence 1 ${k}`, type: "test", academicYear: YEAR, term: 1,
      sequenceNumber: 1, status: "completed", classId: `${k}-cls`, classIds: [`${k}-cls`], startDate: "2026-09-15",
    });
    await M("ExamSubject").create({
      _id: `${k}-es1`, examId: `${k}-ex1`, subjectId: `${k}-sub`, subjectName: "Maths", classId: `${k}-cls`,
      schoolId: S, maxScore: 20, passMark: 10, weight: 100, submissionStatus: "approved",
    });
    await M("StudentScore").create({
      _id: `${k}-sc1`, examId: `${k}-ex1`, examSubjectId: `${k}-es1`, studentId: `${k}-p1`, subjectId: `${k}-sub`,
      classId: `${k}-cls`, schoolId: S, maxScore: 20, score: 14,
    });
    await M("ResultSummary").create({
      _id: `${k}-sum1`, examId: `${k}-ex1`, studentId: `${k}-p1`, classId: `${k}-cls`, schoolId: S,
      average: 14, classPosition: 1, isPublished: true, subjects: [],
    });
    await M("ReportTemplate").create({
      _id: `${k}-tpl`, schoolId: S, name: `Layout ${k}`, isDefault: true, css: "",
      html: "<div>{{school_name}} — {{student_name}}</div>",
    });
    await M("GeneratedReport").create({
      _id: `${k}-gr`, schoolId: S, examId: `${k}-ex1`, studentId: `${k}-p1`, templateId: `${k}-tpl`,
      renderedHtml: `<div>card ${k}</div>`, isPublished: true,
    });
  }

  const app = express(); app.use(express.json());
  app.use("/api/exams",             auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/results",           auth.authenticate, require("../src/routes/results.routes"));
  app.use("/api/templates",         auth.authenticate, require("../src/routes/template.routes"));
  app.use("/api/generated-reports", auth.authenticate, require("../src/routes/generated.report.routes"));
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const ROLES = { adm: "school_admin", tea: "teacher" };
  const token = (who) => {
    if (who === "sup")    return jwt.sign({ id: "sup",    role: "super_admin",  schoolId: null }, process.env.JWT_SECRET, { expiresIn: "1h" });
    if (who === "orphan") return jwt.sign({ id: "orphan", role: "school_admin", schoolId: null }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const [role, k] = who.split("-");
    return jwt.sign({ id: who, role: ROLES[role], schoolId: SCHOOLS[k] }, process.env.JWT_SECRET, { expiresIn: "1h" });
  };
  const call = async (method, who, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token(who)}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json };
  };

  // Every row of every model these routers touch, so "nothing was written"
  // is checked on the data rather than inferred from the status codes.
  const MODELS = ["Exam", "ExamSubject", "StudentScore", "ResultSummary", "ReportTemplate", "GeneratedReport", "ReportTemplateVersion"];
  const snapshot = async (filter = {}) => {
    const out = {};
    for (const m of MODELS) {
      out[m] = (await M(m).find(filter).sort({ _id: 1 }).lean())
        .map(({ updatedAt, __v, ...rest }) => rest);
    }
    return JSON.stringify(out);
  };

  const REFUSED = { success: false, code: "SCHOOL_REQUIRED", error: "A school must be selected" };

  // ── Every route of the three school-only routers ────────────────────────
  //
  // Bodies are ones that would succeed for school A's admin, so a route the
  // guard missed shows up as a write, not as a validation error.
  const A = SCHOOLS.A;
  const examBody = { name: "Created without a school", academicYear: YEAR, term: 1, type: "test", classId: "A-cls" };
  const SCHOOL_ONLY = [
    ["GET",    "/exams"],
    ["GET",    "/exams/dashboard"],
    ["GET",    "/exams/stats"],
    ["GET",    "/exams/reports"],
    ["GET",    "/exams/reports/results"],
    ["GET",    "/exams/reports/submissions"],
    ["GET",    "/exams/submissions"],
    ["GET",    "/exams/submissions/results"],
    ["GET",    "/exams/submissions/submissions"],
    ["GET",    "/exams/A-ex1"],
    ["POST",   "/exams", examBody],
    ["PUT",    "/exams/A-ex1", { name: "renamed" }],
    ["PATCH",  "/exams/A-ex1/status", { status: "archived" }],
    ["DELETE", "/exams/A-ex1"],
    ["GET",    "/exams/A-ex1/subjects"],
    ["POST",   "/exams/A-ex1/subjects", { subjectId: "A-sub", classId: "A-cls", maxScore: 20 }],
    ["PUT",    "/exams/A-ex1/subjects/A-es1", { maxScore: 40 }],
    ["DELETE", "/exams/A-ex1/subjects/A-es1"],
    ["GET",    "/exams/A-ex1/scores"],
    ["POST",   "/exams/A-ex1/scores/bulk", { examSubjectId: "A-es1", scores: [{ studentId: "A-p1", score: 2 }] }],
    ["POST",   "/exams/A-ex1/process", {}],
    ["GET",    "/exams/A-ex1/results"],
    ["GET",    "/exams/A-ex1/submissions"],
    ["PATCH",  "/exams/A-ex1/subjects/A-es1/submit", {}],
    ["PATCH",  "/exams/A-ex1/subjects/A-es1/approve", {}],
    ["PATCH",  "/exams/A-ex1/subjects/A-es1/reject", { reason: "x" }],
    ["PATCH",  "/exams/A-ex1/lock", {}],
    ["PATCH",  "/exams/A-ex1/unlock", { reason: "x" }],

    ["GET",    "/templates"],
    ["GET",    "/templates/default"],
    ["POST",   "/templates/seed-default", {}],
    ["GET",    "/templates/layout"],
    ["PUT",    "/templates/layout", { sections: { results: false } }],
    ["GET",    "/templates/layout/versions"],
    ["GET",    "/templates/layout/versions/1"],
    ["GET",    "/templates/A-tpl"],
    ["POST",   "/templates", { name: "Created without a school", html: "<p>x</p>" }],
    ["PUT",    "/templates/A-tpl", { html: "<p>overwritten</p>" }],
    ["DELETE", "/templates/A-tpl"],
    ["POST",   "/templates/A-tpl/preview", { examId: "A-ex1", studentId: "A-p1" }],
    ["POST",   "/templates/A-tpl/duplicate", {}],
    ["PATCH",  "/templates/A-tpl/default", {}],
    ["GET",    "/templates/A-tpl/generated"],

    ["POST",   "/generated-reports", { examId: "A-ex1", studentId: "A-p1", renderedHtml: "<p>overwritten</p>" }],
    ["GET",    "/generated-reports"],
    ["GET",    "/generated-reports/A-gr"],
    ["PUT",    "/generated-reports/A-gr", { isPublished: false }],
    ["DELETE", "/generated-reports/A-gr"],
    ["GET",    "/generated-reports/student/A-p1"],
    ["GET",    "/generated-reports/exam/A-ex1"],
  ];

  // The results router: everything a schoolless school account could reach.
  const RESULTS = [
    ["GET",    "/results/my-results"],
    ["GET",    "/results/A-ex1"],
    ["GET",    "/results/A-ex1/stats"],
    ["GET",    "/results/A-ex1/rankings"],
    ["GET",    "/results/A-ex1/student/A-p1"],
    ["GET",    "/results/A-ex1/history"],
    ["GET",    "/results/A-ex1/student/A-p1/reportcard"],
    ["GET",    "/results/A-ex1/student/A-p1/reportcard/html"],
    ["POST",   "/results/A-ex1/student/A-p1/reportcard/calculate", { subjects: [{ subjectId: "A-sub", score: 2 }] }],
    ["POST",   "/results/A-ex1/student/A-p1/reportcard/reissue", {}],
    ["POST",   "/results/score", { examId: "A-ex1", studentId: "A-p1", subjectId: "A-sub", score: 2 }],
    ["PUT",    "/results/summary/A-sum1/publish", { isPublished: false }],
    ["DELETE", "/results/score/A-sc1"],
  ];

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 1. no school: every exam, template and issued-card route refuses ---");
  {
    const before = await snapshot();
    for (const who of ["sup", "orphan"]) {
      for (const [method, url, body] of SCHOOL_ONLY) {
        const r = await call(method, who, url, body);
        check(`${who} ${method} ${url} → 400 SCHOOL_REQUIRED`, [r.status, r.body], [400, REFUSED]);
      }
    }
    check("nothing was written by any refused request", await snapshot() === before, true);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 2. results: a schoolless account refused; the super_admin's Info-A read kept ---");
  {
    const before = await snapshot();
    for (const [method, url, body] of RESULTS) {
      const r = await call(method, "orphan", url, body);
      check(`orphan ${method} ${url} → 400 SCHOOL_REQUIRED`, [r.status, r.body], [400, REFUSED]);
    }
    check("nothing was written by the schoolless account", await snapshot() === before, true);

    let r = await call("GET", "sup", "/results/A-ex1/student/A-p1");
    check("super_admin naming no school reads a pupil's result, scoped by the exam's school (Info-A)",
      [r.status, r.body?.data?.summary?._id], [200, "A-sum1"]);
    r = await call("GET", "sup", "/results/A-ex1/rankings");
    check("  and the exam's rankings", r.status, 200);
    r = await call("GET", "adm-A", "/results/A-ex1/student/A-p1");
    check("school A's admin reads A's pupil", r.status, 200);
    r = await call("GET", "adm-A", "/results/B-ex1/student/B-p1");
    check("school A's admin reading B's pupil by id → 404", r.status, 404);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 3. a school's own staff: workflows unchanged ---");
  {
    let r = await call("GET", "adm-A", "/exams");
    check("admin lists only A's exams", [r.status, (r.body?.exams ?? []).map((e) => e._id)], [200, ["A-ex1"]]);
    r = await call("GET", "tea-A", "/exams");
    check("teacher lists exams", r.status, 200);
    r = await call("GET", "adm-A", "/exams/A-ex1");
    check("admin reads A's exam", r.status, 200);
    r = await call("GET", "adm-A", "/exams/A-ex1/subjects");
    check("admin reads A's papers", r.status, 200);
    r = await call("GET", "adm-A", "/exams/A-ex1/scores");
    check("admin reads A's mark sheet", r.status, 200);
    r = await call("POST", "adm-A", "/exams", { ...examBody, _id: "A-ex2", name: "Sequence 2 A" });
    check("admin creates an exam in A", [r.status, (await M("Exam").findById("A-ex2").lean())?.schoolId], [201, A]);
    r = await call("PUT", "adm-A", "/exams/A-ex2", { name: "Sequence 2 A (renamed)" });
    check("admin renames it", [r.status, (await M("Exam").findById("A-ex2").lean())?.name], [200, "Sequence 2 A (renamed)"]);

    r = await call("GET", "adm-A", "/templates");
    check("admin lists only A's templates", [r.status, (r.body?.templates ?? []).map((t) => t._id)], [200, ["A-tpl"]]);
    r = await call("GET", "adm-A", "/templates/A-tpl");
    check("admin reads A's template", r.status, 200);
    r = await call("POST", "adm-A", "/templates/A-tpl/duplicate", { _id: "A-tpl-copy" });
    check("admin duplicates it in A", [r.status, (await M("ReportTemplate").findById("A-tpl-copy").lean())?.schoolId], [201, A]);
    r = await call("GET", "adm-A", "/templates/A-tpl/generated");
    check("admin lists the cards issued from it", [r.status, (r.body?.reports ?? []).map((g) => g._id)], [200, ["A-gr"]]);

    r = await call("GET", "adm-A", "/generated-reports");
    check("admin lists only A's issued cards", [r.status, (r.body?.reports ?? []).map((g) => g._id)], [200, ["A-gr"]]);
    r = await call("GET", "tea-A", "/generated-reports/A-gr");
    check("teacher reads an issued card", r.status, 200);
    r = await call("PUT", "adm-A", "/generated-reports/A-gr", { isPublished: true });
    check("admin updates A's issued card", [r.status, r.body?.report?.isPublished], [200, true]);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 4. another school's records, by id or by name ---");
  {
    const bBefore = await snapshot({ schoolId: SCHOOLS.B });
    const BY_ID = [
      ["GET",    "/exams/B-ex1", undefined, 404],
      ["PUT",    "/exams/B-ex1", { name: "taken over" }, 404],
      ["PATCH",  "/exams/B-ex1/status", { status: "archived" }, 404],
      ["DELETE", "/exams/B-ex1", undefined, 404],
      ["POST",   "/exams/B-ex1/process", {}, 404],
      ["GET",    "/templates/B-tpl", undefined, 404],
      ["PUT",    "/templates/B-tpl", { html: "<p>taken over</p>" }, 404],
      ["DELETE", "/templates/B-tpl", undefined, 404],
      ["POST",   "/templates/B-tpl/duplicate", {}, 404],
      ["PATCH",  "/templates/B-tpl/default", {}, 404],
      ["GET",    "/generated-reports/B-gr", undefined, 404],
      ["PUT",    "/generated-reports/B-gr", { isPublished: false }, 404],
      ["DELETE", "/generated-reports/B-gr", undefined, 404],
    ];
    for (const [method, url, body, status] of BY_ID) {
      const r = await call(method, "adm-A", url, body);
      check(`A's admin ${method} ${url} → ${status}`, r.status, status);
    }
    let r = await call("GET", "adm-A", "/exams/B-ex1/subjects");
    check("A's admin listing B's papers sees none of them", [r.status, r.body?.subjects], [200, []]);
    r = await call("GET", "adm-A", "/generated-reports/student/B-p1");
    check("A's admin listing B's pupil's cards sees none", r.body?.count, 0);
    r = await call("GET", "adm-A", "/generated-reports/exam/B-ex1");
    check("A's admin listing B's exam's cards sees none", r.body?.count, 0);

    for (const [method, url, body] of [
      ["GET",  `/exams?schoolId=${SCHOOLS.B}`],
      ["GET",  `/templates?schoolId=${SCHOOLS.B}`],
      ["GET",  `/generated-reports?schoolId=${SCHOOLS.B}`],
      ["POST", "/exams", { ...examBody, schoolId: SCHOOLS.B }],
    ]) {
      r = await call(method, "adm-A", url, body);
      check(`A's admin naming school B: ${method} ${url} → 403`, [r.status, r.body?.code], [403, "SCHOOL_ACCESS_DENIED"]);
    }
    check("school B's rows are exactly as they were", await snapshot({ schoolId: SCHOOLS.B }) === bBefore, true);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 5. a super_admin who names a school acts inside it ---");
  {
    const bBefore = await snapshot({ schoolId: SCHOOLS.B });
    let r = await call("GET", "sup", `/exams?schoolId=${A}`);
    check("lists A's exams only", [r.status, (r.body?.exams ?? []).map((e) => e._id).sort()], [200, ["A-ex1", "A-ex2"]]);
    r = await call("GET", "sup", `/templates?schoolId=${A}`);
    check("lists A's templates only", [r.status, (r.body?.templates ?? []).map((t) => t._id).sort()], [200, ["A-tpl", "A-tpl-copy"]]);
    r = await call("GET", "sup", `/generated-reports?schoolId=${A}`);
    check("lists A's issued cards only", [r.status, (r.body?.reports ?? []).map((g) => g._id)], [200, ["A-gr"]]);
    r = await call("GET", "sup", `/generated-reports/B-gr?schoolId=${A}`);
    check("naming A, B's issued card by id → 404", r.status, 404);
    r = await call("PUT", "sup", "/exams/B-ex1", { schoolId: A, name: "taken over" });
    check("naming A, B's exam by id → 404", r.status, 404);
    r = await call("DELETE", "sup", `/templates/B-tpl?schoolId=${A}`);
    check("naming A, B's template by id → 404", r.status, 404);
    r = await call("GET", "sup", `/exams?schoolId=${new mongoose.Types.ObjectId()}`);
    check("naming a school that does not exist → 404", [r.status, r.body?.code], [404, "SCHOOL_NOT_FOUND"]);
    r = await call("GET", "sup", `/exams/B-ex1?schoolId=${SCHOOLS.B}`);
    check("naming B, B's exam", r.status, 200);
    check("school B's rows are exactly as they were", await snapshot({ schoolId: SCHOOLS.B }) === bBefore, true);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- 6. Phase 2(d) layout routes and the school-free vocabularies ---");
  {
    let r = await call("GET", "sup", "/templates/sections");
    check("sections listed without a school", [r.status, (r.body?.sections ?? []).length > 0], [200, true]);
    r = await call("GET", "sup", "/templates/tokens");
    check("tokens listed without a school", [r.status, r.body?.success], [200, true]);
    r = await call("GET", "adm-A", "/templates/layout");
    check("A's layout: the default, version 0", [r.status, r.body?.layout?.version, r.body?.layout?.source], [200, 0, "default"]);
    r = await call("PUT", "adm-A", "/templates/layout", { sections: { conduct: false } });
    check("A changes its layout → 201, version 1", [r.status, r.body?.layout?.version], [201, 1]);
    r = await call("PUT", "adm-A", "/templates/layout", { sections: { conduct: false }, schoolId: SCHOOLS.B });
    check("A writing B's layout → 403", r.status, 403);
    r = await call("GET", "sup", `/templates/layout?schoolId=${SCHOOLS.B}`);
    check("B's layout untouched", [r.status, r.body?.layout?.version], [200, 0]);
    r = await call("GET", "tea-A", "/templates/layout");
    check("a teacher is still 403 on the template router", r.status, 403);
  }

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);

  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
