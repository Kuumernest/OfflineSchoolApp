// backend/src/services/classSubjectTeacher.service.js
"use strict";

/**
 * Who teaches each (class, subject): the active class-subject assignments
 * (shared/classSubjectTeachers.js). The Subjects page, the exam marks screen
 * and the report card all read it here.
 */

const TeacherAssignment = require("../db/models/TeacherAssignment");
const User              = require("../db/models/User");
const { assignedTeachers, pairKey } = require("../../../shared/classSubjectTeachers");

/**
 * @param {object} args
 * @param {string} args.schoolId
 * @param {string[]} [args.classIds]    narrow to these classes
 * @param {string[]} [args.subjectIds]  narrow to these subjects
 * @returns {Promise<(classId, subjectId) => ({ teacherIds: string[], teacherName: string, teachers: Array } | null)>}
 */
async function teachersFor({ schoolId, classIds = null, subjectIds = null }) {
  const none = () => null;
  if (!schoolId) return none;
  const uniq = (xs) => [...new Set((xs || []).filter(Boolean).map(String))];
  const filter = { schoolId: String(schoolId), isActive: { $ne: false } };
  if (classIds)   { const c = uniq(classIds);   if (!c.length) return none; filter.$or = [{ class: { $in: c } }, { classId: { $in: c } }]; }
  if (subjectIds) { const s = uniq(subjectIds); if (!s.length) return none; filter.subject = { $in: s }; }

  const rows = await TeacherAssignment.find(filter).select("teacher class classId subject isActive").lean().catch(() => []);
  if (!rows.length) return none;
  const users = await User.find({ _id: { $in: uniq(rows.map((r) => r.teacher)) } })
    .select("name email").lean().catch(() => []);
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const byPair = assignedTeachers(rows, (id) => userOf.get(id) ?? null);
  return (classId, subjectId) => byPair.get(pairKey(classId, subjectId)) ?? null;
}

/**
 * Exam-subject rows with the teacher the assignment names, not the one
 * copied onto the exam when it was created. A row whose class-subject has no
 * active assignment says so (null), whatever the exam once recorded.
 */
async function withAssignedTeachers(examSubjects, schoolId) {
  if (!examSubjects?.length) return examSubjects || [];
  const lookup = await teachersFor({
    schoolId,
    classIds:   examSubjects.map((es) => es.classId),
    subjectIds: examSubjects.map((es) => es.subjectId),
  });
  return examSubjects.map((es) => {
    const t = lookup(es.classId, es.subjectId);
    return { ...es, teacherId: t?.teacherIds[0] ?? null, teacherIds: t?.teacherIds ?? [], teacherName: t?.teacherName ?? null };
  });
}

/**
 * The school's class-subject coverage (B4): pairs, distinct subjects, and the
 * pairs no active assignment covers, with their class names. Subjects of
 * inactive or deleted classes are not on anyone's timetable and do not count.
 */
async function coverageFor(schoolId) {
  const Subject = require("../db/models/Subject");
  const Class   = require("../db/models/Class");
  const { classSubjectCoverage } = require("../../../shared/classSubjectTeachers");
  const [subjects, classes, rows] = await Promise.all([
    Subject.find({ schoolId: String(schoolId), deletedAt: null }).select("name class classId deletedAt").lean(),
    // Class.deletedAt is Mixed; "not deleted" is any of these, as notDeletedClause.
    Class.find({ schoolId: String(schoolId), isActive: { $ne: false }, deletedAt: { $in: [null, "", 0, false] } }).select("name").lean(),
    TeacherAssignment.find({ schoolId: String(schoolId), isActive: { $ne: false } }).select("teacher class classId subject isActive").lean(),
  ]);
  const users = rows.length
    ? await User.find({ _id: { $in: [...new Set(rows.map((r) => String(r.teacher)))] } }).select("name").lean()
    : [];
  const userOf = new Map(users.map((u) => [String(u._id), u]));
  const byPair = assignedTeachers(rows, (id) => userOf.get(id) ?? null);
  const className = new Map(classes.map((c) => [String(c._id), c.name]));
  const cov = classSubjectCoverage(subjects, byPair, new Set(className.keys()));
  return {
    ...cov,
    unassigned: cov.unassigned
      .map((u) => ({ ...u, className: className.get(u.classId) ?? null }))
      .sort((a, b) => String(a.className).localeCompare(String(b.className), undefined, { numeric: true })
        || String(a.subjectName).localeCompare(String(b.subjectName))),
  };
}

module.exports = { teachersFor, withAssignedTeachers, coverageFor };
