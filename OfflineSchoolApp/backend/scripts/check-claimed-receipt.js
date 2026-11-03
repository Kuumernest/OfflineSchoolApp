// backend/scripts/check-claimed-receipt.js
"use strict";

/**
 * A device receipt number the server refuses is still recorded.
 *
 * The desktop numbers its own receipts while offline (RCT-2026-2027-CB6F-0041)
 * and the server keeps that number. When it does NOT — the number's year is not
 * the payment's — it issues its own, and the parent may be holding provisional
 * paper under the refused one. The owner's decision: store the claimed number
 * (FeePayment.claimedReceiptNo), never rewrite it, and have the official
 * receipt say "Replaces provisional receipt <number>". What this holds:
 *
 *   - a claimed number that is kept: it is the receipt number, nothing extra
 *     stored, no "replaces" line;
 *   - a refused one: server number + stored claim + the line, in en and fr,
 *     on the staff receipt and on the guardian portal's (second child of a
 *     family — fees are per child);
 *   - a replay (same Idempotency-Key, or the same client _id with a different
 *     number) does not change it, nor does a later update;
 *   - the portal's fee JSON does not carry the field;
 *   - the desktop is recorded as "desktop", the browser still as "web";
 *   - a credit note with a refused number records it too;
 *   - nothing but a well-formed device number is ever stored.
 *
 *   node scripts/check-claimed-receipt.js
 */

const { stopQuietly } = require("./stopQuietly");

const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const path     = require("path");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(SRC, "db/models"));
  const User           = mongoose.model("User");
  const School         = mongoose.model("School");
  const Student        = mongoose.model("Student");
  const Class          = mongoose.model("Class");
  const FeePayment     = mongoose.model("FeePayment");
  const GuardianAccess = mongoose.model("GuardianAccess");
  await mongoose.model("IdempotencyKey").init();
  await FeePayment.init();

  const { receiptLabelsFor } = require(path.join(ROOT, "..", "shared", "receiptHtml"));

  const S    = "68c00000000000000000000b";
  const YEAR = "2026-2027";
  const HASH = "$2a$10$check.only.not.a.real.hash.value.padding.padding.pad";

  await School.create({ _id: S, name: "Lycée Bilingue", email: "office@example.test" });
  await User.create({
    _id: "bur-1", name: "A Bursar", email: "bursar@example.test",
    password: "check-only-password", role: "bursar", schoolId: S, isActive: true,
  });
  await Class.create({ _id: "cls-1", schoolId: S, name: "Form 1" });
  // One guardian, two children: the receipt is the second child's.
  await Student.create([
    { _id: "st-1", userId: "usr-st-1", schoolId: S, classId: "cls-1",
      studentName: "Bern Constance", enrollmentNo: "E-1", isActive: true, status: "approved" },
    { _id: "st-2", userId: "usr-st-2", schoolId: S, classId: "cls-1",
      studentName: "Bern Emmanuel", enrollmentNo: "E-2", isActive: true, status: "approved" },
  ]);
  await GuardianAccess.create({
    _id: "acc-parent", schoolId: S, studentIds: ["st-1", "st-2"], codeHash: HASH, codeHint: "11",
  });

  const auth = require(path.join(ROOT, "middleware/auth"));
  const app  = express();
  app.use(express.json());
  app.use("/api/portal", require(path.join(SRC, "routes/portal.routes")));
  app.use("/api", auth.authenticate, require(path.join(ROOT, "middleware/idempotency")));
  app.use("/api/fees", auth.authenticate, require(path.join(SRC, "routes/fees.routes")));

  const server = app.listen(0);
  const port   = server.address().port;
  const staff  = jwt.sign({ id: "bur-1", role: "bursar", schoolId: S },
    process.env.JWT_SECRET, { expiresIn: "1h" });
  const parent = jwt.sign({ accessId: "acc-parent", schoolId: S },
    process.env.JWT_SECRET, { audience: "portal", expiresIn: "1h" });

  const call = async (method, url, { token = staff, body, key } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  };
  const pay = (body, key) => call("POST", "/api/fees/payments", {
    key, body: { schoolId: S, academicYear: YEAR, method: "cash", ...body },
  });
  const stored = (id) => FeePayment.findById(id).lean();

  const esc  = (s) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;");
  const line = (lang, no) => esc(receiptLabelsFor(lang).replacesProvisionalReceipt.replace("{no}", no));
  const anyReplaces = (html, lang) => {
    const L = receiptLabelsFor(lang);
    return [L.replacesProvisionalReceipt, L.replacesProvisional]
      .some((w) => w && html.includes(esc(w.split("{")[0].trim())));
  };

  // ── kept ─────────────────────────────────────────────────────────────────
  console.log("\n--- a claimed number the server keeps ---");
  const KEPT = "RCT-2026-2027-CB6F-0001";
  const r1 = await pay({ _id: "pay-kept", studentId: "st-1", amount: 5000,
    receiptNo: KEPT, source: "desktop" }, "k-kept");
  const p1 = await stored("pay-kept");
  ok(`accepted (${r1.status})`, r1.status === 201, r1.text.slice(0, 200));
  ok("the claimed number is the receipt number", p1?.receiptNo === KEPT, p1?.receiptNo);
  ok("nothing stored as a refused claim", p1?.claimedReceiptNo == null, p1?.claimedReceiptNo);
  ok("recorded as a desktop payment", p1?.source === "desktop", p1?.source);
  for (const lang of ["en", "fr"]) {
    const html = (await call("GET", `/api/fees/receipt/pay-kept?lang=${lang}`)).text;
    ok(`${lang}: official receipt carries the number and no "replaces" line`,
      html.includes(KEPT) && !anyReplaces(html, lang));
  }

  // ── refused ──────────────────────────────────────────────────────────────
  console.log("\n--- a claimed number the server refuses (wrong year) ---");
  const CLAIM = "RCT-2025-2026-CB6F-0042";
  const r2 = await pay({ _id: "pay-refused", studentId: "st-2", amount: 7000,
    receiptNo: CLAIM, source: "desktop" }, "k-refused");
  const p2 = await stored("pay-refused");
  ok(`accepted (${r2.status})`, r2.status === 201, r2.text.slice(0, 200));
  ok("the server issued its own number", /^RCT-2026-2027-\d{4,}$/.test(p2?.receiptNo ?? ""), p2?.receiptNo);
  ok("the claimed number is stored", p2?.claimedReceiptNo === CLAIM, p2?.claimedReceiptNo);
  ok("staff read (the create reply) carries it", r2.json?.data?.claimedReceiptNo === CLAIM);
  for (const lang of ["en", "fr"]) {
    const html = (await call("GET", `/api/fees/receipt/pay-refused?lang=${lang}`)).text;
    ok(`${lang}: staff receipt says "${receiptLabelsFor(lang).replacesProvisionalReceipt.replace("{no}", CLAIM)}"`,
      html.includes(line(lang, CLAIM)) && html.includes(p2.receiptNo));
    ok(`${lang}: …and only that line, not the payment-id reference as well`,
      !html.includes(esc(receiptLabelsFor(lang).replacesProvisional.split("{")[0].trim())));
    const portal = await call("GET", `/api/portal/receipt/pay-refused?studentId=st-2&lang=${lang}`, { token: parent });
    ok(`${lang}: guardian portal receipt (second child) says it too (${portal.status})`,
      portal.status === 200 && portal.text.includes(line(lang, CLAIM)));
  }
  const fees = await call("GET", "/api/portal/fees?studentId=st-2", { token: parent });
  ok(`portal fee account lists the payment (${fees.status})`,
    (fees.json?.data?.payments ?? []).some((p) => p._id === "pay-refused"));
  ok("…without the audit field", !fees.text.includes("claimedReceiptNo") && !fees.text.includes(CLAIM));

  // ── replays ──────────────────────────────────────────────────────────────
  console.log("\n--- replays and later writes do not change it ---");
  const r3 = await pay({ _id: "pay-refused", studentId: "st-2", amount: 7000,
    receiptNo: CLAIM, source: "desktop" }, "k-refused");
  const p3 = await stored("pay-refused");
  ok(`same Idempotency-Key: answered like the original (${r3.status})`,
    r3.status === r2.status && r3.json?.data?.receiptNo === p2.receiptNo);
  ok("…receipt number and claim unchanged",
    p3.receiptNo === p2.receiptNo && p3.claimedReceiptNo === CLAIM);

  const r4 = await pay({ _id: "pay-refused", studentId: "st-2", amount: 7000,
    receiptNo: "RCT-2024-2025-AAAA-0001", source: "desktop" });
  const p4 = await stored("pay-refused");
  ok(`same client _id, a different claimed number: a replay (${r4.status})`, r4.json?.replay === true);
  ok("…the first claim stands", p4.claimedReceiptNo === CLAIM && p4.receiptNo === p2.receiptNo,
    `${p4.claimedReceiptNo} ${p4.receiptNo}`);
  ok("one row", (await FeePayment.countDocuments({ _id: "pay-refused" })) === 1);

  await FeePayment.updateOne({ _id: "pay-refused" }, { $set: { claimedReceiptNo: "RCT-2024-2025-BBBB-0001" } });
  const doc = await FeePayment.findById("pay-refused");
  doc.claimedReceiptNo = "RCT-2024-2025-CCCC-0001";
  await doc.save();
  ok("an update or a save cannot rewrite it",
    (await stored("pay-refused")).claimedReceiptNo === CLAIM);

  // ── what may be stored ───────────────────────────────────────────────────
  console.log("\n--- only a well-formed device number is ever stored ---");
  for (const [id, receiptNo] of [
    ["pay-junk",   "<b>not a receipt</b>"],
    ["pay-server", "RCT-2025-2026-0042"],
    ["pay-lower",  "RCT-2025-2026-cb6f-0042"],
  ]) {
    await pay({ _id: id, studentId: "st-1", amount: 1000, receiptNo });
    const p = await stored(id);
    ok(`${JSON.stringify(receiptNo)}: server number, nothing claimed`,
      /^RCT-2026-2027-\d{4,}$/.test(p?.receiptNo ?? "") && p?.claimedReceiptNo == null,
      `${p?.receiptNo} / ${p?.claimedReceiptNo}`);
  }

  // ── source ───────────────────────────────────────────────────────────────
  console.log("\n--- where the row came from ---");
  // A real client id: the provisional reference is its first eight hex digits.
  const PHONE_ID = "9f1c2b3a-1111-4222-8333-444455556666";
  await pay({ _id: "pay-web", studentId: "st-1", amount: 1100 });
  await pay({ _id: "pay-odd", studentId: "st-1", amount: 1200, source: "anything" });
  await pay({ _id: PHONE_ID, studentId: "st-1", amount: 1300, source: "mobile" });
  ok("the browser (no source) is still web", (await stored("pay-web"))?.source === "web");
  ok("an unrecognised source is web, not a refusal", (await stored("pay-odd"))?.source === "web");
  ok("the phone is still mobile", (await stored(PHONE_ID))?.source === "mobile");
  const phoneHtml = (await call("GET", `/api/fees/receipt/${PHONE_ID}?lang=en`)).text;
  ok("a phone payment keeps its payment-id reference line",
    phoneHtml.includes(esc(receiptLabelsFor("en").replacesProvisional.split("{")[0].trim())) &&
    !phoneHtml.includes(esc(receiptLabelsFor("en").replacesProvisionalReceipt.split("{")[0].trim())));

  // ── credit note ──────────────────────────────────────────────────────────
  console.log("\n--- a credit note with a refused number ---");
  const CN = "RCT-2025-2026-CB6F-0043";
  const rv = await call("POST", "/api/fees/payments/pay-kept/reverse", {
    key: "k-rev",
    body: { schoolId: S, reason: "entered twice", _id: "rev-1", receiptNo: CN, source: "desktop" },
  });
  const pr = await stored("rev-1");
  ok(`reversed (${rv.status})`, rv.status === 201, rv.text.slice(0, 200));
  ok("server number, claim stored, desktop source",
    /^RCT-2026-2027-\d{4,}$/.test(pr?.receiptNo ?? "") && pr?.claimedReceiptNo === CN && pr?.source === "desktop",
    `${pr?.receiptNo} / ${pr?.claimedReceiptNo} / ${pr?.source}`);
  const cnHtml = (await call("GET", "/api/fees/receipt/rev-1?lang=fr")).text;
  ok("fr: the credit note names the provisional one", cnHtml.includes(line("fr", CN)));
  const rvWeb = await call("POST", "/api/fees/payments/pay-web/reverse", {
    body: { schoolId: S, reason: "wrong pupil", _id: "rev-2" },
  });
  ok(`a browser reversal is still web (${rvWeb.status})`, (await stored("rev-2"))?.source === "web");

  console.log(`\n  ${pass} passed, ${fail} failed`);
  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
