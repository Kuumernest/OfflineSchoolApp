// backend/scripts/check-role-matrix.js
"use strict";

/**
 * Assert the role matrix.
 *
 * The bursar exists so that the person who handles a school's money is not
 * also the person who can change a child's grade. That separation is spread
 * across twenty route files, and nothing about reading any one of them tells
 * you whether the whole thing still holds. This pins it by example.
 *
 * What it proves:
 *   • the membership of every role set — a set quietly widened shows up here
 *   • what authorize() actually decides, per role, per set
 *   • which export workbooks each role may build (exports.js is plain data, so
 *     this is the real wiring rather than a restatement of it)
 *   • that the User model accepts the five roles and refuses anything else
 *   • that no route file still guards on the dead "admin" string
 *
 * What it does NOT prove: that a given route is wired to the set it ought to
 * be. That needs the app and a database. Section 5 is the cheap half of it —
 * it catches the specific regression this change was cleaning up.
 *
 * Pure — no database, no network. Safe to run anywhere.
 *
 *   node scripts/check-role-matrix.js
 */

const fs   = require("fs");
const path = require("path");

const roles = require("../src/config/roles");
const { authorize } = require("../middleware/auth");
const { kindsFor }  = require("../src/export/exports");
const User = require("../src/db/models/User");

const PERMS = require("../src/config/permissions");
const perms = require("../src/services/permissions.service");
const { requirePermission } = require("../middleware/permissions");

const { ROLES } = roles;

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL ${label}: got ${a}, expected ${e}`); }
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE SETS
// ─────────────────────────────────────────────────────────────────────────────

console.log("--- role sets ---");
check("ALL_ROLES", roles.ALL_ROLES,
  ["super_admin", "school_admin", "bursar", "teacher", "student"]);
check("ADMIN_ROLES    excludes the bursar", roles.ADMIN_ROLES.includes(ROLES.BURSAR),   false);
check("ADMIN_ROLES    excludes teachers",   roles.ADMIN_ROLES.includes(ROLES.TEACHER),  false);
check("FINANCE_ROLES  includes the bursar", roles.FINANCE_ROLES.includes(ROLES.BURSAR),  true);
check("FINANCE_ROLES  excludes teachers",   roles.FINANCE_ROLES.includes(ROLES.TEACHER), false);
check("TEACHING_ROLES excludes the bursar", roles.TEACHING_ROLES.includes(ROLES.BURSAR), false);
check("STAFF_ROLES    includes the bursar", roles.STAFF_ROLES.includes(ROLES.BURSAR),    true);

const everySet = [
  roles.ADMIN_ROLES, roles.FINANCE_ROLES, roles.OFFICE_ROLES,
  roles.TEACHING_ROLES, roles.STAFF_ROLES,
];
check("no staff set contains a student",
  everySet.filter((s) => s.includes(ROLES.STUDENT)).length, 0);

console.log("--- legacy and unknown role names ---");
check('"admin" normalises to school_admin',  roles.normalizeRole("admin"), "school_admin");
check('"  ADMIN " normalises too',           roles.normalizeRole("  ADMIN "), "school_admin");
check("bursar normalises to itself",         roles.normalizeRole("bursar"), "bursar");
check("an invented role normalises to null", roles.normalizeRole("principal"), null);
check("empty normalises to null",            roles.normalizeRole(""), null);
check("undefined normalises to null",        roles.normalizeRole(undefined), null);

// ─────────────────────────────────────────────────────────────────────────────
// 2. WHAT authorize() DECIDES
// ─────────────────────────────────────────────────────────────────────────────

/** Runs a guard against one role and answers whether it called next(). */
const decide = (guard, role) => {
  let allowed = false, status = null;
  const req = { user: role === null ? null : { role, _id: "u1", email: "u@x" } };
  const res = { status: (c) => { status = c; return res; }, json: () => res };
  guard(req, res, () => { allowed = true; });
  return { allowed, status };
};

const grid = (guard) => roles.ALL_ROLES.map((r) => decide(guard, r).allowed);

console.log("--- authorize(SET), in ALL_ROLES order: sadmin, admin, bursar, teacher, student ---");
check("ADMIN_ROLES",    grid(authorize(roles.ADMIN_ROLES)),    [true, true, false, false, false]);
check("FINANCE_ROLES",  grid(authorize(roles.FINANCE_ROLES)),  [true, true, true,  false, false]);
check("OFFICE_ROLES",   grid(authorize(roles.OFFICE_ROLES)),   [true, true, true,  false, false]);
check("TEACHING_ROLES", grid(authorize(roles.TEACHING_ROLES)), [true, true, false, true,  false]);
check("STAFF_ROLES",    grid(authorize(roles.STAFF_ROLES)),    [true, true, true,  true,  false]);

console.log("--- authorize() edge cases ---");
check("no user at all is a 401",
  decide(authorize(roles.STAFF_ROLES), null).status, 401);
check("a role outside the set is a 403",
  decide(authorize(roles.ADMIN_ROLES), ROLES.BURSAR).status, 403);
check("a spread of names still works",
  decide(authorize(ROLES.BURSAR, ROLES.TEACHER), ROLES.BURSAR).allowed, true);
check("an unrecognised name in the set is dropped, not honoured",
  decide(authorize(["janitor"]), "janitor").allowed, false);

// ─────────────────────────────────────────────────────────────────────────────
// 3. EXPORTS — the workbook menu each role is offered
// ─────────────────────────────────────────────────────────────────────────────

// kindsFor now takes the caller's effective capabilities rather than their
// role, so the menu follows a school's own permission changes. defaultsFor is
// the synchronous, database-free view of those capabilities, which is exactly
// what wants asserting here: the out-of-the-box answer.
const kindsForRole = (role) => kindsFor(perms.defaultsFor(role));

console.log("--- exports each role may build ---");
check("bursar",  kindsForRole(ROLES.BURSAR),
  ["students", "arrears", "payments", "expenses", "payroll"]);
check("teacher", kindsForRole(ROLES.TEACHER), ["students"]);
check("student", kindsForRole(ROLES.STUDENT), []);
check("school_admin gets everything", kindsForRole(ROLES.SCHOOL_ADMIN).length, 6);
check("super_admin gets everything",  kindsForRole(ROLES.SUPER_ADMIN).length, 6);
check("the bursar cannot export class history",
  kindsForRole(ROLES.BURSAR).includes("enrollments"), false);
check("no capabilities means no menu at all", kindsFor([]), []);
check("a garbage argument means no menu", kindsFor(undefined), []);

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE MODEL
// ─────────────────────────────────────────────────────────────────────────────

// Runs the schema's own enum validator, rather than building a document and
// calling validateSync() on it. Same verdict, but nothing here constructs a
// model instance or reaches for a connection.
//
// The point of asserting this at all: the model reads its enum from
// config/roles.js, so a role the guards honour is a role the database will
// store, and vice versa. Someone re-hardcoding the enum list — which is how it
// looked before this change — breaks that and fails here.
const enumValidator = User.schema.path("role").validators
  .find((v) => v.type === "enum").validator;

const roleVerdict = (role) =>
  enumValidator(role) ? "accepted" : "rejected";

const checkModel = () => {
  console.log("--- User.role validation ---");
  roles.ALL_ROLES.forEach((r) =>
    check(`${r} is storable`, roleVerdict(r), "accepted"));
  check('"admin" is NOT storable', roleVerdict("admin"), "rejected");
  check("an invented role is not storable", roleVerdict("principal"), "rejected");
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. NO DEAD "admin" STRING LEFT IN A GUARD
// ─────────────────────────────────────────────────────────────────────────────
//
// "admin" appeared in every guard list in this codebase and matched no account
// that could exist, because the User enum has never included it. Anything
// still comparing a role against it is either dead or wrong, so the string is
// banned from role position outright.
//
// The pattern matches "admin" only as a standalone quoted value: "school_admin"
// and "super_admin" are untouched, comments may discuss the old string, and
// policy.principalKind() answers a persona rather than a role.

const ROUTE_DIR = path.join(__dirname, "..", "src", "routes");

const checkRouteFiles = () => {
console.log('--- no route still guards on "admin" ---');

// server.js is in the list because it defines routes of its own, and the first
// version of this scan read only src/routes — which is precisely how
// POST /api/students/:id/enrollment-number kept its dead "admin" guard through
// the whole role sweep. A check that looks in the obvious place only finds the
// obvious mistakes.
const GUARD_FILES = fs.readdirSync(ROUTE_DIR)
  .filter((f) => f.endsWith(".routes.js"))
  .map((f) => path.join(ROUTE_DIR, f))
  .concat([path.join(__dirname, "..", "src", "server.js")]);

const offenders = GUARD_FILES
  .flatMap((full) => {
    const f    = path.basename(full);
    const body = fs.readFileSync(full, "utf8");
    return body
      .split(/\r?\n/)
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*");
      })
      .filter(({ line }) => /(^|[^_\w])["']admin["']/.test(line))
      .filter(({ line }) => !line.includes("principalKind"))
      .map(({ no }) => `${f}:${no}`);
  });
check("route files free of it", offenders, []);
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE OFFICE ALLOWLIST IN admin.routes.js
// ─────────────────────────────────────────────────────────────────────────────
//
// /api/admin is the school control panel and is ADMIN_ROLES throughout, with a
// short list of GETs the bursar may also make. That list is the one place in
// the codebase where a bursar is let past an admin guard, so it is pinned:
// adding to it must be a deliberate act somebody has to come here and confirm.
//
// Read from the source rather than imported, because the Set is a local inside
// the router and exporting it purely to be asserted would be a worse trade
// than a regex. What this proves is that the list has not grown; it does not
// prove the guard consults it, which section 2 does not cover either. Both
// would need the app and a database.

const ADMIN_ROUTES_SRC = () =>
  fs.readFileSync(path.join(ROUTE_DIR, "admin.routes.js"), "utf8");

/**
 * The [path, permission] pairs in admin.routes.js OFFICE_READABLE.
 *
 * Shared by the allowlist section and the usage scan below — the capabilities
 * named in that Map are genuine call sites, and a scan that only looked for
 * requirePermission() reported them as dead.
 *
 * @returns {Array<[string,string]>|null} sorted by path, or null if not found
 */
const officeAllowlist = (src) => {
  const block = /const OFFICE_READABLE = new Map\(\[([\s\S]*?)\]\);/.exec(src);
  if (!block) return null;

  // Each entry is ["<path>", "<permission>"]. Both halves are asserted: a path
  // added without a capability, or pointed at the wrong one, is the mistake
  // this is here to catch.
  return [...block[1].matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)]
    .map((m) => [m[1], m[2]])
    .sort((a, b) => a[0].localeCompare(b[0]));
};

const checkOfficeAllowlist = () => {
  console.log("--- the office allowlist on /api/admin ---");

  const src = ADMIN_ROUTES_SRC();

  const entries = officeAllowlist(src);
  if (!entries) {
    fail++;
    console.log("  FAIL OFFICE_READABLE not found in admin.routes.js");
    return;
  }

  const paths = entries.map(([p]) => p);

  check("exactly these four paths, GET only", paths,
    ["/classes", "/school-info", "/students", "/students/approved"]);

  check("each one names the capability it should", entries, [
    ["/classes",           "classes.view"],
    ["/school-info",       "school.view"],
    ["/students",          "students.view"],
    ["/students/approved", "students.view"],
  ]);

  check("every capability it names is real",
    paths.length && entries.filter(([, k]) => !PERMS.isPermission(k)), []);

  // None of these may be a locked one. A locked capability reached through the
  // allowlist would be enforcement a school could neither see nor adjust.
  check("none of them is locked",
    entries.filter(([, k]) => PERMS.LOCKED_KEYS.includes(k)), []);

  // The admission queue is the boundary case: it sits one path segment away
  // from a roster read and is a different kind of decision entirely.
  check("the admission queue is not on it",
    paths.includes("/students/pending"), false);
  check("nothing under /settings is on it",
    paths.filter((p) => p.startsWith("/settings")), []);
};

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 7. PERMISSIONS
// ─────────────────────────────────────────────────────────────────────────────
//
// The equivalence proof for the whole permission layer.
//
// Every route that moved from authorize(SET) to requirePermission(key) is safe
// only if the key's default holders are exactly SET. Asserted here for all of
// them at once, by construction rather than route by route: the registry
// declares its defaults AS the sets from roles.js, so what this really checks
// is that the inversion into DEFAULTS_BY_ROLE did not lose or invent anybody.

const checkPermissions = () => {
  console.log("--- the registry ---");

  check("every key is module.action",
    PERMS.PERMISSION_KEYS.filter((k) => !/^[a-z]+\.[a-zA-Z]+$/.test(k)), []);
  check("no duplicate keys",
    PERMS.PERMISSION_KEYS.length, new Set(PERMS.PERMISSION_KEYS).size);
  check("every definition names a real role set",
    PERMS.PERMISSION_DEFS.filter((d) =>
      !Array.isArray(d.defaults) ||
      d.defaults.some((r) => !roles.ALL_ROLES.includes(r))
    ).map((d) => d.key), []);

  console.log("--- defaults match the role sets they were derived from ---");

  // For each permission: the set of roles whose DEFAULTS include it must equal
  // the set the definition declared. A one-line proof that no route changed
  // audience when it migrated.
  const mismatched = PERMS.PERMISSION_DEFS.filter((d) => {
    const holders = roles.ALL_ROLES.filter((r) =>
      PERMS.DEFAULTS_BY_ROLE[r].includes(d.key)
    );
    // super_admin holds everything by fiat, so it is excluded from the
    // comparison — it appears in every set in roles.js anyway.
    const expected = [roles.ROLES.SUPER_ADMIN, ...d.defaults.filter(
      (r) => r !== roles.ROLES.SUPER_ADMIN
    )];
    return JSON.stringify(holders.sort()) !== JSON.stringify([...new Set(expected)].sort());
  }).map((d) => d.key);

  check("no permission changed audience", mismatched, []);

  console.log("--- what each role holds out of the box ---");
  check("super_admin holds every capability",
    perms.defaultsFor(ROLES.SUPER_ADMIN).length, PERMS.PERMISSION_KEYS.length);
  check("school_admin holds every capability",
    perms.defaultsFor(ROLES.SCHOOL_ADMIN).length, PERMS.PERMISSION_KEYS.length);
  check("student holds none", perms.defaultsFor(ROLES.STUDENT), []);
  check("an unrecognised role holds none", perms.defaultsFor("principal"), []);

  // The four that matter most. Spelled out rather than counted, because a count
  // stays green while the contents rot.
  const bursar = perms.defaultsFor(ROLES.BURSAR);
  check("bursar can run the ledger",
    ["fees.view", "fees.manage", "expenses.manage", "payroll.process"]
      .every((k) => bursar.includes(k)), true);
  check("bursar cannot touch a mark",
    ["results.edit", "results.publish", "exams.manage"]
      .some((k) => bursar.includes(k)), false);
  check("bursar cannot administer the school",
    ["users.manage", "settings.manage", "permissions.manage", "promotion.run",
     "students.admit", "messages.audit", "teachers.manage", "payroll.setSalary"]
      .some((k) => bursar.includes(k)), false);
  check("bursar reads the roster and the classes",
    ["students.view", "classes.view"].every((k) => bursar.includes(k)), true);

  // The §12 split, as capabilities: raising is part of running the fee desk,
  // deciding is somebody else's job. If these two ever land in the same set the
  // approval workflow becomes theatre.
  check("bursar may raise a request",
    bursar.includes("approvals.view"), true);
  check("bursar may ask for a refund or a waiver",
    ["fees.refund", "fees.waive"].every((k) => bursar.includes(k)), true);
  check("bursar may NOT decide one",
    bursar.includes("approvals.decide"), false);
  check("bursar may NOT set the thresholds",
    bursar.includes("approvals.configure"), false);
  check("a teacher has nothing to do with any of it",
    perms.defaultsFor(ROLES.TEACHER).filter((k) => k.startsWith("approvals.")), []);

  console.log("--- what a school may and may not delegate ---");
  check("delegable + locked covers everything",
    PERMS.DELEGABLE_KEYS.length + PERMS.LOCKED_KEYS.length,
    PERMS.PERMISSION_KEYS.length);
  check("only bursar and teacher are adjustable",
    PERMS.ADJUSTABLE_ROLES, ["bursar", "teacher"]);

  // The locks that hold the whole design together. If any of these becomes
  // delegable, a school can tick a box and undo the separation of duties.
  const mustBeLocked = [
    "results.edit", "results.publish", "exams.manage", "reports.manage",
    "users.manage", "teachers.manage", "permissions.manage",
    "promotion.run", "messages.audit", "sync.push",
    "students.admit", "students.delete", "payroll.setSalary",
    "documents.manage",
    // The countersignature. A school that could grant approvals.decide to the
    // bursar would have a workflow asking one person to sign their own work,
    // which is worse than no workflow because it looks like a control.
    "approvals.decide", "approvals.configure",
  ];
  check("every lock is still locked",
    mustBeLocked.filter((k) => !PERMS.LOCKED_KEYS.includes(k)), []);

  console.log("--- overrides are filtered on the way in and the way out ---");

  const dirty = perms.cleanOverrides({
    bursar:  { granted: ["gate.scan", "results.edit", "nope.nope"], revoked: ["fees.manage"] },
    teacher: { granted: ["fees.view"], revoked: ["results.edit"] },
    // Not adjustable. Must vanish entirely rather than be carried around.
    school_admin: { revoked: ["permissions.manage"] },
    super_admin:  { revoked: ["users.manage"] },
  });

  check("a locked grant is dropped", dirty.bursar.granted, ["gate.scan"]);
  check("an unknown key is dropped",
    dirty.bursar.granted.includes("nope.nope"), false);
  check("a delegable revoke survives", dirty.bursar.revoked, ["fees.manage"]);
  check("a locked revoke is dropped", dirty.teacher.revoked, []);
  check("school_admin cannot be adjusted", "school_admin" in dirty, false);
  check("super_admin cannot be adjusted", "super_admin" in dirty, false);

  // A key in both lists is a contradiction. Revoked wins: of two readings of an
  // ambiguous instruction, take the one that grants less.
  const both = perms.cleanOverrides({
    bursar: { granted: ["gate.scan"], revoked: ["gate.scan"] },
  });
  check("granted and revoked together resolves to revoked",
    [both.bursar.granted, both.bursar.revoked], [[], ["gate.scan"]]);

  console.log("--- the write path refuses what it should ---");

  const rejects = async (label, args, code) => {
    try {
      await perms.setRolePermissions(args);
      check(label, "no error", code);
    } catch (err) {
      check(label, err.code, code);
    }
  };

  console.log("--- requirePermission fails loudly at startup ---");
  let threw = false;
  try { requirePermission("not.areal.key"); } catch { threw = true; }
  check("an unknown key throws when the route is defined", threw, true);
  check("a real key does not", typeof requirePermission("fees.view"), "function");

  return { rejects };
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. NO DEAD OR MISSPELLED PERMISSIONS
// ─────────────────────────────────────────────────────────────────────────────
//
// Two directions, both cheap and both real:
//
//   A key used in the code that is not in the registry — requirePermission
//   throws on those at startup, but a can() call or a string in a client
//   payload would not, and this catches them without booting the app.
//
//   A key in the registry that nothing uses. Harmless at runtime and dishonest
//   on the permissions screen: an administrator ticking a box that controls
//   nothing has been told a lie about their own school.

const checkPermissionUsage = () => {
  console.log("--- every permission is used, every use is a permission ---");

  const SRC = path.join(__dirname, "..");
  const skip = new Set(["node_modules", ".git", "uploads", "scripts"]);

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (skip.has(e.name)) return [];
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith(".js") ? [full] : [];
  });

  const files = walk(SRC).filter((f) => !f.includes("config" + path.sep + "permissions.js"));
  const blob  = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");

  // Only strings in a position that ACTUALLY asks about a permission. The first
  // version of this matched every quoted dotted string in the codebase and
  // reported "attendance.absent", "gate.arrival" and "settings.permissions" as
  // misspelled permissions — a check that cries wolf gets switched off, so it
  // reads call sites rather than text.
  const CALL_SITES = [
    /requirePermission\(\s*["']([^"']+)["']/g,
    /requireAnyPermission\(([^)]*)\)/g,
    /\bcan\(\s*[^,]+,\s*["']([^"']+)["']/g,
    /permission:\s*["']([^"']+)["']/g,
  ];

  const used = new Set();
  for (const re of CALL_SITES) {
    for (const m of blob.matchAll(re)) {
      // requireAnyPermission takes a list, so pull every quoted key out of it.
      for (const q of m[1].matchAll(/["']([^"']+)["']/g)) used.add(q[1]);
      if (!/["']/.test(m[1])) used.add(m[1].trim());
    }
  }

  // The admin router consults its capabilities through a lookup table rather
  // than a call, so they are read from the table itself.
  (officeAllowlist(ADMIN_ROUTES_SRC()) ?? []).forEach(([, k]) => used.add(k));

  const unknown = [...used]
    // middleware/permissions.js names the offending key in its own throw, which
    // the regex reads as a call site. A template placeholder is not a key.
    .filter((k) => !k.includes("${"))
    .filter((k) => !PERMS.isPermission(k));
  check("no misspelled permission keys at any call site", unknown, []);

  const unused = PERMS.PERMISSION_KEYS.filter((k) => !used.has(k));
  check("no permission the code never checks", unused, []);
};

checkModel();
checkRouteFiles();
checkOfficeAllowlist();
const { rejects } = checkPermissions();
checkPermissionUsage();

(async () => {
  await rejects("a non-adjustable role is refused",
    { schoolId: "s1", role: "school_admin", desired: [] }, "ROLE_NOT_ADJUSTABLE");
  await rejects("an unrecognised role is refused",
    { schoolId: "s1", role: "principal", desired: [] }, "ROLE_NOT_ADJUSTABLE");
  await rejects("a missing schoolId is refused",
    { role: "bursar", desired: [] }, "BAD_REQUEST");
  await rejects("an unknown permission is reported, not ignored",
    { schoolId: "s1", role: "bursar", desired: ["fees.view", "nope.nope"] },
    "UNKNOWN_PERMISSION");
  // The bursar does not hold results.edit, so asking for it is an attempt to
  // grant a locked capability.
  await rejects("granting a locked capability is refused",
    { schoolId: "s1", role: "bursar", desired: ["results.edit"] },
    "PERMISSION_LOCKED");
  // The teacher DOES hold results.edit by default, so omitting it is an attempt
  // to revoke a locked capability. Both directions must fail.
  await rejects("revoking a locked capability is refused",
    { schoolId: "s1", role: "teacher", desired: ["fees.view"] },
    "PERMISSION_LOCKED");

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();

