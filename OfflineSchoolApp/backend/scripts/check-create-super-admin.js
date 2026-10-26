// backend/scripts/check-create-super-admin.js
"use strict";

/**
 * scripts/create-super-admin.js makes exactly one first super admin on a
 * database that has none: a strong generated password, flagged for change at
 * first sign-in, printed once and stored only as a hash; it refuses when any
 * super admin exists or the email is taken. In-memory MongoDB.
 *
 *   node scripts/check-create-super-admin.js
 */

const path = require("path");
const { spawn } = require("child_process");
const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");

const SCRIPT = path.join(__dirname, "create-super-admin.js");

(async () => {
  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
  };

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  const uri = mongo.getUri("first_admin");
  require("../src/db/models");
  await mongoose.connect(uri);
  const User = mongoose.model("User");
  const AuditLog = mongoose.model("AuditLog");
  const { createFirstSuperAdmin, generatePassword } = require("./create-super-admin");
  const { passwordPolicyError } = require("../src/utils/passwordPolicy");

  // ── the password ────────────────────────────────────────────────────────
  console.log("--- generated password ---");
  const samples = Array.from({ length: 200 }, generatePassword);
  check("200 generated passwords all pass the password policy",
    samples.filter((p) => passwordPolicyError(p)).length, 0);
  check("each is 20 characters", samples.every((p) => p.length === 20), true);
  check("no look-alike characters (0 O 1 l I)", samples.some((p) => /[0O1lI]/.test(p)), false);
  check("no two alike", new Set(samples).size, samples.length);

  // ── the function ────────────────────────────────────────────────────────
  console.log("\n--- on an empty database ---");
  check("a bad email is refused", (await createFirstSuperAdmin({ email: "nope", name: "Op" })).code, "BAD_INPUT");
  check("a one-letter name is refused", (await createFirstSuperAdmin({ email: "op@example.cm", name: "O" })).code, "BAD_INPUT");
  check("  and nothing was written", await User.countDocuments({}), 0);

  const made = await createFirstSuperAdmin({ email: " Op@Example.CM ", name: "  Platform Operator " });
  check("an empty database gets one", made.ok, true);
  const stored = await User.findById(made.user._id).select("+password").lean();
  check("the account: super_admin, no school, active, email and name cleaned",
    [stored.role, stored.schoolId, stored.isActive, stored.email, stored.name],
    ["super_admin", null, true, "op@example.cm", "Platform Operator"]);
  check("the first sign-in can only change the password", stored.mustResetPassword, true);
  check("stored as a bcrypt hash, never the password",
    [stored.password === made.password, /^\$2[aby]\$/.test(stored.password)], [false, true]);
  check("the hash matches the printed password",
    await (await User.findById(made.user._id).select("+password")).comparePassword(made.password), true);

  const audit = await AuditLog.find({ action: "superAdmin.created" }).lean();
  check("one audit row, actor named as the script",
    [audit.length, audit[0]?.actorName, audit[0]?.resourceLabel], [1, "scripts/create-super-admin.js", "op@example.cm"]);
  check("the audit row holds no password", JSON.stringify(audit).includes(made.password), false);

  console.log("\n--- once one exists ---");
  const again = await createFirstSuperAdmin({ email: "second@example.cm", name: "Second Operator" });
  check("a second run is refused", again.code, "SUPER_ADMIN_EXISTS");
  await User.updateOne({ _id: made.user._id }, { $set: { isActive: false } });
  check("still refused when the only super admin is deactivated",
    (await createFirstSuperAdmin({ email: "second@example.cm", name: "Second Operator" })).code, "SUPER_ADMIN_EXISTS");
  check("  and there is still exactly one", await User.countDocuments({ role: "super_admin" }), 1);

  console.log("\n--- an email already in use ---");
  await User.deleteMany({});
  await User.create({ name: "A Teacher", email: "taken@example.cm", password: "Teacher123", role: "teacher", schoolId: "s1" });
  check("an email any account uses is refused",
    (await createFirstSuperAdmin({ email: "TAKEN@example.cm", name: "Platform Operator" })).code, "EMAIL_TAKEN");
  check("  and no super admin was made", await User.countDocuments({ role: "super_admin" }), 0);

  // ── the command ─────────────────────────────────────────────────────────
  // Async, not spawnSync: mongod's output is piped to this process, and a
  // parent blocked in spawnSync stops draining it (check-calibration-export.js).
  console.log("\n--- the command ---");
  await User.deleteMany({});
  const run = (args, env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 120000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });

  check("no arguments: usage, exit 64", (await run([], { MONGODB_URI: uri })).status, 64);
  check("no MONGODB_URI: exit 64", (await run(["--email=a@b.cm", "--name=Op Erator"], { MONGODB_URI: "" })).status, 64);

  const first = await run(["--email=cli@example.cm", "--name=Command Line Op"], { MONGODB_URI: uri });
  const shown = first.stdout.match(/Temporary password: (\S+)/)?.[1] ?? null;
  check("creates one: exit 0, names the database", [first.status, /database first_admin/.test(first.stdout)], [0, true]);
  check("prints the password exactly once", shown ? first.stdout.split(shown).length - 1 : 0, 1);
  check("never prints the connection string", first.stdout.includes(uri) || first.stderr.includes(uri), false);
  const cli = await User.findOne({ email: "cli@example.cm" }).select("+password");
  check("the printed password signs in", Boolean(cli && shown && await cli.comparePassword(shown)), true);

  const second = await run(["--email=other@example.cm", "--name=Other Op"], { MONGODB_URI: uri });
  check("run again: refused, exit 3, nothing printed as a password",
    [second.status, /Temporary password/.test(second.stdout)], [3, false]);
  check("  still exactly one super admin", await User.countDocuments({ role: "super_admin" }), 1);

  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
