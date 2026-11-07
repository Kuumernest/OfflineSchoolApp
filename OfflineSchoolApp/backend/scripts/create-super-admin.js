// backend/scripts/create-super-admin.js
"use strict";

/**
 * Create the platform's FIRST super admin, on a database that has none.
 *
 * Why this exists: a new production database has no users, and every other
 * way to make a super admin (POST /api/super-admin/admins) needs a super admin
 * signed in. Without this, nobody could sign in to a fresh deployment.
 *
 * What it does:
 *   - refuses (exit 3) if ANY super_admin account exists, active or not: from
 *     then on, operators are made from the Platform settings page, where the
 *     audit trail names who made them;
 *   - refuses (exit 3) if the email is already used by any account;
 *   - creates one active super_admin with a generated password, flagged
 *     mustResetPassword, so the first sign-in can only change it
 *     (middleware/auth.js);
 *   - prints that password ONCE, to stdout, and nowhere else: not logged, not
 *     stored in clear, not in the audit row;
 *   - records superAdmin.created in the platform audit log, actor named as
 *     this script.
 *
 * The connection string is MONGODB_URI, the server's own: the account has to
 * exist in exactly the database the server signs people in against, and on
 * the VM the backend container's environment already holds it. It is never
 * printed: only the host and database name are.
 *
 *   node scripts/create-super-admin.js --email=ops@example.cm --name="Platform Operator"
 *
 * On the production VM, see docs/17 ("First super admin").
 *
 * Exit codes: 0 created · 1 error · 3 refused · 64 bad arguments.
 */

const crypto   = require("crypto");
const mongoose = require("mongoose");
const { ROLES }               = require("../src/config/roles");
const { isValidEmail }        = require("../src/utils/email");
const { passwordPolicyError } = require("../src/utils/passwordPolicy");

// No look-alikes (0/O, 1/l/I), so the password survives being read aloud or
// copied by hand once. 20 characters over 56 symbols ≈ 116 bits.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const LENGTH   = 20;

/** A random password that satisfies utils/passwordPolicy. */
function generatePassword() {
  for (;;) {
    let pw = "";
    for (let i = 0; i < LENGTH; i++) pw += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!passwordPolicyError(pw)) return pw;
  }
}

/**
 * @returns {Promise<{ ok: true, user: object, password: string }
 *                  | { ok: false, code: "SUPER_ADMIN_EXISTS" | "EMAIL_TAKEN" | "BAD_INPUT", message: string }>}
 */
async function createFirstSuperAdmin({ email, name, connection = mongoose.connection } = {}) {
  const cleanEmail = String(email ?? "").toLowerCase().trim();
  const cleanName  = String(name ?? "").trim();
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return { ok: false, code: "BAD_INPUT", message: "A valid --email is required" };
  }
  if (cleanName.length < 2 || cleanName.length > 200) {
    return { ok: false, code: "BAD_INPUT", message: "--name must be between 2 and 200 characters" };
  }

  const User = connection.model("User");
  if (await User.exists({ role: ROLES.SUPER_ADMIN })) {
    return {
      ok: false, code: "SUPER_ADMIN_EXISTS",
      message: "A super admin already exists. Create further operators from Platform settings, signed in as one.",
    };
  }
  if (await User.exists({ email: cleanEmail })) {
    return { ok: false, code: "EMAIL_TAKEN", message: `An account already uses ${cleanEmail}` };
  }

  const password = generatePassword();
  // Hashed by the model's pre("save") hook, which also stamps passwordChangedAt.
  const user = await User.create({
    name:              cleanName,
    email:             cleanEmail,
    password,
    role:              ROLES.SUPER_ADMIN,
    schoolId:          null,
    isActive:          true,
    mustResetPassword: true,
  });

  const { recordAudit } = require("../src/services/audit.service");
  await recordAudit({ user: { name: "scripts/create-super-admin.js" }, ip: null, headers: {} }, {
    action:   "superAdmin.created",
    resource: { type: "user", id: user._id, label: user.email },
    after:    { name: user.name, email: user.email, isActive: true },
  });

  return { ok: true, user, password };
}

module.exports = { createFirstSuperAdmin, generatePassword };

if (require.main === module) {
  (async () => {
    const arg = (name) => {
      const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
      return hit ? hit.slice(name.length + 3) : "";
    };
    const email = arg("email"), name = arg("name");
    if (!email || !name) {
      console.error('Usage: node scripts/create-super-admin.js --email=<address> --name="<full name>"');
      process.exit(64);
    }
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error("MONGODB_URI is not set: point it at the database the server uses.");
      process.exit(64);
    }

    require("../src/db/models");
    // As production connects: nothing built behind anybody's back.
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
    const { host, name: db } = mongoose.connection;
    console.log(`Creating the first super admin on host ${host}, database ${db}\n`);

    const out = await createFirstSuperAdmin({ email, name });
    await mongoose.disconnect();

    if (!out.ok) {
      console.error(`Refused: ${out.message}`);
      process.exit(out.code === "BAD_INPUT" ? 64 : 3);
    }
    console.log(`Created super admin ${out.user.email} (${out.user.name}).`);
    console.log("");
    console.log(`  Temporary password: ${out.password}`);
    console.log("");
    console.log("Shown once and not stored anywhere. Sign in with it now: the first");
    console.log("sign-in only allows changing it.");
    process.exit(0);
  })().catch(async (err) => {
    console.error(`create-super-admin: ${err.message}`);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });
}
