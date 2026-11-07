// backend/scripts/check-login-limits.js
"use strict";

/**
 * A whole school behind one address can sign back in; a password guesser
 * still cannot.
 *
 * ── The bug ───────────────────────────────────────────────────────────────
 *
 * POST /api/auth/login allowed 10 requests per 15 minutes per IP, and counted
 * SUCCESSFUL sign-ins. A school is one NAT address (and a mobile operator's
 * carrier-grade NAT is one address for whole towns), so after a power or
 * network outage the eleventh teacher to sign back in was refused for fifteen
 * minutes, and so was everybody after them. The guardian portal had the same
 * shape at 15.
 *
 * ── What is pinned ────────────────────────────────────────────────────────
 *
 *   staff/pupil   30 different accounts sign in from one address: all succeed
 *                 11 wrong passwords on one account: the 11th is limited
 *                 another account on the same address still signs in, and
 *                 still gets an honest 401 for its own typo
 *                 the limited account is limited for its correct password too
 *                 (the window is the point) — but only on that address
 *                 wrong passwords spread over many accounts from one address
 *                 still meet a per-address ceiling
 *   portal        30 parents sign in from one address: all succeed
 *                 failures across many admission numbers from one address
 *                 (the enumeration the route limiter exists for) are limited
 *
 * DISABLE_LOGIN_RATE_LIMIT is deliberately NOT set here.
 *
 *   node scripts/check-login-limits.js
 */

const { stopQuietly } = require("./stopQuietly");
const mongoose = require("mongoose");
const path     = require("path");
const bcrypt   = require("bcryptjs");

const SRC = path.join(__dirname, "..", "src");

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  process.env.NODE_ENV   = process.env.NODE_ENV || "test";
  delete process.env.DISABLE_LOGIN_RATE_LIMIT;

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
  await M("School").create({ _id: S, name: "Valley", code: "VA", email: "va@example.test", isActive: true });

  // Hashed at cost 4 and inserted through the driver: the login compares
  // against whatever cost the hash carries, and sixty cost-12 hashes would
  // make this check slow for nothing.
  const HASH = bcrypt.hashSync("Right-pass-1", 4);
  const users = [];
  for (let i = 1; i <= 40; i++) {
    users.push({ _id: `t${i}`, name: `Teacher ${i}`, email: `t${i}@valley.example.test`, role: "teacher",
      schoolId: S, isActive: true, password: HASH, mustResetPassword: false });
  }
  for (let i = 1; i <= 10; i++) {
    users.push({ _id: `s${i}`, name: `Pupil ${i}`, enrollmentNo: `VA-2026-${String(i).padStart(3, "0")}`,
      role: "student", schoolId: S, isActive: true, password: HASH, mustResetPassword: false });
  }
  await M("User").collection.insertMany(users);

  const express = require("express");
  const app = express(); app.use(express.json());
  app.use("/api/auth",   require(path.join(SRC, "routes/auth.routes")));
  app.use("/api/portal", require(path.join(SRC, "routes/portal.routes")));
  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;
  const post = async (url, body) => {
    const r = await fetch(`${API}${url}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return r.status;
  };
  const staff = (i, password = "Right-pass-1") => post("/auth/login", { email: `t${i}@valley.example.test`, password });
  const pupil = (i, password = "Right-pass-1") =>
    post("/auth/login", { enrollmentNo: `va-2026-${String(i).padStart(3, "0")}`, password });

  try {
    console.log("\n--- staff and pupil sign-in, one address ---");
    const ok = [];
    for (let i = 1; i <= 20; i++) ok.push(await staff(i));
    for (let i = 1; i <= 10; i++) ok.push(await pupil(i));
    check("30 different accounts sign in from one address, every one",
      [ok.length, ok.filter((s) => s === 200).length], [30, 30]);
    // And again, as a school does after a second outage the same morning.
    const again = [];
    for (let i = 1; i <= 20; i++) again.push(await staff(i));
    check("  and all sign in again in the same window", again.filter((s) => s === 200).length, 20);

    const tries = [];
    for (let k = 1; k <= 11; k++) tries.push(await staff(21, "Wrong-pass-" + k));
    check("11 wrong passwords on one account: ten honest 401s, then limited",
      [tries.slice(0, 10).every((s) => s === 401), tries[10]], [true, 429]);
    check("  another account on the same address still signs in", await staff(22), 200);
    check("  and still gets an honest 401 for its own typo", await staff(23, "Typo"), 401);
    check("  a pupil on the same address still signs in", await pupil(1), 200);
    check("  the limited account is limited for its correct password too", await staff(21), 429);
    check("  however the identifier is typed", await post("/auth/login", {
      email: "  T21@Valley.Example.TEST ", password: "Right-pass-1" }), 429);

    // A guesser spraying one password over many accounts never trips any one
    // account's limit; the per-address ceiling of failures is what stops it.
    let sprayed = 0, limited = false;
    for (let i = 24; i <= 40 && !limited; i++) {
      for (let k = 0; k < 9 && !limited; k++) {
        const s = await staff(i, `Spray-${k}`);
        if (s === 429) limited = true; else sprayed++;
      }
    }
    check("wrong passwords spread across many accounts still meet a per-address ceiling",
      [limited, sprayed < 150], [true, true]);

    console.log("\n--- guardian portal, one address ---");
    const portal = require(path.join(SRC, "services/portal.service"));
    const codes = [];
    for (let i = 1; i <= 30; i++) {
      const id = `ch${i}`;
      await M("Student").create({ _id: id, userId: `cu${i}`, schoolId: S, classId: "c1", studentName: `Child ${i}`,
        enrollmentNo: `VA-2026-P${String(i).padStart(3, "0")}`, status: "approved", isActive: true });
      const { code } = await portal.issueAccess({ schoolId: S, studentIds: [id], label: `Parent ${i}` });
      codes.push(code);
    }
    const portalOk = [];
    for (let i = 1; i <= 30; i++) {
      portalOk.push(await post("/portal/login", {
        schoolId: S, admissionNo: `VA-2026-P${String(i).padStart(3, "0")}`, code: codes[i - 1] }));
    }
    check("30 parents sign in to the portal from one address, every one",
      portalOk.filter((s) => s === 200).length, 30);

    let guesses = 0, portalLimited = false;
    for (let i = 1; i <= 200 && !portalLimited; i++) {
      const s = await post("/portal/login", { schoolId: S, admissionNo: `VA-2026-X${i}`, code: "WRONG-CODE" });
      if (s === 429) portalLimited = true; else guesses++;
    }
    check("guessing across admission numbers from one address is still limited",
      [portalLimited, guesses < 100], [true, true]);
  } finally {
    server.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
