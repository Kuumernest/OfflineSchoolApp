// backend/scripts/check-class-subject-teachers.js
"use strict";

/**
 * Who teaches a subject in a class: one answer for the Subjects page, the
 * exam marks screen and the report card (A8, decided 2026-10-27). Pure.
 *
 *   Form 1 French:  Mrs Grace Johnson, active          → "Grace Johnson"
 *                   (the exam copied no teacher: the screen said "No teacher")
 *   Form 1 English: Mr Kum and Mr Buh, both active     → "Mr Buh, Mr Kum", sorted
 *                   Mr Buh again, inactive              → not listed twice
 *   Form 2 English: Mr Kum                              → Form 1's teachers stay Form 1's
 *   Form 1 Maths:   Mr Old, inactive                    → nobody
 *
 *   node scripts/check-class-subject-teachers.js
 */

const { assignedTeachers, pairKey } = require("../../shared/classSubjectTeachers");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};

const NAMES = { grace: "Grace Johnson", kum: "Mr Kum", buh: "Mr Buh", old: "Mr Old" };
const ROWS = [
  { teacher: "grace", class: "f1", subject: "fr-f1", isActive: true },
  { teacher: "kum",   class: "f1", subject: "en-f1", isActive: true },
  { teacher: { _id: "buh", name: "Mr Buh" }, class: "f1", subject: "en-f1" },
  { teacher: "buh",   class: "f1", subject: "en-f1", isActive: false },
  { teacher: "kum",   class: "f2", subject: "en-f2", isActive: true },
  { teacher: "old",   class: "f1", subject: "ma-f1", isActive: false },
  { teacher: "ghost", class: "f1", subject: "ph-f1", isActive: true },
];
const byPair = assignedTeachers(ROWS, (id) => (NAMES[id] ? { name: NAMES[id] } : null));
const at = (c, s) => byPair.get(pairKey(c, s)) ?? null;

check("Form 1 French: the assignment's teacher", [at("f1", "fr-f1")?.teacherIds, at("f1", "fr-f1")?.teacherName], [["grace"], "Grace Johnson"]);
check("Form 1 English: both active teachers, sorted, each once",
  [at("f1", "en-f1")?.teacherIds, at("f1", "en-f1")?.teacherName], [["buh", "kum"], "Mr Buh, Mr Kum"]);
check("a legacy row that spells the class classId is read too",
  assignedTeachers([{ teacher: "kum", classId: "f3", subject: "en-f3" }], (id) => ({ name: NAMES[id] })).get(pairKey("f3", "en-f3"))?.teacherName, "Mr Kum");
check("Form 2 English: its own assignment only", at("f2", "en-f2")?.teacherName, "Mr Kum");
check("an inactive assignment names nobody", at("f1", "ma-f1"), null);
check("an assignment to a user who no longer exists names nobody", at("f1", "ph-f1"), null);
check("a populated teacher ref reads as its id", at("f1", "en-f1")?.teacherIds.includes("buh"), true);

console.log("--- coverage (B4) ---");
const { classSubjectCoverage } = require("../../shared/classSubjectTeachers");
const SUBJECTS = [
  { _id: "fr-f1", name: "French",  classId: "f1" },
  { _id: "en-f1", name: "English", classId: "f1" },
  { _id: "ma-f1", name: "Maths",   class: "f1" },          // only the inactive assignment
  { _id: "ph-f1", name: "Physics", classId: "f1" },        // a ghost teacher
  { _id: "en-f2", name: "english", classId: "f2" },        // the same subject in another class
  { _id: "ma-f2", name: "Maths",   classId: "f2" },
  { _id: "old",   name: "Latin",   classId: "f1", deletedAt: new Date() },
  { _id: "x",     name: "Music",   classId: "gone" },      // a class no longer live
];
const cov = classSubjectCoverage(SUBJECTS, byPair, new Set(["f1", "f2"]));
check("class-subject pairs, not counting a deleted subject or a dead class", cov.classSubjects, 6);
check("distinct subjects: English in two classes is one subject", cov.distinctSubjects, 4);
check("the pairs no active assignment covers",
  cov.unassigned.map((u) => `${u.classId}/${u.subjectName}`), ["f1/Maths", "f1/Physics", "f2/Maths"]);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
