// OfflineSchoolApp/shared/timetableRules.js
"use strict";

/**
 * What a timetable lesson must satisfy beyond "no clash" (B1, decided
 * 2026-10-27).
 *
 *   - It sits in a teaching period. A Break (any period marked isBreak) is not
 *     a lesson; a period that is inactive or deleted is not on the grid.
 *   - Its teacher is one the class-subject assignment names for that class and
 *     subject (shared/classSubjectTeachers.js). Mrs Johnson, who teaches Form 1
 *     French, was accepted for Form 1 English on Friday.
 *
 * Pure. The server, the desktop mirror and the web grid ask it the same
 * question.
 *
 * @param {object} args
 * @param {object|null} args.period       the Period row the lesson is in
 * @param {string[]}    args.assignedIds  teacher ids assigned to this class + subject
 * @param {string}      args.teacherId
 * @returns {null | { code: "period_missing"|"break_period"|"teacher_not_assigned", message: string }}
 */
function timetableSlotProblem({ period, assignedIds, teacherId }) {
  if (!period || period.deletedAt || period.isActive === false) {
    return { code: "period_missing", message: "This period is not on the school's timetable" };
  }
  if (period.isBreak) {
    return { code: "break_period", message: `${period.name || "This period"} is a break — no lesson can be placed in it` };
  }
  if (!(assignedIds || []).map(String).includes(String(teacherId))) {
    return {
      code: "teacher_not_assigned",
      message: "This teacher is not assigned to this subject in this class. Assign them on the Teachers page first.",
    };
  }
  return null;
}

module.exports = { timetableSlotProblem };
