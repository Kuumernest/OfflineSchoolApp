// mobile/scripts/check-fees-client.js
"use strict";

/**
 * The phone's fee service, run against the real routers.
 *
 * A bursar opened a pupil's fee page and read: balance FCFA 0, charged 0, paid
 * 0, "Nothing billed yet", "No payments recorded" — for a pupil whose charges
 * and payments were sitting on the server. They could have taken a second
 * payment against a bill that looked unpaid.
 *
 * getStudentAccount reads the local SQLite mirror and nothing else, which is
 * right — it is what makes the screen work with no signal and what lets a
 * payment queued on this device appear before it has synced. What was missing
 * was anything filling that mirror. pullStudentAccount existed, exported,
 * written for exactly this, with NO call site anywhere in the app.
 *
 * Which is the third bug of that shape in this audit: a function that was
 * complete and never called. The others were seven names missing from a
 * default export, and four notification kinds with a template, an enum entry
 * and no producer. Static reading finds none of them, so this suite does what
 * check-portal-client does — loads the real service, gives it a fake SQLite
 * and a real server, and asserts on what comes back.
 *
 *   node scripts/check-fees-client.js
 */

const path  = require("path");
const fs    = require("fs");
const babel = require("@babel/core");

const MOBILE  = path.join(__dirname, "..");
const BACKEND = path.join(MOBILE, "..", "backend");
const BSRC    = path.join(BACKEND, "src");
const bmod    = (name) => require(path.join(BACKEND, "node_modules", name));

let pass = 0, fail = 0;
const ok  = (label) => { pass++; console.log(`  ok   ${label}`); };
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL ${label}`);
  if (detail) console.log(String(detail).split("\n").map((l) => "       " + l).join("\n"));
};
const note = (label) => console.log(`       ${label}`);

/**
 * A fake expo-sqlite, real enough for the two tables in question.
 *
 * Rows are kept per table with the primary key the service uses, so INSERT OR
 * REPLACE really does replace and a SELECT really does filter. Anything less
 * and "the mirror was filled" would be asserted against a stub that always
 * agrees.
 */
const makeFakeDb = () => {
  const tables = new Map();     // table -> Map(id -> row)
  const of = (t) => {
    if (!tables.has(t)) tables.set(t, new Map());
    return tables.get(t);
  };
  /**
   * Column names, and the value each takes.
   *
   * Not every column is a placeholder: the real inserts write `_synced` as a
   * literal 1 in the VALUES tuple, so there are more columns than params.
   * Mapping positionally by column — which the first version of this did —
   * shifted everything after it by one, and `pending` then counted a
   * server-pulled row as still queued. The fake was wrong, not the service.
   */
  const bind = (sql, params) => {
    const cm = /\(([^)]*)\)\s*VALUES/i.exec(sql);
    const vm = /VALUES\s*\(([^)]*)\)/i.exec(sql);
    if (!cm || !vm) return null;
    const names  = cm[1].split(",").map((c) => c.trim());
    const values = vm[1].split(",").map((v) => v.trim());
    const row = {};
    let p = 0;
    names.forEach((name, i) => {
      const v = values[i];
      if (v === "?") row[name] = params[p++];
      else if (v === undefined) row[name] = undefined;
      else row[name] = /^-?\d+$/.test(v) ? Number(v) : v.replace(/^'|'$/g, "");
    });
    return row;
  };
  return {
    _tables: tables,
    execAsync: async () => {},
    runAsync: async (sql, params = []) => {
      const ins = /INSERT OR REPLACE INTO\s+(\w+)/i.exec(sql);
      if (ins) {
        const row = bind(sql, params);
        if (!row) return { changes: 0 };
        of(ins[1]).set(String(row.id), row);
        return { changes: 1 };
      }
      const del = /DELETE FROM\s+(\w+)/i.exec(sql);
      if (del) { of(del[1]).clear(); return { changes: 1 }; }
      return { changes: 0 };
    },
    getAllAsync: async (sql, params = []) => {
      const m = /FROM\s+(\w+)/i.exec(sql);
      if (!m) return [];
      let rows = [...of(m[1]).values()];
      if (/student_id = \?/.test(sql)) rows = rows.filter((r) => String(r.student_id) === String(params[0]));
      if (/academic_year = \?/.test(sql)) rows = rows.filter((r) => String(r.academic_year) === String(params[1]));
      return rows;
    },
    getFirstAsync: async (sql, params = []) => {
      const m = /FROM\s+(\w+)/i.exec(sql);
      if (!m) return null;
      if (/WHERE id = \?/.test(sql)) return of(m[1]).get(String(params[0])) ?? null;
      const all = await module.exports; // unreachable; kept simple
      return null;
    },
  };
};

/**
 * Load one module out of src/ with a require we control.
 *
 * Relative ids are resolved against the MODULE's directory, not this script's.
 * Node's require would use the caller's, so `../utils/idHelpers` inside
 * src/services resolved to mobile/utils and failed — the module has more
 * relative imports than there are stubs for, and only the ones that touch a
 * device need replacing.
 */
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";

  const express  = bmod("express");
  const mongoose = bmod("mongoose");
  const jwt      = bmod("jsonwebtoken");
  const { MongoMemoryServer } = bmod("mongodb-memory-server");

  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());

  require(path.join(BSRC, "db/models"));
  const User       = mongoose.model("User");
  const Student    = mongoose.model("Student");
  const Class      = mongoose.model("Class");
  const School     = mongoose.model("School");
  const FeeCharge  = mongoose.model("FeeCharge");
  const FeePayment = mongoose.model("FeePayment");

  const SCHOOL = "68c00000000000000000000c";
  const BURSAR = "usr-bursar";
  const PUPIL  = "stu-che-jude";
  const YEAR   = "2026/2027";

  await School.create({ _id: SCHOOL, name: "Geneva Bilingual Academy", email: "o@example.test" });
  await Class.create({ _id: "cls-1", schoolId: SCHOOL, name: "Form 1" });
  await User.create({
    _id: BURSAR, name: "Ndi Grace", email: "b@example.test",
    password: "check-only-password", role: "bursar", schoolId: SCHOOL, isActive: true,
  });
  await Student.create({
    _id: PUPIL, userId: "usr-cj", schoolId: SCHOOL, classId: "cls-1",
    studentName: "Che Jude", enrollmentNo: "GVA00-2026-0011",
    isActive: true, status: "approved",
  });

  // The figures the bursar's phone was showing as zero.
  await FeeCharge.create([
    { _id: "chg-1", schoolId: SCHOOL, studentId: PUPIL, academicYear: YEAR,
      term: "1", code: "TUITION", label: "Tuition", amount: 150000, waivedAmount: 0 },
    { _id: "chg-2", schoolId: SCHOOL, studentId: PUPIL, academicYear: YEAR,
      term: "1", code: "PTA", label: "PTA levy", amount: 10000, waivedAmount: 0 },
  ]);
  await FeePayment.create({
    _id: "pay-1", schoolId: SCHOOL, studentId: PUPIL, academicYear: YEAR,
    amount: 60000, method: "cash", receiptNo: "RCP-1", receivedAt: new Date(),
    recordedBy: BURSAR,
  });

  note(`school ${SCHOOL}  pupil ${PUPIL}  year ${YEAR}`);
  note("charged 160000, paid 60000, so the balance is 100000");

  const app = express();
  app.use(express.json());
  const seen = [];
  app.use((req, _res, next) => { seen.push(`${req.method} ${req.originalUrl}`); next(); });
  const auth = require(path.join(BACKEND, "middleware", "auth"));
  app.use("/api/fees", auth.authenticate, require(path.join(BSRC, "routes/fees.routes")));
  app.use((req, res) => res.status(404).json({ success: false, message: "no such route" }));

  const server = app.listen(0);
  const API = `http://127.0.0.1:${server.address().port}/api`;

  const token = jwt.sign(
    { id: BURSAR, role: "bursar", schoolId: SCHOOL },
    process.env.JWT_SECRET, { expiresIn: "1h" }
  );

  const axios = require(path.join(MOBILE, "node_modules", "axios"));
  const apiStub = axios.create({
    baseURL: API,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });

  const fakeDb = makeFakeDb();
  const Fees = loadModule("src/services/fee.service.js", {
    "../db/database":      { getDatabase: async () => fakeDb },
    "../db/schemaManager": { ensureTableSchema: async (_n, fn, db) => fn(db) },
    "./api":               { default: apiStub, __esModule: true },
    "./mutationQueue.service": { MutationQueue: { enqueue: async () => {} } },
  });

  if (typeof Fees.pullStudentAccount === "function") ok("fee.service.js loads");
  else { bad("the fee service loads", Object.keys(Fees).join(", ")); process.exit(1); }

  // ── The mirror, before anything fills it ────────────────────────────────
  console.log("\n--- what the screen showed ---");
  {
    const acct = await Fees.getStudentAccount(PUPIL, YEAR);
    note(`totals: ${JSON.stringify(acct.totals)}`);
    if (acct.totals.charged === 0 && acct.totals.paid === 0) {
      ok("an unfilled mirror reads as zero — which is what the bursar saw");
    } else {
      bad("the empty mirror reads zero", JSON.stringify(acct.totals));
    }
  }

  // ── The pull that had no caller ─────────────────────────────────────────
  console.log("\n--- the pull the screens now make ---");
  {
    const before = seen.length;
    await Fees.pullStudentAccount({ schoolId: SCHOOL, studentId: PUPIL, academicYear: YEAR });
    note(`sent: ${JSON.stringify(seen.slice(before))}`);

    const acct = await Fees.getStudentAccount(PUPIL, YEAR);
    note(`totals: ${JSON.stringify(acct.totals)}`);

    if (acct.totals.charged === 160000) ok("charged is the school's figure");
    else bad("charged comes through", String(acct.totals.charged));

    if (acct.totals.paid === 60000) ok("paid is the school's figure");
    else bad("paid comes through", String(acct.totals.paid));

    if (acct.totals.balance === 100000) ok("and the balance is the difference");
    else bad("the balance is charged minus paid", String(acct.totals.balance));

    if ((acct.charges ?? []).length === 2) ok("both charges are listed, not \"nothing billed yet\"");
    else bad("the charges are listed", String((acct.charges ?? []).length));

    if ((acct.payments ?? []).length === 1) ok("and the payment is listed");
    else bad("the payments are listed", String((acct.payments ?? []).length));
  }

  // ── Idempotent, because every screen visit pulls ────────────────────────
  console.log("\n--- and pulling again changes nothing ---");
  {
    await Fees.pullStudentAccount({ schoolId: SCHOOL, studentId: PUPIL, academicYear: YEAR });
    const acct = await Fees.getStudentAccount(PUPIL, YEAR);
    if (acct.totals.charged === 160000 && (acct.charges ?? []).length === 2) {
      ok("a second pull does not double the charges");
    } else {
      bad("pulling twice is the same as once",
        `charged ${acct.totals.charged}, ${(acct.charges ?? []).length} charges`);
    }
  }

  // ── A payment queued on this device survives the pull ──────────────────
  //
  // The reason the mirror stays the thing rendered. pullStudentAccount already
  // refuses to overwrite a payment row still marked unsynced; if it did not, a
  // bursar who took cash offline would watch it vanish on the next refresh.
  console.log("\n--- a payment taken offline is not overwritten ---");
  {
    await fakeDb.runAsync(
      `INSERT OR REPLACE INTO fee_payments
         (id, school_id, student_id, academic_year, term, amount, method,
          reference, note, receipt_no, received_at, reverses_id,
          reversed_by_id, _synced, _synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["pay-local", SCHOOL, PUPIL, YEAR, "1", 25000, "cash",
       null, null, null, new Date().toISOString(), null, null, 0, null]
    );

    await Fees.pullStudentAccount({ schoolId: SCHOOL, studentId: PUPIL, academicYear: YEAR });
    const acct = await Fees.getStudentAccount(PUPIL, YEAR);

    // mapPayment's shape, not the column names: `_id` and `isSynced`. Reading
    // the raw row keys here would have asserted against a row this service
    // never hands out.
    const local = (acct.payments ?? []).find((p) => p._id === "pay-local");
    if (local && local.isSynced === false) ok("the queued payment is still there, still unsynced");
    else bad("an unsynced payment survives a pull", JSON.stringify(local ?? null));

    if (acct.totals.paid === 85000) ok("and counts towards what has been paid (85000)");
    else bad("the queued payment counts", String(acct.totals.paid));

    // The count the screen shows as "pending".
    if (acct.pending === 1) ok("and is reported as one payment still to reach the server");
    else bad("the pending count is 1", String(acct.pending));
  }

  // ── The list's one request ─────────────────────────────────────────────
  console.log("\n--- and the list gets every balance in one request ---");
  {
    const before = seen.length;
    const balances = await Fees.pullOutstanding({ schoolId: SCHOOL, academicYear: YEAR });
    const sent = seen.slice(before);
    note(`sent: ${JSON.stringify(sent)}`);

    if (sent.length === 1) ok("one request for the whole roster, not one per pupil");
    else bad("the list makes one request", JSON.stringify(sent));

    if (balances[PUPIL]?.balance === 100000) {
      ok("and it carries this pupil's balance");
    } else {
      bad("the balance comes through", JSON.stringify(balances[PUPIL] ?? null));
    }

    // A pupil who owes nothing is absent from the reply, which is what the
    // endpoint is for — and absence must read as zero, not as missing.
    await Student.create({
      _id: "stu-paid-up", userId: "usr-pu", schoolId: SCHOOL, classId: "cls-1",
      studentName: "Paid Up", enrollmentNo: "GVA00-2026-0012",
      isActive: true, status: "approved",
    });
    const again = await Fees.pullOutstanding({ schoolId: SCHOOL, academicYear: YEAR });
    if (again["stu-paid-up"] === undefined) {
      ok("a pupil who owes nothing is simply absent, and the screen reads that as zero");
    } else {
      bad("only debtors are returned", JSON.stringify(again["stu-paid-up"]));
    }
  }

  // ── The screens call it ────────────────────────────────────────────────
  //
  // The whole bug was a complete function with no call site, so the call sites
  // are asserted. A screen that renders the mirror and never fills it is the
  // defect, and it looks exactly like a pupil who owes nothing.
  console.log("\n--- and the screens actually call these ---");
  {
    const detail = fs.readFileSync(path.join(MOBILE, "app/admin/fees/[studentId].js"), "utf8");
    const list   = fs.readFileSync(path.join(MOBILE, "app/admin/fees/index.js"), "utf8");

    if (/pullStudentAccount\(/.test(detail)) ok("the detail screen pulls the account before reading it");
    else bad("app/admin/fees/[studentId].js pulls before it renders",
      "It reads getStudentAccount, which is the local mirror only.");

    if (/pullOutstanding\(/.test(list)) ok("the list screen pulls the balances");
    else bad("app/admin/fees/index.js pulls the balances",
      "It reads getStudentAccount per pupil, which is the local mirror only.");

    // Both must keep the mirror as the offline fallback.
    if (/getStudentAccount\(/.test(detail) && /getStudentAccount\(/.test(list)) {
      ok("and both still fall back to the mirror, so neither needs a connection");
    } else {
      bad("the mirror remains the fallback",
        "Rendering straight from the network would break the offline case this app exists for.");
    }
  }

  await server.close();
  await mongoose.disconnect();
  await mongo.stop();

  console.log("");
  console.log(`  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
