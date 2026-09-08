// mobile/scripts/check-portal-client.js
"use strict";

/**
 * The phone's own portal client, executed — not read.
 *
 * Everything asserted about the parent portal so far was asserted against the
 * backend: a suite that builds its own HTTP request, sends it to the real
 * routers, and checks the reply. That proves the server correct and says
 * nothing whatever about the phone, and the phone is the product. The web
 * portal turned out to be asking for /api/portal/portal/… — a mistake no
 * amount of backend testing could see, and exactly the class of mistake this
 * script exists to catch on the surface that is actually reported broken.
 *
 * So nothing here writes a URL. It loads the real
 * src/services/portal.service.js through babel, gives it a fake SecureStore
 * and a fake SQLite cache, points it at the real routers on a real port, and
 * calls the same functions the screens call. The URL under test is whatever
 * that module generates, and it is read back off the server — which is the
 * only definition of "the URL the app sent" that cannot be argued with.
 *
 * It then evaluates the screen's own empty-state expression, lifted out of
 * app/portal/index.js, against the value the service actually returned. That
 * is the last link in the chain: service → state → the ternary that prints
 * "No conversations yet".
 *
 *   node scripts/check-portal-client.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");

const MOBILE  = path.join(__dirname, "..");
const BACKEND = path.join(MOBILE, "..", "backend");
const BSRC    = path.join(BACKEND, "src");

// The backend's dependencies, by absolute path: this script runs inside the
// mobile package, which has babel and axios and none of the server's.
const bmod = (name) => require(path.join(BACKEND, "node_modules", name));

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const note = (label) => console.log(`       ${label}`);

// ─────────────────────────────────────────────────────────────────────────────
// The phone's environment, faked only where it touches the device
// ─────────────────────────────────────────────────────────────────────────────

/** expo-secure-store, in memory. This is where the portal token lives. */
const secureStore = new Map();
const SecureStoreStub = {
  getItemAsync:    async (k) => (secureStore.has(k) ? secureStore.get(k) : null),
  setItemAsync:    async (k, v) => { secureStore.set(k, v); },
  deleteItemAsync: async (k) => { secureStore.delete(k); },
};

/**
 * The SQLite section cache, in memory.
 *
 * Real enough to be worth asserting on: the service caches every successful
 * response and serves the cached copy on failure, which is one of the ways a
 * screen can show yesterday's empty list over today's conversations.
 */
const makeFakeDb = () => {
  const rows = new Map();
  return {
    _rows: rows,
    execAsync: async () => {},
    runAsync: async (sql, params = []) => {
      if (/^\s*INSERT OR REPLACE/i.test(sql)) {
        rows.set(params[0], { payload: params[1], _fetched_at: params[2] });
      } else if (/^\s*DELETE FROM/i.test(sql)) {
        rows.clear();
      }
      return { changes: 1 };
    },
    getFirstAsync: async (sql, params = []) => {
      if (/SELECT payload/i.test(sql)) return rows.get(params[0]) ?? null;
      return null;
    },
  };
};

/**
 * Load one ESM module out of mobile/src with a require we control.
 *
 * supportsStaticESM:false makes preset-expo emit require/exports, the same
 * trick scripts/check.js uses to load linkQuality. The interceptor is what
 * makes it possible at all: the module imports expo-secure-store and the
 * SQLite layer at the top level, neither of which exists off a device.
 */
const loadMobileModule = (relPath, stubs) => {
  const { code } = babel.transformFileSync(path.join(MOBILE, relPath), {
    presets: [require.resolve("babel-preset-expo")],
    caller:  { name: "check", supportsStaticESM: false },
    babelrc: false,
    configFile: false,
  });
  const mod = { exports: {} };
  const req = (id) => (id in stubs ? stubs[id] : require(id));
  new Function("module", "exports", "require", code)(mod, mod.exports, req);
  return mod.exports;
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const express  = bmod("express");
  const mongoose = bmod("mongoose");
  const jwt      = bmod("jsonwebtoken");
  const { MongoMemoryServer } = bmod("mongodb-memory-server");

  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(BSRC, "db/models"));
  const User           = mongoose.model("User");
  const Student        = mongoose.model("Student");
  const Class          = mongoose.model("Class");
  const School         = mongoose.model("School");
  const Conversation   = mongoose.model("Conversation");
  const Announcement   = mongoose.model("Announcement");
  const GuardianAccess = mongoose.model("GuardianAccess");

  await Promise.all([Conversation.init(), Announcement.init()]);

  // ── The family the report describes ─────────────────────────────────────
  const SCHOOL  = "68c00000000000000000000b";
  const TEACHER = "usr-teacher";
  const CLASS_A = "cls-a";
  const CLASS_B = "cls-b";
  const CLASS_C = "cls-c";
  const CHILD_A = "stu-a";
  const CHILD_B = "stu-b";
  const PARENT  = "acc-parent";
  const HASH    = "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad";

  await School.create({ _id: SCHOOL, name: "Geneva Bilingual Academy", email: "o@example.test" });
  await Class.create([
    { _id: CLASS_A, schoolId: SCHOOL, name: "Class A" },
    { _id: CLASS_B, schoolId: SCHOOL, name: "Class B" },
    { _id: CLASS_C, schoolId: SCHOOL, name: "Class C" },
  ]);
  await User.create({
    _id: TEACHER, name: "Kuum Ernest", email: "t@example.test",
    password: "check-only-password", role: "teacher", schoolId: SCHOOL, isActive: true,
  });
  await Student.create([
    { _id: CHILD_A, userId: "u-a", schoolId: SCHOOL, classId: CLASS_A,
      studentName: "Child A", enrollmentNo: "E-1", isActive: true, status: "approved" },
    { _id: CHILD_B, userId: "u-b", schoolId: SCHOOL, classId: CLASS_B,
      studentName: "Child B", enrollmentNo: "E-2", isActive: true, status: "approved" },
  ]);
  await GuardianAccess.create({
    _id: PARENT, schoolId: SCHOOL, studentIds: [CHILD_A, CHILD_B],
    codeHash: HASH, codeHint: "11",
  });

  // ── The real routers, plus a tap on the wire ────────────────────────────
  //
  // Every request the phone makes is recorded here, before any router sees it,
  // and anything that matches no route is recorded as a miss. This is the
  // evidence for "which URL did the mobile app actually call".
  const seen   = [];
  const missed = [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { seen.push(`${req.method} ${req.originalUrl}`); next(); });

  const auth = require(path.join(BACKEND, "middleware", "auth"));
  app.use("/api/messages", auth.authenticate, require(path.join(BSRC, "routes/messages.routes")));
  app.use("/api/portal",   require(path.join(BSRC, "routes/portal.routes")));

  app.use((req, res) => {
    missed.push(`${req.method} ${req.originalUrl}`);
    res.status(404).json({ success: false, message: "no such route" });
  });

  const server = app.listen(0);
  const port   = server.address().port;
  const API    = `http://127.0.0.1:${port}/api`;

  console.log("\n=== the environment under test ===");
  note(`server              ${API}`);
  note(`school              ${SCHOOL}`);
  note(`parent access       ${PARENT}  children=[${CHILD_A} (${CLASS_A}), ${CHILD_B} (${CLASS_B})]`);

  // ── The real mobile module ──────────────────────────────────────────────
  const fakeDb = makeFakeDb();
  const Portal = loadMobileModule("src/services/portal.service.js", {
    "expo-secure-store": SecureStoreStub,
    // The one value that decides every URL below. Taken from the real
    // getBaseURL() contract: EXPO_PUBLIC_API_URL, trailing slash trimmed,
    // ending in /api.
    "./api":             { API_URL: API },
    "../db/database":    { getDatabase: async () => fakeDb },
    "../db/schemaManager": { ensureTableSchema: async (_n, fn, db) => fn(db) },
  });

  const exported = Object.keys(Portal).sort();
  note(`portal.service.js exports ${exported.length}: ${exported.join(", ")}`);
  if (typeof Portal.fetchConversations === "function") {
    ok("src/services/portal.service.js loads and exports fetchConversations");
  } else {
    bad("the mobile portal service loads", `exports: ${exported.join(", ")}`);
    process.exit(1);
  }

  // The token the phone would be holding after a code login.
  await Portal.setToken(jwt.sign(
    { accessId: PARENT, schoolId: SCHOOL },
    process.env.JWT_SECRET, { audience: "portal", expiresIn: "1h" }
  ));

  const staffToken = jwt.sign(
    { id: TEACHER, role: "teacher", schoolId: SCHOOL },
    process.env.JWT_SECRET, { expiresIn: "1h" }
  );
  // Origin, not API: the staff helper takes a full /api/... path, and building
  // it on top of API — which already ends in /api — is precisely the doubled
  // prefix this script exists to detect. It made that mistake on its first
  // run and the request tap above is what caught it, which is as good a
  // demonstration as any that the tap works.
  const ORIGIN = `http://127.0.0.1:${port}`;
  const asTeacher = async (method, url, body) => {
    const res = await fetch(`${ORIGIN}${url}`, {
      method,
      headers: { Authorization: `Bearer ${staffToken}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let out = {}; try { out = await res.json(); } catch {}
    return { status: res.status, body: out };
  };

  const urlsFor = (fragment) => seen.filter((u) => u.includes(fragment));

  // ═════════════════════════════════════════════════════════════════════════
  // FAILURE 1 — the conversation list, as the phone asks for it
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n--- what URL does the phone actually request? ---");
  let convTeacher = null;
  {
    const before = seen.length;
    const empty  = await Portal.fetchConversations(CHILD_A);
    const asked  = seen.slice(before);

    note(`fetchConversations("${CHILD_A}") sent:`);
    for (const u of asked) note(`  ${u}`);

    if (asked.length === 1 && asked[0].startsWith("GET /api/portal/messages/conversations")) {
      ok("GET /api/portal/messages/conversations — the correct portal endpoint");
    } else {
      bad("the phone calls /api/portal/messages/conversations",
        `it sent: ${JSON.stringify(asked)}`);
    }
    if (asked[0]?.includes(`studentId=${CHILD_A}`)) {
      ok(`and passes the child as ?studentId=${CHILD_A}`);
    } else {
      bad("the request carries the studentId parameter", asked[0] ?? "(nothing)");
    }
    if (!missed.length) ok("nothing 404s — no doubled base segment, no stale path");
    else bad("no request misses a route", missed.join("\n"));

    // An honestly empty list, before anything has been sent.
    if (Array.isArray(empty.data) && empty.data.length === 0) {
      ok("and returns an empty array when there genuinely are no threads");
    } else {
      bad("an empty list parses to []", JSON.stringify(empty).slice(0, 200));
    }
  }

  console.log("\n--- 1-4: a message arrives; the parent has never opened that contact ---");
  {
    const opened = await asTeacher("POST", "/api/messages/conversations/direct", {
      schoolId: SCHOOL, kind: "guardian", id: PARENT,
    });
    convTeacher = opened.body?.conversation?._id ?? null;
    await asTeacher("POST", `/api/messages/conversations/${convTeacher}/messages`, {
      schoolId: SCHOOL, body: "Child A did well today.",
    });
    note(`teacher's conversation ${convTeacher}`);

    const res = await Portal.fetchConversations(CHILD_A);
    console.log("       what the phone parsed:");
    console.log(JSON.stringify(res, null, 2).split("\n").slice(0, 20)
      .map((l) => "         " + l).join("\n"));

    const rows = res.data ?? [];
    if (rows.length === 1 && String(rows[0]._id) === String(convTeacher)) {
      ok("the conversation is in what the phone parsed, unopened");
    } else {
      bad("the phone receives the conversation",
        `${rows.length} row(s): ${JSON.stringify(rows.map?.((r) => r._id))}`);
    }
    if (res.stale === false) ok("marked fresh, not served from cache");
    else bad("the response is fresh", JSON.stringify(res.stale));
    if (rows[0]?.unread === 1) ok("with one unread");
    else bad("unread is 1", String(rows[0]?.unread));

    // Reload. A new module instance, a new axios, a fresh SecureStore read —
    // everything a restarted app rebuilds — over the same cache table.
    const Reloaded = loadMobileModule("src/services/portal.service.js", {
      "expo-secure-store": SecureStoreStub,
      "./api":             { API_URL: API },
      "../db/database":    { getDatabase: async () => fakeDb },
      "../db/schemaManager": { ensureTableSchema: async (_n, fn, db) => fn(db) },
    });
    const afterReload = await Reloaded.fetchConversations(CHILD_A);
    if ((afterReload.data ?? []).length === 1) ok("and it survives a restart of the app");
    else bad("the conversation survives a reload", JSON.stringify(afterReload).slice(0, 160));
  }

  console.log("\n--- 7-9: several conversations, newest first, counts agreeing ---");
  {
    // The parent opens a thread with the teacher's colleague, through the same
    // function new.js calls.
    await User.create({
      _id: "usr-bursar", name: "Ndi Grace", email: "b@example.test",
      password: "check-only-password", role: "bursar", schoolId: SCHOOL, isActive: true,
    });

    const before = seen.length;
    const conv2  = await Portal.openConversation("usr-bursar", "user");
    note(`openConversation sent: ${JSON.stringify(seen.slice(before))}`);
    note(`returned conversation ${conv2?._id}`);
    if (conv2?._id) ok("openConversation returns the thread it opened");
    else bad("openConversation returns a conversation", JSON.stringify(conv2));

    await Portal.sendMessage(conv2._id, "Good morning, about the fees.");

    const rows = (await Portal.fetchConversations(CHILD_A)).data ?? [];
    note(`ids in order: ${JSON.stringify(rows.map((r) => r._id))}`);
    if (rows.length === 2) ok("both conversations are in the list");
    else bad("all conversations appear", `${rows.length} row(s)`);

    if (String(rows[0]._id) === String(conv2._id)) {
      ok("the one with the newest message is first");
    } else {
      bad("ordered by latest message", `first is ${rows[0]?._id}, newest is ${conv2?._id}`);
    }

    const fromList = rows.reduce((n, r) => n + (r.unread ?? 0), 0);
    const me       = await Portal.fetchMe(CHILD_A);
    const notices  = await Portal.fetchNotifications(CHILD_A);
    const fromMe   = me.data?.unreadMessages ?? null;
    const msgRows  = (notices.data ?? []).filter((n) => n.kind === "message");

    note(`unread: list=${fromList}  me.unreadMessages=${fromMe}  message notices=${msgRows.length}`);
    if (fromList === fromMe) ok(`the badge count agrees with the list (${fromList})`);
    else bad("unread counts agree", `list ${fromList}, /me ${fromMe}`);
    if (msgRows.length === 1) ok("and the unread thread is a notice the phone can show");
    else bad("an unread thread appears among the notices", `${msgRows.length}`);
  }

  // ── The screen's own decision ───────────────────────────────────────────
  //
  // The last link. The service returns a value; the screen puts it in
  // `section` and prints the empty state from one expression. That expression
  // is lifted out of the screen and evaluated against what the service really
  // returned, so this is not a claim about what the render probably does.
  console.log("\n--- and what the screen does with it ---");
  {
    const screen = fs.readFileSync(path.join(MOBILE, "app/portal/index.js"), "utf8");

    const dataLine = /const\s+data\s*=\s*([^;]+);/.exec(screen);
    note(`screen reads: const data = ${dataLine?.[1]}`);
    if (dataLine && /section\?\.data/.test(dataLine[1])) {
      ok("the messages tab reads section.data, which is what the service returns");
    } else {
      bad("the screen reads section.data", dataLine?.[1] ?? "(not found)");
    }

    // The empty-state test, exactly as written in the tab.
    const emptyExpr = /\{\((data \?\? \[\])\)\.length === 0 \?/.exec(screen)
                   ?? /\((data \?\? \[\])\)\.length === 0/.exec(screen);
    if (!emptyExpr) {
      bad("the empty-state condition can be found",
        "Expected `(data ?? []).length === 0` in the messages tab.");
    } else {
      note(`empty state when: (${emptyExpr[1]}).length === 0`);

      const section = await Portal.fetchConversations(CHILD_A);
      const data    = section?.data;
      const isEmpty = new Function("data", `return (${emptyExpr[1]}).length === 0;`)(data);

      if (isEmpty === false) {
        ok('so the screen does NOT print "No conversations yet" — evaluated, not assumed');
      } else {
        bad('the screen does not print "No conversations yet"',
          `the expression returned true against ${JSON.stringify(data).slice(0, 160)}`);
      }
    }
  }

  // ── The cache, which is the other way a list goes empty ─────────────────
  console.log("\n--- a dead link shows the last good list, not an empty one ---");
  {
    // Point the module at a port nothing is listening on, so every request
    // fails the way a phone with no signal fails.
    const Offline = loadMobileModule("src/services/portal.service.js", {
      "expo-secure-store": SecureStoreStub,
      "./api":             { API_URL: "http://127.0.0.1:1/api" },
      "../db/database":    { getDatabase: async () => fakeDb },
      "../db/schemaManager": { ensureTableSchema: async (_n, fn, db) => fn(db) },
    });

    const res = await Offline.fetchConversations(CHILD_A).catch((e) => ({ error: e.message }));
    if (Array.isArray(res.data) && res.data.length === 2 && res.stale === true) {
      ok("both conversations come back from the cache, marked stale");
    } else {
      bad("the cached list is served when the link is down", JSON.stringify(res).slice(0, 200));
    }

    // And the cache key is per child, so a parent switching child offline is
    // not shown the other one's threads under the wrong name.
    const keys = [...fakeDb._rows.keys()].sort();
    note(`cache keys: ${JSON.stringify(keys)}`);
    if (keys.every((k) => k === "me" || k.includes(":"))) {
      ok("and every cached section is keyed by child");
    } else {
      bad("cache keys include the child", JSON.stringify(keys));
    }

    // The last way the reported string could appear honestly: a cache holding
    // an empty list from before, served silently while the link is down. The
    // screen has to say it is showing an old copy, or "no conversations yet"
    // is indistinguishable from "we could not ask".
    const screen = fs.readFileSync(path.join(MOBILE, "app/portal/index.js"), "utf8");
    const banner = /const stale = ([^;]+);/.exec(screen);
    if (banner && /section\?\.stale/.test(banner[1]) && /\{stale && \(/.test(screen)) {
      ok("and the screen shows an offline banner whenever the copy is cached");
    } else {
      bad("a cached list is labelled as cached",
        `const stale = ${banner?.[1] ?? "(not found)"}; banner present: ${/\{stale && \(/.test(screen)}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // FAILURE 2 — class notices, as the phone asks for them
  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n--- the notices, as stored ---");
  const mk = (id, extra) => Announcement.create({
    _id: id, schoolId: SCHOOL, title: id, body: "…", authorRole: "school_admin", ...extra,
  });
  await mk("notice-1-class-A",  { audience: "class", targetClasses: [CLASS_A] });
  await mk("notice-2-class-B",  { audiences: ["parents"], targetClasses: [CLASS_B] });
  await mk("notice-3-class-C",  { audiences: ["parents"], targetClasses: [CLASS_C] });
  await mk("notice-4-schoolwide", { audience: "all" });
  for (const a of await Announcement.find({ schoolId: SCHOOL }).lean()) {
    note(`${String(a._id).padEnd(20)} audience=${String(a.audience).padEnd(6)} ` +
         `audiences=${JSON.stringify(a.audiences ?? null).padEnd(12)} ` +
         `targetClasses=${JSON.stringify(a.targetClasses ?? [])}`);
  }

  console.log("\n--- what the phone asks for, and what it gets ---");
  {
    const before = seen.length;
    const res    = await Portal.fetchAnnouncements(CHILD_A);
    const asked  = seen.slice(before);

    note(`fetchAnnouncements("${CHILD_A}") sent:`);
    for (const u of asked) note(`  ${u}`);

    if (asked.length === 1 && asked[0].startsWith("GET /api/portal/announcements")) {
      ok("GET /api/portal/announcements — the correct portal endpoint");
    } else {
      bad("the phone calls /api/portal/announcements", JSON.stringify(asked));
    }

    console.log("       what the phone parsed:");
    console.log(JSON.stringify(res.data, null, 2).split("\n").slice(0, 18)
      .map((l) => "         " + l).join("\n"));

    const titles = (res.data ?? []).map((a) => a.title);
    note(`titles: ${JSON.stringify(titles)}`);

    // Child A is in Class A, Child B is in Class B, and the token resolved
    // Child A. All four expectations from the report:
    if (titles.includes("notice-1-class-A")) ok("Notice 1 → Class A: visible");
    else bad("the Class A notice reaches the phone", JSON.stringify(titles));

    if (titles.includes("notice-2-class-B")) ok("Notice 2 → Class B: visible (the other child's class)");
    else bad("the Class B notice reaches the phone",
      `Child B (${CHILD_B}) is in ${CLASS_B} and the token resolved ${CHILD_A}.`);

    if (!titles.includes("notice-3-class-C")) ok("Notice 3 → Class C: invisible");
    else bad("the Class C notice is withheld", "no child of this parent is in Class C");

    if (titles.includes("notice-4-schoolwide")) ok("Notice 4 → school-wide: visible");
    else bad("the school-wide notice reaches the phone", JSON.stringify(titles));
  }

  console.log("\n--- and the phone adds no filter of its own ---");
  {
    // The question the report asks directly: does the client drop a notice the
    // server correctly returned? The news tab is the only place these are
    // rendered, so its map is the only place that could.
    const screen = fs.readFileSync(path.join(MOBILE, "app/portal/index.js"), "utf8");
    const start  = screen.indexOf('{tab === "news" &&');
    const news   = start === -1 ? "" : screen.slice(start, start + 1600);

    if (!news) {
      bad("the news tab can be found", 'no `{tab === "news" &&` in the screen');
    } else {
      // Filters applied to the LIST, not any filter anywhere in the branch:
      // the card maps forStudents to child names and drops the misses with a
      // .filter(Boolean), which is not this tab deciding what a parent may
      // read. The first version of this check counted every .filter( and
      // reported that one, which is the sort of finding that teaches people to
      // ignore the check.
      const listFilters = [
        ...news.matchAll(/\bdata\s*(?:\?\.|\.)\s*filter\(/g),
        ...news.matchAll(/\(\s*data\s*\?\?\s*\[\]\s*\)\s*\.filter\(/g),
      ];
      if (!listFilters.length) {
        ok("the news tab applies no filter to the list — it maps what it is given");
      } else {
        bad("the news tab does not filter the server's list",
          `${listFilters.length} filter(s) applied to \`data\` in the news branch`);
      }

      // Its empty state, evaluated against the real response like the other.
      const expr = /\((data\?\.length \?\? 0)\) === 0/.exec(news);
      if (!expr) {
        bad("the news empty-state condition can be found", news.slice(0, 160));
      } else {
        const section = await Portal.fetchAnnouncements(CHILD_A);
        const data    = section?.data;
        const isEmpty = new Function("data", `return (${expr[1]}) === 0;`)(data);
        note(`empty state when: (${expr[1]}) === 0  →  ${isEmpty}`);
        if (isEmpty === false) ok("so the news tab renders the notices rather than its empty state");
        else bad("the news tab renders the notices", `expression returned ${isEmpty}`);
      }

      // The cards are keyed and titled off fields the server sends.
      if (/a\.title/.test(news) && /a\.body/.test(news)) {
        ok("and reads title and body, which is what the endpoint returns");
      } else {
        bad("the card reads the fields the API sends", "title/body not referenced");
      }
    }
  }

  // ── Every URL, for the record ───────────────────────────────────────────
  console.log("\n--- every request the phone made ---");
  for (const u of seen.filter((u) => !u.startsWith("POST /api/messages"))) note(u);
  if (!missed.length) {
    ok(`${seen.length} requests, none unmatched`);
  } else {
    bad("every request matched a route", missed.join("\n"));
  }

  await server.close();
  await mongoose.disconnect();
  await mongo.stop();

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
