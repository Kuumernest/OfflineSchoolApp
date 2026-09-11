// mobile/scripts/check-teacher-profile-table.js
"use strict";

/**
 * Two features, one table name, incompatible schemas.
 *
 * From a teacher's phone, on the last step of Profile Setup:
 *
 *   Call to function 'NativeDatabase.prepareAsync' has been rejected.
 *   → Caused by: Error code : table teacher_profiles has no column named
 *     teacher_id
 *
 * `teacher_profiles` was being used for two unrelated things:
 *
 *   attendance.service.js   a DIRECTORY of every teacher in the school —
 *                           (id, schoolId, name, email, updated_at), filled
 *                           from sync so the register can list colleagues.
 *                           It is the only place that ever CREATED the table.
 *
 *   teacher/profile/setup   the signed-in teacher's own record — teacher_id
 *                           plus twenty-odd personal fields. It never created
 *                           anything; it just wrote, and assumed.
 *
 * CREATE TABLE IF NOT EXISTS is a no-op against a table that already exists,
 * so whichever feature touched the database first defined the shape — and on
 * a real device that is always attendance. The profile save then failed on
 * every phone, every time. It has never once worked.
 *
 * Three more call sites read the same colliding table behind
 * `.catch(() => null)`: the completeness guard, the setup form's own reload,
 * and the settings screen. Those did not crash — they returned nothing and
 * logged nothing, which is worse. A teacher who completed the form was asked
 * to complete it again on the next launch, and the settings screen showed an
 * empty profile, with no error either time.
 *
 * ── Why this runs against real SQLite ─────────────────────────────────────
 *
 * The bug IS the engine's constraint. A hand-written fake would have to
 * decide for itself that writing an undeclared column is an error, and a fake
 * that implements the thing under test proves nothing. node:sqlite enforces
 * it for real, exactly as the phone did.
 *
 *   node scripts/check-teacher-profile-table.js
 */

const path  = require("path");
const babel = require("@babel/core");
const { DatabaseSync } = require("node:sqlite");

const MOBILE = path.join(__dirname, "..");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const note = (label) => console.log(`       ${label}`);

/** expo-sqlite's async surface, over a real synchronous SQLite. */
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
  const req = (id) => {
    if (id in stubs) return stubs[id];
    return require(id.startsWith(".") ? path.resolve(dir, id) : id);
  };
  new Function("module", "exports", "require", code)(mod, mod.exports, req);
  return mod.exports;
};

(async () => {
  const raw = new DatabaseSync(":memory:");
  const db  = adapt(raw);

  const tables = () =>
    raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  const columns = (t) =>
    raw.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);

  console.log("--- the device's starting state: attendance got there first ---");

  /*
   * The attendance directory, verbatim from attendance.service.js. This is
   * what is on every phone in the field, and it is why the profile save
   * failed — not because anything was missing, but because something else
   * already owned the name.
   */
  raw.exec(`CREATE TABLE IF NOT EXISTS teacher_profiles (
    id         TEXT PRIMARY KEY,
    schoolId   TEXT,
    name       TEXT,
    email      TEXT,
    updated_at TEXT
  )`);
  raw.prepare(
    `INSERT INTO teacher_profiles (id, schoolId, name, email, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("t-1", "school-1", "A Colleague", "colleague@school.test", "2026-01-01T00:00:00Z");

  const dirCols = columns("teacher_profiles");
  note(`teacher_profiles: ${dirCols.join(", ")}`);
  if (!dirCols.includes("teacher_id")) ok("it has no teacher_id, as on the device");
  else bad("the fixture reproduces the device", "teacher_id was already there");

  // The write that failed on the phone, to prove the engine really rejects it
  // — otherwise everything below proves nothing.
  try {
    raw.prepare("INSERT INTO teacher_profiles (teacher_id) VALUES (?)").run("t-1");
    bad("the directory rejects a profile write",
      "It accepted one, so this fixture is not reproducing the device.");
  } catch (err) {
    if (/no column named teacher_id/.test(err.message)) {
      ok("and rejects the profile write exactly as the device did");
      note(`  "${err.message.split("\n")[0]}"`);
    } else {
      bad("the failure matches the device's", err.message);
    }
  }

  console.log("--- the teacher's own profile now has its own table ---");

  const TeacherProfile = loadModule("src/services/teacherProfile.service.js", {
    "../db/database":  { getDatabase: async () => db },
    "../db/dbHelpers": loadModule("src/db/dbHelpers.js", {}),
  });

  const TABLE = TeacherProfile.TABLE;
  note(`profile table: ${TABLE}`);

  /*
   * THE ASSERTION THAT GUARDS THE FIX. If this name ever becomes
   * teacher_profiles again — by someone "tidying up" the two into one — every
   * save on every device starts failing again, and three of the four call
   * sites will swallow it silently.
   */
  if (TABLE !== "teacher_profiles") ok("and it is NOT the attendance directory's name");
  else bad("the profile must not share the directory's table", TABLE);

  const PROFILE = {
    firstName: "Bern", lastName: "Constance", gender: "female",
    dateOfBirth: "1990-04-02", nationalId: "NID-77", staffId: "STF-12",
    qualification: "bsc", employmentType: "full_time", joinDate: "2021-09-01",
    yearsOfExperience: "5", previousSchool: "Lycée Bilingue",
    phone: "+237600000000", alternatePhone: "+237699999999",
    address: "Rue 1", city: "Buea", state: "South-West",
    emergencyName: "A Relative", emergencyPhone: "+237611111111",
    emergencyRelation: "spouse", bloodGroup: "O+",
    medicalConditions: "none", bio: "Teaches mathematics.",
    profileCompleted: true,
  };

  // The save that produced the dialog in the screenshot.
  try {
    await TeacherProfile.saveLocal("t-1", PROFILE);
    ok("the save that used to throw now succeeds");
  } catch (err) {
    bad("saveLocal completes", err.message);
  }

  const after = tables();
  if (after.includes(TABLE) && after.includes("teacher_profiles")) {
    ok("both tables exist side by side");
  } else {
    bad("the two tables coexist", after.join(", "));
  }

  console.log("--- and the directory is untouched ---");

  // Fixing the broken feature must not disturb the working one: the register
  // still needs to list colleagues, offline, from rows it already had.
  const stillThere = raw.prepare("SELECT * FROM teacher_profiles WHERE id = ?").get("t-1");
  if (stillThere?.name === "A Colleague") ok("the colleague row survived");
  else bad("the attendance directory is unchanged", JSON.stringify(stillThere));

  if (JSON.stringify(columns("teacher_profiles")) === JSON.stringify(dirCols)) {
    ok("and its schema was not altered");
  } else {
    bad("the directory's columns are untouched", columns("teacher_profiles").join(", "));
  }

  console.log("--- the record reads back in the form's own shape ---");

  const read = await TeacherProfile.getLocal("t-1");

  if (read) ok("the saved profile is found");
  else bad("getLocal returns the row", "null");

  const mismatched = Object.entries(PROFILE)
    .filter(([k]) => k !== "profileCompleted")
    .filter(([k, v]) => read?.[k] !== v)
    .map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(read?.[k])}`);

  if (!mismatched.length) ok("and every field round-trips, camelCase in and out");
  else bad("all fields round-trip", mismatched.join("\n"));

  if (read?.profileCompleted === true) ok("including the completed flag, as a boolean");
  else bad("profileCompleted is a boolean", JSON.stringify(read?.profileCompleted));

  console.log("--- the guard that kept re-asking a teacher to fill the form in ---");

  /*
   * isTeacherProfileComplete read the colliding table behind .catch(() =>
   * null), so offline it always answered false and the dashboard sent the
   * teacher back to Profile Setup on every launch. Silently: a swallowed
   * schema error is indistinguishable from an empty table.
   */
  if (await TeacherProfile.isCompleteLocal("t-1")) ok("a completed profile now reads as complete");
  else bad("isCompleteLocal sees the saved profile", "false");

  if (!(await TeacherProfile.isCompleteLocal("t-nobody"))) ok("and an unknown teacher still reads as incomplete");
  else bad("an unknown teacher is incomplete", "true");

  if (!(await TeacherProfile.isCompleteLocal(null))) ok("as does a missing id, rather than throwing");
  else bad("a null id is incomplete", "true");

  console.log("--- a second save updates rather than duplicating ---");

  await TeacherProfile.saveLocal("t-1", { ...PROFILE, phone: "+237622222222" });
  const rows = raw.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get();
  if (rows.n === 1) ok("still one row for this teacher");
  else bad("the upsert replaces rather than appends", `${rows.n} rows`);

  const updated = await TeacherProfile.getLocal("t-1");
  if (updated?.phone === "+237622222222") ok("carrying the new value");
  else bad("the update lands", JSON.stringify(updated?.phone));

  // A field absent from the second save must not silently survive from the
  // first: the form always sends the whole profile, and a half-updated record
  // would show a teacher stale data they thought they had changed.
  await TeacherProfile.saveLocal("t-1", { firstName: "Bern", profileCompleted: true });
  const sparse = await TeacherProfile.getLocal("t-1");
  if (sparse?.bio === "") ok("and a field left out of a later save is cleared, not stale");
  else bad("an omitted field is cleared", JSON.stringify(sparse?.bio));

  console.log("--- two teachers on one device do not collide ---");

  await TeacherProfile.saveLocal("t-2", { ...PROFILE, firstName: "Other", profileCompleted: false });
  const first  = await TeacherProfile.getLocal("t-1");
  const second = await TeacherProfile.getLocal("t-2");

  if (first?.firstName === "Bern" && second?.firstName === "Other") ok("each teacher keeps their own record");
  else bad("records are keyed per teacher", JSON.stringify({ first: first?.firstName, second: second?.firstName }));

  if (await TeacherProfile.isCompleteLocal("t-1") && !(await TeacherProfile.isCompleteLocal("t-2"))) {
    ok("and completeness is per teacher too");
  } else {
    bad("completeness is per teacher", "one answered for the other");
  }

  console.log("--- no screen writes a profile column of its own any more ---");

  /*
   * The original bug was a screen holding its own idea of the schema. Both
   * screens now go through the service, so the column names exist in one
   * place; this asserts they have not crept back.
   */
  const fs = require("fs");
  for (const rel of ["app/teacher/profile/setup.js", "app/teacher/settings/index.js"]) {
    const src = fs.readFileSync(path.join(MOBILE, rel), "utf8");
    // Ignore comments — both files explain the old bug by name.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (!/\b(FROM|INTO|UPDATE)\s+teacher_profiles\b/.test(code)) {
      ok(`${rel} no longer queries teacher_profiles`);
    } else {
      bad(`${rel} must not touch the directory`, "it still names teacher_profiles in a statement");
    }
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
