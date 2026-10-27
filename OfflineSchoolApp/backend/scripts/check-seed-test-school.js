// backend/scripts/check-seed-test-school.js
"use strict";

/**
 * seed-test-school.js makes a school the app's own rules accept, and makes it
 * once.
 *
 *   school       one, named and described as a test school; 2026/2027 with
 *                3 terms × 2 sequences; Centre region
 *   teaching     every class-subject has exactly one active teacher and a
 *                coefficient; the timetable has no clash, no lesson in a break,
 *                no teacher outside their assignment, and each class gets its
 *                weekly lessons inside school hours
 *   pupils       ~10 a class, ages inside the level's range, +237 and nine
 *                digits, one admission number format
 *   families     at least 3 guardians with 2–3 children across classes, who
 *                share the guardian's email and phone; one portal code opens
 *                all of a family's children; every other address is one person's
 *   marks        Sequences 1 and 2 /20 for every pupil and subject; results
 *                computed; Sequence 1 published, Sequence 2 not
 *   fees         some paid up, some part-paid, a few overdue — by the app's
 *                own overdue rule; receipt numbers unique
 *   logins       the printed head teacher, teacher and parent sign-ins work
 *   idempotent   a second run is refused and writes nothing
 *
 *   node scripts/check-seed-test-school.js
 */

const path     = require("path");
const bcrypt   = require("bcryptjs");
const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

const SRC = path.join(__dirname, "..", "src");

(async () => {
  process.env.JWT_SECRET         = process.env.JWT_SECRET || "test-only-secret";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-only-refresh-secret";
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  // The real unique indexes: a timetable clash or a duplicate number fails here.
  for (const n of ["Student", "User", "TimetableSlot", "FeeCharge", "FeeStructure", "StudentAttendance"]) await M(n).init();

  const { ageWarning, normalisePhone } = require("../../shared/studentValidation");
  const { timetableSlotProblem } = require("../../shared/timetableRules");
  const { firstUnpaid } = require(path.join(SRC, "services/feeReminders.service"));
  const portal = require(path.join(SRC, "services/portal.service"));
  const { seedTestSchool, SCHOOL_NAME } = require("./seed-test-school");

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
  };

  const NOW = new Date("2026-10-27T10:00:00Z");
  const out = await seedTestSchool({ now: NOW });
  const S = out.schoolId;

  console.log("\n--- the school ---");
  const school = await M("School").findById(S).lean();
  check("one school, named as a test school, in Centre", [await M("School").countDocuments(), school.name, school.region, /TEST SCHOOL/.test(school.description)], [1, SCHOOL_NAME, "Centre", true]);
  check("current year 2026/2027, XAF", [school.settings.academicYear, school.settings.currency], ["2026/2027", "XAF"]);
  const structure = await M("AcademicStructure").findOne({ schoolId: S }).lean();
  check("3 terms of 2 sequences", structure.terms.map((t) => t.sequences.map((q) => q.number)), [[1, 2], [3, 4], [5, 6]]);

  console.log("\n--- classes, subjects, teachers ---");
  const classes = await M("Class").find({ schoolId: S }).sort({ level: 1 }).lean();
  check("Form 1, Form 2, Lower Sixth, Upper Sixth", classes.map((c) => c.name), ["Form 1", "Form 2", "Lower Sixth", "Upper Sixth"]);
  const subjects = await M("Subject").find({ schoolId: S }).lean();
  const assignments = await M("TeacherAssignment").find({ schoolId: S, isActive: true }).lean();
  const teachersOf = (s) => assignments.filter((a) => a.class === s.classId && a.subject === s._id).map((a) => a.teacher);
  check("every class-subject has exactly one active teacher", subjects.filter((s) => teachersOf(s).length !== 1).map((s) => s.name), []);
  check("every subject has a coefficient of at least 1", subjects.filter((s) => !(s.coefficient >= 1)).length, 0);
  const teachers = await M("User").find({ schoolId: S, role: "teacher" }).lean();
  check("every assigned teacher is a teacher of this school", assignments.every((a) => teachers.some((t) => t._id === a.teacher)), true);

  console.log("\n--- periods and timetable ---");
  const periods = await M("Period").find({ schoolId: S }).sort({ sortOrder: 1 }).lean();
  const mins = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  check("periods run back to back from school start to school end",
    [periods[0].startTime, periods.at(-1).endTime, periods.every((p, i) => i === 0 || p.startTime === periods[i - 1].endTime && mins(p.endTime) > mins(p.startTime))],
    [school.schoolStartTime, school.schoolEndTime, true]);
  const slots = await M("TimetableSlot").find({ schoolId: S }).lean();
  const periodOf = new Map(periods.map((p) => [p._id, p]));
  check("every lesson passes the timetable rules", slots.map((s) => timetableSlotProblem({
    period: periodOf.get(s.periodId), teacherId: s.teacherId,
    assignedIds: assignments.filter((a) => a.class === s.classId && a.subject === s.subjectId).map((a) => a.teacher),
  })).filter(Boolean), []);
  const dup = (key) => slots.length - new Set(slots.map(key)).size;
  check("no class and no teacher in two places at once", [dup((s) => `${s.classId}|${s.dayOfWeek}|${s.periodId}`), dup((s) => `${s.teacherId}|${s.dayOfWeek}|${s.periodId}`)], [0, 0]);
  check("every class-subject is on the timetable", subjects.filter((s) => !slots.some((x) => x.classId === s.classId && x.subjectId === s._id)).length, 0);
  check("lessons Monday to Friday only", [...new Set(slots.map((s) => s.dayOfWeek))].sort(), ["FRI", "MON", "THU", "TUE", "WED"]);

  console.log("\n--- pupils and families ---");
  const pupils = await M("Student").find({ schoolId: S }).lean();
  const perClass = classes.map((c) => pupils.filter((p) => p.classId === c._id).length);
  check("about ten pupils in each class", perClass.every((n) => n >= 8 && n <= 12), true);
  check("every age is inside its level's range", pupils.filter((p) => ageWarning(p.dateOfBirth, p.className, null, NOW)).map((p) => p.studentName), []);
  check("every guardian phone is +237 and nine digits", pupils.filter((p) => !/^\+237[26]\d{8}$/.test(p.guardianPhone) || normalisePhone(p.guardianPhone).value !== p.guardianPhone).length, 0);
  check("one admission number format, never repeated", [pupils.every((p) => /^ETEST-2026-\d{3}$/.test(p.enrollmentNo)), new Set(pupils.map((p) => p.enrollmentNo)).size], [true, pupils.length]);
  check("every pupil has an approved login with their number", (await M("User").countDocuments({ schoolId: S, role: "student", enrollmentNo: { $in: pupils.map((p) => p.enrollmentNo) } })), pupils.length);

  const byEmail = new Map();
  for (const p of pupils) byEmail.set(p.guardianEmail, [...(byEmail.get(p.guardianEmail) || []), p]);
  const families = [...byEmail.values()].filter((kids) => kids.length >= 2);
  check("at least 3 guardians with 2–3 children", families.length >= 3 && families.every((k) => k.length <= 3), true);
  check("siblings sit in different classes", families.every((k) => new Set(k.map((p) => p.classId)).size === k.length), true);
  check("siblings share the guardian's name and phone", families.every((k) => new Set(k.map((p) => `${p.guardianName}|${p.guardianPhone}`)).size === 1), true);
  const guardians = [...byEmail.entries()].map(([email, kids]) => ({ email, name: kids[0].guardianName, phone: kids[0].guardianPhone }));
  check("each guardian address and phone belongs to one person", [new Set(guardians.map((g) => g.name)).size, new Set(guardians.map((g) => g.phone)).size], [guardians.length, guardians.length]);
  const staff = await M("User").find({ schoolId: S, role: { $ne: "student" } }).lean();
  const emails = [...staff.map((u) => u.email), ...guardians.map((g) => g.email), school.email];
  check("every address is @example.test and nobody shares one", [emails.every((e) => /^[a-z.]+@example\.test$/.test(e)), new Set(emails).size], [true, emails.length]);
  const names = [...pupils.map((p) => p.studentName), ...pupils.map((p) => p.guardianName), ...staff.map((u) => u.name)];
  check("names are plain names: letters, one space or hyphen between, nothing placeholder-like",
    names.filter((n) => !/^[\p{L}'-]+( [\p{L}'-]+)+$/u.test(n) || /\b(test|fake|dummy|demo|foo|xxx)\b/i.test(n)), []);
  const codes = await M("GuardianAccess").find({ schoolId: S }).lean();
  check("one portal code per guardian, covering all their children",
    [codes.length, codes.every((c) => byEmail.get(pupils.find((p) => p._id === c.studentIds[0]).guardianEmail).length === c.studentIds.length)], [guardians.length, true]);

  console.log("\n--- sequences and marks ---");
  const exams = await M("Exam").find({ schoolId: S }).sort({ sequenceNumber: 1 }).lean();
  check("two dated sequence exams for the four classes", exams.map((e) => [e.sequenceNumber, !!e.startDate && !!e.endDate, e.classIds.length]), [[1, true, 4], [2, true, 4]]);
  const scores = await M("StudentScore").find({ schoolId: S }).lean();
  const expected = pupils.reduce((n, p) => n + subjects.filter((s) => s.classId === p.classId).length, 0) * 2;
  check("a mark /20 for every pupil, subject and sequence", [scores.length, scores.every((s) => s.maxScore === 20 && s.score >= 0 && s.score <= 20 && s.grade)], [expected, true]);
  for (const e of exams) {
    const rs = await M("ResultSummary").find({ examId: e._id }).lean();
    check(`${e.name}: a result for every pupil, average /20, ${e.sequenceNumber === 1 ? "published" : "not yet published"}`,
      [rs.length, rs.every((r) => r.average >= 0 && r.average <= 20), rs.every((r) => r.isPublished === (e.sequenceNumber === 1))], [pupils.length, true, true]);
  }

  console.log("\n--- attendance, fees, news ---");
  const att = await M("StudentAttendance").find({ schoolId: S }).lean();
  check("a register on weekdays, mostly present", [att.length > 0, att.every((a) => [1, 2, 3, 4, 5].includes(new Date(`${a.date}T00:00:00Z`).getUTCDay())), att.filter((a) => a.status === "present").length / att.length > 0.8], [true, true, true]);
  const charges = await M("FeeCharge").find({ schoolId: S, voidedAt: null }).lean();
  const payments = await M("FeePayment").find({ schoolId: S }).lean();
  const ledger = pupils.map((p) => {
    const mine = charges.filter((c) => c.studentId === p._id);
    const term = (t) => mine.filter((c) => c.term === t).reduce((s, c) => s + c.amount, 0);
    const paid = payments.filter((x) => x.studentId === p._id).reduce((s, x) => s + x.amount, 0);
    const first = firstUnpaid(mine, paid, NOW);
    return { t1: term("First Term"), t2: term("Second Term"), paid, overdue: !!first && first.dueDate < NOW };
  });
  const paidUp   = ledger.filter((l) => l.paid >= l.t1 + l.t2).length;
  const partPaid = ledger.filter((l) => !l.overdue && l.paid > l.t1 && l.paid < l.t1 + l.t2).length;
  const overdue  = ledger.filter((l) => l.overdue).length;
  check("every pupil billed for both terms", new Set(charges.map((c) => `${c.studentId}|${c.term}`)).size, pupils.length * 2);
  console.log(`       paid up ${paidUp}, part-paid ${partPaid}, overdue ${overdue} of ${pupils.length}`);
  check("some paid ahead, some part-paid, a few overdue", [paidUp > 0, partPaid > 0, overdue >= 2 && overdue <= 8], [true, true, true]);
  check("receipt numbers are unique", new Set(payments.map((x) => x.receiptNo)).size, payments.length);
  const news = await M("Announcement").find({ schoolId: S }).lean();
  check("one normal announcement", news.map((a) => [a.priority, a.audience]), [["normal", "all"]]);

  console.log("\n--- the printed sign-ins ---");
  const { headTeacher, teacher, parent } = out.logins;
  const userBy = async (email) => M("User").findOne({ email }).select("+password role mustResetPassword").lean();
  const h = await userBy(headTeacher.email), t = await userBy(teacher.email);
  check("head teacher: school admin, password works, must change it", [h.role, await bcrypt.compare(headTeacher.password, h.password), h.mustResetPassword], ["school_admin", true, true]);
  check("teacher: password works", [t.role, await bcrypt.compare(teacher.password, t.password)], ["teacher", true]);
  const session = await portal.login({ schoolId: S, admissionNo: parent.admissionNo, code: parent.code }).catch((e) => ({ error: e.message }));
  check("parent: the code opens the portal", !session.error, true);
  check("parent has 2–3 children", parent.children.length >= 2 && parent.children.length <= 3, true);

  console.log("\n--- run it twice ---");
  const before = await Promise.all(["School", "Student", "User", "FeeCharge"].map((n) => M(n).countDocuments()));
  const again = await seedTestSchool({ now: NOW });
  check("a second run is refused", typeof again.refused === "string" && !again.schoolId, true);
  check("and writes nothing", await Promise.all(["School", "Student", "User", "FeeCharge"].map((n) => M(n).countDocuments())), before);

  console.log("\n--- start again: the D2 delete, then a fresh seed ---");
  await require("./delete-school").run({ school: S, apply: true, confirm: SCHOOL_NAME, uploadsRoot: require("os").tmpdir() });
  check("the delete leaves nothing of the school", await Promise.all(["School", "Student", "Subject", "TimetableSlot", "FeeCharge", "GuardianAccess"].map((n) =>
    M(n).countDocuments(n === "School" ? { _id: S } : { schoolId: S }))), [0, 0, 0, 0, 0, 0]);
  check("nor any of its logins", await M("User").countDocuments({ schoolId: S }), 0);
  const fresh = await seedTestSchool({ now: NOW });
  check("and the seed runs again", [!!fresh.schoolId, fresh.counts?.students], [true, pupils.length]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
