// mobile/scripts/check-sync-permissions.js
"use strict";

/**
 * A sync step that asks for something the account can never have.
 *
 * From a teacher's device, once per sync cycle:
 *
 *   ERROR [api] ❌ 403 ← /fees/structures
 *     "Access denied. This action requires \"fees.view\"."
 *
 * pullFeeStructures() skipped students and nobody else, so every teacher's
 * sync made a request that could not succeed. It was caught, and the rest of
 * the sync carried on, so nothing visibly broke — which is exactly why it
 * survived.
 *
 * What it cost: a wasted round trip on every sync, on the connection this app
 * exists to be careful with, and a red ERROR line in the device log every
 * time. A log that cries wolf on each cycle is one nobody reads when
 * something real happens, and that is the actual damage.
 *
 * ── The fragile part, and why this file exists ────────────────────────────
 *
 * The fix asks hasPermission("fees.view", [...roles]) before requesting. The
 * fallback list matters: a session stored before the permission layer shipped
 * has no permission list at all, and those roles are what stands in for it. If
 * that list ever drifts from the server's own default for fees.view, the
 * symptom is not an error — it is an admin or a bursar quietly no longer
 * receiving fee structures on their phone, offline, with nothing logged.
 *
 * So the list is checked against backend/src/config/roles.js itself rather
 * than against a copy of it written here.
 *
 *   node scripts/check-sync-permissions.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");

const MOBILE  = path.join(__dirname, "..");
const BACKEND = path.join(MOBILE, "..", "backend");

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const note = (label) => console.log(`       ${label}`);

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
  console.log("--- the guard the teacher's 403 came through ---");

  // Line endings normalised first. The repo stores these files CRLF, and the
  // slice below is written with \n — against CRLF it matches nothing, and the
  // whole section then reports the guard as missing when it is right there.
  const NL   = String.fromCharCode(10);
  const CRLF = String.fromCharCode(13) + NL;

  const SYNC = fs
    .readFileSync(path.join(MOBILE, "src/services/syncManager.js"), "utf8")
    .split(CRLF).join(NL);

  const body = SYNC.slice(SYNC.indexOf("async pullFeeStructures()"));
  const end  = body.indexOf(NL + "  }" + NL);
  const step = end === -1 ? body : body.slice(0, end);

  if (/hasPermission\(\s*["']fees\.view["']/.test(step)) {
    ok("pullFeeStructures asks about fees.view before requesting");
  } else {
    bad("the fee-structure pull is permission-guarded",
      "Without it every teacher's sync 403s once per cycle.");
  }

  // The old guard. Roles are the wrong instrument here: the server decides by
  // capability, and a school that grants a teacher fees.view should get the
  // structures on that teacher's phone.
  if (!/if \(this\.isStudent\(\)\) return;/.test(step)) {
    ok("and does not decide by role alone");
  } else {
    bad("the role-only guard is gone", "isStudent() is still the gate");
  }

  console.log("--- the fallback roles match the server's own default ---");

  /*
   * Read from the backend rather than restated here. A list copied into a
   * comment is a list that goes stale; this fails the day somebody changes
   * who may see fees on the server and does not think about the phone.
   */
  const ROLES_SRC = fs.readFileSync(path.join(BACKEND, "src/config/roles.js"), "utf8");

  const roleValue = (constName) => {
    const m = ROLES_SRC.match(new RegExp(`${constName}:\\s*"([^"]+)"`));
    return m ? m[1] : null;
  };

  const financeLine = ROLES_SRC.match(/const FINANCE_ROLES\s*=\s*\[([^\]]+)\]/);
  if (!financeLine) {
    bad("FINANCE_ROLES is readable from the backend", "the shape of roles.js changed");
  } else {
    const serverRoles = financeLine[1]
      .split(",")
      .map((x) => x.trim().replace(/^ROLES\./, ""))
      .filter(Boolean)
      .map(roleValue)
      .filter(Boolean);

    note(`server fees.view default: ${serverRoles.join(", ")}`);

    const guard = step.match(/hasPermission\(\s*["']fees\.view["']\s*,\s*\[([^\]]*)\]/);
    if (!guard) {
      bad("the fallback roles are readable", "hasPermission call not in the expected shape");
    } else {
      const mobileRoles = guard[1].split(",").map((x) => x.trim().replace(/["']/g, "")).filter(Boolean);
      note(`phone fallback:           ${mobileRoles.join(", ")}`);

      const missing = serverRoles.filter((r) => !mobileRoles.includes(r));
      if (!missing.length) {
        ok("every role the server allows is in the phone's fallback");
      } else {
        bad("the fallback covers the server's roles",
          `missing: ${missing.join(", ")} — those accounts would stop receiving ` +
          "fee structures offline, silently.");
      }

      /*
       * "admin" is deliberately extra: it was never a role in the User schema,
       * but sessions stored on phones can still say it — the backend's own
       * roles.js explains why it survived in twenty places. Anything ELSE
       * extra is a phone handing out a capability the server will refuse,
       * which puts the 403 back.
       */
      const extra = mobileRoles.filter((r) => !serverRoles.includes(r) && r !== "admin");
      if (!extra.length) {
        ok("and it grants nothing the server would refuse");
      } else {
        bad("the fallback is not wider than the server's",
          `extra: ${extra.join(", ")} — each one 403s on every sync.`);
      }

      if (mobileRoles.includes("admin")) {
        ok('including the legacy "admin" spelling a stored session may hold');
      } else {
        bad('the legacy "admin" role is tolerated',
          "A phone whose session says admin would stop pulling fee structures.");
      }

      if (!mobileRoles.includes("teacher") && !mobileRoles.includes("student")) {
        ok("and neither teachers nor students are in it — the reported bug");
      } else {
        bad("teachers and students are excluded", mobileRoles.join(", "));
      }
    }
  }

  console.log("--- hasPermission itself, on the three sessions a phone holds ---");

  let state = {};
  const auth = loadModule("src/utils/authHelpers.js", {
    "../store/auth.store": { useAuthStore: { getState: () => state } },
  });

  const FALLBACK = ["super_admin", "school_admin", "admin", "bursar"];

  // 1. A session carrying the server's permission list — the normal case now.
  state = { user: { role: "teacher", permissions: ["attendance.view", "exams.view"] }, token: "t" };
  if (!auth.hasPermission("fees.view", FALLBACK)) ok("a teacher with a list and no fees.view is refused");
  else bad("the permission list is honoured", "it allowed fees.view");

  // A school that DOES grant it must still get the structures. This is why the
  // guard asks about the capability and not the role.
  state = { user: { role: "teacher", permissions: ["fees.view"] }, token: "t" };
  if (auth.hasPermission("fees.view", FALLBACK)) ok("a teacher genuinely granted it is allowed");
  else bad("a granted capability wins over the role", "it refused");

  state = { user: { role: "bursar", permissions: ["fees.view"] }, token: "t" };
  if (auth.hasPermission("fees.view", FALLBACK)) ok("a bursar with the list is allowed");
  else bad("a bursar is allowed", "it refused");

  /*
   * 2. A session stored before the permission layer shipped. This app is built
   * to keep working from stored credentials for weeks without a successful
   * sign-in, so "no list" is a real and common state — and it must not be read
   * as "no capabilities", which would quietly stop an admin's phone syncing
   * fees after an update.
   */
  state = { user: { role: "school_admin" }, token: "t" };
  if (auth.hasPermission("fees.view", FALLBACK)) ok("an old admin session falls back to its role");
  else bad("the role fallback covers a session with no list", "it refused");

  state = { user: { role: "bursar" }, token: "t" };
  if (auth.hasPermission("fees.view", FALLBACK)) ok("so does an old bursar session");
  else bad("a bursar with no list falls back", "it refused");

  state = { user: { role: "teacher" }, token: "t" };
  if (!auth.hasPermission("fees.view", FALLBACK)) ok("and an old teacher session is still refused");
  else bad("a teacher with no list is refused", "it allowed fees.view");

  // 3. Signed out entirely. Not an error — sync checks this first — but it must
  // not read as permitted.
  state = {};
  if (!auth.hasPermission("fees.view", FALLBACK)) ok("no session at all is refused, not allowed");
  else bad("an empty session is refused", "it allowed fees.view");

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
