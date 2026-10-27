// backend/scripts/phase-d-cleanup.js
"use strict";

/**
 * D1 — clear the test data found in pre-launch QA, and report what needs a
 * person to decide.
 *
 * Changed on --apply (soft: deletedAt + isActive false, nothing is dropped):
 *   - the student "Bin Laden" (and their login, if any)
 *   - the "Testing testing" announcement
 *   - a clearly fake address (FAKE_* below) in a pupil's email or guardian
 *     email is cleared (the pupils themselves stay)
 *   - grading-scale remarks saved as "Faire" → "Fair" (A9)
 *
 * One guardian with several children is normal: siblings sharing a guardian's
 * email or phone are NOT test data. An address is cleared only because it is
 * on the fake list, never because several pupils share it.
 *
 * Reported only:
 *   - every other address shared by several pupils, grouped by guardian, for
 *     a person to review
 *   - Kena Academy: approved students and active teachers
 *   - exams with no start date
 *   - timetable lessons in a break / missing period, or taught by a teacher not
 *     assigned to that class + subject (B1)
 *   - admission numbers not in the current CODE-YEAR-NNN shape (B3) — never
 *     rewritten, they may already be printed on paperwork
 *
 *   node scripts/phase-d-cleanup.js            # dry run (default)
 *   node scripts/phase-d-cleanup.js --apply    # write
 */

const path     = require("path");
const mongoose = require("mongoose");

const { timetableSlotProblem } = require("../../shared/timetableRules");
const { pairKey }              = require("../../shared/classSubjectTeachers");

const SRC = path.join(__dirname, "..", "src");

const TEST_STUDENT      = /bin\s*laden/i;
const TEST_ANNOUNCEMENT = /^\s*testing\s+testing\b/i;
const KENA              = /kena\s+academy/i;
const ADMISSION_SHAPE   = /^[A-Z0-9]+-\d{4}-\d{3,}$/;

// Clearly fake addresses — the only ones --apply clears. Add an exact address
// to FAKE_EMAILS once the dry run has shown it; never add a real family's.
const FAKE_EMAILS       = [];
const FAKE_DOMAINS      = ["example.com", "example.org", "example.net", "test.com", "mailinator.com"];
const FAKE_LOCAL_PART   = /^test\d*$/;               // test@…, test1@…, test123@…
const EMAIL_FIELDS      = ["email", "guardianEmail"];

const norm = (v) => String(v || "").trim().toLowerCase();
const fullNameOf = (s) => s.studentName || [s.firstName, s.lastName].filter(Boolean).join(" ");

/** Why an address is fake, or null when it is not on the list. */
function fakeReason(address) {
  const a = norm(address);
  if (!a) return null;
  if (FAKE_EMAILS.map(norm).includes(a)) return "listed";
  const [local, domain = ""] = a.split("@");
  if (FAKE_DOMAINS.includes(domain) || /\.(test|invalid|example)$/.test(domain)) return `domain ${domain}`;
  if (FAKE_LOCAL_PART.test(local)) return `"${local}@"`;
  return null;
}

const live = { deletedAt: null };
const M = (n) => mongoose.model(n);

async function collect() {
  const [schools, students, announcements, gradings, exams, slots, periods, assignments] = await Promise.all([
    M("School").find({}).select("name").lean(),
    M("Student").find(live).select("schoolId studentName firstName lastName email guardianName guardianEmail userId status enrollmentNo admissionNo").lean(),
    M("Announcement").find(live).select("schoolId title body").lean(),
    M("GradingConfig").find({ "grades.remark": /^\s*faire\s*$/i }).select("schoolId grades").lean(),
    M("Exam").find({ ...live, $or: [{ startDate: null }, { startDate: "" }] })
      .select("schoolId name className classNames academicYear term status").lean(),
    M("TimetableSlot").find(live).lean(),
    M("Period").find({}).lean(),
    M("TeacherAssignment").find({}).lean(),
  ]);
  const schoolName = new Map(schools.map((s) => [String(s._id), s.name]));
  const nameOf = (id) => schoolName.get(String(id)) || String(id);

  const testStudents = students.filter((s) => TEST_STUDENT.test(fullNameOf(s)));

  const testAnnouncements = announcements.filter(
    (a) => TEST_ANNOUNCEMENT.test(a.title || "") || TEST_ANNOUNCEMENT.test(a.body || ""),
  );

  const fakeEmails = [];
  const byEmail = new Map();
  for (const s of students) {
    for (const field of EMAIL_FIELDS) {
      const email = norm(s[field]);
      if (!email) continue;
      const reason = fakeReason(email);
      if (reason) { fakeEmails.push({ _id: s._id, school: nameOf(s.schoolId), student: fullNameOf(s), field, email, reason }); continue; }
      const key = `${s.schoolId}|${email}`;
      if (!byEmail.has(key)) byEmail.set(key, new Map());
      byEmail.get(key).set(String(s._id), s);
    }
  }
  // Review only: usually one guardian's children.
  const sharedEmails = [...byEmail.entries()]
    .map(([key, m]) => [key, [...m.values()]])
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({
      school:    nameOf(list[0].schoolId),
      email:     key.split("|")[1],
      guardians: [...new Set(list.map((s) => (s.guardianName || "").trim()).filter(Boolean))],
      students:  list,
    }));

  const faireRemarks = gradings.map((g) => ({
    _id: g._id, school: nameOf(g.schoolId),
    grades: g.grades.filter((b) => /^\s*faire\s*$/i.test(b.remark || "")).map((b) => b.grade),
  }));

  const kena = [];
  for (const s of schools.filter((x) => KENA.test(x.name || ""))) {
    const approved = students.filter((p) => String(p.schoolId) === String(s._id) && p.status === "approved").length;
    const teachers = await M("User").countDocuments({ schoolId: String(s._id), role: "teacher", isActive: true });
    kena.push({ school: s.name, students: approved, teachers });
  }

  const periodById = new Map(periods.map((p) => [String(p._id), p]));
  const assigned = new Map();
  for (const a of assignments) {
    if (a.isActive === false || a.deletedAt) continue;
    const key = pairKey(a.class, a.subject);
    if (!assigned.has(key)) assigned.set(key, []);
    assigned.get(key).push(String(a.teacher));
  }
  const badSlots = [];
  for (const slot of slots) {
    const problem = timetableSlotProblem({
      period:      periodById.get(String(slot.periodId)) || null,
      assignedIds: assigned.get(pairKey(slot.classId, slot.subjectId)) || [],
      teacherId:   slot.teacherId,
    });
    if (problem) badSlots.push({ _id: slot._id, school: nameOf(slot.schoolId), day: slot.dayOfWeek, classId: slot.classId, code: problem.code });
  }

  const admissionMismatches = [];
  for (const s of students) {
    if (s.status !== "approved") continue;
    for (const field of ["admissionNo", "enrollmentNo"]) {
      const v = String(s[field] || "").trim();
      if (v && !ADMISSION_SHAPE.test(v)) {
        admissionMismatches.push({ school: nameOf(s.schoolId), student: fullNameOf(s), field, value: v });
      }
    }
  }

  return {
    testStudents, testAnnouncements, fakeEmails, sharedEmails, faireRemarks,
    kena, examsWithoutDates: exams.map((e) => ({ ...e, school: nameOf(e.schoolId) })),
    badSlots, admissionMismatches,
  };
}

async function apply(r) {
  const now = new Date();
  const gone = { deletedAt: now, isActive: false };

  const studentIds = r.testStudents.map((s) => s._id);
  const userIds    = r.testStudents.map((s) => s.userId).filter(Boolean);
  await M("Student").updateMany({ _id: { $in: studentIds } }, { $set: gone });
  if (userIds.length) await M("User").updateMany({ _id: { $in: userIds } }, { $set: { isActive: false } });

  await M("Announcement").updateMany({ _id: { $in: r.testAnnouncements.map((a) => a._id) } }, { $set: gone });

  for (const f of r.fakeEmails) {
    await M("Student").updateOne({ _id: f._id }, { $set: { [f.field]: null } });
  }

  for (const g of r.faireRemarks) {
    await M("GradingConfig").updateOne(
      { _id: g._id },
      { $set: { "grades.$[b].remark": "Fair" } },
      { arrayFilters: [{ "b.remark": /^\s*faire\s*$/i }] },
    );
  }
}

function print(r, applied) {
  const head = (t, n) => console.log(`\n${t} (${n})`);
  const line = (s) => console.log(`  - ${s}`);
  const verb = applied ? "done" : "would";

  console.log(applied ? "PHASE D — APPLIED" : "PHASE D — DRY RUN (nothing written; --apply to write)");

  head(`Test students — ${verb} soft-delete (and deactivate login)`, r.testStudents.length);
  r.testStudents.forEach((s) => line(`${s.studentName} [${s._id}]`));

  head(`Test announcements — ${verb} soft-delete`, r.testAnnouncements.length);
  r.testAnnouncements.forEach((a) => line(`"${a.title}" [${a._id}]`));

  head(`Fake email addresses — ${verb} clear (pupils stay)`, r.fakeEmails.length);
  r.fakeEmails.forEach((f) => line(`${f.school}: ${f.student} ${f.field}=${f.email} (${f.reason})`));

  head(`Grading remarks "Faire" — ${verb} change to "Fair"`, r.faireRemarks.length);
  r.faireRemarks.forEach((g) => line(`${g.school}: grade ${g.grades.join(", ")}`));

  console.log("\n— Report only —");

  head("Addresses shared by several pupils — usually siblings, review only", r.sharedEmails.length);
  r.sharedEmails.forEach((g) => line(
    `${g.school}: ${g.guardians.join(" / ") || "(no guardian named)"} <${g.email}> — ${g.students.map(fullNameOf).join(", ")}`));

  head("Kena Academy", r.kena.length);
  r.kena.forEach((k) => line(`${k.school}: ${k.students} students, ${k.teachers} teachers`));

  head("Exams with no dates", r.examsWithoutDates.length);
  r.examsWithoutDates.forEach((e) => line(`${e.school}: ${e.name} — ${e.className || e.classNames || "no class"}, ${e.academicYear} term ${e.term} (${e.status})`));

  head("Timetable lessons breaking the B1 rules", r.badSlots.length);
  r.badSlots.forEach((s) => line(`${s.school}: ${s.day} class ${s.classId} — ${s.code} [${s._id}]`));

  head("Admission numbers not in CODE-YEAR-NNN (not rewritten)", r.admissionMismatches.length);
  r.admissionMismatches.forEach((m) => line(`${m.school}: ${m.student} ${m.field}=${m.value}`));
}

async function run({ apply: doApply = false } = {}) {
  require(path.join(SRC, "db/models"));
  const report = await collect();
  if (doApply) await apply(report);
  return report;
}

module.exports = { run, print };

if (require.main === module) {
  require("dotenv").config();
  const APPLY = process.argv.includes("--apply");
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    const report = await run({ apply: APPLY });
    print(report, APPLY);
    await mongoose.disconnect();
  })().catch((e) => { console.error(e); process.exit(1); });
}
