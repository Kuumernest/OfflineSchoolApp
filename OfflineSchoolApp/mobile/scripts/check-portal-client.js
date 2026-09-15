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

// The same guard the backend check scripts use: a mongod that will not
// stop must not turn a passing run into a failing one. These two print
// their summary AFTER teardown, so the throw suppressed the verdict too.
const { stopQuietly } =
  require(require("path").join(__dirname, "..", "..", "backend", "scripts", "stopQuietly"));
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
  if (typeof Portal.fetchConversations !== "function") {
    bad("the mobile portal service loads", `exports: ${exported.join(", ")}`);
    process.exit(1);
  }
  ok("src/services/portal.service.js loads");

  // ── Every screen gets what IT imports ───────────────────────────────────
  //
  // This check had the same blind spot as the bug it exists to catch, which is
  // worth writing down. It reached for `mod.exports` — the namespace, holding
  // every named export — and passed, while app/portal/index.js imports the
  // DEFAULT and got undefined for fetchConversations. Its own header says the
  // point is "the module the screen imports"; it then tested a different
  // object.
  //
  // So the import style is read out of each screen and honoured. A function
  // added to the service and forgotten in the default export now fails here
  // instead of on a parent's phone, in one tab, as an empty list.
  console.log("\n--- each portal screen gets the functions it calls ---");
  {
    const screens = [
      "app/portal/index.js",
      "app/portal/messages/new.js",
      "app/portal/messages/[id].js",
    ];

    for (const rel of screens) {
      const src = fs.readFileSync(path.join(MOBILE, rel), "utf8");
      const imp = /import\s+(\*\s+as\s+)?(\w+)\s+from\s+["'][^"']*portal\.service["']/.exec(src);
      if (!imp) { bad(`${rel} imports the portal service`, "no import found"); continue; }

      const isNamespace = Boolean(imp[1]);
      const alias       = imp[2];
      // The object that screen actually holds at runtime.
      const surface = isNamespace ? Portal : Portal.default;

      // Every property touched, called or not.
      //
      // Requiring a "(" was this check's second blind spot in a row: the tab
      // that broke reads its fetcher out of a map —
      //
      //     messages:   PortalService.fetchConversations,
      //
      // — a bare reference, invoked later as `fetcher(...)`. So the one usage
      // that mattered was the one shape the pattern could not see, and the
      // per-screen assertion passed with the bug reintroduced.
      const used = [...new Set(
        [...src.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, "g"))].map((m) => m[1])
      )].sort();

      const missing = used.filter((fn) => typeof surface?.[fn] !== "function");

      if (!missing.length) {
        ok(`${rel} (${isNamespace ? "namespace" : "default"}) — all ${used.length} calls resolve`);
      } else {
        bad(`${rel} calls only functions its import provides`,
          `imports the ${isNamespace ? "namespace" : "default"} export as \`${alias}\`\n` +
          `missing: ${missing.join(", ")}\n` +
          `A named export that is not in the default object is invisible to a\n` +
          `default import, and the call throws at the moment the tab is opened.`);
      }
    }

    // And the two surfaces must agree, so the next function cannot go missing.
    const named   = Object.keys(Portal).filter((k) => k !== "default" && typeof Portal[k] === "function");
    const inDefault = Object.keys(Portal.default ?? {});
    const notExported = named.filter((k) => !inDefault.includes(k));
    if (!notExported.length) {
      ok(`the default export carries all ${named.length} named functions`);
    } else {
      bad("the default export carries every named function",
        `missing: ${notExported.join(", ")}`);
    }
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
    // Either straight off `section`, or off the tab-guarded view of it — the
    // point is that it derives from the stored payload and nothing else.
    if (dataLine && /(?:section|forThisTab)\?\.data/.test(dataLine[1])) {
      ok("the messages tab reads the stored section, which is what the service returns");
    } else {
      bad("the screen reads the stored section", dataLine?.[1] ?? "(not found)");
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

  // ── One tab must never render another tab's payload ─────────────────────
  //
  // This is what actually reached the parent, and it took a red box on a phone
  // to find: `section` is one state slot for six tabs, each of which reads a
  // different SHAPE out of it. Fees and attendance are objects; results,
  // notices and messages are arrays.
  //
  // On a tab switch the new branch rendered the old tab's payload for as long
  // as the new fetch was in flight, and the spinner could not intervene
  // because its condition is `loading && !data` — the old payload made `data`
  // truthy. Two faces, one bug:
  //
  //   Fees → Messages       an object has no .length, so the empty-state test
  //                         was false and `.map()` was reached on an object:
  //                         "undefined is not a function", render error.
  //   Notices → Messages    an empty ARRAY crossed over and the tab printed
  //                         "No conversations yet" over a conversation that
  //                         was on the server the whole time.
  //
  // Asserted by evaluating the screen's own derivation against a foreign
  // payload, rather than by reading it and hoping.
  console.log("\n--- a tab cannot render another tab's data ---");
  {
    const screen = fs.readFileSync(path.join(MOBILE, "app/portal/index.js"), "utf8");

    const decl = /const\s+forThisTab\s*=\s*([^;]+);/.exec(screen);
    if (decl && /section\?\.tab\s*===\s*tab/.test(decl[1])) {
      ok("the screen only reads a section tagged with the current tab");
    } else {
      bad("section is matched against the tab before being read",
        `const forThisTab = ${decl?.[1] ?? "(not found)"}`);
    }

    if (/setSection\(\{\s*\.\.\.loaded,\s*tab\s*\}\)/.test(screen)) {
      ok("and every payload is tagged when it is stored");
    } else {
      bad("the payload carries the tab it was fetched for",
        "Expected setSection({ ...loaded, tab }).");
    }

    // The real shapes, from the real service, cross-wired on purpose.
    const feesSection = await Portal.fetchFees(CHILD_A);
    const isObject = feesSection.data && !Array.isArray(feesSection.data);
    if (isObject) ok("fees really does return an object, so the shapes really do differ");
    else bad("the fees payload is an object", typeof feesSection.data);

    const dataDecl = /const\s+data\s*=\s*([^;]+);/.exec(screen);
    const derive = new Function("section", "tab", `
      const forThisTab = section?.tab === tab ? section : null;
      return ${dataDecl[1]};
    `);

    // Standing on Messages while section still holds the Fees payload.
    const leaked = derive({ ...feesSection, tab: "fees" }, "messages");
    if (leaked === undefined || leaked === null) {
      ok("the fees payload is invisible to the messages tab");
    } else {
      bad("a foreign payload does not reach the messages tab",
        `messages tab would receive a ${Array.isArray(leaked) ? "array" : typeof leaked}`);
    }

    // And the render decision that crashed: with the leak closed, the empty
    // state is reached instead of .map() on an object.
    const emptyExpr = /\((data \?\? \[\])\)\.length === 0/.exec(screen);
    const decides = new Function("data", `
      const target = (${emptyExpr[1]});
      if (target.length === 0) return "empty-state";
      if (typeof target.map !== "function") return "CRASH";
      return "rows";
    `);
    if (decides(leaked) === "empty-state") {
      ok("so the messages tab shows its empty state rather than crashing");
    } else {
      bad("the messages tab cannot crash on a foreign payload",
        `it would ${decides(leaked)}`);
    }
    // Proof the assertion above is not vacuous: the old derivation crashes.
    const before = new Function("section", "tab", "return section?.data;")(
      { ...feesSection, tab: "fees" }, "messages"
    );
    if (decides(before) === "CRASH") {
      ok("and the derivation this replaced does crash, on the same payload");
    } else {
      bad("the old derivation is shown to be the fault", `it would ${decides(before)}`);
    }

    // Its own tab still reads it, or the fix would have broken every tab.
    const own = derive({ ...feesSection, tab: "fees" }, "fees");
    if (own && !Array.isArray(own)) ok("while the fees tab still reads its own payload");
    else bad("a tab reads its own payload", JSON.stringify(own).slice(0, 120));
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
    if (banner && /(?:section|forThisTab)\?\.stale/.test(banner[1]) && /\{stale && \(/.test(screen)) {
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
  // ═════════════════════════════════════════════════════════════════════════
  // THE SESSION — a parent is not asked for the code every morning
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Everything above ran on a hand-minted token. This is the real thing: the
  // real login, the real tokens in SecureStore, the real interceptors renewing
  // them — on a second, clean phone with its own store and its own cache, so
  // nothing the earlier sections did leaks in.
  console.log("\n--- a parent signs in once and stays signed in ---");
  const portalSvc  = require(path.join(BSRC, "services/portal.service"));
  const phoneStore = new Map();
  const PhoneStore = {
    getItemAsync:    async (k) => (phoneStore.has(k) ? phoneStore.get(k) : null),
    setItemAsync:    async (k, v) => { phoneStore.set(k, v); },
    deleteItemAsync: async (k) => { phoneStore.delete(k); },
  };
  const phoneDb = makeFakeDb();
  const phoneAt = (apiUrl) => loadMobileModule("src/services/portal.service.js", {
    "expo-secure-store":   PhoneStore,
    "./api":               { API_URL: apiUrl },
    "../db/database":      { getDatabase: async () => phoneDb },
    "../db/schemaManager": { ensureTableSchema: async (_n, fn, db) => fn(db) },
  });
  const Phone = phoneAt(API);
  // The same phone with no signal: every request is refused at the socket.
  const NoSignal = phoneAt("http://127.0.0.1:1/api");

  const sessionsOnRow = async () =>
    (await GuardianAccess.findOne({ _id: PARENT }).lean())?.sessions ?? [];

  /** Overnight, in one line: the stored access token is now in the past. */
  const expireAccessToken = () => {
    const { sid } = jwt.decode(phoneStore.get("portal_token"));
    phoneStore.set("portal_token", jwt.sign(
      { aud: "portal", accessId: PARENT, schoolId: SCHOOL, sid,
        exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET
    ));
  };

  // A real code, so the real login runs — the fixture had a placeholder hash.
  const { code } = await portalSvc.issueAccess({ schoolId: SCHOOL, accessId: PARENT });

  {
    await Phone.login({ admissionNo: "E-1", code });
    if (phoneStore.get("portal_token") && phoneStore.get("portal_refresh_token")) {
      ok("login keeps an access token AND a refresh token in SecureStore");
    } else {
      bad("login stores both tokens", `keys: ${[...phoneStore.keys()].join(", ")}`);
    }
    if (await Phone.hasSession()) ok("hasSession() — what the screen asks on launch — is true");
    else bad("hasSession() is true after login");

    const before = seen.length;
    const res    = await Phone.fetchMe(CHILD_A);
    if (res.stale === false && res.data?.student?._id === CHILD_A) ok("fetchMe → fresh data");
    else bad("fetchMe works with the fresh token", JSON.stringify(res).slice(0, 200));
    if (seen.length - before === 1) ok("one request; no refresh needed yet");
    else bad("no refresh on a fresh token", seen.slice(before).join("\n"));
  }

  console.log("\n--- next morning: the access token has lapsed ---");
  {
    expireAccessToken();
    const lapsed = phoneStore.get("portal_token");
    const before = seen.length;
    const res    = await Phone.fetchMe(CHILD_A);
    const asked  = seen.slice(before);
    for (const u of asked) note(`  ${u}`);

    if (res.stale === false && res.data?.student?._id === CHILD_A) {
      ok("fetchMe still returns fresh data — no sign-in screen");
    } else {
      bad("fetchMe survives an expired access token", JSON.stringify(res).slice(0, 200));
    }
    if (asked.includes("POST /api/portal/refresh")) ok("the client renewed through POST /api/portal/refresh on its own");
    else bad("the client called /refresh", JSON.stringify(asked));
    if (asked.filter((u) => u.startsWith("GET /api/portal/me")).length === 2) ok("and re-sent the request that had failed");
    else bad("the failed request is retried once", JSON.stringify(asked));
    const renewed = phoneStore.get("portal_token");
    if (renewed && renewed !== lapsed && jwt.decode(renewed).exp * 1000 > Date.now()) {
      ok("SecureStore now holds a renewed, unexpired access token");
    } else {
      bad("the renewed token was stored", String(renewed).slice(0, 40));
    }
    if (await Phone.hasSession()) ok("the session is untouched");
    else bad("the session survives a renewal");
  }

  console.log("\n--- offline for a day: nothing signs the parent out ---");
  {
    expireAccessToken();
    const before = seen.length;
    const res    = await NoSignal.fetchMe(CHILD_A);
    if (res?.stale === true && res.data?.student?._id === CHILD_A) {
      ok("with no signal, fetchMe serves the cached copy, marked stale");
    } else {
      bad("offline falls back to the cache", JSON.stringify(res).slice(0, 200));
    }
    if (phoneStore.get("portal_refresh_token")) ok("the refresh token is still there — no signal is not a 401");
    else bad("offline kept the session");
    if (seen.length === before) ok("and the server heard nothing");
    else bad("nothing reached the server", seen.slice(before).join("\n"));

    const back = await Phone.fetchMe(CHILD_A);
    if (back.stale === false) ok("signal back: the next request renews and succeeds");
    else bad("recovery after being offline", JSON.stringify(back).slice(0, 200));
  }

  console.log("\n--- three sections wake together with no access token ---");
  {
    // An app update that kept the session but not the short-lived token, or a
    // renewal whose reply never arrived. Every section asks at once.
    phoneStore.delete("portal_token");
    const before = seen.length;
    await Promise.all([
      Phone.fetchMe(CHILD_A), Phone.fetchFees(CHILD_A), Phone.fetchAnnouncements(CHILD_A),
    ]);
    const refreshes = seen.slice(before).filter((u) => u === "POST /api/portal/refresh").length;
    if (refreshes === 1) ok("one POST /api/portal/refresh, shared by all three");
    else bad("concurrent requests share one refresh", `${refreshes} refresh call(s)`);
    if (phoneStore.get("portal_token")) ok("and the access token is back in SecureStore");
    else bad("the pre-emptive refresh stored a token");
  }

  console.log("\n--- the parent signs out ---");
  {
    const token = phoneStore.get("portal_refresh_token");
    await Phone.signOut();
    if (!phoneStore.get("portal_token") && !phoneStore.get("portal_refresh_token")) {
      ok("both tokens are gone from SecureStore");
    } else {
      bad("signOut clears both tokens", `keys: ${[...phoneStore.keys()].join(", ")}`);
    }
    if (!(await Phone.hasSession())) ok("hasSession() is false — the screen shows the sign-in form");
    else bad("hasSession() is false after signOut");

    // signOut does not wait on the server; give the call a moment to land.
    for (let i = 0; i < 50 && !seen.includes("POST /api/portal/logout"); i++) {
      await new Promise((r) => setTimeout(r, 40));
    }
    if (seen.includes("POST /api/portal/logout")) ok("and the server was told: POST /api/portal/logout");
    else bad("signOut calls /logout", "not seen on the wire");
    await new Promise((r) => setTimeout(r, 40));
    const rows = await sessionsOnRow();
    if (!rows.some((s) => s.tokenHash === portalSvc.hashToken(token))) ok("the session is gone from the GuardianAccess row");
    else bad("the server ended the session", `${rows.length} session(s) on the row`);
    if (phoneDb._rows.size === 0) ok("the section cache was wiped for the next family");
    else bad("signOut wipes the cache", `${phoneDb._rows.size} row(s) left`);
  }

  console.log("\n--- the office revokes the code ---");
  {
    await Phone.login({ admissionNo: "E-1", code });
    await portalSvc.revokeAccess({ schoolId: SCHOOL, accessId: PARENT });
    let caught = null;
    try { await Phone.fetchMe(CHILD_A); } catch (err) { caught = err; }
    if (caught?.response?.status === 401 && caught.response.data?.code === "ACCESS_REVOKED") {
      ok("the very next request fails 401 ACCESS_REVOKED — no cache, no retry, straight to the screen");
    } else {
      bad("revocation reaches the phone at once",
        caught ? `${caught.response?.status} ${JSON.stringify(caught.response?.data)}` : "no error thrown");
    }
    // The session cannot renew either, and it is told WHY: the phone shows
    // "ask the school office", not "sign in again", to a parent who cannot.
    let refusal = null;
    try { await portalSvc.refresh({ refreshToken: phoneStore.get("portal_refresh_token") }); }
    catch (err) { refusal = err; }
    if (refusal?.status === 401 && refusal.code === "ACCESS_REVOKED") ok("and a refresh is refused with ACCESS_REVOKED, not SESSION_EXPIRED");
    else bad("refresh names the revocation", refusal ? `${refusal.status} ${refusal.code}` : "refresh succeeded");
  }

  console.log("\n--- every request the phone made ---");
  for (const u of seen.filter((u) => !u.startsWith("POST /api/messages"))) note(u);
  if (!missed.length) {
    ok(`${seen.length} requests, none unmatched`);
  } else {
    bad("every request matched a route", missed.join("\n"));
  }

  await server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
