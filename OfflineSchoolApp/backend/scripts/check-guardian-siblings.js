// backend/scripts/check-guardian-siblings.js
"use strict";

/**
 * One guardian, three children — the ordinary family, never a duplicate.
 *
 * Mrs Bate has Eve (Form 1), Fay (Form 3) and Gus (Form 5). All three records
 * carry her name, email and phone, and Eve's and Fay's own email is hers too.
 *
 *   saving       all three save; the same phone passes B3 for each
 *   portal       one code opens all three; logging in with any child's
 *                admission number gives the same three to switch between
 *   profile      each child's profile shows Mrs Bate and that child's own
 *                balance (C10)
 *   fees         overdue is per child (Eve and Gus owe, Fay paid up); the
 *                To do count and amount add up the children (C6, C11)
 *   reminders    one reminder per owing child, each to Mrs Bate, each naming
 *                its child
 *
 *   node scripts/check-guardian-siblings.js
 */

const path     = require("path");
const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

const SRC = path.join(__dirname, "..", "src");

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  await M("Student").init(); // build the real indexes, unique ones included

  const { normalisePhone, checkStudentInput } = require("../../shared/studentValidation");
  const portal       = require(path.join(SRC, "services/portal.service"));
  const { overviewFor }    = require(path.join(SRC, "services/studentOverview.service"));
  const reminders          = require(path.join(SRC, "services/feeReminders.service"));
  const { actionItemsFor } = require(path.join(SRC, "services/actionItems.service"));

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const S = new mongoose.Types.ObjectId().toString();
  const YEAR  = "2026/2027";
  const TODAY = new Date("2026-10-27T10:00:00Z");
  const daysFrom = (n) => new Date(TODAY.getTime() + n * 86_400_000);
  await M("School").create({ _id: S, name: "Bright Future", email: "bf@example.test", settings: { academicYear: YEAR } });

  const KIDS = [["eve", "Eve Bate", "Form 1"], ["fay", "Fay Bate", "Form 3"], ["gus", "Gus Bate", "Form 5"]];

  console.log("\n--- saving ---");
  const phones = KIDS.map(() => normalisePhone("677 00 00 01", "guardianPhone"));
  check("the same guardian phone passes B3 for each child",
    phones.map((p) => [p.error ?? null, p.value]), KIDS.map(() => [null, "+237677000001"]));
  check("and raises no error from the student checks",
    KIDS.map(([, , className]) => checkStudentInput({ guardianPhone: "677000001" }, { className, now: TODAY }).errors),
    [[], [], []]);

  let saved = 0;
  for (const [id, name, className] of KIDS) {
    try {
      await M("Student").create({
        _id: id, userId: `u-${id}`, schoolId: S, classId: className, className,
        studentName: name, enrollmentNo: `BF-2026-00${++saved}`, status: "approved", isActive: true,
        email: id === "gus" ? null : "bate@gmail.com",
        guardianName: "Mrs Bate", guardianEmail: "bate@gmail.com", guardianPhone: phones[0].value,
      });
    } catch (err) { console.log(`       ${id}: ${err.message}`); saved--; }
  }
  check("all three children save with the same guardian email and phone", saved, 3);

  console.log("\n--- portal ---");
  const { code } = await portal.issueAccess({ schoolId: S, studentIds: ["eve", "fay", "gus"], label: "Mrs Bate" });
  const logins = [];
  for (let i = 1; i <= 3; i++) {
    const r = await portal.login({ schoolId: S, admissionNo: `BF-2026-00${i}`, code }).catch((e) => ({ error: e.message }));
    logins.push((r.children ?? []).map((c) => c.name));
  }
  check("one code, any child's admission number, the same three children to switch between",
    logins, [0, 1, 2].map(() => ["Eve Bate", "Fay Bate", "Gus Bate"]));

  console.log("\n--- fees ---");
  let n = 0;
  const charge = (studentId, amount, dueDate) => M("FeeCharge").create({
    schoolId: S, studentId, academicYear: YEAR, code: `C${++n}`, label: "Tuition", amount, dueDate,
  });
  await charge("eve", 60000, daysFrom(-10));
  await charge("fay", 50000, daysFrom(-10));
  await M("FeePayment").create({ schoolId: S, studentId: "fay", academicYear: YEAR, amount: 50000 });
  await charge("gus", 80000, daysFrom(-5));

  const overdue = await reminders.candidates({ schoolId: S, academicYear: YEAR, mode: "overdue", asOf: TODAY });
  check("overdue is per child: Eve and Gus, each with their own balance",
    overdue.map((r) => [r.studentId, r.balance]).sort(), [["eve", 60000], ["gus", 80000]]);
  check("both name the same guardian",
    overdue.map((r) => r.guardianName), ["Mrs Bate", "Mrs Bate"]);

  const items = await actionItemsFor({ schoolId: S, can: { marks: false, publish: false, fees: true }, asOf: TODAY });
  const fees  = items.find((i) => i.key === "overdueFees") ?? {};
  check("To do counts the two owing children and adds their balances", [fees.count, fees.amount], [2, 140000]);

  console.log("\n--- profile ---");
  const views = [];
  for (const [id] of KIDS) {
    const student = await M("Student").findById(id).lean();
    const o = await overviewFor({ schoolId: S, student, asOf: TODAY });
    views.push([o.guardian.name, o.guardian.phone, o.guardian.email, o.fees?.balance ?? null]);
  }
  check("each profile shows Mrs Bate and that child's own balance", views, [
    ["Mrs Bate", "+237677000001", "bate@gmail.com", 60000],
    ["Mrs Bate", "+237677000001", "bate@gmail.com", 0],
    ["Mrs Bate", "+237677000001", "bate@gmail.com", 80000],
  ]);

  console.log("\n--- reminders ---");
  const sent = await reminders.sendReminders({ schoolId: S, academicYear: YEAR, mode: "overdue", asOf: TODAY });
  const notes = await M("Notification").find({ schoolId: S, kind: "fee.reminder" }).lean();
  check("one reminder per owing child, none merged or skipped", [sent.queued, sent.skippedUnreachable], [2, 0]);
  check("each to Mrs Bate, each about its own child",
    notes.map((x) => [x.studentId, x.to]).sort(), [["eve", "bate@gmail.com"], ["gus", "bate@gmail.com"]]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
