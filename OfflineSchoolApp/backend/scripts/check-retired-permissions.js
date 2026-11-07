// backend/scripts/check-retired-permissions.js
"use strict";

/**
 * A permission we removed does not break a school that still has it stored.
 *
 * sync.push was removed with POST /sync/push (owner decision; the route stays
 * and answers 410 SYNC_PUSH_RETIRED to any authenticated caller). A school's
 * settings.permissions may still name it — a hand edit, a restored backup, a
 * build where somebody wrote it. That row must:
 *
 *   • load: GET /api/admin/permissions answers 200, and neither the matrix nor
 *     any role's effective set mentions the key;
 *   • not decide anything: the bursar's other overrides still apply;
 *   • save: PUT /api/admin/permissions/:role succeeds — with or without the
 *     retired key in the body (a screen open on an older build) — and the
 *     stored lists no longer contain it afterwards;
 *   • not become a back door for typos: an unknown key is still a 400.
 *
 * Also: a session/login for a role reads its permission list without it.
 *
 *   node scripts/check-retired-permissions.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");
const path     = require("path");

const SRC = path.join(__dirname, "..", "src");

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  process.env.NODE_ENV   = process.env.NODE_ENV || "test";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const S = new mongoose.Types.ObjectId().toString();
  await M("School").create({ _id: S, name: "Hill Top", code: "HT", email: "ht@example.test" });
  // Written straight to the collection, past any model validation, the way a
  // hand edit or an old build would have left it.
  await M("School").collection.updateOne({ _id: new mongoose.Types.ObjectId(S) }, {
    $set: {
      "settings.permissions.bursar.granted":  ["sync.push", "gate.scan"],
      "settings.permissions.bursar.revoked":  ["sync.push"],
      "settings.permissions.teacher.granted": ["sync.push"],
    },
  });
  const raw = async () =>
    (await M("School").collection.findOne({ _id: new mongoose.Types.ObjectId(S) }))?.settings?.permissions;
  check("the stored override really does name sync.push (the case under test)",
    JSON.stringify(await raw()).includes("sync.push"), true);

  const express = require("express");
  const jwt     = require("jsonwebtoken");
  const auth    = require(path.join(__dirname, "..", "middleware/auth"));
  await M("User").create({ _id: "adm", name: "Registrar", email: "adm@ht.example.test",
    password: "check-only-password", role: "school_admin", schoolId: S, isActive: true });

  const app = express(); app.use(express.json());
  app.use("/api/admin/permissions", auth.authenticate, require(path.join(SRC, "routes/permissions.routes")));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
  const server = app.listen(0);
  const API   = `http://127.0.0.1:${server.address().port}/api`;
  const token = jwt.sign({ id: "adm", role: "school_admin", schoolId: S }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const call  = async (method, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };

  const perms = require(path.join(SRC, "services/permissions.service"));
  const { DEFAULTS_BY_ROLE } = require(path.join(SRC, "config/permissions"));

  try {
    console.log("\n--- loading permissions with a stored sync.push ---");
    let r = await call("GET", "/admin/permissions");
    check("GET answers 200", r.status, 200);
    const d = r.body?.data ?? {};
    check("  the matrix does not list sync.push", (d.matrix ?? []).some((m) => m.key === "sync.push"), false);
    check("  nor the locked keys", (d.lockedKeys ?? []).includes("sync.push"), false);
    check("  no role's effective set has it",
      Object.values(d.effective ?? {}).some((ks) => ks.includes("sync.push")), false);
    check("  the bursar's real grant still applies", (d.effective?.bursar ?? []).includes("gate.scan"), true);
    check("  and the teacher is exactly the defaults",
      [...(d.effective?.teacher ?? [])].sort(), [...DEFAULTS_BY_ROLE.teacher].sort());
    check("can() is false for the retired key, even for an admin",
      await perms.can({ role: "school_admin", schoolId: S }, "sync.push"), false);

    console.log("\n--- saving permissions with a stored sync.push ---");
    // What the screen sends: the effective set it was shown.
    r = await call("PUT", "/admin/permissions/bursar", { schoolId: S, permissions: d.effective.bursar });
    check("PUT the bursar's set as shown answers 200", r.status, 200);
    let stored = await raw();
    check("  the bursar's stored lists no longer name sync.push",
      [...(stored?.bursar?.granted ?? []), ...(stored?.bursar?.revoked ?? [])].includes("sync.push"), false);
    check("  and keep the real grant", stored?.bursar?.granted, ["gate.scan"]);

    // A screen still open on an older build sends the retired key back.
    r = await call("PUT", "/admin/permissions/teacher",
      { schoolId: S, permissions: [...d.effective.teacher, "sync.push"] });
    check("PUT with sync.push in the body is not a validation error", [r.status, r.body?.code ?? null], [200, null]);
    stored = await raw();
    check("  and sync.push is not saved back",
      [...(stored?.teacher?.granted ?? []), ...(stored?.teacher?.revoked ?? [])].includes("sync.push"), false);
    check("  nothing in the stored overrides names it any more", JSON.stringify(stored).includes("sync.push"), false);

    r = await call("PUT", "/admin/permissions/teacher",
      { schoolId: S, permissions: [...d.effective.teacher, "nope.nope"] });
    check("a real typo is still refused", [r.status, r.body?.code], [400, "UNKNOWN_PERMISSION"]);

    r = await call("GET", "/admin/permissions");
    check("GET after the saves still answers 200, still without sync.push",
      [r.status, JSON.stringify(r.body?.data).includes("sync.push")], [200, false]);
  } finally {
    server.close();
    await mongoose.disconnect();
    await stopQuietly(mongo);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
