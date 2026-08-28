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
const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * A calendar day as the server stores it.
 *
 * Falls back to today on anything unparseable, which is what dateStr() in
 * attendance.routes.js does. Not an improvement to make on one side only.
 */
const dateStr = (d) => {
  if (!d) return todayStr();
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime()) ? todayStr() : parsed.toISOString().slice(0, 10);
};

module.exports = [
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

      let rows;
      if (query.date) {
        // An exact day. Note this wins over any range, as it does on the server.
        rows = docs.find("studentAttendance", { ...filter, date: dateStr(query.date) });
      } else {
        rows = docs.find("studentAttendance", filter);
        // Inclusive at both ends, and applied after the query because the
        // store's filter language takes one operator per field.
        if (query.startDate) {
          const from = dateStr(query.startDate);
          rows = rows.filter((r) => String(r.date ?? "") >= from);
        }
        if (query.endDate) {
          const to = dateStr(query.endDate);
          rows = rows.filter((r) => String(r.date ?? "") <= to);
        }
      }

      // date descending, then markedAt descending — the server's sort. The
      // second key matters when a register is corrected: the later mark is the
      // one that should be read first.
      rows = rows.slice().sort((a, b) => {
        const byDate = String(b.date ?? "").localeCompare(String(a.date ?? ""));
        if (byDate !== 0) return byDate;
        return String(b.markedAt ?? "").localeCompare(String(a.markedAt ?? ""));
      });

      // `records` and `count` — this endpoint does not use the `data` key that
      // most of the others do.
      return ok({ records: rows, count: rows.length });
    },
  },
];
