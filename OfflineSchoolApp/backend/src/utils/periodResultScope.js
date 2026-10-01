// backend/src/utils/periodResultScope.js
"use strict";

/**
 * Who reads which term and annual results, and who may compute them.
 *
 * One rule for the REST routes and the sync feed. The feed already answered
 * "published rows unless the caller is an administrator" for termResult and
 * annualResult (config/syncFeed.js, publishedUnlessAdmin); the routes answered
 * every row to every staff member, so a teacher's desk mirrored less than the
 * same teacher's browser showed. The feed's function is reused here, not
 * restated.
 *
 * On top of publication, a TEACHER reads the classes they hold an active
 * assignment in — the class-level set, because a term average spans every
 * subject — and computes only one of those classes at a time. An
 * administrator reads and computes the whole school; a bursar reads what is
 * published, school-wide, as the feed already let them. Students never reach
 * these routes (results.view is a staff capability; their own results come
 * through /results/my-results).
 */
const { scopes }            = require("../config/syncFeed");
const { teacherAssigned, teacherClassIds } = require("./teacherScope");
const TeacherAssignment     = require("../db/models/TeacherAssignment");

const teacherId = (req) => req.user?._id || req.user?.id;

/**
 * The filter fragment a read must carry for this caller.
 * @returns {Promise<object>} e.g. {} | { isPublished: true } | { isPublished: true, classId: { $in: [...] } }
 */
const readScope = async (req, schoolId) => {
  const scope = { ...scopes.publishedUnlessAdmin(req) };
  if (req.user?.role === "teacher") {
    scope.classId = { $in: await teacherClassIds(TeacherAssignment, { teacherId: teacherId(req), schoolId }) };
  }
  return scope;
};

/**
 * Apply a scope to a filter that may already name a class. A class the
 * caller asked for but may not read becomes a filter that matches nothing,
 * which is an empty page, not a 403: the list route never confirms that a
 * class exists to someone who may not read it.
 */
const applyReadScope = (filter, scope, classId) => {
  const out = { ...filter, ...scope };
  if (classId) {
    const allowed = scope.classId?.$in;
    out.classId = !allowed || allowed.includes(String(classId)) ? String(classId) : { $in: [] };
  }
  return out;
};

/**
 * Why this caller may not compute what they asked for, or null.
 * A teacher names one of their classes; the whole school is the office's run.
 */
const computeRefusal = async (req, schoolId, classId) => {
  if (req.user?.role !== "teacher") return null;
  const ok = classId && await teacherAssigned(TeacherAssignment, {
    teacherId: teacherId(req), schoolId, classId: String(classId),
  });
  if (ok) return null;
  return {
    success: false,
    code:    "CLASS_NOT_ASSIGNED",
    message: classId
      ? "You are not assigned to this class"
      : "Name one of your classes; computing the whole school is an administrator's run",
  };
};

module.exports = { readScope, applyReadScope, computeRefusal };
