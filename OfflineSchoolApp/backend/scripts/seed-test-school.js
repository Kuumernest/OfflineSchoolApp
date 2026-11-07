// backend/scripts/seed-test-school.js
"use strict";

/**
 * One clean, realistic TEST school to use once the real pilot schools are
 * gone: "Ecole Test Bilingue", Yaoundé, Centre region, year 2026/2027.
 *
 *   MONGODB_URI=… npm run seed:test-school
 *
 * Refuses, and writes nothing, when a school of that name or code already
 * exists — run it once. To start again: npm run school:delete -- --school
 * "Ecole Test Bilingue" --apply. If it fails half-way, what it wrote is
 * removed through the same D2 delete before it exits.
 *
 * What it makes, through the app's own rules rather than beside them:
 *
 *   school      combined Collège + Lycée, Mon–Fri 07:30–14:55, XAF, Africa/Douala;
 *               3 terms × 2 sequences (AcademicStructure.defaultTermsFor)
 *   classes     Form 1, Form 2, Lower Sixth, Upper Sixth — ~10 pupils each
 *   subjects    per class, with coefficients; ONE active teacher on every
 *               class-subject (shared/classSubjectTeachers coverage: no gaps)
 *   timetable   7 lessons a day between two breaks; every lesson passes
 *               shared/timetableRules and the clash indexes
 *   pupils      dates of birth inside the level's age range and phones as
 *               +237 and nine digits (shared/studentValidation); admission
 *               numbers from admissionNumber.service (ETEST-2026-001 …)
 *   families    four guardians with 2–3 children in different classes, who
 *               share that guardian's name, email and phone, and one portal
 *               code per family covering all of their children (CLAUDE.md)
 *   marks       Sequences 1 and 2, /20, computed with computeGrade and
 *               processExam; Sequence 1 published, Sequence 2 left for the
 *               head teacher to publish
 *   attendance  a daily register for two weeks of October
 *   fees        a Collège and a Lycée structure per term, billed through
 *               fees.service; payments with real receipt numbers — paid,
 *               part-paid and a few overdue
 *   news        one ordinary announcement
 *
 * Every e-mail is <name>@example.test and belongs to one person. Passwords are
 * random (utils/tempPassword) and must be changed at first sign-in. The head
 * teacher's, one teacher's and one parent's sign-in are printed to this
 * console once and stored nowhere else; every other account can be reset from
 * the app.
 *
 * The School model has no "test school" flag, so nothing here can keep it out
 * of the platform dashboard's totals: it is marked in its name, code (ETEST)
 * and description instead.
 */

const path     = require("path");
const mongoose = require("mongoose");

const SRC    = path.join(__dirname, "..", "src");
const SHARED = path.join(__dirname, "..", "..", "shared");

const { checkStudentInput, normalisePhone, ageWarning } = require(path.join(SHARED, "studentValidation"));
const { timetableSlotProblem } = require(path.join(SHARED, "timetableRules"));
const { assignedTeachers, classSubjectCoverage, pairKey } = require(path.join(SHARED, "classSubjectTeachers"));
const { defaultGradingConfig } = require(path.join(SHARED, "gradeScale"));
const { cleanItems, asDueDate } = require(path.join(SHARED, "feeStructures"));
const { attendanceId, schoolDaysOnly } = require(path.join(SHARED, "attendance"));
const { dayCodeFor } = require(path.join(SHARED, "timetable"));

const SCHOOL_NAME = "Ecole Test Bilingue";
const SCHOOL_CODE = "ETEST";
const YEAR        = "2026/2027";
const ADMISSION_YEAR = 2026;

// ─────────────────────────────────────────────────────────────────────────────
// The school's data, written out so it reads like the school it pretends to be
// ─────────────────────────────────────────────────────────────────────────────

const CLASSES = [
  { key: "F1", name: "Form 1",      level: "1", ages: [11, 12], cycle: "college" },
  { key: "F2", name: "Form 2",      level: "2", ages: [12, 13], cycle: "college" },
  { key: "LS", name: "Lower Sixth", level: "6", ages: [16, 17], cycle: "lycee"   },
  { key: "US", name: "Upper Sixth", level: "7", ages: [17, 18], cycle: "lycee"   },
];

// [code, name, coefficient, lessons a week, teacher key]
const SUBJECTS = {
  college: [
    ["MATH", "Mathematics",      4, 5, "maths"],
    ["ENG",  "English Language", 4, 5, "english"],
    ["FRE",  "French",           4, 5, "french"],
    ["PHY",  "Physics",          2, 2, "physics"],
    ["CHEM", "Chemistry",        2, 2, "chemistry"],
    ["BIO",  "Biology",          2, 3, "biology"],
    ["HIST", "History",          2, 2, "humanities"],
    ["GEO",  "Geography",        2, 2, "humanities"],
    ["CIT",  "Citizenship",      1, 1, "humanities"],
    ["ICT",  "Computer Science", 2, 2, "ict"],
  ],
  lycee: [
    ["MATH", "Mathematics",      5, 6, "maths"],
    ["PHY",  "Physics",          4, 5, "physics"],
    ["CHEM", "Chemistry",        4, 5, "chemistry"],
    ["BIO",  "Biology",          4, 5, "biology"],
    ["ENG",  "English Language", 2, 3, "english"],
    ["FRE",  "French",           2, 3, "french"],
    ["ICT",  "Computer Science", 2, 3, "ict"],
  ],
};

const HEAD    = { first: "Florence", last: "Ngono",  role: "school_admin" };
const BURSAR  = { first: "Pierre",   last: "Mballa", role: "bursar" };
const TEACHERS = {
  maths:      { first: "Christian",  last: "Mbouda"   },
  english:    { first: "Margaret",   last: "Ebai"     },
  french:     { first: "Hélène",     last: "Biloa"    },
  physics:    { first: "Roland",     last: "Tchoumi"  },
  chemistry:  { first: "Agnes",      last: "Mokube"   },
  biology:    { first: "Felix",      last: "Nkwenti"  },
  humanities: { first: "Josephine",  last: "Ekwalla"  },
  ict:        { first: "Armand",     last: "Kouam"    },
};
const CLASS_TEACHER = { F1: "english", F2: "french", LS: "maths", US: "physics" };

// The bell. Seven lessons between a morning break and lunch.
const PERIODS = [
  ["Period 1",    "07:30", "08:25", false],
  ["Period 2",    "08:25", "09:20", false],
  ["Period 3",    "09:20", "10:15", false],
  ["Short break", "10:15", "10:35", true ],
  ["Period 4",    "10:35", "11:30", false],
  ["Period 5",    "11:30", "12:25", false],
  ["Lunch break", "12:25", "13:05", true ],
  ["Period 6",    "13:05", "14:00", false],
  ["Period 7",    "14:00", "14:55", false],
];
const DAYS = ["MON", "TUE", "WED", "THU", "FRI"];

/**
 * Families with several children: each child carries the guardian's own name,
 * email and phone. The first is the parent whose sign-in is printed.
 */
const FAMILIES = [
  { guardian: ["Grace", "Tabi", "Mother"], children: [
    ["F1", "Brenda", "female"], ["F2", "Collins", "male"], ["LS", "Mirabel", "female"] ] },
  { guardian: ["Emmanuel", "Fon", "Father"], children: [
    ["F1", "Clarisse", "female"], ["F2", "Divine", "male"], ["US", "Ethan", "male"] ] },
  { guardian: ["Paul", "Essomba", "Father"], children: [
    ["F1", "Inès", "female"], ["US", "Arthur", "male"] ] },
  { guardian: ["Solange", "Mbarga", "Mother"], children: [
    ["F2", "Kevin", "male"], ["LS", "Laure", "female"] ] },
];

// One child, one guardian: [class, first, gender, guardian first, relation].
// The surname is the family's.
const SINGLES = [
  ["F1", "Audrey",   "female", "Nkongho",  "Pauline",   "Mother"],
  ["F1", "Bryan",    "male",   "Atangana", "Joseph",    "Father"],
  ["F1", "Chantal",  "female", "Nana",     "Bernadette","Mother"],
  ["F1", "Daniel",   "male",   "Ewane",    "Simon",     "Father"],
  ["F1", "Esther",   "female", "Kamga",    "Rose",      "Mother"],
  ["F1", "Franck",   "male",   "Ndzana",   "Martin",    "Father"],
  ["F1", "Gloria",   "female", "Ayuk",     "Comfort",   "Mother"],
  ["F2", "Hervé",    "male",   "Owona",    "Thérèse",   "Mother"],
  ["F2", "Joy",      "female", "Tanyi",    "Peter",     "Father"],
  ["F2", "Karl",     "male",   "Mvondo",   "Albert",    "Father"],
  ["F2", "Linda",    "female", "Foncha",   "Mary",      "Mother"],
  ["F2", "Marc",     "male",   "Ekane",    "Sylvie",    "Mother"],
  ["F2", "Nadia",    "female", "Fouda",    "Bernard",   "Father"],
  ["F2", "Olivier",  "male",   "Tchinda",  "Odile",     "Mother"],
  ["LS", "Patience", "female", "Achu",     "Elizabeth", "Mother"],
  ["LS", "Quentin",  "male",   "Abega",    "Jacques",   "Father"],
  ["LS", "Rita",     "female", "Nkeng",    "Lucas",     "Father"],
  ["LS", "Samuel",   "male",   "Etame",    "Brigitte",  "Mother"],
  ["LS", "Tatiana",  "female", "Mbah",     "Vivian",    "Mother"],
  ["LS", "Ulrich",   "male",   "Manga",    "Gaston",    "Father"],
  ["LS", "Vanessa",  "female", "Ngwa",     "Julius",    "Father"],
  ["LS", "William",  "male",   "Asong",    "Regina",    "Mother"],
  ["US", "Yvette",   "female", "Nji",      "Clement",   "Father"],
  ["US", "Alain",    "male",   "Onana",    "Monique",   "Mother"],
  ["US", "Bertrand", "male",   "Tambe",    "Henry",     "Father"],
  ["US", "Cynthia",  "female", "Elad",     "Dorothy",   "Mother"],
  ["US", "Didier",   "male",   "Zambo",    "Cécile",    "Mother"],
  ["US", "Eunice",   "female", "Ashu",     "Stephen",   "Father"],
  ["US", "Fabrice",  "male",   "Mbida",    "Yvonne",    "Mother"],
  ["US", "Hope",     "female", "Takang",   "Francis",   "Father"],
];

// Fees, whole XAF. Billed per term; First Term is past due, Second Term is not.
const FEES = {
  college: { tuition: 75000, pta: 10000 },
  lycee:   { tuition: 95000, pta: 10000 },
};
const TERM_DUE = { "First Term": "2026-10-05", "Second Term": "2027-01-11" };

const SEQUENCES = [
  { number: 1, term: 1, name: "Sequence 1", start: "2026-09-28", end: "2026-10-02", publish: true  },
  { number: 2, term: 1, name: "Sequence 2", start: "2026-10-19", end: "2026-10-23", publish: false },
];
const REGISTER_DAYS = { from: "2026-10-12", to: "2026-10-23" };

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Repeatable "random": the same run makes the same marks and payments. */
const prng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const ascii = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const emailOf = (first, last) => `${ascii(first)}.${ascii(last)}@example.test`;
const fullName = (p) => `${p.first} ${p.last}`;

/** Cameroon mobiles: 67/69/65/68 and seven digits, a different one each call. */
const phoneMaker = () => {
  let i = 0;
  const used = new Set();
  return () => {
    for (;;) {
      i += 1;
      const raw = `6${"7958"[i % 4]}${String(1000000 + ((i * 1046527) % 9000000)).padStart(7, "0")}`;
      const { value, error } = normalisePhone(raw);
      if (error) throw new Error(`seed phone ${raw}: ${error}`);
      if (!used.has(value)) { used.add(value); return value; }
    }
  };
};

const dayRange = (from, to) => {
  const out = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

/**
 * Place every class's lessons on the week without a clash: a class or a
 * teacher is in one place a period. Spread a subject across days first.
 */
function planTimetable(classes, lessonsOf, teachingPeriods) {
  const busyTeacher = new Set();          // teacher|day|period
  const slots = [];
  for (const cls of classes) {
    const free = new Set();               // day|period still open for this class
    for (const d of DAYS) for (const p of teachingPeriods) free.add(`${d}|${p._id}`);
    const perDay = new Map();             // subject|day → lessons that day
    // The busiest teachers first, while there is most room.
    const lessons = lessonsOf(cls).sort((a, b) => b.load - a.load || a.code.localeCompare(b.code));
    for (const lesson of lessons) {
      const days = [...DAYS].sort((a, b) =>
        (perDay.get(`${lesson.subjectId}|${a}`) || 0) - (perDay.get(`${lesson.subjectId}|${b}`) || 0));
      let placed = null;
      for (const d of days) {
        for (const p of teachingPeriods) {
          if (!free.has(`${d}|${p._id}`) || busyTeacher.has(`${lesson.teacherId}|${d}|${p._id}`)) continue;
          placed = { d, p };
          break;
        }
        if (placed) break;
      }
      if (!placed) throw new Error(`No free period for ${lesson.code} in ${cls.name}`);
      free.delete(`${placed.d}|${placed.p._id}`);
      busyTeacher.add(`${lesson.teacherId}|${placed.d}|${placed.p._id}`);
      perDay.set(`${lesson.subjectId}|${placed.d}`, (perDay.get(`${lesson.subjectId}|${placed.d}`) || 0) + 1);
      slots.push({ classId: cls._id, subjectId: lesson.subjectId, teacherId: lesson.teacherId, periodId: placed.p._id, dayOfWeek: placed.d });
    }
  }
  return slots;
}

// ─────────────────────────────────────────────────────────────────────────────
// The seed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the school. Needs a mongoose connection with the models loaded.
 *
 * @param {object} [opts]
 * @param {Date}   [opts.now]  "today", for age checks
 * @returns {Promise<{ refused?: string, schoolId?: string, logins?: object, counts?: object }>}
 */
async function seedTestSchool({ now = new Date() } = {}) {
  require(path.join(SRC, "db/models"));
  const M = (n) => mongoose.model(n);
  const { generateTempPassword } = require(path.join(SRC, "utils/tempPassword"));
  const { nextAdmissionNo }      = require(path.join(SRC, "services/admissionNumber.service"));
  const fees                     = require(path.join(SRC, "services/fees.service"));
  const { computeGrade, processExam } = require(path.join(SRC, "services/examProcess.service"));
  const { publishResults }       = require(path.join(SRC, "services/results.service"));
  const { weightFor }            = require(path.join(SRC, "services/subjectCoefficient.service"));
  const portal                   = require(path.join(SRC, "services/portal.service"));

  const exists = await M("School").findOne({
    deletedAt: null,
    $or: [{ name: SCHOOL_NAME }, { code: SCHOOL_CODE }],
  }).select("_id name").lean();
  if (exists) {
    return { refused: `"${exists.name}" already exists (${exists._id}). Nothing was written. ` +
      `To recreate it: npm run school:delete -- --school "${exists.name}" --apply` };
  }

  // ── School ────────────────────────────────────────────────────────────────
  const school = await M("School").create({
    name: SCHOOL_NAME, code: SCHOOL_CODE,
    description: "TEST SCHOOL — not a real school. Made by scripts/seed-test-school.js for trying the app.",
    motto: "Learning together", address: "Rue de l'École, Bastos", city: "Yaoundé",
    region: "Centre", division: "Mfoundi", country: "Cameroon",
    phone: "+237222000000", email: "secretariat.ecoletestbilingue@example.test",
    schoolType: "combined", termSystem: "trimester", defaultLanguage: "en",
    principalName: fullName(HEAD),
    academicYearStart: "2026-09-07", academicYearEnd: "2027-06-25",
    schoolDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    schoolStartTime: PERIODS[0][1], schoolEndTime: PERIODS[PERIODS.length - 1][2],
    isActive: true, verified: false,
    settings: { academicYear: YEAR, currentTerm: "First Term", currency: "XAF", timezone: "Africa/Douala" },
  });
  const schoolId = String(school._id);

  // Continuous assessment off: a sequence here is its paper, marked /20.
  await M("GradingConfig").create({ ...defaultGradingConfig(schoolId), caEnabled: false });
  await M("AcademicStructure").create({
    schoolId, academicYear: YEAR, terms: M("AcademicStructure").defaultTermsFor("en"),
    annualAverageMethod: "terms", passMark: 10, promotionThreshold: 10,
  });

  // ── Staff ─────────────────────────────────────────────────────────────────
  const logins = {};
  const staff = async (person, role) => {
    const password = generateTempPassword();
    const user = await M("User").create({
      name: fullName(person), email: emailOf(person.first, person.last), password,
      role, schoolId, isActive: true, mustResetPassword: true,
    });
    return { user, password };
  };
  const head = await staff(HEAD, "school_admin");
  logins.headTeacher = { name: head.user.name, email: head.user.email, password: head.password };
  const bursar = (await staff(BURSAR, "bursar")).user;
  const teacherIds = {};
  for (const [key, person] of Object.entries(TEACHERS)) {
    const t = await staff(person, "teacher");
    teacherIds[key] = String(t.user._id);
    if (key === "maths") logins.teacher = { name: t.user.name, email: t.user.email, password: t.password };
  }
  const by = String(head.user._id);
  const teacherNameById = new Map(Object.entries(teacherIds).map(([key, id]) => [id, fullName(TEACHERS[key])]));

  // ── Classes, subjects, assignments ────────────────────────────────────────
  const classes = [];
  for (const c of CLASSES) {
    const teacherKey = CLASS_TEACHER[c.key];
    classes.push((await M("Class").create({
      schoolId, name: c.name, level: c.level, capacity: 40, isActive: true,
      isFinalYear: c.key === "US",
      classTeacherId: teacherIds[teacherKey], classTeacherName: fullName(TEACHERS[teacherKey]),
      createdBy: by,
    })).toObject());
  }
  const classByKey = Object.fromEntries(CLASSES.map((c, i) => [c.key, { ...c, ...classes[i] }]));
  // Where each class goes next year, stated (Form 3 is not in this school).
  await M("Class").updateOne({ _id: classByKey.F1._id }, { nextClassId: classByKey.F2._id });
  await M("Class").updateOne({ _id: classByKey.LS._id }, { nextClassId: classByKey.US._id });

  const subjectsByClass = new Map();
  for (const c of Object.values(classByKey)) {
    const rows = [];
    for (const [code, name, coefficient, perWeek, teacherKey] of SUBJECTS[c.cycle]) {
      const subject = (await M("Subject").create({
        schoolId, classId: c._id, class: c._id, name, code, coefficient,
      })).toObject();
      await M("TeacherAssignment").create({
        schoolId, teacher: teacherIds[teacherKey], class: c._id, subject: subject._id,
        assignedBy: by, isActive: true,
      });
      rows.push({ ...subject, perWeek, teacherId: teacherIds[teacherKey] });
    }
    subjectsByClass.set(String(c._id), rows);
  }

  // ── Bell and timetable ────────────────────────────────────────────────────
  const periods = [];
  for (const [i, [name, startTime, endTime, isBreak]] of PERIODS.entries()) {
    periods.push((await M("Period").create({
      schoolId, name, startTime, endTime, isBreak, sortOrder: i + 1, isActive: true, assignedBy: by,
    })).toObject());
  }
  const teaching = periods.filter((p) => !p.isBreak);
  const load = new Map();
  for (const rows of subjectsByClass.values()) for (const s of rows) load.set(s.teacherId, (load.get(s.teacherId) || 0) + s.perWeek);

  const plan = planTimetable(Object.values(classByKey), (cls) => subjectsByClass.get(String(cls._id)).flatMap((s) =>
    Array.from({ length: s.perWeek }, () => ({ subjectId: s._id, code: s.code, teacherId: s.teacherId, load: load.get(s.teacherId) }))),
  teaching);
  const assignments = await M("TeacherAssignment").find({ schoolId, isActive: true }).lean();
  const byPair = assignedTeachers(assignments, (id) => ({ name: id }));
  const periodById = new Map(periods.map((p) => [String(p._id), p]));
  for (const slot of plan) {
    const problem = timetableSlotProblem({
      period: periodById.get(String(slot.periodId)),
      assignedIds: byPair.get(pairKey(slot.classId, slot.subjectId))?.teacherIds ?? [],
      teacherId: slot.teacherId,
    });
    if (problem) throw new Error(`timetable: ${problem.message}`);
  }
  await M("TimetableSlot").insertMany(plan.map((s) => ({ ...s, schoolId, room: null })));

  // ── Fee structures (before the pupils, so enrolling bills them) ───────────
  for (const [cycle, amounts] of Object.entries(FEES)) {
    const classIds = Object.values(classByKey).filter((c) => c.cycle === cycle).map((c) => String(c._id));
    for (const [term, due] of Object.entries(TERM_DUE)) {
      const items = [{ code: "TUITION", label: `Tuition — ${term}`, labelFr: `Scolarité — ${term === "First Term" ? "1er trimestre" : "2e trimestre"}`, amount: amounts.tuition }];
      if (term === "First Term") items.push({ code: "PTA", label: "PTA levy", labelFr: "Cotisation APE", amount: amounts.pta });
      const clean = cleanItems(items);
      if (clean.error) throw new Error(`fees: ${clean.error}`);
      await M("FeeStructure").create({
        schoolId, academicYear: YEAR, classIds, term, dueDate: asDueDate(due),
        items: clean.value, isActive: true, createdBy: by,
      });
    }
  }

  // ── Pupils and their guardians ────────────────────────────────────────────
  const nextPhone = phoneMaker();
  const rand = prng(20262027);
  const pupils = [];
  const seenNames = new Set();
  const enrol = async ({ classKey, first, last, gender, guardian }) => {
    const cls = classByKey[classKey];
    const studentName = `${first} ${last}`;
    if (seenNames.has(studentName)) throw new Error(`two pupils named ${studentName}`);
    seenNames.add(studentName);
    // A birthday inside the level's usual ages on the day of the run.
    const age = cls.ages[Math.floor(rand() * cls.ages.length)];
    const month = 1 + Math.floor(rand() * 12), day = 1 + Math.floor(rand() * 28);
    let dob = `${now.getUTCFullYear() - age}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (ageWarning(dob, cls.name, null, now)) dob = `${now.getUTCFullYear() - age - 1}-01-15`;
    const input = checkStudentInput({ dateOfBirth: dob, guardianPhone: guardian.phone }, { className: cls.name, now });
    if (input.errors.length || input.warnings.length) {
      throw new Error(`${studentName}: ${[...input.errors, ...input.warnings.map((w) => w.message)].join("; ")}`);
    }
    const enrollmentNo = await nextAdmissionNo(schoolId, { year: ADMISSION_YEAR });
    const user = await M("User").create({
      name: studentName, email: null, password: generateTempPassword(), enrollmentNo,
      role: "student", schoolId, classId: String(cls._id), isActive: true, mustResetPassword: true,
    });
    const when = new Date("2026-09-07T08:00:00Z");
    const student = await M("Student").create({
      userId: user._id, schoolId, classId: String(cls._id), className: cls.name, grade: cls.name,
      enrollmentNo, studentName, firstName: first, lastName: last, gender,
      dateOfBirth: input.values.dateOfBirth, address: "Yaoundé",
      guardianName: guardian.name, guardianPhone: input.values.guardianPhone,
      guardianEmail: guardian.email, guardianRelation: guardian.relation,
      status: "approved", isActive: true, reviewedBy: by, reviewedAt: when, approvedAt: when, enrolledAt: when,
    });
    await fees.applyActiveStructuresForStudent({ schoolId, student: { _id: student._id, classId: String(cls._id) }, raisedBy: by });
    const row = { _id: String(student._id), classId: String(cls._id), classKey, studentName, enrollmentNo, ability: 7 + rand() * 10 };
    pupils.push(row);
    return row;
  };

  const families = [];
  for (const f of FAMILIES) {
    const [gFirst, gLast, relation] = f.guardian;
    const guardian = { name: `${gFirst} ${gLast}`, email: emailOf(gFirst, gLast), phone: nextPhone(), relation };
    const kids = [];
    for (const [classKey, first, gender] of f.children) kids.push(await enrol({ classKey, first, last: gLast, gender, guardian }));
    families.push({ guardian, kids });
  }
  for (const [classKey, first, gender, last, gFirst, relation] of SINGLES) {
    const guardian = { name: `${gFirst} ${last}`, email: emailOf(gFirst, last), phone: nextPhone(), relation };
    families.push({ guardian, kids: [await enrol({ classKey, first, last, gender, guardian })] });
  }

  // One portal code per guardian, covering all of their children.
  for (const [i, fam] of families.entries()) {
    const { code } = await portal.issueAccess({
      schoolId, studentIds: fam.kids.map((k) => k._id), label: fam.guardian.name, createdBy: by,
    });
    if (i === 0) {
      logins.parent = {
        name: fam.guardian.name, email: fam.guardian.email,
        children: fam.kids.map((k) => `${k.studentName} (${classByKey[k.classKey].name}, ${k.enrollmentNo})`),
        admissionNo: fam.kids[0].enrollmentNo, code,
      };
    }
  }

  // ── Sequences 1 and 2: one exam each for the four classes, marks /20 ──────
  const gradingConfig = await M("GradingConfig").findOne({ schoolId }).lean();
  const allClassIds = Object.values(classByKey).map((c) => String(c._id));
  for (const seq of SEQUENCES) {
    const exam = await M("Exam").create({
      schoolId, classId: allClassIds[0], className: classes[0].name,
      classIds: allClassIds, classNames: classes.map((c) => c.name).join(", "),
      name: seq.name, type: "test", academicYear: YEAR, term: seq.term, sequenceNumber: seq.number,
      startDate: seq.start, endDate: seq.end, totalMarks: 20, passMark: 10, status: "ongoing", createdBy: by,
    });
    const scores = [];
    for (const c of Object.values(classByKey)) {
      for (const s of subjectsByClass.get(String(c._id))) {
        const es = await M("ExamSubject").create({
          examId: exam._id, subjectId: s._id, classId: c._id, schoolId,
          teacherId: s.teacherId, subjectName: s.name, teacherName: teacherNameById.get(s.teacherId),
          maxScore: 20, passMark: 10, weight: Math.round(weightFor(s.coefficient)),
          submissionStatus: "approved", submittedAt: new Date(`${seq.end}T16:00:00Z`), submittedBy: s.teacherId,
        });
        for (const p of pupils.filter((x) => x.classKey === c.key)) {
          // A pupil's level, a subject's lean, a paper's luck — in quarter marks.
          const raw = p.ability + (rand() - 0.5) * 6 + (seq.number === 2 ? 0.5 : 0);
          const score = Math.max(2, Math.min(19.5, Math.round(raw * 4) / 4));
          const g = computeGrade(score, 20, gradingConfig);
          scores.push({
            examId: exam._id, examSubjectId: es._id, studentId: p._id, subjectId: s._id, classId: c._id, schoolId,
            score, maxScore: 20, passMark: 10, percentage: g.percentage, grade: g.grade, remark: g.remark,
            gpaPoints: g.gpaPoints, isPassing: g.isPassing, isAbsent: false,
            enteredBy: s.teacherId, enteredAt: new Date(`${seq.end}T15:00:00Z`), syncStatus: "synced",
          });
        }
      }
    }
    await M("StudentScore").insertMany(scores);
    const processed = await processExam({ exam: exam.toObject(), schoolId, userId: by });
    if (processed.status !== 200) throw new Error(`processing ${seq.name}: ${processed.body?.message}`);
    if (seq.publish) await publishResults(String(exam._id), null, by);
  }

  // ── Attendance: a daily register, two school weeks ────────────────────────
  const registerDays = schoolDaysOnly(dayRange(REGISTER_DAYS.from, REGISTER_DAYS.to), school.schoolDays);
  const attendance = [];
  for (const date of registerDays) {
    if (!DAYS.includes(dayCodeFor(date))) continue;
    for (const p of pupils) {
      const r = rand();
      const status = r < 0.04 ? "absent" : r < 0.08 ? "late" : r < 0.095 ? "excused" : "present";
      const key = { schoolId, classId: p.classId, subjectId: null, periodId: null, studentId: p._id, date };
      const cls = Object.values(classByKey).find((c) => String(c._id) === p.classId);
      attendance.push({
        _id: attendanceId(key), ...key, status, markedBy: cls.classTeacherId,
        markedAt: new Date(`${date}T07:40:00Z`), note: status === "excused" ? "Medical appointment" : null,
      });
    }
  }
  await M("StudentAttendance").insertMany(attendance);

  // ── Payments: most paid, some part-paid, a few overdue ────────────────────
  // By position in the register, so each kind lands in every class. The
  // printed parent's three children show three states: paid for the term,
  // overdue on a part payment, paid ahead.
  const PAYS = ["t1", "t1", "t1", "t1+part", "t1", "t1+t2", "t1", "part-t1", "t1", "t1+part"];
  const OVERRIDE = { 0: "t1", 1: "part-t1", 2: "t1+t2", 19: "none", 33: "none" };
  const methods = ["mobile_money", "cash", "bank", "mobile_money"];
  let receipts = 0;
  for (const [i, p] of pupils.entries()) {
    const charges = await M("FeeCharge").find({ schoolId, studentId: p._id, voidedAt: null, deletedAt: null }).lean();
    const owed = (term) => charges.filter((c) => c.term === term).reduce((s, c) => s + c.amount, 0);
    const t1 = owed("First Term"), t2 = owed("Second Term");
    const kind = OVERRIDE[i] ?? PAYS[i % PAYS.length];
    const amounts = {
      "t1": [t1], "t1+part": [t1, 40000], "t1+t2": [t1, t2], "part-t1": [Math.round(t1 / 2 / 5000) * 5000], "none": [],
    }[kind];
    for (const [j, amount] of amounts.entries()) {
      const receivedAt = new Date(Date.UTC(2026, 8, 10 + ((i * 3 + j * 9) % 30), 9, 0, 0));
      await M("FeePayment").create({
        schoolId, studentId: p._id, academicYear: YEAR, classId: p.classId, amount,
        method: methods[(i + j) % methods.length], reference: null,
        receiptNo: await fees.nextReceiptNo(schoolId, YEAR), receivedAt, receivedBy: String(bursar._id), source: "web",
      });
      receipts += 1;
    }
  }

  // ── One ordinary announcement ─────────────────────────────────────────────
  await M("Announcement").create({
    schoolId, title: "Parent–teacher meeting on Saturday 14 November",
    body: "Dear parents, the first-term parent–teacher meeting will hold on Saturday 14 November from 9:00 in the main hall. " +
      "Class teachers will be available to discuss your child's Sequence 1 and 2 results.",
    author: by, authorName: fullName(HEAD), authorRole: "school_admin",
    audience: "all", priority: "normal", isActive: true,
  });

  // ── The promise: no class-subject without its teacher ─────────────────────
  const users = await M("User").find({ schoolId }).select("_id name email").lean();
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const coverage = classSubjectCoverage(
    await M("Subject").find({ schoolId, deletedAt: null }).lean(),
    assignedTeachers(await M("TeacherAssignment").find({ schoolId }).lean(), (id) => userOf.get(id) ?? null),
  );
  if (coverage.unassigned.length) throw new Error(`${coverage.unassigned.length} class-subject(s) without a teacher`);

  return {
    schoolId, logins,
    counts: {
      classes: classes.length, classSubjects: coverage.classSubjects, teachers: Object.keys(teacherIds).length,
      periods: periods.length, lessons: plan.length, students: pupils.length,
      multiChildGuardians: families.filter((f) => f.kids.length > 1).length,
      attendance: attendance.length, payments: receipts,
    },
  };
}

module.exports = { seedTestSchool, SCHOOL_NAME, SCHOOL_CODE, planTimetable };

// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  (async () => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) { console.error("Set MONGODB_URI."); process.exit(2); }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

    // The services it calls narrate every pupil billed; the sign-ins below
    // should not drown in that.
    const log = console.log;
    console.log = () => {};
    let result;
    try {
      result = await seedTestSchool();
    } catch (err) {
      console.log = log;
      console.error(`\nSeed failed: ${err.message}`);
      // Take back what was written, with the D2 delete, so a rerun can start clean.
      const made = await mongoose.model("School").findOne({ name: SCHOOL_NAME, code: SCHOOL_CODE }).select("_id").lean();
      if (made) {
        try {
          await require("./delete-school").run({ school: String(made._id), apply: true, confirm: SCHOOL_NAME });
          console.error("What had been written was removed. Fix the cause and run it again.");
        } catch (cleanup) {
          console.error(`Clean-up failed too (${cleanup.message}). Remove it with: npm run school:delete -- --school "${SCHOOL_NAME}" --apply`);
        }
      }
      await mongoose.disconnect();
      process.exit(1);
    }
    console.log = log;
    await mongoose.disconnect();

    if (result.refused) { console.error(`Refused: ${result.refused}`); process.exit(1); }

    const { logins, counts } = result;
    console.log(`\n${SCHOOL_NAME} created (${result.schoolId}).`);
    console.log(`  ${counts.classes} classes, ${counts.classSubjects} class-subjects all with a teacher, ${counts.teachers} teachers,`);
    console.log(`  ${counts.lessons} timetabled lessons, ${counts.students} pupils, ${counts.multiChildGuardians} guardians with several children,`);
    console.log(`  ${counts.attendance} register marks, ${counts.payments} fee payments.`);
    console.log("\nSign-ins — shown once, stored nowhere. Each password must be changed at first sign-in.\n");
    console.log(`  Head teacher   ${logins.headTeacher.name}\n                 ${logins.headTeacher.email}  /  ${logins.headTeacher.password}`);
    console.log(`  Teacher        ${logins.teacher.name} (Mathematics, all four classes)\n                 ${logins.teacher.email}  /  ${logins.teacher.password}`);
    console.log(`  Parent portal  ${logins.parent.name}, ${logins.parent.children.length} children: ${logins.parent.children.join("; ")}`);
    console.log(`                 admission no. ${logins.parent.admissionNo}  /  code ${logins.parent.code}\n`);
  })().catch((err) => { console.error(err); process.exit(1); });
}
