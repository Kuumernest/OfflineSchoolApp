// mobile/scripts/check-exploration-teacher-client.js
"use strict";

/**
 * The teacher's exploration writes from the phone store what the web's store.
 *
 * The phone's exploration service is loaded through babel with a fake SQLite
 * and a real axios pointed at the real insights and explorations routers on
 * an in-memory MongoDB (as check-intelligence-client does). Its outbox is
 * stubbed to deliver at once, which is what a drain does. What is asserted:
 *
 *   - an observation recorded through the phone's service is stored as the
 *     same body posted the way the web posts it — level, codes, note — and
 *     the server keeps one per teacher per exploration
 *   - a rating recorded through the phone's service completes the exploration
 *     with the same level and ratings as the web's; the level is the
 *     server's, never computed on the handset
 *   - an unknown level, an unknown criterion, a teacher of another class: the
 *     same refusals the web gets (400 INVALID_OBSERVATION, 400
 *     INVALID_PERFORMANCE, 403 CLASS_NOT_ASSIGNED)
 *   - the pupil's explorations are read, cached under the teacher, and the
 *     criteria come from the cached catalog
 *   - the screen: linked from the class intelligence card, holds no scale,
 *     reads the level from the row, and every key it uses is in both languages
 *
 * Fixtures throughout. Nothing here is evidence about a real pupil.
 *
 *   node scripts/check-exploration-teacher-client.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");
const { stopQuietly } = require(path.join(__dirname, "..", "..", "backend", "scripts", "stopQuietly"));

const MOBILE  = path.join(__dirname, "..");
const BACKEND = path.join(MOBILE, "..", "backend");
const BSRC    = path.join(BACKEND, "src");
const bmod    = (name) => require(path.join(BACKEND, "node_modules", name));

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => { fail++; console.log(`  FAIL ${label}`); if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n")); };
const check = (label, actual, expected) => { const a = JSON.stringify(actual), e = JSON.stringify(expected); a === e ? ok(label) : bad(label, `got ${a}\nexpected ${e}`); };

/** A fake expo-sqlite: one table of rows keyed by the first column, enough for INSERT OR REPLACE and SELECT … WHERE id = ?. */
const makeFakeDb = () => {
  const tables = new Map();
  const tableOf = (sql) => (sql.match(/(?:INTO|FROM|TABLE IF NOT EXISTS)\s+(\w+)/i) ?? [])[1];
  return {
    execAsync: async (sql) => { const t = tableOf(sql); if (t && !tables.has(t)) tables.set(t, new Map()); },
    runAsync: async (sql, params = []) => { const t = tableOf(sql); if (!tables.has(t)) tables.set(t, new Map()); if (/INSERT OR REPLACE/i.test(sql)) { const cols = sql.match(/\(([^)]+)\)\s*VALUES/i)[1].split(",").map((s) => s.trim()); const row = Object.fromEntries(cols.map((c, i) => [c, params[i]])); tables.get(t).set(params[0], row); } },
    getFirstAsync: async (sql, params = []) => { const t = tableOf(sql); const row = tables.get(t)?.get(params[0]); return row ?? null; },
    getAllAsync: async (sql) => [...(tables.get(tableOf(sql))?.values() ?? [])],
    rows: (t) => [...(tables.get(t)?.values() ?? [])],
  };
};

const loadModule = (rel, stubs) => {
  const abs = path.join(MOBILE, rel);
  const { code } = babel.transformFileSync(abs, { presets: [require.resolve("babel-preset-expo")], caller: { name: "check", supportsStaticESM: false }, babelrc: false, configFile: false });
  const dir = path.dirname(abs);
  const mod = { exports: {} };
  const req = (id) => { if (id in stubs) return stubs[id]; return require(id.startsWith(".") ? path.resolve(dir, id) : id); };
  new Function("module", "exports", "require", code)(mod, mod.exports, req);
  return mod.exports;
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "check-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const express  = bmod("express");
  const mongoose = bmod("mongoose");
  const jwt      = bmod("jsonwebtoken");
  const axios    = require(path.join(MOBILE, "node_modules", "axios"));
  const { MongoMemoryServer } = bmod("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(BSRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));

  const A = "6b00000000000000000000a1";
  await M("School").create({ _id: A, name: "Alpha Academy", code: "ALPHA", email: "alpha@example.test" });
  const mkUser = (id, role, name) => M("User").create({ _id: id, name, email: `${id}@example.test`, password: "Check-only-passw0rd", role, schoolId: A, isActive: true });
  await Promise.all([mkUser("teach-a", "teacher", "Teacher A"), mkUser("teach-b", "teacher", "Teacher B"), mkUser("teach-c", "teacher", "Teacher C"), mkUser("stu-a1", "student", "Pupil A1"), mkUser("stu-a2", "student", "Pupil A2")]);
  await M("Class").create([{ _id: "form3a", schoolId: A, name: "Form 3A" }, { _id: "form4b", schoolId: A, name: "Form 4B" }]);
  await M("TeacherAssignment").create([
    { schoolId: A, teacher: "teach-a", class: "form3a", subject: "maths" },
    { schoolId: A, teacher: "teach-b", class: "form3a", subject: "physics" },
    { schoolId: A, teacher: "teach-c", class: "form4b", subject: "maths" },
  ]);
  await M("Student").create([
    { _id: "st-a1", userId: "stu-a1", schoolId: A, classId: "form3a", studentName: "Pupil A1", enrollmentNo: "A1", isActive: true, status: "approved" },
    { _id: "st-a2", userId: "stu-a2", schoolId: A, classId: "form3a", studentName: "Pupil A2", enrollmentNo: "A2", isActive: true, status: "approved" },
  ]);

  const app = express();
  app.use(express.json());
  const auth = require(path.join(BACKEND, "middleware", "auth"));
  app.use("/api/insights",     auth.authenticate, require(path.join(BSRC, "routes/insights.routes")));
  app.use("/api/explorations", auth.authenticate, require(path.join(BSRC, "routes/explorations.routes")));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const tokenOf = (id, role) => jwt.sign({ id, role, schoolId: A }, process.env.JWT_SECRET, { expiresIn: "1h" });
  // One connection per request. Node's default agent keeps sockets alive and
  // the server drops an idle one after five seconds; transforming the service
  // through babel takes longer than that, and the next request on the pooled
  // socket died with ECONNRESET — a timing accident, not a finding.
  const agent = new (require("http").Agent)({ keepAlive: false });
  const clientOf = (token) => axios.create({ baseURL: API, httpAgent: agent, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const web = clientOf(tokenOf("teach-b", "teacher"));   // "the web": the same routes, posted directly
  const pupil1 = clientOf(tokenOf("stu-a1", "student")), pupil2 = clientOf(tokenOf("stu-a2", "student"));

  // Two pupils complete the same activity, which has criteria to rate against.
  const complete = async (client, studentId) => {
    const { data } = await client.post(`/insights/student/${studentId}/explorations`, { activityId: "qsci-intro-bridge", action: "start" });
    const id = data.data._id;
    await client.post(`/explorations/${id}/submit`, { outputs: [{ label: "bridge", value: "A card truss; held one book" }], completionMode: "pair" });
    return id;
  };
  const x1 = await complete(pupil1, "st-a1");
  const x2 = await complete(pupil2, "st-a2");

  /** The phone's service as a given teacher, its outbox delivering at once (what a drain does). */
  const serviceAs = (teacherId) => {
    const client = clientOf(tokenOf(teacherId, "teacher"));
    const sent = [];
    const MutationQueue = {
      enqueue: async ({ entityKey, method, endpoint, payload }) => {
        sent.push({ entityKey, method, endpoint, payload });
        const res = await client.request({ method, url: endpoint, data: payload });
        return res.data;
      },
    };
    const db = makeFakeDb();
    const svc = loadModule("src/services/exploration.service.js", {
      "./api": { default: client, __esModule: true },
      "../db/database": { getDatabase: async () => db },
      "../utils/authHelpers": { getCurrentAuth: () => ({ user: { _id: teacherId } }) },
      "./mutationQueue.service": { MutationQueue },
    });
    return { svc, sent, db, client };
  };
  const status = async (p) => { try { await p; return [200, null]; } catch (e) { return [e.response?.status ?? 0, e.response?.data?.code ?? null]; } };

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 1. an observation from the phone is the web's observation ---");
  // ═══════════════════════════════════════════════════════════════════════════
  const a = serviceAs("teach-a");
  const body = { level: "PARTLY_OBSERVED", codes: ["ITERATION", "EXPLANATION"], note: "Rebuilt the deck after the first test" };
  await a.svc.observeExploration(x1, body);
  await web.post(`/explorations/${x1}/observation`, body);
  const stored = await M("ExplorationObservation").find({ explorationId: x1 }).sort({ observedBy: 1 }).lean();
  const shape = (o) => [o.level, o.codes, o.note, o.version, o.revisions.length];
  check("the phone sent exactly the web's body to the web's route", [a.sent[0].method, a.sent[0].endpoint, a.sent[0].payload], ["POST", `/explorations/${x1}/observation`, body]);
  check("two teachers, two rows, the same level, codes and note stored for each", [stored.map((o) => o.observedBy), shape(stored[0]), shape(stored[1])], [["teach-a", "teach-b"], ["PARTLY_OBSERVED", ["ITERATION", "EXPLANATION"], "Rebuilt the deck after the first test", 1, 0], ["PARTLY_OBSERVED", ["ITERATION", "EXPLANATION"], "Rebuilt the deck after the first test", 1, 0]]);
  await a.svc.observeExploration(x1, { level: "OBSERVED", codes: ["ITERATION"] });
  const revised = await M("ExplorationObservation").findOne({ explorationId: x1, observedBy: "teach-a" }).lean();
  check("posting again from the phone revises the same row — the first observation kept as a revision, as on the web", [await M("ExplorationObservation").countDocuments({ explorationId: x1 }), revised.version, revised.revisions.length, revised.revisions[0].level, revised.note], [2, 2, 1, "PARTLY_OBSERVED", null]);
  check("the evidence the strengths engine reads: one teacher_observation row per observer, none doubled", await M("ExplorationEvidence").countDocuments({ explorationId: x1, kind: "teacher_observation" }), 2);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 2. a rating from the phone is the web's rating ---");
  // ═══════════════════════════════════════════════════════════════════════════
  const ratings = [{ criterion: "task_completion", rating: "met" }, { criterion: "problem_solving_approach", rating: "partly_met" }, { criterion: "iteration", rating: "met" }];
  const row1 = (await a.client.get("/insights/student/st-a1/explorations")).data.data.explorations.find((e) => e.explorationId === x1);
  await a.svc.rateExploration(x1, { version: row1.version, ratings });
  const row2 = (await web.get("/insights/student/st-a2/explorations")).data.data.explorations.find((e) => e.explorationId === x2);
  await web.post(`/explorations/${x2}/performance`, { version: row2.version, ratings });
  const [p1, p2] = await Promise.all([M("StudentExploration").findById(x1).lean(), M("StudentExploration").findById(x2).lean()]);
  const perf = (e) => [e.status, e.performance.level, e.performance.ratings.map((r) => [r.criterion, r.rating])];
  check("the phone sent the web's body: the row's version and the chosen ratings", a.sent.at(-1).payload, { version: row1.version, ratings });
  check("both explorations complete with the same level and ratings; the level is the server's", [perf(p1), perf(p1)[1] === perf(p2)[1], perf(p1)[2].length === perf(p2)[2].length, p1.performance.ratedBy, p2.performance.ratedBy], [["COMPLETED", "demonstrated", [["task_completion", "met"], ["problem_solving_approach", "partly_met"], ["iteration", "met"]]], true, true, "teach-a", "teach-b"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 3. the same refusals as the web ---");
  // ═══════════════════════════════════════════════════════════════════════════
  check("an unknown level → 400 INVALID_OBSERVATION", await status(a.svc.observeExploration(x1, { level: "SEEN" })), [400, "INVALID_OBSERVATION"]);
  check("an unknown code → 400 INVALID_OBSERVATION", await status(a.svc.observeExploration(x1, { level: "OBSERVED", codes: ["NATURAL_LEADER"] })), [400, "INVALID_OBSERVATION"]);
  check("a criterion the activity does not have → 400 INVALID_PERFORMANCE", await status(a.svc.rateExploration(x1, { version: p1.version, ratings: [{ criterion: "accuracy", rating: "met" }] })), [400, "INVALID_PERFORMANCE"]);
  check("a stale version → 409 VERSION_CONFLICT", await status(a.svc.rateExploration(x1, { version: 1, ratings: [{ criterion: "task_completion", rating: "met" }] })), [409, "VERSION_CONFLICT"]);
  const c = serviceAs("teach-c");
  check("a teacher of another class cannot observe → 403 CLASS_NOT_ASSIGNED", await status(c.svc.observeExploration(x1, { level: "OBSERVED" })), [403, "CLASS_NOT_ASSIGNED"]);
  check("nor rate → 403 CLASS_NOT_ASSIGNED", await status(c.svc.rateExploration(x1, { version: p1.version, ratings })), [403, "CLASS_NOT_ASSIGNED"]);
  check("nor read the pupil's explorations → 403", (await status(c.svc.refreshPupilExplorations("st-a1")))[0], 403);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 4. reading: the pupil's rows, cached under the teacher; criteria from the catalog ---");
  // ═══════════════════════════════════════════════════════════════════════════
  const rows = await a.svc.refreshPupilExplorations("st-a1", "en");
  const mine = rows.find((e) => e.explorationId === x1);
  check("the staff view: status, two observations, the performance, no reflection text that was not shared", [mine.status, mine.observations.length, mine.performance.level, mine.reflection], ["COMPLETED", 2, "demonstrated", null]);
  const cached = await a.svc.getPupilExplorations("st-a1");
  check("cached under this teacher and this pupil, dated", [cached.rows.length === rows.length, typeof cached.fetchedAt, a.db.rows("teacher_pupil_explorations")[0]?.id], [true, "string", "teach-a:st-a1"]);
  await a.svc.refreshCatalog("en");
  check("the criteria to rate against are the activity's own, from the cached catalog", await a.svc.criteriaFor("qsci-intro-bridge", "en"), ["task_completion", "problem_solving_approach", "communication", "iteration"]);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n--- 5. the screen ---");
  // ═══════════════════════════════════════════════════════════════════════════
  const screen = fs.readFileSync(path.join(MOBILE, "app/teacher/explorations/[studentId].js"), "utf8");
  const intel  = fs.readFileSync(path.join(MOBILE, "app/teacher/intelligence/index.js"), "utf8");
  check("the class intelligence card links to it, with the pupil", /pathname:\s*"\/teacher\/explorations\/\[studentId\]"/.test(intel) && /classIntel\.explorations/.test(intel), true);
  check("it writes through the service's two functions and the outbox, and posts nothing itself", [/observeExploration\(/.test(screen), /rateExploration\(/.test(screen), /api\.post|axios/.test(screen)], [true, true, false]);
  check("it computes no level and no score: the level shown is the row's", [/e\.performance\.level/.test(screen), /performanceLevel|score\s*=|\bpoints\b/.test(screen)], [true, false]);
  const ex = require(path.join(MOBILE, "..", "shared", "exploration"));
  const lists = (name) => JSON.parse(screen.match(new RegExp(`const ${name}\\s*=\\s*(\\[[^\\]]*\\])`))[1].replace(/'/g, '"'));
  check("its option lists are the catalog's, not a scale of its own", [lists("OBS_LEVELS"), lists("OBS_CODES"), lists("RATINGS")], [ex.OBSERVATION_LEVELS, ex.OBSERVATION_CODES, ex.PERFORMANCE_RATINGS]);
  const en = JSON.parse(fs.readFileSync(path.join(MOBILE, "src/i18n/locales/en.json"), "utf8"));
  const fr = JSON.parse(fs.readFileSync(path.join(MOBILE, "src/i18n/locales/fr.json"), "utf8"));
  const get = (obj, key) => key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
  const keys = [...new Set([...screen.matchAll(/t\("([a-zA-Z.]+)"/g)].map((m) => m[1]))];
  check(`the ${keys.length} literal keys it uses exist in en and fr`, keys.filter((k) => typeof get(en, k) !== "string" || typeof get(fr, k) !== "string"), []);
  const dyn = [["explore.status", ["DISCOVERED", "SAVED", "STARTED", "SUBMITTED", "REVIEW_REQUIRED", "COMPLETED", "ABANDONED", "SKIPPED", "NOT_INTERESTED"]], ["explore.obsLevel", ex.OBSERVATION_LEVELS], ["explore.obsCode", ex.OBSERVATION_CODES], ["explore.rating", ex.PERFORMANCE_RATINGS], ["explore.criterion", ex.PERFORMANCE_CRITERIA], ["explore.perfLevel", ["limited", "partial", "demonstrated", "strong"]]];
  check("and the labels for every level, code, rating and criterion exist in both", dyn.flatMap(([ns, vals]) => vals.filter((v) => typeof get(en, `${ns}.${v}`) !== "string" || typeof get(fr, `${ns}.${v}`) !== "string").map((v) => `${ns}.${v}`)), []);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close(); server.closeAllConnections?.();
  await mongoose.disconnect(); await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
