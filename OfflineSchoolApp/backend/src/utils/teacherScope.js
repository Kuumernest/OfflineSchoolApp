// backend/src/utils/teacherScope.js
"use strict";

/**
 * Is this teacher assigned to this class (and subject, when one is named)?
 *
 * TeacherAssignment is the source of truth the permission registry points at:
 * "Affecter un enseignant à une classe détermine qui peut saisir les notes de
 * qui". Quiz authoring, homework, the exam mark sheet, the single-mark route
 * and the register all ask this one function, so the answer cannot drift
 * between features that all say "the teacher marks their own".
 *
 * A null subjectId asks the CLASS-level question — the one the register asks,
 * because a form master takes the whole class, not one subject in it. A
 * subjectId asks the PAIR question — the one marks ask, because a teacher of
 * Mathematics in 3A is not the teacher of Physics in 3A.
 *
 * Only ACTIVE rows count. An assignment switched off by the office is a
 * teacher who no longer teaches that class; a mark or a register queued while
 * they still did is re-authorised against today's rows when it arrives.
 *
 * The model stores `teacher`, `class` and `subject` as String UUIDs; rows
 * written by older code paths spell them teacherId, classId and subjectId, and
 * two check fixtures insert that shape raw. Both spellings are read, so an old
 * assignment grants exactly what it did.
 */
const either = (a, b, value) => ({ $or: [{ [a]: value }, { [b]: value }] });
const teacherAssigned = async (
  TeacherAssignment,
  { teacherId, schoolId, classId, subjectId = null }
) => {
  if (!teacherId || !schoolId || !classId) return false;
  if (subjectId === undefined) return false;

  const filter = {
    schoolId: String(schoolId),
    isActive: { $ne: false },
    $and: [
      either("teacher", "teacherId", String(teacherId)),
      either("class",   "classId",   String(classId)),
    ],
  };
  if (subjectId !== null) filter.$and.push(either("subject", "subjectId", String(subjectId)));

  return Boolean(await TeacherAssignment.exists(filter));
};

module.exports = { teacherAssigned };
