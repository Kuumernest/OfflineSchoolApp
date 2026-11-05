// mobile/scripts/check-teacher-profile-sync.js
"use strict";

/**
 * A teacher's profile does not disappear.
 *
 * It used to: the server kept name and email only, and the profile screens
 * read the server's reply first — a reply with no `data` and no profile — so
 * online they showed blanks and an "incomplete" profile, offline the phone's
 * copy. Re-saving the blank form then overwrote the only copy, setup signed
 * the teacher out on the next launch (setUser without a token), and a
 * per-user store started with the profile table empty.
 *
 *   the server's reply, old and new, is read for what it holds — an old
 *     reply with no profile is "nothing", not an object of blanks
 *   a read merges server and phone field by field; a value beats a blank
 *   a profile only the phone has is queued for the server; one the server
 *     has and the phone lacks is saved to the phone
 *   offline, the phone's copy is shown
 *   saving a blank form over a stored profile changes nothing it left blank
 *   updateUser keeps the session token (setUser without one emptied it), and
 *     neither setup screen calls setUser any more
 *   switching to a per-user store carries this account's profile across
 *
 * Real SQLite (node:sqlite), the real service, auth store and per-user code.
 *
 *   node scripts/check-teacher-profile-sync.js
 */

const fs    = require("fs");
const path  = require("path");
const babel = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

const MOBILE = path.join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

const adapt = (db) => ({
  execAsync:     async (sql) => { db.exec(sql); },
  runAsync:      async (sql, params = []) => db.prepare(sql).run(...params),
  getAllAsync:   async (sql, params = []) => db.prepare(sql).all(...params),
  getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
});

const loadModule = (rel, stubs) => {
  const abs = path.join(MOBILE, rel);
  const { code } = babel.transformFileSync(abs, {
    presets: [require.resolve("babel-preset-expo")],
    caller:  { name: "check", supportsStaticESM: false },
    babelrc: false, configFile: false,
  });
  const dir = path.dirname(abs);
  const mod = { exports: {} };
  const req = (id) => (id in stubs ? stubs[id] : require(id.startsWith(".") ? path.resolve(dir, id) : id));
  new Function("module", "exports", "require", code)(mod, mod.exports, req);
  return mod.exports;
};

const FULL = {
  firstName: "Ama", lastName: "Mensah", gender: "female", dateOfBirth: "1990-04-12",
  nationalId: "GHA-123", qualification: "bsc", employmentType: "full_time", joinDate: "2020-09-01",
  yearsOfExperience: "6", previousSchool: "St. Mary's", phone: "+233200000001",
  alternatePhone: "+233200000002", address: "12 Ring Road", city: "Accra", state: "Greater Accra",
  emergencyName: "Kofi Mensah", emergencyPhone: "+233200000003", emergencyRelation: "brother",
  bloodGroup: "O+", medicalConditions: "none", bio: "Maths teacher.",
};

(async () => {
  let raw = new DatabaseSync(":memory:");
  let db  = adapt(raw);
  const queued = [];
  const TP = loadModule("src/services/teacherProfile.service.js", {
    "../db/database":  { getDatabase: async () => db },
    "../db/dbHelpers": loadModule("src/db/dbHelpers.js", {}),
    "./mutationQueue.service": { MutationQueue: { enqueue: async (m) => { queued.push(m); return "row"; } } },
  });
  const pick = (p) => Object.fromEntries(TP.FIELDS.map((f) => [f, p?.[f] ?? ""]));
  const apiReturning = (body) => ({ get: async () => ({ data: body }) });
  const apiOffline   = { get: async () => { throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }); } };
  const reset = () => { raw = new DatabaseSync(":memory:"); db = adapt(raw); TP.resetSchemaCache(); queued.length = 0; };

  console.log("--- the server's reply ---");
  const OLD_REPLY = { success: true, teacher: { _id: "t-1", name: "Ama Mensah", email: "a@x.test" }, assignments: [], summary: {} };
  check("an older server's reply (no profile) is nothing, not an object of blanks", TP.parseServerProfile(OLD_REPLY), null);
  const NEW_REPLY = { success: true, data: { id: "t-1", name: "Ama Mensah", ...FULL, profileCompleted: true }, teacher: {} };
  check("this server's reply is read from data", pick(TP.parseServerProfile(NEW_REPLY)), FULL);
  check("  with profileCompleted", TP.parseServerProfile(NEW_REPLY).profileCompleted, true);
  check("a reply carrying teacher.teacherProfile is read too",
    TP.parseServerProfile({ teacher: { teacherProfile: { qualification: "msc", completed: true } } })?.qualification, "msc");

  console.log("--- online, an older server: the phone's copy is shown and sent ---");
  reset();
  await TP.saveLocal("t-1", { ...FULL, profileCompleted: true });
  let r = await TP.loadProfile("t-1", { api: apiReturning(OLD_REPLY) });
  check("the profile shown is the phone's, not blanks", pick(r.profile), FULL);
  check("  and it is complete", r.profile.profileCompleted, true);
  check("  and it is queued for the server, once, as a merging PUT",
    [queued.length, queued[0]?.method, queued[0]?.endpoint, queued[0]?.entityKey, queued[0]?.merge],
    [1, "PUT", "/teacher/profile", "teacher-profile:t-1", true]);
  check("  carrying every field and the completed flag",
    [pick(queued[0]?.payload), queued[0]?.payload?.profileCompleted, queued[0]?.payload?.name], [FULL, true, "Ama Mensah"]);

  console.log("--- online, the server has it and this phone does not (a new phone) ---");
  reset();
  r = await TP.loadProfile("t-1", { api: apiReturning(NEW_REPLY) });
  check("the server's profile is shown", pick(r.profile), FULL);
  check("  saved to this phone", pick(await TP.getLocal("t-1")), FULL);
  check("  complete here too", await TP.isCompleteLocal("t-1"), true);
  check("  and nothing is queued", queued.length, 0);

  console.log("--- both have parts ---");
  reset();
  await TP.saveLocal("t-1", { qualification: "bsc", bio: "Maths teacher.", profileCompleted: true });
  r = await TP.loadProfile("t-1", { api: apiReturning({ data: { phone: "+233200000001", bio: "Head of maths.", profileCompleted: false } }) });
  check("a value beats a blank, and the server's value wins a disagreement",
    [r.profile.qualification, r.profile.phone, r.profile.bio, r.profile.profileCompleted],
    ["bsc", "+233200000001", "Head of maths.", true]);
  check("  what only the phone had is queued", [queued.length, queued[0]?.payload?.qualification], [1, "bsc"]);

  console.log("--- offline ---");
  reset();
  await TP.saveLocal("t-1", { ...FULL, profileCompleted: true });
  r = await TP.loadProfile("t-1", { api: apiOffline });
  check("offline, the phone's copy is shown", [pick(r.profile), r.source], [FULL, "local"]);
  check("  and nothing is queued (not reached)", queued.length, 0);

  console.log("--- a blank form saved over a stored profile ---");
  reset();
  await TP.saveLocal("t-1", { ...FULL, profileCompleted: true });
  const blank = Object.fromEntries(TP.FIELDS.map((f) => [f, ""]));
  await TP.saveLocal("t-1", { ...blank, phone: "+233200000009", profileCompleted: false });
  check("only the field it filled in changes", pick(await TP.getLocal("t-1")), { ...FULL, phone: "+233200000009" });
  check("  and the profile stays complete", await TP.isCompleteLocal("t-1"), true);

  console.log("--- the session token survives profile setup ---");
  const secure = new Map([
    ["auth_token", "jwt-abc"], ["auth_refresh_token", "rt-1"],
    ["user", JSON.stringify({ _id: "t-1", id: "t-1", name: "Ama", role: "teacher", schoolId: "s1" })],
  ]);
  const SecureStore = {
    getItemAsync:    async (k) => (secure.has(k) ? secure.get(k) : null),
    setItemAsync:    async (k, v) => { secure.set(k, v); },
    deleteItemAsync: async (k) => { secure.delete(k); },
  };
  const auth = loadModule("src/store/auth.store.js", {
    "expo-secure-store": SecureStore,
    "../services/api": { API_URL: "http://stub/api", refreshAccessToken: async () => null },
    "../utils/appError": { appError: (k, m) => new Error(m) },
    "../config/appBuild": { appBuildHeaders: () => ({}), isUpdateRequiredAnswer: () => false },
    "@react-native-community/netinfo": { default: { fetch: async () => ({ isConnected: false }) } },
    "../db/dbService": { DB: null },
    "../db/deviceDb": { checkLocalDataFormat: async () => ({ ok: true }), deviceDbExists: async () => false },
    "../services/perUserData.service": { prepareSession: async () => ({ mode: "legacy" }), needsPriming: async () => false, endSession: async () => {} },
  });
  const store = auth.useAuthStore || auth.default;
  const realLog = console.log; console.log = () => {};
  try {
    await store.getState().initAuth();
    await store.getState().updateUser({ name: "Ama Mensah", profileCompleted: true });
  } finally { console.log = realLog; }
  check("updateUser keeps the token, in memory and on the device",
    [store.getState().token, secure.get("auth_token"), store.getState().user?.name], ["jwt-abc", "jwt-abc", "Ama Mensah"]);
  for (const screen of ["app/teacher/profile/setup.js", "app/student/profile/setup.js"]) {
    const src = fs.readFileSync(path.join(MOBILE, screen), "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
    check(`${screen} calls updateUser, never setUser`, [/\bsetUser\b/.test(src), /\bupdateUser\b/.test(src)], [false, true]);
  }

  console.log("--- a per-user store carries this account's profile ---");
  const legacyRaw = new DatabaseSync(":memory:"); const legacy = adapt(legacyRaw);
  const storeRaw  = new DatabaseSync(":memory:"); const storeDb = adapt(storeRaw);
  db = legacy; TP.resetSchemaCache();
  await TP.saveLocal("t-1", { ...FULL, profileCompleted: true });
  await TP.saveLocal("t-2", { qualification: "other teacher", profileCompleted: true });
  legacyRaw.exec("CREATE TABLE student_profiles (student_id TEXT PRIMARY KEY, first_name TEXT, place_of_birth TEXT, profile_completed INTEGER DEFAULT 0)");
  legacyRaw.prepare("INSERT INTO student_profiles VALUES (?, ?, ?, 1)").run("t-1", "x", "y");
  const PU = loadModule("src/services/perUserData.service.js", {
    "expo-secure-store": SecureStore,
    "../db/database": {
      getDatabase: async () => legacy, openDatabaseFile: async () => storeDb, setActiveDatabase: () => {},
      activeDatabaseName: () => "x", closeDatabaseFile: async () => {}, deleteDatabaseFile: async () => {},
      LEGACY_DB_NAME: "schoolapp.db",
    },
    "../db/deviceDb": {}, "../db/rowHash": { hashRow: () => "h" }, "./syncState": { localIdsOf: () => [] },
    "../db/credentialCache": {},
  });
  await PU.syncSchema(legacy, storeDb);
  check("a new store starts with the table and no rows (as before)",
    storeRaw.prepare("SELECT COUNT(*) n FROM teacher_self_profile").get().n, 0);
  check("placeOwnProfile copies this account's rows", await PU.placeOwnProfile({ legacy, store: storeDb, uid: "t-1" }), 2);
  db = storeDb; TP.resetSchemaCache();
  check("  so the profile is there in the store", [pick(await TP.getLocal("t-1")), await TP.isCompleteLocal("t-1")], [FULL, true]);
  check("  and only this account's", [await TP.getLocal("t-2"), storeRaw.prepare("SELECT COUNT(*) n FROM teacher_self_profile").get().n], [null, 1]);
  await TP.saveLocal("t-1", { bio: "Newer, in the store." });
  check("a second pass keeps the store's own, newer copy",
    [await PU.placeOwnProfile({ legacy, store: storeDb, uid: "t-1" }), (await TP.getLocal("t-1")).bio], [0, "Newer, in the store."]);
  const flip = fs.readFileSync(path.join(MOBILE, "src/services/perUserData.service.js"), "utf8");
  check("finishFlip runs placeOwnProfile", /const finishFlip[\s\S]*?await placeOwnProfile\(\{ legacy, store, uid \}\)/.test(flip), true);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("check crashed:", e); process.exit(1); });
