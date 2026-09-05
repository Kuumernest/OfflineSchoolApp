// desktop/src/main/api/handlers/attendance.js
"use strict";

/**
 * The register.
 *
 * ── Dates here are strings, and that is what makes this simple ────────────
 *
 * Attendance is keyed by a `date` field holding "2026-09-15" — a calendar day,
 * not an instant. The server normalises whatever it is given with
 * new Date(x).toISOString().slice(0, 10), so a range query compares those
 * strings, and strings in that format compare correctly as text. No timezone
 * arithmetic is involved on either side, which is the right shape for a register:
 * a pupil was present on a DAY, and which day that is does not depend on where
 * the reader is standing.
 *
 * The same normalisation is applied here, including its fallback: an
 * unparseable date becomes TODAY on the server rather than an error. That is
 * surprising enough to reproduce deliberately rather than improve on — a mirror
 * that refused what the server accepts would send the request to the network and
 * get a different answer than the one it declined to give.
 *
 * ── No deleted filter, and no limit ───────────────────────────────────────
 *
 * The endpoint applies neither. Both are reproduced as they are: a mirror that
 * filtered deleted rows would show fewer marks than the server, and one that
 * capped the result would disagree about a term's register.
 */

const ok = (payload) => ({ status: 200, data: { success: true, ...payload } });

/** Today, as the server writes it. */
/**
 * ── Which day a mark belongs to, defined once ─────────────────────────────
 *
 * This file used to carry its own copy of todayStr and dateStr, with a comment
 * admitting they duplicated attendance.routes.js and were "not an improvement to
 * make on one side only". They come from shared/attendance.js now, so there is
 * no side to make it on: the endpoint and this handler agree by construction.
 *
 * It matters more than tidiness. dateStr falls back to TODAY on anything
 * unparseable, so two implementations that disagreed by a character would write
 * a queued register against one day and apply it against another — and the two
 * would disagree about who was in the room with nothing to show why.
 */
const { dateStr, lastSevenDays } = require("../../../../../shared/attendance");

/**
 * A calendar-day filter, as both teacher and pupil queries build it.
 *
 * A date wins outright; otherwise startDate and endDate bound a range, either
 * end of which may be absent. Dates are stored as "YYYY-MM-DD" strings, so a
 * lexical comparison is a chronological one — which is why the endpoints can
 * use $gte on them at all.
 */
const withinDates = (rows, query) => {
  if (query.date) {
    const only = dateStr(query.date);
    return rows.filter((r) => String(r.date) === only);
  }
  if (!query.startDate && !query.endDate) return rows;

  const from = query.startDate ? dateStr(query.startDate) : null;
  const to   = query.endDate   ? dateStr(query.endDate)   : null;

  return rows.filter((r) => {
    const d = String(r.date ?? "");
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  });
};

/**
 * How many of a school's pupils and staff there are to mark.
 *
 * ── Two different readings of isActive, and both are the endpoint's ───────
 *
 * Pupils: isActive is not false, so a record that never had the field counts —
 * and most do not have it. Staff: isActive is exactly true. Reading the pupil
 * side as true-only would make every attendance RATE in the school read as zero
 * per cent, because the denominator would be nothing.
 *
 * Neither query filters deletedAt, so a withdrawn pupil is still counted. That
 * looks like an oversight and is not this layer's to correct: a rate that
 * disagreed with the server's would be a worse problem, and a silent one.
 */
const population = (docs, schoolId) => ({
  students: docs.find("student", { schoolId }).filter((s) => s.isActive !== false).length,
  teachers: docs.count("user", { schoolId, role: "teacher", isActive: true }),
});

/** Marks of one status, counted. */
const countOf = (rows, status) => rows.filter((r) => r.status === status).length;

/**
 * present as a percentage of the POPULATION, not of the marks taken.
 *
 * So a class of thirty with two pupils marked present reads 7%, not 100%. That is
 * the number a head is looking for — it answers "how much of the school was
 * here", and a rate over marks taken would answer "of the ones somebody
 * remembered to mark", which flatters an unmarked register.
 */
const rateOf = (rows, total) =>
  total > 0 ? Math.round((countOf(rows, "present") / total) * 100) : 0;

module.exports = [
  {
    /**
     * The administrator dashboard's attendance card.
     *
     * Every other figure on that dashboard is answered from this mirror —
     * students/stats, classes/stats, subjects/stats, teachers/stats are all
     * here. This one was not, so it alone went to the network, and a desktop
     * that could not reach the server showed a dashboard where every card had
     * a number except attendance, which read nought present. Nothing looked
     * broken; the school just appeared to be empty.
     *
     * The same rows and the same arithmetic as report/overview above, so the
     * card and the report cannot disagree.
     */
    route: "GET /api/admin/attendance/stats",

    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      // Students only, so — unlike report/overview — this does not need the
      // staff directory and does not decline when it is absent.
      const date  = dateStr(query.date);
      const total = population(docs, schoolId).students;
      const rows  = docs.find("studentAttendance", { schoolId, date });

      return ok({
        todayPresent: countOf(rows, "present"),
        todayAbsent:  countOf(rows, "absent"),
        todayLate:    countOf(rows, "late"),
        todayExcused: countOf(rows, "excused"),
        total,
        marked:   rows.length,
        unmarked: total - rows.length,
        rate:     rateOf(rows, total),
      });
    },
  },

  {
    route: "GET /api/attendance/report/overview",

    /**
     * One day, pupils and staff side by side.
     *
     * Declines when the staff directory is not mirrored — it needs users.manage,
     * and a teacher's own machine does not hold it. A summary reporting nought
     * out of nought teachers is not a smaller answer than the server's, it is a
     * different one.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      if (docs.count("user", { schoolId, role: "teacher" }) === 0) return null;

      const date  = dateStr(query.date);
      const total = population(docs, schoolId);

      const studentRows = docs.find("studentAttendance", { schoolId, date });
      const teacherRows = docs.find("teacherAttendance", { schoolId, date });

      return ok({
        date,
        students: {
          total:    total.students,
          marked:   studentRows.length,
          present:  countOf(studentRows, "present"),
          absent:   countOf(studentRows, "absent"),
          late:     countOf(studentRows, "late"),
          excused:  countOf(studentRows, "excused"),
          // May go negative where marks exist for pupils no longer counted as
          // active. The endpoint subtracts without a floor, so this does too.
          unmarked: total.students - studentRows.length,
          rate:     rateOf(studentRows, total.students),
        },
        teachers: {
          total:    total.teachers,
          marked:   teacherRows.length,
          present:  countOf(teacherRows, "present"),
          absent:   countOf(teacherRows, "absent"),
          late:     countOf(teacherRows, "late"),
          on_leave: countOf(teacherRows, "on_leave"),
          unmarked: total.teachers - teacherRows.length,
          rate:     rateOf(teacherRows, total.teachers),
        },
      });
    },
  },

  {
    route: "GET /api/attendance/report/weekly",

    /**
     * The last seven days, as a trend.
     *
     * The window comes from shared/attendance.js because the arithmetic mixes a
     * local calendar day with a UTC reading of it — see the note there. Two
     * implementations would agree for most of the day and differ for the rest,
     * which is the worst way for anything to be wrong.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      if (docs.count("user", { schoolId, role: "teacher" }) === 0) return null;

      const days  = lastSevenDays();
      const from  = days[0];
      const to    = days[days.length - 1];
      const total = population(docs, schoolId);

      const inWindow = (collection) =>
        docs.find(collection, { schoolId }).filter((r) => {
          const d = String(r.date ?? "");
          return d >= from && d <= to;
        });

      const studentRows = inWindow("studentAttendance");
      const teacherRows = inWindow("teacherAttendance");

      const trend = days.map((day) => {
        const s = studentRows.filter((r) => r.date === day);
        const t = teacherRows.filter((r) => r.date === day);

        return {
          date: day,
          students: {
            present: countOf(s, "present"),
            absent:  countOf(s, "absent"),
            late:    countOf(s, "late"),
            excused: countOf(s, "excused"),
            total:   total.students,
            rate:    rateOf(s, total.students),
          },
          teachers: {
            present:  countOf(t, "present"),
            absent:   countOf(t, "absent"),
            late:     countOf(t, "late"),
            on_leave: countOf(t, "on_leave"),
            total:    total.teachers,
            rate:     rateOf(t, total.teachers),
          },
        };
      });

      return ok({ trend, days });
    },
  },

  {
    route: "GET /api/attendance/report/class/:classId",

    /**
     * One class over a range of days, pupil by pupil.
     *
     * ── The default range is today, not everything ──────────────────────────
     *
     * Both ends go through dateStr, which falls back to TODAY on anything
     * missing or unparseable — so a request with no dates asks about today
     * alone. A mirror that read "no dates" as "all time" would answer a
     * different question from the server's, and a screen showing a term's
     * figures where the server shows one day is a difference nobody would read
     * as a bug.
     *
     * ── And the rate here means something else ──────────────────────────────
     *
     * Per pupil it is present as a share of THAT PUPIL'S marks, not of the days
     * in the range: a child marked once and present reads 100%. The overview's
     * rate is over the population instead. Two rates with one name, and copying
     * either into the other's place would be undetectable on a screen.
     */
    handler: ({ params, query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const classId   = String(params.classId);
      const startDate = dateStr(query.startDate);
      const endDate   = dateStr(query.endDate || new Date());

      const records = docs
        .find("studentAttendance", { schoolId, classId })
        .filter((r) => {
          const d = String(r.date ?? "");
          return d >= startDate && d <= endDate;
        });

      // ── The endpoint imposes no order on this list ──────────────────────
      //
      // Student.find() with no .sort(), so the server returns whatever order the
      // storage engine gives and any order is as faithful as another. Sorted by
      // name here so the desktop shows a stable one — a class list that
      // reshuffles between reads is its own kind of wrong — with the id as a
      // tie-break so two pupils of the same name do not swap places either.
      //
      // It also means the parity harness compares these rows BY PUPIL rather
      // than by position: a list comparison would be asserting Mongo's storage
      // order, which the endpoint does not promise.
      const roster = docs
        .find("student", { schoolId, classId })
        .filter((s) => s.isActive !== false)
        .map((s) => ({ _id: s._id, studentName: s.studentName, email: s.email }))
        .sort((a, b) => {
          const an = String(a.studentName ?? "");
          const bn = String(b.studentName ?? "");
          if (an === bn) return String(a._id).localeCompare(String(b._id));
          return an < bn ? -1 : 1;
        });

      const students = roster.map((student) => {
        const mine  = records.filter((r) => r.studentId === String(student._id));
        const total = mine.length;
        const present = countOf(mine, "present");

        return {
          student,
          present,
          absent:  countOf(mine, "absent"),
          late:    countOf(mine, "late"),
          excused: countOf(mine, "excused"),
          total,
          // Of this pupil's own marks — see the docstring.
          rate: total > 0 ? Math.round((present / total) * 100) : 0,
        };
      });

      return ok({
        classId,
        startDate,
        endDate,
        students,
        overall: {
          totalStudents: roster.length,
          totalRecords:  records.length,
          present: countOf(records, "present"),
          absent:  countOf(records, "absent"),
          late:    countOf(records, "late"),
          excused: countOf(records, "excused"),
        },
      });
    },
  },

  {
    route: "GET /api/attendance/teachers/roster",

    /**
     * The staff a school may mark present.
     *
     * ── isActive: true here, unlike the pupil roster ────────────────────────
     *
     * The student roster uses isActive: { $ne: false }, which includes a record
     * that never had the field. This one requires it to be exactly true. The
     * difference looks like an inconsistency and is faithfully reproduced: an
     * account created without the field is absent from this list on the server,
     * and a mirror that included it would offer a name the office cannot mark
     * through the web.
     *
     * ── The endpoint imposes no order ───────────────────────────────────────
     *
     * There is no .sort(), so the server returns whatever order the storage
     * engine gives. Any order is therefore as faithful as any other, and this
     * sorts by name so the desktop at least shows a stable one — a list that
     * reshuffles between reads is its own kind of wrong.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const teachers = docs
        .find("user", { schoolId, role: "teacher", isActive: true })
        .map((t) => ({ _id: t._id, name: t.name, email: t.email, role: t.role }))
        .sort((a, b) => {
          const an = String(a.name ?? "");
          const bn = String(b.name ?? "");
          if (an === bn) return String(a._id).localeCompare(String(b._id));
          return an < bn ? -1 : 1;
        });

      return ok({ teachers, count: teachers.length });
    },
  },

  {
    route: "GET /api/attendance/teachers",

    /**
     * Staff attendance records, for the admin screens.
     *
     * Sorted by day and then by when the mark was made, both descending, as the
     * endpoint sorts them. Neither is unique, so an _id tie-break is added here:
     * without one the order of two marks made in the same moment is whatever
     * SQLite happens to return, and a screen would show them differently on two
     * reads of the same data.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const filter = { schoolId };
      if (query.teacherId) filter.teacherId = String(query.teacherId);
      if (query.status)    filter.status    = String(query.status);

      const records = withinDates(docs.find("teacherAttendance", filter), query)
        .sort((a, b) => {
          const byDate = String(b.date ?? "").localeCompare(String(a.date ?? ""));
          if (byDate !== 0) return byDate;
          const byMark = String(b.markedAt ?? "").localeCompare(String(a.markedAt ?? ""));
          if (byMark !== 0) return byMark;
          return String(a._id).localeCompare(String(b._id));
        });

      return ok({ records, count: records.length });
    },
  },

  {
    route: "GET /api/attendance/students/roster",

    /**
     * Who is in the class, for the register screen to list.
     *
     * ── Three things here are easy to get wrong ─────────────────────────────
     *
     * THE PROJECTION. The endpoint selects nine named fields and nothing else. A
     * mirror answering with the whole student document would send a screen more
     * than the server does — including, on this collection, a home address and a
     * guardian's telephone number. Reproduced field for field.
     *
     * isActive: { $ne: false }. Not "isActive is true": a student whose record
     * never had the field is included, and most do not have it. Reading it as
     * true-only empties the register for a whole school.
     *
     * DELETED STUDENTS ARE NOT EXCLUDED. There is no deletedAt filter on this
     * query, so a withdrawn pupil still appears. That looks like an oversight and
     * is not this layer's to correct — a register that disagreed with the
     * server's about who is in the room would be a worse problem than the one it
     * fixed, and silently.
     */
    handler: ({ query }, { docs, session }) => {
      const schoolId = query.schoolId ? String(query.schoolId).trim() : session?.schoolId;
      if (!schoolId) return null;

      const filter = { schoolId };
      if (query.classId) filter.classId = String(query.classId);

      const students = docs
        .find("student", filter)
        .filter((s) => s.isActive !== false)
        .map((s) => ({
          _id:          s._id,
          studentName:  s.studentName,
          firstName:    s.firstName,
          lastName:     s.lastName,
          email:        s.email,
          classId:      s.classId,
          className:    s.className,
          grade:        s.grade,
          admissionNo:  s.admissionNo,
        }))
        // .sort({ studentName: 1 }) on the server: byte order, not a locale's.
        .sort((a, b) => {
          const an = String(a.studentName ?? "");
          const bn = String(b.studentName ?? "");
          if (an === bn) return 0;
          return an < bn ? -1 : 1;
        });

      return ok({ students, count: students.length });
    },
  },

  {
    route: "GET /api/attendance/students",
    handler: ({ query }, { docs, session }) => {
      // schoolId comes from the query OR the token, in that order — the same
      // fallback the endpoint uses, which is why the session is consulted here
      // even though most handlers do not need it.
      const schoolId = query.schoolId
        ? String(query.schoolId).trim()
        : (session?.schoolId ?? null);
      if (!schoolId) return null;

      // A pupil signing in gets only their own rows, resolved from their user
      // account through Student documents. The desktop console is staff-only, so
      // this should never arise — and if it somehow did, declining sends the
      // request to the server which will scope it properly, rather than this
      // guessing at the scoping.
      if (session?.role === "student") return null;

      const filter = { schoolId };
      if (query.classId)   filter.classId   = String(query.classId).trim();
      if (query.studentId) filter.studentId = String(query.studentId).trim();
      if (query.status)    filter.status    = String(query.status).trim();
      if (query.periodId)  filter.periodId  = String(query.periodId).trim();

      // An exact day wins over any range, as it does on the server, and a range
      // is inclusive at both ends. Applied after the query because the store's
      // filter language takes one operator per field. Shared with the staff
      // version below, which builds its filter the same way.
      let rows = withinDates(docs.find("studentAttendance", filter), query);

      // date descending, then markedAt descending — the server's sort. The
      // second key matters when a register is corrected: the later mark is the
      // one that should be read first.
      rows = rows.slice().sort((a, b) => {
        const byDate = String(b.date ?? "").localeCompare(String(a.date ?? ""));
        if (byDate !== 0) return byDate;
        const byMark = String(b.markedAt ?? "").localeCompare(String(a.markedAt ?? ""));
        // Ties broken by _id, matching the server — see the note there.
        if (byMark !== 0) return byMark;
        return String(a._id ?? "").localeCompare(String(b._id ?? ""));
      });

      // `records` and `count` — this endpoint does not use the `data` key that
      // most of the others do.
      return ok({ records: rows, count: rows.length });
    },
  },
];
