// mobile/scripts/check-offline-credentials.js
"use strict";

/**
 * Offline sign-in credentials (docs/14 §offline credentials).
 *
 * The bug: auth.store.js hashed with CryptoJS.PBKDF2, crypto-js was never
 * installed, and the fallback stored `password + salt` — the password in
 * clear text — in `users`, which the per-user migration then copied into
 * device.db as it found it.
 *
 * Part 1, the KDF (src/security/passwordHash.js), with expo-crypto replaced
 * by a Node-crypto implementation of the same API (expo-crypto-node.js):
 *   - SHA-256, HMAC-SHA256 and PBKDF2-HMAC-SHA256 (both backends) against
 *     Node's crypto and the RFC 7914 §11 vectors;
 *   - the stored format, a wrong password, a tampered value, the old
 *     clear-text form, the timing-safe compare, the self-test refusing a
 *     broken digest; the time a sign-in's hash takes here.
 *
 * Part 2, the REAL auth store, deviceDb and perUserData over real SQLite
 * files (peruser-harness.js), with a stand-in /auth/login:
 *   A  switch off: an old clear-text value signs in offline (and is not
 *      changed by it); the next online sign-in replaces it; no byte of the
 *      password is left in any file; offline sign-in then uses the new value;
 *      wrong passwords are refused in both forms.
 *   B  switch on: setup:credentials copies another account's clear-text value
 *      into device.db; that account signs in offline with it; its next online
 *      sign-in replaces it in `users`, device.db AND its own store — no byte
 *      of its password anywhere on the phone.
 *
 *   node scripts/check-offline-credentials.js
 */

const fs   = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const { bootDevice, tmpDir, quietly } = require("./peruser-harness");
const { makeLoader } = require("./offline-harness");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`); }
};

const SCHOOL = "5c0e2e000000000000000001";
const ACCOUNTS = {
  "tea-a": { name: "Ama",  email: "ama@s.test",  role: "teacher",      pw: "Ama-secret-7781" },
  "adm-c": { name: "Head", email: "head@s.test", role: "school_admin", pw: "Head-secret-4412" },
};
const userOf = (id) => ({ _id: id, id, schoolId: SCHOOL, name: ACCOUNTS[id].name, email: ACCOUNTS[id].email, role: ACCOUNTS[id].role });

const server = { perUserLocalData: false, logins: 0 };
global.fetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body || "{}");
  const id = Object.keys(ACCOUNTS).find((k) => ACCOUNTS[k].email === body.email);
  const ok = String(url).endsWith("/auth/login") && id && body.password === ACCOUNTS[id].pw;
  server.logins++;
  return {
    ok, status: ok ? 200 : 401,
    json: async () => ok
      ? { success: true, token: `tok-${id}`, refreshToken: `ref-${id}`, user: userOf(id), localData: { perUserLocalData: server.perUserLocalData } }
      : { success: false, message: "Invalid email or password" },
  };
};
const noNetworkApi = new Proxy({}, { get: () => async () => { throw Object.assign(new Error("no network in this check"), { code: "ERR_NETWORK" }); } });

const hex = (u8) => Buffer.from(u8).toString("hex");
const enc = (s) => new Uint8Array(Buffer.from(s, "utf8"));

// ═════════════════════════════════════════════════════════════════════════════
async function partOne() {
  console.log("--- 1. the KDF ---");
  const expoCrypto = require("./expo-crypto-node");
  const P = makeLoader(new Map([["expo-crypto", expoCrypto]]), new Map())("src/security/passwordHash");

  let shaOk = true;
  for (let n = 0; n < 300; n++) {
    const m = nodeCrypto.randomBytes(n);
    if (hex(P.sha256(new Uint8Array(m))) !== nodeCrypto.createHash("sha256").update(m).digest("hex")) shaOk = false;
  }
  check("SHA-256 equals Node's for every length 0…299", shaOk, true);
  let hmacOk = true;
  for (const kl of [0, 1, 32, 63, 64, 65, 200]) {
    const k = nodeCrypto.randomBytes(kl), m = nodeCrypto.randomBytes(77);
    if (hex(P.hmacSha256(new Uint8Array(k), new Uint8Array(m))) !== nodeCrypto.createHmac("sha256", k).update(m).digest("hex")) hmacOk = false;
  }
  check("HMAC-SHA256 equals Node's (keys shorter than, equal to, longer than a block)", hmacOk, true);

  // RFC 7914 §11 (PBKDF2-HMAC-SHA256 test vectors).
  const v1 = "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783";
  const v2 = "4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d";
  check("RFC 7914 vector 1 (P=passwd, S=salt, c=1, 64 bytes), JS backend", hex(await P.pbkdf2Sha256(enc("passwd"), enc("salt"), 1, 64)), v1);
  check("RFC 7914 vector 1, expo-crypto digest backend", hex(await P.pbkdf2Sha256Native(enc("passwd"), enc("salt"), 1, 64)), v1);
  check("RFC 7914 vector 2 (P=Password, S=NaCl, c=80000, 64 bytes), JS backend", hex(await P.pbkdf2Sha256(enc("Password"), enc("NaCl"), 80000, 64)), v2);

  let pbOk = true, pbNat = true;
  for (let i = 0; i < 24; i++) {
    const pw = i % 4 === 0 ? `ünïcödé-密码-${"x".repeat(i * 4)}` : nodeCrypto.randomBytes(i * 3).toString("base64");
    const salt = nodeCrypto.randomBytes(16);
    const it = [1, 2, 3, 17, 1000][i % 5];
    const len = [32, 64, 20, 33][i % 4];
    const want = nodeCrypto.pbkdf2Sync(Buffer.from(pw, "utf8"), salt, it, len, "sha256").toString("hex");
    if (hex(await P.pbkdf2Sha256(P.utf8(pw), new Uint8Array(salt), it, len)) !== want) pbOk = false;
    if (i < 12 && hex(await P.pbkdf2Sha256Native(P.utf8(pw), new Uint8Array(salt), it, len)) !== want) pbNat = false;
  }
  check("PBKDF2 equals crypto.pbkdf2Sync: 24 random cases (unicode, >64-byte passwords, odd lengths)", pbOk, true);
  check("  the expo-crypto digest backend gives the same bytes", pbNat, true);
  check("UTF-8 encoding matches Buffer's", hex(P.utf8("añ€😀")), Buffer.from("añ€😀", "utf8").toString("hex"));

  const t0 = process.hrtime.bigint();
  const v = await P.hashPassword("correct horse");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const m = /^pbkdf2-sha256\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(v.hash);
  check("stored form: pbkdf2-sha256$10000$<16-byte salt>$<32-byte key>",
    [!!m, m && Number(m[1]), m && Buffer.from(m[2], "base64").length, m && Buffer.from(m[3], "base64").length, v.salt === m?.[2]], [true, 10000, 16, 32, true]);
  check("  the key is PBKDF2-HMAC-SHA256(password, salt, 10000) per Node",
    m?.[3], nodeCrypto.pbkdf2Sync("correct horse", Buffer.from(m?.[2] ?? "", "base64"), 10000, 32, "sha256").toString("base64"));
  check("  the salt comes from expo-crypto's CSPRNG (getRandomBytesAsync)", expoCrypto.calls.random > 0, true);
  const again = await P.hashPassword("correct horse");
  check("  two hashes of one password differ (fresh salt)", again.hash !== v.hash, true);
  console.log(`  ..   one sign-in's hash here (Node, JIT, incl. calibration): ${ms.toFixed(1)} ms`);

  check("the right password verifies", await P.verifyPassword("correct horse", v.salt, v.hash), { ok: true, legacy: false });
  check("a wrong password is refused", await P.verifyPassword("correct horsf", v.salt, v.hash), { ok: false, legacy: false });
  check("an empty password is refused", await P.verifyPassword("", v.salt, v.hash), { ok: false, legacy: false });
  const tampered = v.hash.slice(0, -6) + (v.hash.slice(-6, -5) === "A" ? "B" : "A") + v.hash.slice(-5);
  check("a tampered stored key is refused", (await P.verifyPassword("correct horse", v.salt, tampered)).ok, false);
  check("the old clear-text form still verifies (flagged legacy)", await P.verifyPassword("hunter2", "lq1abc9z", "hunter2lq1abc9z"), { ok: true, legacy: true });
  check("  a wrong password against it is refused", await P.verifyPassword("hunter3", "lq1abc9z", "hunter2lq1abc9z"), { ok: false, legacy: true });
  check("  a prefix of it is refused", await P.verifyPassword("hunter", "lq1abc9z", "hunter2lq1abc9z"), { ok: false, legacy: true });
  check("timingSafeEqual: equal / one byte off / different lengths",
    [P.timingSafeEqual(enc("abc"), enc("abc")), P.timingSafeEqual(enc("abc"), enc("abd")), P.timingSafeEqual(enc("abc"), enc("abcd"))], [true, false, false]);

  const broken = { ...expoCrypto, digest: async () => new Uint8Array(32).buffer };
  const PB = makeLoader(new Map([["expo-crypto", broken]]), new Map())("src/security/passwordHash");
  const refused = await PB.hashPassword("x").then(() => "hashed", (e) => e.message);
  check("a digest that disagrees with the JS SHA-256 stops hashing (self-test)", /differs from expo-crypto/.test(refused), true);
}

// ═════════════════════════════════════════════════════════════════════════════

const waitIdle = async (phone) => {
  for (let i = 0; i < 600 && phone.useAuthStore.getState().localDataPhase !== "idle"; i++) await new Promise((r) => setTimeout(r, 5));
};
const launch = async (dir) => {
  const phone = await bootDevice({ dir, api: noNetworkApi });
  const LD = phone.load("src/services/perUserData.service");
  LD.__setTestHooks({ skipQuiesce: true, prime: async () => "completed" });
  phone.LD = LD;
  return phone;
};
const login = (phone, id, pw = ACCOUNTS[id].pw) => quietly(async () => {
  const ok = await phone.useAuthStore.getState().login({ email: ACCOUNTS[id].email, password: pw });
  await waitIdle(phone);
  return ok;
})();
const logout = (phone) => quietly(() => phone.useAuthStore.getState().logout())();

/** Files on the phone that contain these bytes (every file in its storage). */
const filesHolding = (dir, needle) => fs.readdirSync(dir)
  .filter((f) => fs.readFileSync(path.join(dir, f)).includes(Buffer.from(needle, "utf8")))
  .sort();

const isNew = (h) => /^pbkdf2-sha256\$10000\$/.test(String(h ?? ""));
const nodeVerifies = (pw, h) => {
  const [, it, s, k] = String(h).split("$");
  if (!isNew(h) || !s || !k) return false;
  return nodeCrypto.pbkdf2Sync(pw, Buffer.from(s, "base64"), Number(it), 32, "sha256").toString("base64") === k;
};

/** Write what the old build wrote: `password + salt`, the row left _synced = 0. */
const plantLegacy = (dir, file, id, { device = false } = {}) => {
  const { DatabaseSync } = require("node:sqlite");
  const salt = "lq" + nodeCrypto.randomBytes(6).toString("hex");
  const w = new DatabaseSync(path.join(dir, file));
  const a = ACCOUNTS[id];
  if (device) {
    w.prepare(`INSERT OR REPLACE INTO credentials (user_id, email, enrollment_no, role, school_id, name, password_salt, password_hash, profile, updated_at, source)
               VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'legacy')`)
      .run(id, a.email, a.role, SCHOOL, a.name, salt, a.pw + salt, JSON.stringify(userOf(id)), "2026-09-01T00:00:00.000Z");
  } else {
    w.prepare(`INSERT INTO users (id, name, email, role, schoolId, passwordSalt, passwordHash, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00.000Z')
               ON CONFLICT(id) DO UPDATE SET passwordSalt = excluded.passwordSalt, passwordHash = excluded.passwordHash`)
      .run(id, a.name, a.email, a.role, SCHOOL, salt, a.pw + salt);
  }
  w.close();
};

const read = (phone, file, sql, p = []) => { const d = phone.inspect(file); try { return d.all(sql, p); } finally { d.close(); } };

async function partTwo() {
  // ── A. switch off ────────────────────────────────────────────────────────
  console.log("--- 2A. switch off: an old clear-text value, then an online sign-in ---");
  {
    const dir = tmpDir("cred-a");
    let phone = await launch(dir);
    await quietly(async () => { await (await phone.load("src/db/database").getDatabase()); })();
    phone.kill();
    plantLegacy(dir, "schoolapp.db", "tea-a");
    check("before: the password is readable in schoolapp.db (the bug)", filesHolding(dir, ACCOUNTS["tea-a"].pw), ["schoolapp.db"]);

    phone = await launch(dir);
    phone.net.connected = false;
    check("offline sign-in with the old value works", await login(phone, "tea-a"), true);
    await logout(phone);
    check("a wrong password is refused against the old value", await login(phone, "tea-a", "Ama-secret-7782"), false);
    check("offline sign-in does not rewrite it (upgrade happens online)",
      read(phone, "schoolapp.db", "SELECT passwordHash FROM users WHERE id = 'tea-a'")[0]?.passwordHash.startsWith(ACCOUNTS["tea-a"].pw), true);

    phone.net.connected = true;
    check("online sign-in", await login(phone, "tea-a"), true);
    await logout(phone);
    const row = read(phone, "schoolapp.db", "SELECT passwordSalt, passwordHash FROM users WHERE id = 'tea-a'")[0];
    check("users now holds the new form, which Node's PBKDF2 verifies", [isNew(row?.passwordHash), nodeVerifies(ACCOUNTS["tea-a"].pw, row?.passwordHash)], [true, true]);
    phone.kill();
    check("no byte of the password left in any file on the phone (db, -wal, SecureStore)", filesHolding(dir, ACCOUNTS["tea-a"].pw), []);

    phone = await launch(dir);
    phone.net.connected = false;
    check("offline sign-in with the new value works", await login(phone, "tea-a"), true);
    await logout(phone);
    check("a wrong password is refused against the new value", await login(phone, "tea-a", "Ama-secret-7782"), false);
    check("no device.db was created (switch off)", phone.exists("device.db"), false);
    phone.kill();
  }

  // ── B. switch on, migrated credentials ───────────────────────────────────
  console.log("--- 2B. switch on: copied clear-text credentials upgrade everywhere ---");
  {
    const dir = tmpDir("cred-b");
    let phone = await launch(dir);
    server.perUserLocalData = true;
    // A has signed in before (own store made), then an older build left a
    // clear-text value in each copy: the shared users, A's store, device.db.
    check("A signs in online (own store prepared)", await login(phone, "tea-a"), true);
    await logout(phone);
    const store = phone.LD.storeFileFor("tea-a");
    phone.kill();
    plantLegacy(dir, "schoolapp.db", "tea-a");
    plantLegacy(dir, store, "tea-a");
    plantLegacy(dir, "device.db", "tea-a", { device: true });
    // C, an old account, has only the shared users row — in clear text.
    plantLegacy(dir, "schoolapp.db", "adm-c");
    check("before: A's password is readable in all three files",
      filesHolding(dir, ACCOUNTS["tea-a"].pw), ["device.db", "schoolapp.db", store].sort());

    phone = await launch(dir);
    phone.net.connected = false;
    check("A signs in offline with the copied old value", await login(phone, "tea-a"), true);
    await logout(phone);
    check("…a wrong password is refused", await login(phone, "tea-a", "nope-nope"), false);

    phone.net.connected = true;
    check("A signs in online", await login(phone, "tea-a"), true);
    await logout(phone);
    const dev = read(phone, "device.db", "SELECT password_hash FROM credentials WHERE user_id = 'tea-a'")[0]?.password_hash;
    const shared = read(phone, "schoolapp.db", "SELECT passwordHash FROM users WHERE id = 'tea-a'")[0]?.passwordHash;
    const own = read(phone, store, "SELECT passwordHash FROM users WHERE id = 'tea-a'")[0]?.passwordHash;
    check("device.db, the shared users and A's store all hold the new form",
      [isNew(dev), isNew(shared), isNew(own)], [true, true, true]);
    check("  each verifies with Node's PBKDF2", [dev, shared, own].map((h) => nodeVerifies(ACCOUNTS["tea-a"].pw, h)), [true, true, true]);
    phone.kill();
    check("no byte of A's password left in any file on the phone", filesHolding(dir, ACCOUNTS["tea-a"].pw), []);
    check("C (has not signed in online since) still has its old value — replaced at its own online sign-in",
      filesHolding(dir, ACCOUNTS["adm-c"].pw), ["schoolapp.db"]);

    phone = await launch(dir);
    phone.net.connected = false;
    check("A signs in offline with the new value", await login(phone, "tea-a"), true);
    await logout(phone);
    check("C signs in offline with its old value", await login(phone, "adm-c"), true);
    await logout(phone);
    phone.net.connected = true;
    check("C signs in online", await login(phone, "adm-c"), true);
    await logout(phone);
    phone.kill();
    check("…and then no byte of C's password is left either", filesHolding(dir, ACCOUNTS["adm-c"].pw), []);
    const devC = (() => { const p = new (require("node:sqlite").DatabaseSync)(path.join(dir, "device.db")); try { return p.prepare("SELECT password_hash FROM credentials WHERE user_id = 'adm-c'").get()?.password_hash; } finally { p.close(); } })();
    check("  C's device.db copy is the new form", isNew(devC), true);
  }
}

(async () => {
  await partOne();
  await partTwo();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
