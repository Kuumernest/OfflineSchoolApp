// backend/src/services/timetableConflicts.service.js
//
// Loads one school's timetable into shared/timetableConflicts.js.
//
// The detection itself is shared with the desktop mirror and the phone; this
// file only knows where the rows live in Mongo. The dashboard count, the
// conflicts screen and the pre-save check all go through loadContext, so they
// cannot disagree about what counts as a conflict.
"use strict";

const mongoose  = require("mongoose");
const conflicts = require("../../../shared/timetableConflicts");

const NOT_DELETED = {
  $or: [
    { deletedAt: { $exists: false } },
    { deletedAt: { $in: [null, ""] } },
  ],
};

const model = (name) => {
  try { return mongoose.model(name); } catch { return null; }
};

/**
 * Every row the detector needs for one school, as a built context.
 * A model that is missing just contributes no rows (names then read
 * "Unknown …"), matching how the stats endpoint treats optional models.
 */
const loadContext = async (schoolId) => {
  const sid = String(schoolId ?? "").trim();
  if (!sid) return conflicts.buildContext({});

  const TimetableSlot     = model("TimetableSlot");
  const Period            = model("Period");
  const Class             = model("Class");
  const Subject           = model("Subject");
  const User              = model("User");
  const TeacherAssignment = model("TeacherAssignment");

  const [slots, periods, assignments] = await Promise.all([
    TimetableSlot ? TimetableSlot.find({ schoolId: sid, ...NOT_DELETED }).lean() : [],
    Period ? Period.find({ schoolId: sid, isActive: { $ne: false }, ...NOT_DELETED }).lean() : [],
    TeacherAssignment
      ? TeacherAssignment.find({ schoolId: sid, isActive: { $ne: false } }).select("teacher class subject isActive").lean()
      : [],
  ]);

  // Names for the whole school, not just the slots already saved: the
  // pre-save check describes a lesson whose class or subject may have no
  // slot yet, and a "Change teacher" option may name a teacher who has none.
  const teacherIds = [...new Set([
    ...slots.map((s) => String(s.teacherId)),
    ...assignments.map((a) => String(a.teacher)),
  ])];
  const quiet = (q) => (q ? q.lean().catch(() => []) : []);

  const [classes, subjects, teachers] = await Promise.all([
    quiet(Class   && Class.find({ schoolId: sid }).select("name section")),
    quiet(Subject && Subject.find({ schoolId: sid }).select("name")),
    quiet(User    && User.find({
      $or: [{ _id: { $in: teacherIds } }, { schoolId: sid, role: "teacher" }],
    }).select("name firstName lastName")),
  ]);

  return conflicts.buildContext({ slots, periods, classes, subjects, teachers, assignments });
};

/** The conflicts for a school, messages in `lang` ("en" | "fr"). */
const listConflicts = async (schoolId, lang = "en") => {
  const ctx  = await loadContext(schoolId);
  return localise(conflicts.detectConflicts(ctx), lang);
};

const localise = (list, lang) =>
  lang === "fr"
    ? list.map((c) => ({ ...c, message: conflicts.conflictMessage(c, "fr") }))
    : list;

module.exports = { loadContext, listConflicts, localise, ...conflicts };
