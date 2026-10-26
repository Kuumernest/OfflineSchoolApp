// backend/scripts/check-report-layout.js
"use strict";

/**
 * School report-card layouts: which sections each school's cards print
 * (docs/39 §10, Phase 2d).
 *
 * Through the real routers and auth, over HTTP, on synthetic schools:
 *
 *   1. Two schools, two different layouts, two different cards.
 *   2. A school can switch academic results off and keep everything else.
 *   3. A layout is presentation only: no result, score, rank, decision or
 *      intelligence input moves when a section is switched or a card printed.
 *   4. A section switched back on prints again when its data exists.
 *   5. Unknown section ids and malformed bodies are refused; so are
 *      unauthorised callers, and a super_admin who named no school.
 *   6. Cross-school: a layout, a version or a template of another school is
 *      never read, written or attached.
 *   7. A change is a new version; earlier versions stay exactly as they were.
 *   8. An issued card reprints with the layout it was issued with; a reissue
 *      takes the current one.
 *   9. A card issued before layouts existed reprints with every section.
 *  10. With no layout the built-in card is what it was (the byte-for-byte
 *      comparison is the unit check at the end; the academic pipeline is
 *      pinned by check:academic).
 *  +   Token templates: the shipped default gates every section; a school's
 *      own template that does not is reported, never silently ignored.
 *
 *   node scripts/check-report-layout.js
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

  const termGrading = require("../src/services/termGrading.service");
  const academicHistory = require("../src/services/intelligence/academicHistory.service");
  const { SECTION_IDS } = require("../../shared/reportSections");
  const { DEFAULT_TEMPLATE_HTML, DEFAULT_TEMPLATE_CSS } = require("../src/print/defaultReportTemplate");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  // ── Two schools, the same data in each ──────────────────────────────────

  const YEAR = "2026/2027";
  // ObjectId-shaped, as School._id is: the super_admin's school lookup and the
  // reissue's letterhead read the School document by it.
  const SCHOOLS = { A: new mongoose.Types.ObjectId().toString(), B: new mongoose.Types.ObjectId().toString() };
  const user = (id, role, schoolId) => M("User").create({
    _id: id, name: id, email: `${id}@example.test`, password: "check-only-password", role, schoolId, isActive: true,
  });
  await M("User").create({ _id: "sup", name: "sup", email: "sup@example.test", password: "check-only-password", role: "super_admin", schoolId: null, isActive: true });

  for (const [k, S] of Object.entries(SCHOOLS)) {
    // Its own email: School.email is unique, and two schools without one
    // collide on null once Mongoose has built that index — which it does
    // lazily, so whether they collided depended on timing.
    await M("School").createIndexes();
    await M("School").create({ _id: S, name: `Synthetic School ${k}`, email: `school-${k.toLowerCase()}@example.test` });
    await user(`adm-${k}`, "school_admin", S);
    await user(`tea-${k}`, "teacher", S);
    await user(`bur-${k}`, "bursar", S);
    await M("AcademicStructure").create({ schoolId: S, academicYear: YEAR });
    await M("GradingConfig").create({ schoolId: S, caEnabled: false });
    await M("Class").create({ _id: `${k}-cls`, schoolId: S, name: "Form 1" });
    for (const p of ["p1", "p2", "p3"]) {
      await M("Student").create({
        _id: `${k}-${p}`, userId: `usr-${k}-${p}`, schoolId: S, classId: `${k}-cls`, className: "Form 1",
        studentName: `Pupil ${k}${p}`, enrollmentNo: `ENR-${k}-${p}`, status: "approved", isActive: true,
      });
    }
    await M("Exam").create({
      _id: `${k}-ex1`, schoolId: S, name: "Sequence 1", type: "test", academicYear: YEAR, term: 1,
      sequenceNumber: 1, status: "completed", classId: `${k}-cls`, classIds: [`${k}-cls`], startDate: "2026-09-15",
    });
    for (const [sub, w] of [["sub-math", 200], ["sub-eng", 100]]) {
      const es = await M("ExamSubject").create({
        examId: `${k}-ex1`, subjectId: sub, subjectName: sub, classId: `${k}-cls`, schoolId: S,
        maxScore: 20, passMark: 10, weight: w, submissionStatus: "approved",
      });
      for (const [p, score] of [["p1", 15], ["p2", 11], ["p3", 8]]) {
        await M("StudentScore").create({
          examId: `${k}-ex1`, examSubjectId: es._id, studentId: `${k}-${p}`, subjectId: sub,
          classId: `${k}-cls`, schoolId: S, maxScore: 20, score,
        });
      }
    }
  }

  const app = express(); app.use(express.json());
  app.use("/api/exams",        auth.authenticate, require("../src/routes/exam.routes"));
  app.use("/api/results",      auth.authenticate, require("../src/routes/results.routes"));
  app.use("/api/term-results", auth.authenticate, require("../src/routes/termResults.routes"));
  app.use("/api/templates",    auth.authenticate, require("../src/routes/template.routes"));
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const ROLES = { adm: "school_admin", tea: "teacher", bur: "bursar" };
  const token = (who) => {
    if (who === "sup") return jwt.sign({ id: "sup", role: "super_admin", schoolId: null }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const [role, k] = who.split("-");
    return jwt.sign({ id: who, role: ROLES[role], schoolId: SCHOOLS[k] }, process.env.JWT_SECRET, { expiresIn: "1h" });
  };
  const call = async (method, who, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token(who)}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json, text, headers: r.headers };
  };
  const putLayout = (who, sections, extra = {}) => call("PUT", who, "/templates/layout", { sections, ...extra });
  const seqCard = async (who, k, p = "p1", query = "") => {
    const r = await call("GET", who, `/results/${k}-ex1/student/${k}-${p}/reportcard/html${query}`);
    return { status: r.status, html: r.body?.data?.html ?? "", data: r.body?.data ?? null };
  };
  const termCard = (who, k, p = "p1") =>
    call("GET", who, `/term-results/${k}-${p}/report-card?academicYear=${encodeURIComponent(YEAR)}&term=1&classId=${k}-cls`);

  // Markers of each built-in block (reportHtml.service renderReportCardHtml).
  const MARK = {
    header: '<header class="report-header">', studentInfo: '<div class="info-grid">', results: "<table>",
    performance: "Student Performance", classProfile: "Class Profile", conduct: "Behaviour",
    remarks: '<div class="remarks">', verification: '<div class="verify">', footer: '<div class="footer">',
  };
  const shows = (html) => Object.fromEntries(Object.entries(MARK).map(([id, m]) => [id, html.includes(m)]));

  // Results for both schools, through the live route, then published.
  for (const k of ["A", "B"]) {
    check(`school ${k}: processed`, (await call("POST", `adm-${k}`, `/exams/${k}-ex1/process`, {})).status, 200);
  }

  // ── 5. Validation and authorisation ─────────────────────────────────────

  console.log("--- validation and authorisation ---");
  {
    const bad = async (label, body, code) => {
      const r = await call("PUT", "adm-A", "/templates/layout", body);
      check(`${label} → 400 ${code}`, [r.status, r.body?.code], [400, code]);
    };
    await bad("an unknown section", { sections: { grades: false } }, "UNKNOWN_SECTION");
    await bad("a known and an unknown section", { sections: { results: false, stamp: true } }, "UNKNOWN_SECTION");
    await bad("a non-boolean value", { sections: { results: "no" } }, "INVALID_SECTION_VALUE");
    await bad("a numeric value", { sections: { results: 0 } }, "INVALID_SECTION_VALUE");
    await bad("sections as an array", { sections: ["results"] }, "INVALID_SECTIONS");
    await bad("sections missing", {}, "INVALID_SECTIONS");
    await bad("sections empty", { sections: {} }, "INVALID_SECTIONS");
    await bad("an extra top-level field", { sections: { results: false }, layout: "x" }, "UNKNOWN_FIELD");
    check("nothing was stored by any refused request", await M("ReportTemplateVersion").countDocuments({}), 0);

    for (const who of ["tea-A", "bur-A"]) {
      check(`${who} cannot change the layout`, (await putLayout(who, { results: false })).status, 403);
      check(`${who} cannot read it`, (await call("GET", who, "/templates/layout")).status, 403);
    }
    const noSchool = await call("GET", "sup", "/templates/layout");
    check("super_admin with no school selected → 400, not every school", [noSchool.status, noSchool.body?.code], [400, "SCHOOL_REQUIRED"]);
    check("super_admin with no school cannot write either",
      [(await putLayout("sup", { results: false })).status, await M("ReportTemplateVersion").countDocuments({})], [400, 0]);
    check("the section catalogue lists exactly the supported ids",
      (await call("GET", "adm-A", "/templates/sections")).body?.sections?.map((s) => s.id), [...SECTION_IDS]);
  }

  // ── Before anything is configured: the default ──────────────────────────

  console.log("--- the default ---");
  const dflt = await call("GET", "adm-A", "/templates/layout");
  check("no layout configured → every section, version 0, source default",
    [dflt.body?.layout?.version, dflt.body?.layout?.source, Object.values(dflt.body?.layout?.sections || {}).every(Boolean)],
    [0, "default", true]);
  check("an unconfigured school's card prints every block", shows((await seqCard("adm-A", "A", "p2")).html),
    Object.fromEntries(Object.keys(MARK).map((id) => [id, true])));

  // Snapshot every stored academic figure, and the intelligence layer's input,
  // before any layout is changed — compared again at the end (3).
  const snapshotAcademic = async () => {
    const strip = (rows) => rows.map((r) => JSON.stringify(r)).sort();
    const history = await academicHistory.publishedHistory({ schoolId: SCHOOLS.A, withSubjects: true });
    return {
      summaries: strip(await M("ResultSummary").find({}).lean()),
      scores:    strip(await M("StudentScore").find({}).lean()),
      terms:     strip(await M("TermResult").find({}).lean()),
      grading:   strip(await M("GradingConfig").find({}).lean()),
      history:   JSON.stringify([...history.entries()]),
    };
  };

  // Publish, compute the term, then take the snapshot.
  for (const k of ["A", "B"]) {
    check(`school ${k}: published`, (await call("PATCH", `adm-${k}`, `/exams/${k}-ex1/status`, { status: "published" })).status, 200);
    await termGrading.computeClassTermAverages({ schoolId: SCHOOLS[k], academicYear: YEAR, term: 1, classId: `${k}-cls` });
  }
  // A card issued before layouts existed (9): archived with no layout fields.
  await M("GeneratedReport").create({
    schoolId: SCHOOLS.A, examId: "A-ex1", studentId: "A-p3", renderedHtml: "<p>legacy</p>",
    variablePayload: {}, isPublished: false,
  });
  const before = await snapshotAcademic();

  // ── 1 & 2. Two schools, two layouts ─────────────────────────────────────

  console.log("--- two schools, two layouts ---");
  const a1 = await putLayout("adm-A", { results: false });
  check("A switches results off → 201, version 1", [a1.status, a1.body?.changed, a1.body?.layout?.version, a1.body?.layout?.sections?.results],
    [201, true, 1, false]);
  const b1 = await putLayout("adm-B", { remarks: false, conduct: false });
  check("B switches remarks and conduct off → its own version 1", [b1.status, b1.body?.layout?.version, b1.body?.layout?.schoolId],
    [201, 1, SCHOOLS.B]);

  const aCard = await seqCard("adm-A", "A", "p1", "?issue=1");
  const bCard = await seqCard("adm-B", "B", "p1");
  check("A's card: no results; every other block still printed", shows(aCard.html),
    { header: true, studentInfo: true, results: false, performance: true, classProfile: true, conduct: true, remarks: true, verification: true, footer: true });
  check("B's card: results printed; remarks and conduct not", shows(bCard.html),
    { header: true, studentInfo: true, results: true, performance: true, classProfile: true, conduct: false, remarks: false, verification: true, footer: true });
  check("each card says which layout it printed with",
    [aCard.data?.layout?.version, aCard.data?.layout?.source, bCard.data?.layout?.version, bCard.data?.layout?.source],
    [1, "current", 1, "current"]);
  check("A's average is still on the card in the performance panel (only the table is hidden)",
    aCard.html.includes("Average") || aCard.html.includes("average"), true);

  const aTerm = await termCard("adm-A", "A");
  check("A's term card honours the same layout, and names its version",
    [aTerm.status, aTerm.text.includes("<table>"), aTerm.text.includes('<div class="remarks">'), aTerm.headers.get("x-report-layout-version")],
    [200, false, true, "1"]);
  const bTerm = await termCard("adm-B", "B");
  check("B's term card is B's layout, not A's", [bTerm.text.includes("<table>"), bTerm.text.includes('<div class="remarks">')], [true, false]);

  const jsonCard = await call("GET", "adm-A", "/results/A-ex1/student/A-p1/reportcard");
  check("the JSON card carries its layout beside the data, the data untouched",
    [jsonCard.body?.layout?.sections?.results, Array.isArray(jsonCard.body?.data?.subjects), (jsonCard.body?.data?.subjects || []).length],
    [false, true, 2]);

  // ── 6. Cross-school ─────────────────────────────────────────────────────

  console.log("--- cross-school ---");
  {
    const named = await call("PUT", "adm-A", "/templates/layout", { sections: { footer: false }, schoolId: SCHOOLS.B });
    check("A naming B's school in a write is refused", named.status, 403);
    check("and B's layout is untouched", (await call("GET", "adm-B", "/templates/layout")).body?.layout?.sections?.footer, true);
    const readB = await call("GET", "adm-A", `/templates/layout?schoolId=${SCHOOLS.B}`);
    check("A naming B in a read is refused", readB.status, 403);
    check("A's versions are A's only", (await call("GET", "adm-A", "/templates/layout/versions")).body?.versions?.map((v) => v.schoolId),
      [SCHOOLS.A]);
    // A super_admin acts on the school it names, and only that one.
    const supB = await call("GET", "sup", `/templates/layout?schoolId=${SCHOOLS.B}`);
    check("super_admin naming B reads B's layout", [supB.status, supB.body?.layout?.schoolId, supB.body?.layout?.sections?.remarks],
      [200, SCHOOLS.B, false]);

    // B's own token template; A tries to print with it by id.
    const tplB = await M("ReportTemplate").create({ schoolId: SCHOOLS.B, name: "B only", html: "<p>B-ONLY-TEMPLATE</p>", isDefault: false });
    const attached = await seqCard("adm-A", "A", "p1", `?templateId=${tplB._id}`);
    check("A cannot print with B's template by naming its id", [attached.status, attached.html.includes("B-ONLY-TEMPLATE"), attached.data?.source],
      [200, false, "builtin"]);
    const smuggled = await seqCard("adm-A", "A", "p1", `?layoutVersionId=${encodeURIComponent(`${SCHOOLS.B}:v1`)}`);
    check("a layout cannot be attached by id from the request: A still prints A's", [smuggled.data?.layout?.versionId, shows(smuggled.html).results],
      [`${SCHOOLS.A}:v1`, false]);
    check("B's layout version cannot be read through A's school", (await call("GET", "adm-A", "/templates/layout/versions/1")).body?.version?.schoolId,
      SCHOOLS.A);
  }

  // ── 8. Issued cards keep the layout they were issued with ───────────────

  console.log("--- issued cards ---");
  const issued = await M("GeneratedReport").findOne({ examId: "A-ex1", studentId: "A-p1" }).lean();
  check("A's p1 card was issued (published) with layout v1, results off",
    [issued?.layoutVersionId, issued?.layoutVersion, issued?.layoutSections?.results], [`${SCHOOLS.A}:v1`, 1, false]);
  const frozen = issued?.renderedHtml;

  const academicRows = async () => JSON.stringify(await Promise.all(
    ["StudentScore", "ResultSummary", "TermResult", "AnnualResult"].map((m) => M(m).find({}).sort({ _id: 1 }).lean())));
  const rowsBeforeLayout = await academicRows();
  const a2 = await putLayout("adm-A", { results: true, footer: false });
  // A section switch is presentation: it moves no mark, result or rank.
  check("switching sections rewrites no score, summary, term or annual row", await academicRows(), rowsBeforeLayout);
  check("A changes its layout → version 2", [a2.status, a2.body?.layout?.version, a2.body?.layout?.basedOnVersion], [201, 2, 1]);

  const reprint = await seqCard("adm-A", "A", "p1");
  check("the issued card reprints with v1: still no results, footer still there",
    [shows(reprint.html).results, shows(reprint.html).footer, reprint.data?.layout?.source, reprint.data?.layout?.version],
    [false, true, "issued", 1]);
  const after = await M("GeneratedReport").findOne({ examId: "A-ex1", studentId: "A-p1" }).lean();
  check("its archive is unchanged: same html, same layout", [after.renderedHtml === frozen, after.layoutVersion], [true, 1]);

  const fresh = await seqCard("adm-A", "A", "p2", "?issue=1");
  check("a card issued after the change prints with v2", [shows(fresh.html).results, shows(fresh.html).footer, fresh.data?.layout?.version],
    [true, false, 2]);

  // docs/39 §4.6f: the reissued card carries the same letterhead and
  // verification strip as an issued one, and the reissue is audited.
  await M("School").updateOne({ _id: SCHOOLS.A }, { $set: { motto: "Discipline and Work" } });
  const reissued = await call("POST", "adm-A", "/results/A-ex1/student/A-p1/reportcard/reissue",
    { lang: "en", reason: "Mathematics mark corrected" });
  const afterReissue = await M("GeneratedReport").findOne({ examId: "A-ex1", studentId: "A-p1" }).lean();
  check("a reissue is the deliberate supersede: current layout (v2), recorded",
    [reissued.status, reissued.body?.data?.layout?.version, afterReissue.layoutVersion, afterReissue.renderedHtml.includes("<table>")],
    [200, 2, 2, true]);
  check("the reissued card keeps the letterhead (motto) and the verification strip (QR and code)",
    ["Discipline and Work", 'class="verify-qr"', 'class="verify-code"'].map((m) => afterReissue.renderedHtml.includes(m)),
    [true, true, true]);
  const reissueAudit = await M("AuditLog").findOne({ action: "reportCard.reissued", schoolId: SCHOOLS.A }).lean();
  check("the reissue is audited: who, which card, layout v1 → v2, the reason, no card content",
    [reissueAudit?.actorId != null, reissueAudit?.resourceId, reissueAudit?.before?.layoutVersion, reissueAudit?.after?.layoutVersion,
     reissueAudit?.reason, JSON.stringify(reissueAudit ?? {}).includes("<table>")],
    [true, afterReissue._id, 1, 2, "Mathematics mark corrected", false]);

  // ── 9. Legacy cards ─────────────────────────────────────────────────────

  console.log("--- legacy cards ---");
  {
    await putLayout("adm-A", { results: false });
    const legacy = await seqCard("adm-A", "A", "p3");
    check("a card issued before layouts existed reprints with every section",
      [legacy.data?.layout?.source, Object.values(shows(legacy.html)).every(Boolean)], ["legacy", true]);
    const stored = await M("GeneratedReport").findOne({ examId: "A-ex1", studentId: "A-p3" }).lean();
    check("and its archive is not rewritten", [stored.renderedHtml, stored.layoutVersionId ?? null], ["<p>legacy</p>", null]);
  }

  // ── 7. Versions ─────────────────────────────────────────────────────────

  console.log("--- versions ---");
  {
    const list = (await call("GET", "adm-A", "/templates/layout/versions")).body?.versions || [];
    check("A has versions 3, 2, 1, newest first", list.map((v) => v.version), [3, 2, 1]);
    const v1 = (await call("GET", "adm-A", "/templates/layout/versions/1")).body?.version;
    check("version 1 is exactly as it was saved", [v1?.sections?.results, v1?.sections?.footer], [false, true]);
    const same = await putLayout("adm-A", { results: false });
    check("saving what is already there inserts nothing", [same.status, same.body?.changed, same.body?.layout?.version], [200, false, 3]);
    check("an unknown version is 404", (await call("GET", "adm-A", "/templates/layout/versions/99")).status, 404);
    let refused = 0;
    for (const op of [
      () => M("ReportTemplateVersion").updateOne({ _id: `${SCHOOLS.A}:v1` }, { $set: { "sections.results": true } }),
      () => M("ReportTemplateVersion").deleteOne({ _id: `${SCHOOLS.A}:v1` }),
      () => M("ReportTemplateVersion").findOneAndUpdate({ _id: `${SCHOOLS.A}:v1` }, { $set: { version: 9 } }),
    ]) { try { await op(); } catch (e) { if (/append-only/.test(e.message)) refused += 1; } }
    check("a version cannot be edited or deleted", refused, 3);

    // Five administrators at once, each switching a different section off:
    // five new versions, and none of the five changes is lost.
    const ids = ["header", "studentInfo", "performance", "classProfile", "verification"];
    const results = await Promise.all(ids.map((id) => putLayout("adm-B", { [id]: false })));
    const latest = (await call("GET", "adm-B", "/templates/layout")).body?.layout;
    check("five concurrent changes: five versions, every change kept",
      [results.every((r) => r.status === 201), latest?.version, ids.every((id) => latest?.sections?.[id] === false),
       latest?.sections?.remarks, latest?.sections?.conduct],
      [true, 6, true, false, false]);
  }

  // ── 4. A section switched back on prints when its data exists ───────────

  console.log("--- switched back on ---");
  {
    await putLayout("adm-A", { results: true, footer: true, verification: true });
    const back = await seqCard("adm-A", "A", "p2");   // issued under v2: results on, footer off
    check("p2 reprints with the layout it was issued with (v2)", [back.data?.layout?.version, shows(back.html).results], [2, true]);
    const term = await termCard("adm-A", "A", "p2");
    check("the term card (never archived) prints the current layout: results back",
      [term.text.includes("<table>"), term.text.includes('<div class="verify">')], [true, true]);
    // A section on with no data behind it prints nothing new: verification
    // needs a code, and a card with none has no strip whatever the layout says.
    const { renderReportCardHtml } = require("../src/services/reportHtml.service");
    const noVerify = renderReportCardHtml({ reportType: "sequence", subjects: [], summary: null }, { sections: { verification: true } });
    check("verification on, no verification data → no strip", noVerify.includes('<div class="verify">'), false);
  }

  // ── Token templates ─────────────────────────────────────────────────────

  console.log("--- token templates ---");
  {
    // A: the shipped default (section-aware) as its default template.
    await M("ReportTemplate").create({ schoolId: SCHOOLS.A, name: "Default", html: DEFAULT_TEMPLATE_HTML, css: DEFAULT_TEMPLATE_CSS, isDefault: true });
    await putLayout("adm-A", { results: false, remarks: false });
    const t = await termCard("adm-A", "A", "p2");
    check("the shipped template honours the layout: no subject table, no remarks; header still there",
      // "<table": the wrapper's CSS names .subjects-table whatever is printed.
      [t.status, t.text.includes('class="report-wrapper"'), t.text.includes("<table"), t.text.includes('class="remarks"'), t.text.includes("ministry-column")],
      [200, true, false, false, true]);
    const lay = await call("GET", "adm-A", "/templates/layout");
    check("and nothing is reported as not hidden", lay.body?.sectionsNotHiddenByTemplate, []);

    // B: its own template, which gates nothing.
    await M("ReportTemplate").updateOne({ schoolId: SCHOOLS.B, name: "B only" }, { $set: { isDefault: true, html: "<div>{{subjects_table}}<p>OWN-REMARKS</p></div>" } });
    const bLay = await call("GET", "adm-B", "/templates/layout");
    check("B's own template cannot hide what it prints unconditionally — and the API says so",
      bLay.body?.sectionsNotHiddenByTemplate, ["header", "studentInfo", "performance", "classProfile", "conduct", "remarks", "verification"]);
    const bJson = await seqCard("adm-B", "B", "p2");
    check("so does the card response", [bJson.data?.source, (bJson.data?.layout?.sectionsNotHiddenByTemplate || []).includes("remarks")],
      ["template", true]);
    check("and B's own document is not rewritten",
      (await M("ReportTemplate").findOne({ schoolId: SCHOOLS.B, isDefault: true }).lean()).html, "<div>{{subjects_table}}<p>OWN-REMARKS</p></div>");
  }

  // ── 3 & 10. Presentation only ───────────────────────────────────────────

  console.log("--- presentation only ---");
  {
    const now = await snapshotAcademic();
    check("no stored result, score, term result or grading config moved", [
      now.summaries.join() === before.summaries.join(), now.scores.join() === before.scores.join(),
      now.terms.join() === before.terms.join(), now.grading.join() === before.grading.join(),
    ], [true, true, true, true]);
    check("the intelligence layer's published history is identical", now.history === before.history, true);
  }

  // ── 10. No layout is the card it always was ─────────────────────────────
  //
  // Byte-for-byte against the renderer before this change was checked when it
  // was made (docs/39 §20.0, 2d); what is pinned here is that "no layout" and
  // "every section on" are the same document, so the default can never drift
  // from the legacy card without this failing.
  console.log("--- no layout = every section ---");
  {
    const { renderReportCardHtml } = require("../src/services/reportHtml.service");
    const allOn = Object.fromEntries(SECTION_IDS.map((id) => [id, true]));
    const payload = {
      studentName: "Synthetic", subjects: [{ subjectName: "Maths", score: 15, maxScore: 20, normalizedMark: 15, coefficient: 2, grade: "B+", isPassing: true }],
      summary: { average: 3, overallGrade: "B", isPassing: true, classPosition: 1, totalInClass: 3, promotionStatus: "PROMOTED" },
      computed: { weightedAverage: 15, totalCoefficients: 2, totalWeighted: 30 }, classStats: { average: 12, highest: 15, lowest: 8, scale: "20" },
    };
    const same = [];
    for (const lang of ["en", "fr"]) for (const reportType of ["sequence", "term", "annual"]) {
      const opts = { lang, school: { name: "S", logo: "http://x/l.png", principalName: "H" }, verify: { code: "C", url: "http://x", qrSvg: "<svg/>" } };
      same.push(renderReportCardHtml({ ...payload, reportType }, opts) === renderReportCardHtml({ ...payload, reportType }, { ...opts, sections: allOn }));
    }
    check("no layout and every section on are the same document (3 kinds × 2 languages)", same.every(Boolean), true);
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
