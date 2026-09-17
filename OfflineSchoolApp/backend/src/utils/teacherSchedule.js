// backend/src/utils/teacherSchedule.js
//
// Who is timetabled to teach, for a school, a day and (optionally) a period.
//
// The staff register used to list every active teacher in the school. The
// office marks staff per period, and a teacher with no class in that period
// has nothing to be present for — so the timetable, not the payroll, decides
// who is on the list:
//
//   eligible ⇔ an undeleted TimetableSlot in this school, on the weekday of
//              the attendance date, in the chosen period (or any period when
//              none is chosen), whose class is active and undeleted, whose
//              period is active and undeleted, and whose teacher is an active
//              account of this school with role "teacher".
//
// A TeacherAssignment says who MAY teach a class; it never puts anyone on the
// register by itself. A teacher with two slots in one period appears once,
// carrying both slots, because attendance is recorded for the person and the
// day, not per lesson.
//
// Everything is scoped by schoolId at the query, never by filtering afterwards,
// so a period or class id from another school resolves nobody rather than
// somebody else's staff.
"use strict";

const mongoose      = require("mongoose");
const { dayCodeFor } = require("../../../shared/timetable");
const { dateStr }    = require("../../../shared/attendance");

const byName = (a, b) => {
  const an = String(a.name ?? ""), bn = String(b.name ?? "");
  return an === bn ? String(a._id).localeCompare(String(b._id)) : an.localeCompare(bn);
};

/**
 * @param {{ schoolId: string, date?: string, periodId?: string|null }} args
 * @returns {Promise<{
 *   date: string, dayOfWeek: string|null, periodId: string|null,
 *   period: { _id: string, name: string, startTime: string, endTime: string }|null,
 *   teachers: Array<{ _id: string, name: string, email: string, role: string,
 *     slots: Array<{ classId: string, className: string|null, subjectId: string|null,
 *                    periodId: string, periodName: string|null }> }>
 * }>}
 */
async function scheduledTeachers({ schoolId, date, periodId } = {}) {
  const day       = dateStr(date);
  const dayOfWeek = dayCodeFor(day);
  const wanted    = periodId ? String(periodId).trim() : null;
  const out = { date: day, dayOfWeek, periodId: wanted || null, period: null, teachers: [] };
  if (!schoolId || !dayOfWeek) return out;

  const TimetableSlot = mongoose.model("TimetableSlot");
  const Period        = mongoose.model("Period");
  const Class         = mongoose.model("Class");
  const User          = mongoose.model("User");

  // The school's periods in force. A period id from another school, one that
  // has been switched off or one that was deleted resolves nobody.
  const periods = await Period.find({ schoolId, isActive: { $ne: false }, deletedAt: null })
    .select("_id name startTime endTime sortOrder").lean();
  const periodById = new Map(periods.map((p) => [String(p._id), p]));
  if (out.periodId) {
    const p = periodById.get(out.periodId);
    if (!p) return out;
    out.period = { _id: String(p._id), name: p.name, startTime: p.startTime, endTime: p.endTime };
  }

  const slotFilter = { schoolId, dayOfWeek, deletedAt: null };
  if (out.periodId) slotFilter.periodId = out.periodId;
  const slots = (await TimetableSlot.find(slotFilter).select("classId subjectId teacherId periodId").lean())
    .filter((s) => periodById.has(String(s.periodId)));
  if (!slots.length) return out;

  // Only a class that still exists, in this school, switched on.
  const classIds = [...new Set(slots.map((s) => String(s.classId)).filter(Boolean))];
  const classes  = await Class.find({ _id: { $in: classIds }, schoolId, isActive: { $ne: false }, deletedAt: null })
    .select("_id name").lean();
  const classById = new Map(classes.map((c) => [String(c._id), c]));
  const live = slots.filter((s) => classById.has(String(s.classId)));

  const teacherIds = [...new Set(live.map((s) => String(s.teacherId)).filter(Boolean))];
  if (!teacherIds.length) return out;

  // The account must be this school's, a teacher, and active. A slot that
  // names an id nobody holds any more is a stale reference and lists nobody.
  const teachers = await User.find({ _id: { $in: teacherIds }, schoolId, role: "teacher", isActive: true })
    .select("_id name email role").lean();

  const slotsByTeacher = new Map();
  for (const s of live) {
    const key = String(s.teacherId);
    if (!slotsByTeacher.has(key)) slotsByTeacher.set(key, []);
    slotsByTeacher.get(key).push({
      classId:    String(s.classId),
      className:  classById.get(String(s.classId))?.name ?? null,
      subjectId:  s.subjectId ? String(s.subjectId) : null,
      periodId:   String(s.periodId),
      periodName: periodById.get(String(s.periodId))?.name ?? null,
    });
  }
  const slotOrder = (a, b) =>
    ((periodById.get(a.periodId)?.sortOrder ?? 0) - (periodById.get(b.periodId)?.sortOrder ?? 0)) ||
    String(a.className ?? "").localeCompare(String(b.className ?? "")) ||
    a.classId.localeCompare(b.classId);

  out.teachers = teachers
    .map((t) => ({
      _id:   String(t._id),
      name:  t.name,
      email: t.email,
      role:  t.role,
      slots: (slotsByTeacher.get(String(t._id)) ?? []).sort(slotOrder),
    }))
    .sort(byName);
  return out;
}

module.exports = { scheduledTeachers };
