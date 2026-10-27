// backend/scripts/check-portal-home.js
"use strict";

/**
 * GET /api/portal/home — one card per child, every figure read as the screen
 * it leads to reads it.
 *
 *   Mrs Bate's code covers three children (one guardian, many children):
 *     ama  Form 1  two published results (12.5 then 14.25), one draft;
 *                  9 of 10 days present this month; owes 30,000, due 5 days ago
 *     bih  Form 3  nothing published; no register this month; paid up
 *     cho  Form 1  one result; owes 20,000, due in 10 days
 *   dan, another family's child in Form 1, is never on her Home.
 *   Form 1's next exam starts in 6 days; a past exam is not "next".
 *   Notices list newest first.
 *
 *   node scripts/check-portal-home.js
 */

const path     = require("path");
const express  = require("express");
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
  const C = (n) => M(n).collection;

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const DAY = 86_400_000;
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const days = (n) => new Date(now.getTime() + n * DAY);
  const YEAR = "2026/2027";
  const S = new mongoose.Types.ObjectId();
  const sid = String(S);

  await C("School").insertOne({ _id: S, name: "Check School", isActive: true, deletedAt: null, settings: { academicYear: YEAR } });
  await C("Class").insertMany([{ _id: "f1", schoolId: sid, name: "Form 1" }, { _id: "f3", schoolId: sid, name: "Form 3" }]);
  const pupil = (_id, classId) => ({ _id, schoolId: sid, classId, studentName: `${_id} Bate`, enrollmentNo: `CS-${_id}`,
    status: "approved", isActive: true, deletedAt: null, guardianName: "Mrs Bate" });
  await C("Student").insertMany([pupil("ama", "f1"), pupil("bih", "f3"), pupil("cho", "f1"), { ...pupil("dan", "f1"), guardianName: "Mr Fon" }]);

  const exam = (_id, name, offset, status = "published") => ({ _id, schoolId: sid, classId: "f1", classIds: ["f1"], name,
    type: "test", academicYear: YEAR, term: 1, startDate: iso(days(offset)), status, deletedAt: null });
  await C("Exam").insertMany([exam("x1", "1st Sequence", -40), exam("x2", "2nd Sequence", -10), exam("x9", "Old test", -2, "scheduled"),
    exam("x3", "3rd Sequence", 6, "scheduled")]);
  const result = (studentId, examId, average, position, published, ago) => M("ResultSummary").create({
    examId, studentId, classId: "f1", schoolId: sid, academicYear: YEAR, term: "1", average, classPosition: position,
    totalInClass: 30, isPublished: published, publishedAt: published ? days(-ago) : null, calcVersion: "exam-process/3",
  });
  await result("ama", "x1", 12.5, 9, true, 30);
  await result("ama", "x2", 14.25, 4, true, 5);
  await result("ama", "x3", 18, 1, false, 0);
  await result("cho", "x2", 11, 15, true, 5);
  await result("dan", "x2", 17, 2, true, 5);

  const monthStart = `${iso(now).slice(0, 7)}-01`;
  const marks = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(Date.parse(monthStart) + i * DAY);
    if (d > now) break;
    marks.push({ schoolId: sid, classId: "f1", studentId: "ama", date: iso(d), status: i === 3 ? "absent" : "present", period: "p1" });
  }
  marks.push({ schoolId: sid, classId: "f1", studentId: "ama", date: iso(days(-45)), status: "absent", period: "p1" });
  await M("StudentAttendance").collection.insertMany(marks);
  const amaMarked = marks.filter((m) => m.date >= monthStart).length;
  const amaPresent = marks.filter((m) => m.date >= monthStart && m.status === "present").length;

  await M("FeeCharge").create({ schoolId: sid, studentId: "ama", academicYear: YEAR, code: "T1", label: "Tuition", amount: 50000, dueDate: days(-5) });
  await M("FeePayment").create({ schoolId: sid, studentId: "ama", academicYear: YEAR, amount: 20000 });
  await M("FeeCharge").create({ schoolId: sid, studentId: "cho", academicYear: YEAR, code: "T1", label: "Tuition", amount: 20000, dueDate: days(10) });
  await M("FeeCharge").create({ schoolId: sid, studentId: "bih", academicYear: YEAR, code: "T1", label: "Tuition", amount: 40000, dueDate: days(-5) });
  await M("FeePayment").create({ schoolId: sid, studentId: "bih", academicYear: YEAR, amount: 40000 });

  await M("Announcement").create({ schoolId: sid, title: "Sports day", body: "Friday", audience: "all", isActive: true });
  // Three notices on days whose weekday names sort in the wrong order.
  await C("Notification").insertMany([1, 13, 3].map((ago) => ({
    schoolId: sid, studentId: "ama", kind: "result.published", channel: "log", to: "x@example.test",
    subject: `${ago} days ago`, body: "", status: "sent", deletedAt: null, readBy: [], createdAt: days(-ago), updatedAt: days(-ago),
  })));

  const portal = require(path.join(SRC, "services/portal.service"));
  const { code } = await portal.issueAccess({ schoolId: sid, studentIds: ["ama", "bih", "cho"], label: "Mrs Bate" });

  const app = express();
  app.use(express.json());
  app.use("/api/portal", require(path.join(SRC, "routes/portal.routes")));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/portal`;
  const login = await (await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admissionNo: "CS-ama", code }) })).json();
  const token = login.token ?? login.data?.token ?? login.accessToken ?? login.data?.accessToken;
  const get = async (p) => {
    const r = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const home = await get("/home");
  const cards = home.body.data?.children ?? [];
  const card = (id) => cards.find((c) => c._id === id) ?? {};

  console.log("\n--- one card per child of this code, and only them ---");
  check("200, three cards in the office's order", [home.status, cards.map((c) => c._id)], [200, ["ama", "bih", "cho"]]);
  check("another family's child is not on it", cards.some((c) => c._id === "dan"), false);
  check("each card names its class", cards.map((c) => c.className), ["Form 1", "Form 3", "Form 1"]);

  console.log("\n--- latest result: as Results shows it ---");
  const amaResults = (await get("/results?studentId=ama")).body.data;
  check("the newest published result, with the one before it (a draft is not shown)",
    [card("ama").latest?.average, card("ama").latest?.position, card("ama").latest?.outOf, card("ama").latest?.examName,
     card("ama").latest?.previousAverage, card("ama").latest?.previousExamName],
    [14.25, 4, 30, "2nd Sequence", 12.5, "1st Sequence"]);
  check("the same figure Results leads with", card("ama").latest?.average, amaResults[0].average);
  check("Results now names the exam", amaResults.map((r) => r.examName).sort(), ["1st Sequence", "2nd Sequence"]);
  check("one result: no previous to compare with", [card("cho").latest?.average, card("cho").latest?.previousAverage], [11, null]);
  check("nothing published: no latest result", card("bih").latest, null);

  console.log("\n--- attendance this month: as Attendance shows it ---");
  const amaAtt = (await get(`/attendance?studentId=ama&from=${monthStart}&to=${iso(now)}`)).body.data;
  check("present ÷ marked this month, last month left out",
    [card("ama").attendance.present, card("ama").attendance.marked], [amaPresent, amaMarked]);
  check("the same rate Attendance gives for the month", card("ama").attendance.rate, amaAtt.rate);
  check("no register this month: no rate, not 0%", [card("bih").attendance.rate, card("bih").attendance.marked], [null, 0]);

  console.log("\n--- fees: balance as Fees, overdue by the school's rule ---");
  const amaFees = (await get("/fees?studentId=ama")).body.data;
  check("the balance Fees shows", card("ama").fees?.balance, amaFees.totals.balance);
  check("owes, due date passed: overdue", [card("ama").fees?.balance, card("ama").fees?.isOverdue], [30000, true]);
  check("owes, not yet due: not overdue, with the date", [card("cho").fees?.balance, card("cho").fees?.isOverdue, Boolean(card("cho").fees?.dueDate)], [20000, false, true]);
  check("paid up: zero, not overdue", [card("bih").fees?.balance, card("bih").fees?.isOverdue], [0, false]);

  console.log("\n--- next exam and the latest news ---");
  check("the class's next exam that has not started", [card("ama").nextExam?.name, card("cho").nextExam?.name], ["3rd Sequence", "3rd Sequence"]);
  check("a class with none scheduled", card("bih").nextExam, null);
  check("the latest announcement", home.body.data?.latestNews?.title, "Sports day");

  console.log("\n--- notices, newest first ---");
  const notices = (await get("/notifications")).body.data ?? [];
  check("ordered by time, not by the weekday's name", notices.map((n) => n.subject), ["1 days ago", "3 days ago", "13 days ago"]);

  server.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
