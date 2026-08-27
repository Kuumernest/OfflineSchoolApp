// desktop/scripts/check-doc-store.js
"use strict";

/**
 * Assert that the local mirror behaves like a mirror.
 *
 * ── What is actually at stake ─────────────────────────────────────────────
 *
 * This database is what the bursar sees. If it drops a row, the school's
 * arrears list is wrong; if it duplicates one, a family is billed twice; if it
 * loses a write on a power cut, a payment the bursar was told was recorded is
 * gone and there is a paper receipt with no record behind it.
 *
 * So the assertions are about the properties a mirror has to have rather than
 * about the API's surface: re-delivery is harmless, unknown fields survive, a
 * newer schema is refused rather than corrupted, and what was written is still
 * there after a close and reopen.
 *
 * Runs against real files in a temporary directory, not :memory:. An in-memory
 * database cannot use WAL and cannot be reopened, which are two of the things
 * being checked.
 *
 *   node scripts/check-doc-store.js
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const store = require("../src/main/db/store");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`  FAIL ${label}:\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "school-store-"));
const file = path.join(dir, "nested", "school.db");

// maxRetries because Windows holds a lock for a moment after a handle closes,
// and a temporary directory this suite cannot remove should not be reported as
// a failure of the thing being tested.
const cleanup = () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.log(`  (could not remove ${dir}: ${err.code})`);
  }
};

const main = () => {
  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- opening ---");

  let db = store.open(file);
  check("creates the directory it was pointed at", fs.existsSync(file), true);

  // The durability argument for synchronous=FULL assumes WAL. If this is not
  // WAL, that argument does not hold and the pragma is doing less than it looks.
  check("journal_mode is WAL",
    String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase(), "wal");
  check("synchronous is FULL — a power cut must not lose an acknowledged write",
    db.prepare("PRAGMA synchronous").get().synchronous, 2);
  check("schema is at the current version",
    db.prepare("SELECT MAX(version) AS v FROM schema_version").get().v,
    store.SCHEMA_VERSION);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- migrations are idempotent ---");

  // Every launch runs migrate(). Running it twice must be a no-op, or the
  // second launch of the app would fail on "table already exists".
  store.migrate(db);
  check("running them again changes nothing",
    db.prepare("SELECT COUNT(*) AS n FROM schema_version").get().n,
    store.SCHEMA_VERSION);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- storing and reading documents ---");

  let docs = store.documents(db);

  const ada = {
    _id: "stu-1", schoolId: "sch-1", classId: "cls-1",
    studentName: "Ada Nkeng", enrollmentNo: "SMK-001",
    status: "approved", deletedAt: null, updatedAt: "2026-08-01T10:00:00.000Z",
  };
  docs.put("student", ada);

  check("a document comes back", docs.get("student", "stu-1")?.studentName, "Ada Nkeng");
  check("and is not marked pending when it came from the server",
    docs.get("student", "stu-1")?._pending, false);
  check("a document that was never stored is null",
    docs.get("student", "nobody"), null);

  // The reason for storing JSON rather than columns: a newer server can add a
  // field and this build must carry it through untouched rather than dropping it.
  docs.put("student", {
    ...ada, _id: "stu-2", studentName: "Bertin Oyono",
    fieldThisBuildHasNeverHeardOf: { nested: [1, 2, 3] },
  });
  check("a field this build does not know about survives storage",
    docs.get("student", "stu-2")?.fieldThisBuildHasNeverHeardOf,
    { nested: [1, 2, 3] });

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- re-delivery is harmless ---");

  // The puller re-sends rows whenever a cursor overlaps, which it does on every
  // sync by design. An insert would fail; an upsert must simply be current.
  docs.put("student", { ...ada, studentName: "Ada Nkeng-Fomba" });
  check("the same id twice is one row", docs.count("student"), 2);
  check("and holds the newer version",
    docs.get("student", "stu-1").studentName, "Ada Nkeng-Fomba");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- filters ---");

  docs.putMany("feeCharge", [
    { _id: "c1", schoolId: "sch-1", studentId: "stu-1", amount: 75000, code: "TUITION", deletedAt: null },
    { _id: "c2", schoolId: "sch-1", studentId: "stu-1", amount:  5000, code: "PTA",     deletedAt: null },
    { _id: "c3", schoolId: "sch-1", studentId: "stu-2", amount: 75000, code: "TUITION", deletedAt: null },
    { _id: "c4", schoolId: "sch-1", studentId: "stu-2", amount:  5000, code: "PTA",     deletedAt: "2026-08-02T00:00:00.000Z" },
    { _id: "c5", schoolId: "sch-2", studentId: "other", amount: 99000, code: "TUITION", deletedAt: null },
  ]);

  check("equality on a real column",
    docs.find("feeCharge", { schoolId: "sch-1" }).length, 4);
  check("equality on a field inside the JSON",
    docs.find("feeCharge", { studentId: "stu-1" }).length, 2);
  check("IS NULL",
    docs.find("feeCharge", { deletedAt: null }).length, 4);
  check("IS NOT NULL",
    docs.find("feeCharge", { deletedAt: { not: null } }).map((d) => d._id), ["c4"]);
  check("IN",
    docs.find("feeCharge", { code: { in: ["PTA"] } }).map((d) => d._id).sort(), ["c2", "c4"]);
  check("greater than",
    docs.find("feeCharge", { amount: { gt: 70000 } }).length, 3);
  check("several conditions together",
    docs.find("feeCharge", { schoolId: "sch-1", deletedAt: null, code: "TUITION" })
        .map((d) => d._id).sort(),
    ["c1", "c3"]);

  // An empty IN is not valid SQL, and it means "nothing", not "everything" —
  // getting that backwards would show one school another school's charges.
  check("an empty IN matches nothing rather than erroring",
    docs.find("feeCharge", { code: { in: [] } }).length, 0);

  check("ordering, descending, by a JSON field",
    docs.find("feeCharge", { schoolId: "sch-1" }, { order: "amount", dir: "DESC" })
        .map((d) => d.amount),
    [75000, 75000, 5000, 5000]);
  check("limit", docs.find("feeCharge", {}, { limit: 2 }).length, 2);

  // Different collections are separate namespaces; an id may repeat across them.
  docs.put("feePayment", { _id: "c1", schoolId: "sch-1", amount: 30000 });
  check("collections do not collide on id",
    [docs.get("feeCharge", "c1").amount, docs.get("feePayment", "c1").amount],
    [75000, 30000]);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- the aggregates the fee screens need ---");

  const balance = docs.sql(`
    SELECT SUM(json_extract(json,'$.amount')) AS charged
    FROM docs
    WHERE collection='feeCharge'
      AND school_id = ?
      AND json_extract(json,'$.studentId') = ?
      AND deleted_at IS NULL
  `, "sch-1", "stu-1")[0];
  check("a student's charges sum correctly", balance.charged, 80000);

  const arrears = docs.sql(`
    SELECT json_extract(json,'$.studentId') AS studentId,
           SUM(json_extract(json,'$.amount')) AS charged
    FROM docs
    WHERE collection='feeCharge' AND school_id=? AND deleted_at IS NULL
    GROUP BY studentId ORDER BY charged DESC
  `, "sch-1");
  check("and a group-by gives the arrears list",
    arrears, [{ studentId: "stu-1", charged: 80000 }, { studentId: "stu-2", charged: 75000 }]);

  // A soft-deleted charge must be excluded from money, or a waived fee keeps
  // being chased.
  check("a soft-deleted charge is not counted",
    docs.sql(`SELECT SUM(json_extract(json,'$.amount')) AS c FROM docs
              WHERE collection='feeCharge' AND json_extract(json,'$.studentId')='stu-2'
                AND deleted_at IS NULL`)[0].c,
    75000);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- local writes are distinguishable from confirmed ones ---");

  docs.put("feePayment", { _id: "p-local", schoolId: "sch-1", amount: 10000 }, { pending: true });
  check("a local write is flagged", docs.get("feePayment", "p-local")._pending, true);
  check("and is listed as pending",
    docs.pending().some((p) => p.id === "p-local"), true);

  docs.settle("feePayment", "p-local");
  check("settling clears the flag", docs.get("feePayment", "p-local")._pending, false);
  check("and it leaves the pending list", docs.pending().length, 0);

  docs.put("feePayment", { _id: "p-rejected", schoolId: "sch-1", amount: 1 }, { pending: true });
  docs.forget("feePayment", "p-rejected");
  check("a rejected local write can be removed entirely",
    docs.get("feePayment", "p-rejected"), null);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- sync cursors ---");

  const st = store.state(db);
  check("a collection never pulled has no cursor", st.cursorFor("student"), null);

  st.setCursor("student", "2026-08-01T10:00:00.000Z");
  check("a cursor is remembered", st.cursorFor("student"), "2026-08-01T10:00:00.000Z");

  // Per collection, because they are pulled independently and a single global
  // cursor would either re-pull everything or skip what it never received.
  st.setCursor("feeCharge", "2026-08-02T00:00:00.000Z");
  check("cursors are independent",
    [st.cursorFor("student"), st.cursorFor("feeCharge")],
    ["2026-08-01T10:00:00.000Z", "2026-08-02T00:00:00.000Z"]);

  // A failed pull records why and must NOT move the cursor backwards, or the
  // next sync would re-pull from the beginning.
  st.setCursor("student", null, { error: "network unreachable" });
  check("a failure keeps the cursor where it was",
    st.cursorFor("student"), "2026-08-01T10:00:00.000Z");
  check("and records the reason",
    st.all().find((r) => r.collection === "student").last_error, "network unreachable");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- this installation's identity ---");

  const m = store.meta(db);
  const code = m.deviceCode();
  check("a device code is four characters", code.length, 4);
  check("uppercase hex, so it can be read off a receipt over the phone",
    /^[0-9A-F]{4}$/.test(code), true);
  check("and is stable — receipt numbers already issued must keep meaning",
    m.deviceCode(), code);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- and all of it survives a restart ---");

  db.close();
  db = store.open(file);
  docs = store.documents(db);

  check("documents are still there", docs.count("feeCharge"), 5);
  check("with their contents", docs.get("student", "stu-1").studentName, "Ada Nkeng-Fomba");
  check("unknown fields included",
    docs.get("student", "stu-2").fieldThisBuildHasNeverHeardOf, { nested: [1, 2, 3] });
  check("cursors survive", store.state(db).cursorFor("feeCharge"), "2026-08-02T00:00:00.000Z");
  check("and the device code survives — this is the whole point of it",
    store.meta(db).deviceCode(), code);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("--- an older build refuses a newer database ---");

  // Rather than writing to it with assumptions that no longer hold. A mirror
  // silently diverging is the failure that is hardest to notice and worst to
  // reconcile.
  db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(store.SCHEMA_VERSION + 5);
  db.close();

  let refused = null;
  try { store.open(file); } catch (err) { refused = err.message; }
  check("it throws", Boolean(refused), true);
  check("saying which way to resolve it",
    /Update the application/.test(refused ?? ""), true);

  console.log(`\n  ${pass} passed, ${fail} failed`);
};

try {
  main();
} catch (err) {
  console.error("\nHarness error:", err);
  fail++;
} finally {
  cleanup();
}

process.exit(fail ? 1 : 0);
