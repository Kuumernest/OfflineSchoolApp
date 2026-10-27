// OfflineSchoolApp/shared/classSubjectTeachers.js
"use strict";

/**
 * Who teaches a subject in a class — one answer for every screen (decided
 * 2026-10-27).
 *
 * The class-subject assignment (TeacherAssignment: teacher + class + subject)
 * is the source of truth. The Subjects page took the first assignment it found
 * for the subject, active or not; the exam marks screen printed the teacher
 * copied onto the exam when it was created; the report card read the active
 * assignments. Three screens, three answers. Here: the ACTIVE assignments of
 * that class and that subject, each teacher once, names sorted so two
 * printings agree, joined with ", " when the school has put two teachers on
 * one subject.
 *
 * Pure.
 */

const pairKey = (classId, subjectId) => `${String(classId ?? "")}|${String(subjectId ?? "")}`;

const refId = (ref) => (ref == null ? "" : String(ref?._id ?? ref));

/**
 * @param {Array} assignments  TeacherAssignment rows ({ teacher, class, subject, isActive });
 *                             a legacy row may spell the class `classId`
 * @param {(teacherId: string) => ({ name, email? }|null)} userOf
 * @returns {Map<string, { teacherIds: string[], teacherName: string, teachers: Array<{ _id, name, email }> }>}
 *          keyed by pairKey
 */
function assignedTeachers(assignments, userOf) {
  const byPair = new Map();
  for (const a of assignments || []) {
    if (!a || a.isActive === false || a.deletedAt) continue;
    const teacherId = refId(a.teacher);
    const user = teacherId ? userOf(teacherId) : null;
    if (!user?.name) continue;
    const key = pairKey(refId(a.class ?? a.classId), refId(a.subject));
    if (!byPair.has(key)) byPair.set(key, new Map());
    byPair.get(key).set(teacherId, { _id: teacherId, name: user.name, email: user.email || "" });
  }
  const out = new Map();
  for (const [key, teachers] of byPair) {
    const sorted = [...teachers.values()].sort((x, y) => x.name.localeCompare(y.name));
    out.set(key, {
      teacherIds:  sorted.map((t) => t._id),
      teacherName: [...new Set(sorted.map((t) => t.name))].join(", "),
      teachers:    sorted,
    });
  }
  return out;
}

/**
 * How many class-subjects a school has, how many distinct subjects that is,
 * and which class-subjects no active assignment covers (B4, decided
 * 2026-10-27). The dashboard said "Subjects: 105" for 105 class-subject pairs
 * — Mathematics in Form 1 and in Form 2 are two — and nowhere said that 69 of
 * them had no teacher.
 *
 * @param {Array} subjects    Subject rows (one per class); deleted ones are skipped
 * @param {Set<string>} [liveClassIds]  only subjects of these classes count
 * @param {Map} byPair        assignedTeachers(...)
 */
function classSubjectCoverage(subjects, byPair, liveClassIds = null) {
  const live = (subjects || []).filter((s) => {
    if (!s || s.deletedAt) return false;
    const cid = s.classId || s.class;
    return cid && (!liveClassIds || liveClassIds.has(String(cid)));
  });
  const names = new Set(live.map((s) => String(s.name || "").trim().toLowerCase()).filter(Boolean));
  const unassigned = live
    .filter((s) => !byPair.has(pairKey(s.classId || s.class, s._id)))
    .map((s) => ({ subjectId: String(s._id), subjectName: s.name || null, classId: String(s.classId || s.class) }));
  return { classSubjects: live.length, distinctSubjects: names.size, unassigned };
}

module.exports = { assignedTeachers, pairKey, classSubjectCoverage };
