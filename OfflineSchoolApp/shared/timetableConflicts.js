// shared/timetableConflicts.js
//
// What is wrong with a timetable, entry by entry — and what would fix it.
//
// The dashboard used to say "1 timetable conflict detected" from a $group
// count that knew only that some (teacher, day, period) appeared twice. It
// could not say which lessons, so nobody could act on it. This module answers
// the whole question from plain rows, so the server, the desktop mirror and
// the phone all describe the same conflicts — and so the number on the
// dashboard is always the length of the list the alert opens.
//
// Everything here is pure: rows in, plain objects out. Callers load the rows
// (Mongo, the desktop mirror, SQLite) and normalise them to the shapes below.
//
//   slot       { _id, classId, subjectId, teacherId, dayOfWeek, periodId, room }
//   period     { _id, name, startTime, endTime, sortOrder, isBreak }
//   class      { _id, name, section? }
//   subject    { _id, name }
//   teacher    { _id, name }
//   assignment { teacher, class, subject, isActive? }  (TeacherAssignment)
//
// Deleted rows must already be filtered out by the caller.
"use strict";

const TYPES = Object.freeze({
  TEACHER_DOUBLE_BOOKED: "TEACHER_DOUBLE_BOOKED",
  CLASS_DOUBLE_BOOKED:   "CLASS_DOUBLE_BOOKED",
  ROOM_DOUBLE_BOOKED:    "ROOM_DOUBLE_BOOKED",
  PERIOD_OVERLAP:        "PERIOD_OVERLAP",
});

/** The legacy one-word `conflict` kind the 409s have always carried. */
const LEGACY_KIND = {
  CLASS_DOUBLE_BOOKED:   "class",
  TEACHER_DOUBLE_BOOKED: "teacher",
  ROOM_DOUBLE_BOOKED:    "room",
  PERIOD_OVERLAP:        "period",
};

const WEEK = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const SCHOOL_WEEK = ["MON", "TUE", "WED", "THU", "FRI"];

const DAY_NAMES = {
  en: { MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday", SUN: "Sunday" },
  fr: { MON: "lundi", TUE: "mardi", WED: "mercredi", THU: "jeudi", FRI: "vendredi", SAT: "samedi", SUN: "dimanche" },
};

const id = (v) => (v === undefined || v === null ? "" : String(v));

const toDay = (raw) => {
  const code = String(raw ?? "").trim().slice(0, 3).toUpperCase();
  return WEEK.includes(code) ? code : null;
};

const roomKey = (room) => String(room ?? "").trim().toLowerCase();

const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const byPeriodOrder = (a, b) =>
  (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) ||
  String(a.startTime ?? "").localeCompare(String(b.startTime ?? "")) ||
  id(a._id).localeCompare(id(b._id));

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Index the rows once. Every function below takes the result.
 *
 * A period's number is its place among the lesson periods (breaks are not
 * counted), which is what a timetable grid shows down its left edge.
 */
const buildContext = ({
  slots = [], periods = [], classes = [], subjects = [], teachers = [], assignments = [],
} = {}) => {
  const ordered = [...periods].sort(byPeriodOrder);
  const periodInfo = new Map();
  let n = 0;
  for (const p of ordered) {
    const number = p.isBreak ? null : ++n;
    periodInfo.set(id(p._id), {
      periodId:  id(p._id),
      name:      p.name || null,
      number,
      startTime: p.startTime || null,
      endTime:   p.endTime || null,
      isBreak:   Boolean(p.isBreak),
      sortOrder: Number(p.sortOrder) || 0,
    });
  }

  const cleanSlots = slots
    .map((s) => ({
      _id:       id(s._id),
      classId:   id(s.classId),
      subjectId: id(s.subjectId),
      teacherId: id(s.teacherId),
      dayOfWeek: toDay(s.dayOfWeek),
      periodId:  id(s.periodId),
      room:      s.room ? String(s.room).trim() || null : null,
      version:   s.version,
    }))
    .filter((s) => s.dayOfWeek && s.periodId);

  const nameMap = (rows, fmt) => new Map(rows.map((r) => [id(r._id ?? r.id), fmt(r)]));

  return {
    slots:      cleanSlots,
    periods:    ordered.map((p) => periodInfo.get(id(p._id))),
    periodInfo,
    classNames:   nameMap(classes,  (c) => [c.name, c.section].filter(Boolean).join(" ") || null),
    subjectNames: nameMap(subjects, (s) => s.name || null),
    teacherNames: nameMap(teachers, (t) => t.name || [t.firstName, t.lastName].filter(Boolean).join(" ") || null),
    assignments: assignments
      .filter((a) => a && a.isActive !== false)
      .map((a) => ({
        teacherId: id(a.teacher ?? a.teacherId),
        classId:   id(a.class ?? a.classId),
        subjectId: id(a.subject ?? a.subjectId),
      })),
  };
};

const describeEntry = (ctx, s) => ({
  entryId:     s._id,
  classId:     s.classId,
  className:   ctx.classNames.get(s.classId)   || "Unknown class",
  subjectId:   s.subjectId,
  subjectName: ctx.subjectNames.get(s.subjectId) || "Unknown subject",
  teacherId:   s.teacherId,
  teacherName: ctx.teacherNames.get(s.teacherId) || "Unknown teacher",
  room:        s.room,
  dayOfWeek:   s.dayOfWeek,
  periodId:    s.periodId,
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

const periodLabel = (info, lang) => {
  if (!info) return lang === "fr" ? "période inconnue" : "an unknown period";
  if (info.name) return info.name;
  return info.number ? (lang === "fr" ? `Période ${info.number}` : `Period ${info.number}`) : "";
};

const whenText = (c, lang) => {
  const day   = (DAY_NAMES[lang] || DAY_NAMES.en)[c.day] || c.day;
  const label = periodLabel(c.periodId ? { name: c.periodName, number: c.periodNumber } : null, lang);
  const time  = c.startTime && c.endTime ? ` (${c.startTime}–${c.endTime})` : "";
  return lang === "fr" ? `le ${day}, ${label}${time}` : `on ${day}, ${label}${time}`;
};

const joinAnd = (parts, lang) => parts.join(lang === "fr" ? " ET " : " AND ");

/**
 * The plain-language sentence for one conflict. English by default; "fr" for
 * French. Built from the structured fields, so a client can rebuild it in the
 * viewer's language from the same object the server sent.
 */
const conflictMessage = (c, lang = "en") => {
  const fr = lang === "fr";
  const e  = c.entries || [];
  switch (c.conflict_type) {
    case TYPES.TEACHER_DOUBLE_BOOKED:
      return fr
        ? `${e[0]?.teacherName} a cours de ${joinAnd(e.map((x) => `${x.subjectName} en ${x.className}`), lang)} ${whenText(c, lang)}.`
        : `${e[0]?.teacherName} is scheduled for ${joinAnd(e.map((x) => `${x.subjectName} in ${x.className}`), lang)} ${whenText(c, lang)}.`;
    case TYPES.CLASS_DOUBLE_BOOKED:
      return fr
        ? `${e[0]?.className} a ${joinAnd(e.map((x) => `${x.subjectName} (${x.teacherName})`), lang)} ${whenText(c, lang)}.`
        : `${e[0]?.className} has ${joinAnd(e.map((x) => `${x.subjectName} (${x.teacherName})`), lang)} ${whenText(c, lang)}.`;
    case TYPES.ROOM_DOUBLE_BOOKED:
      return fr
        ? `La salle ${c.room} est réservée pour ${joinAnd(e.map((x) => `${x.className} (${x.subjectName})`), lang)} ${whenText(c, lang)}.`
        : `Room ${c.room} is booked for ${joinAnd(e.map((x) => `${x.className} (${x.subjectName})`), lang)} ${whenText(c, lang)}.`;
    case TYPES.PERIOD_OVERLAP: {
      const [a, b] = c.periods || [];
      const show = (p) => `${periodLabel(p, lang)} (${p.startTime}–${p.endTime})`;
      return fr
        ? `${show(a)} chevauche ${show(b)} : une leçon dans l'une empiète sur l'autre.`
        : `${show(a)} overlaps ${show(b)}: a lesson in one runs into the other.`;
    }
    default:
      return "";
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DETECTION
// ─────────────────────────────────────────────────────────────────────────────

const DAY_RANK = Object.fromEntries(WEEK.map((d, i) => [d, i]));

const makeSlotConflict = (ctx, type, key, group, extra = {}) => {
  const first = group[0];
  const info  = ctx.periodInfo.get(first.periodId);
  const c = {
    id:            `${type}:${first.dayOfWeek}:${first.periodId}:${key}`,
    conflict_type: type,
    day:           first.dayOfWeek,
    periodId:      first.periodId,
    periodName:    info?.name ?? null,
    periodNumber:  info?.number ?? null,
    startTime:     info?.startTime ?? null,
    endTime:       info?.endTime ?? null,
    entries:       [...group]
      .sort((a, b) => a._id.localeCompare(b._id))
      .map((s) => describeEntry(ctx, s)),
    ...extra,
  };
  c.message = conflictMessage(c, "en");
  return c;
};

/**
 * Every conflict in the timetable, grouped by type and sorted by day then
 * period. Two entries that clash on several counts at once (the same teacher
 * AND the same class in one period) are one problem, reported once, as the
 * most specific kind: class first, then teacher, then room.
 */
const detectConflicts = (ctx) => {
  const out  = [];
  const seen = new Set(); // entry-set fingerprints already reported

  const groupBy = (keyOf) => {
    const groups = new Map();
    for (const s of ctx.slots) {
      const k = keyOf(s);
      if (!k) continue;
      const full = `${s.dayOfWeek}|${s.periodId}|${k}`;
      if (!groups.has(full)) groups.set(full, { key: k, rows: [] });
      groups.get(full).rows.push(s);
    }
    return [...groups.values()].filter((g) => g.rows.length > 1);
  };

  const fingerprint = (rows) => rows.map((r) => r._id).sort().join(",");

  const push = (type, groups, extra) => {
    for (const g of groups) {
      const fp = fingerprint(g.rows);
      if (seen.has(fp)) continue;
      seen.add(fp);
      out.push(makeSlotConflict(ctx, type, g.key, g.rows, extra ? extra(g) : {}));
    }
  };

  push(TYPES.CLASS_DOUBLE_BOOKED,   groupBy((s) => s.classId));
  push(TYPES.TEACHER_DOUBLE_BOOKED, groupBy((s) => s.teacherId));
  push(
    TYPES.ROOM_DOUBLE_BOOKED,
    groupBy((s) => roomKey(s.room)).filter((g) => new Set(g.rows.map((r) => r.classId)).size > 1),
    (g) => ({ room: g.rows[0].room }),
  );

  // Period definitions whose times overlap. Not tied to a day: a period is the
  // same every day of the week.
  const timed = ctx.periods.filter((p) => minutes(p.startTime) !== null && minutes(p.endTime) !== null);
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i], b = timed[j];
      if (minutes(a.startTime) < minutes(b.endTime) && minutes(b.startTime) < minutes(a.endTime)) {
        const c = {
          id:            `${TYPES.PERIOD_OVERLAP}:${a.periodId}:${b.periodId}`,
          conflict_type: TYPES.PERIOD_OVERLAP,
          day:           null,
          periodId:      a.periodId,
          periodName:    a.name,
          periodNumber:  a.number,
          startTime:     a.startTime,
          endTime:       a.endTime,
          periods:       [a, b],
          entries:       [],
        };
        c.message = conflictMessage(c, "en");
        out.push(c);
      }
    }
  }

  const periodRank = (c) => ctx.periodInfo.get(c.periodId)?.sortOrder ?? 0;
  return out.sort((a, b) =>
    (DAY_RANK[a.day] ?? -1) - (DAY_RANK[b.day] ?? -1) ||
    periodRank(a) - periodRank(b) ||
    a.id.localeCompare(b.id));
};

/**
 * The conflicts a slot WOULD be part of if it were saved — the check run
 * before a create or an edit. `candidate._id` (when editing) replaces that
 * slot's saved copy; a create without one is checked as a new row.
 */
const checkSlot = (ctx, candidate) => {
  const cand = buildContext({ slots: [candidate] }).slots[0];
  if (!cand) return [];
  const candId = cand._id || "__candidate__";
  const next = { ...ctx, slots: [...ctx.slots.filter((s) => s._id !== candId), { ...cand, _id: candId }] };
  // The lessons already there first, the one being saved last — the order a
  // person reads "X is already booked AND now you are adding Y".
  return detectConflicts(next)
    .filter((c) => c.entries.some((e) => e.entryId === candId))
    .map((c) => {
      const entries = [
        ...c.entries.filter((e) => e.entryId !== candId),
        ...c.entries.filter((e) => e.entryId === candId),
      ];
      const out = { ...c, entries };
      out.message = conflictMessage(out, "en");
      return out;
    });
};

// ─────────────────────────────────────────────────────────────────────────────
// RESOLUTION OPTIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Days a move may go to: the days the school timetables, or Mon–Fri. */
const schoolDays = (ctx) => {
  const used = new Set(ctx.slots.map((s) => s.dayOfWeek));
  return WEEK.filter((d) => SCHOOL_WEEK.includes(d) || used.has(d));
};

const busy = (ctx, excludeId, pred) =>
  ctx.slots.some((s) => s._id !== excludeId && pred(s));

/**
 * Lesson periods where BOTH the class and the teacher are free (and the
 * room, if the entry has one) — the same day first, then the rest of the week.
 */
const freePeriods = (ctx, entryId) => {
  const entry = ctx.slots.find((s) => s._id === id(entryId));
  if (!entry) return [];
  const out = [];
  for (const day of schoolDays(ctx)) {
    for (const p of ctx.periods) {
      if (p.isBreak) continue;
      if (day === entry.dayOfWeek && p.periodId === entry.periodId) continue;
      const at = (s) => s.dayOfWeek === day && s.periodId === p.periodId;
      if (busy(ctx, entry._id, (s) => at(s) && s.classId === entry.classId)) continue;
      if (busy(ctx, entry._id, (s) => at(s) && s.teacherId === entry.teacherId)) continue;
      if (entry.room && busy(ctx, entry._id, (s) => at(s) && roomKey(s.room) === roomKey(entry.room))) continue;
      out.push({
        dayOfWeek: day, periodId: p.periodId, periodName: p.name, periodNumber: p.number,
        startTime: p.startTime, endTime: p.endTime, sameDay: day === entry.dayOfWeek,
      });
    }
  }
  return out.sort((a, b) => Number(b.sameDay) - Number(a.sameDay));
};

/**
 * Teachers assigned to the entry's subject who are free at its slot. Those
 * assigned to the subject for this very class come first.
 */
const freeTeachers = (ctx, entryId) => {
  const entry = ctx.slots.find((s) => s._id === id(entryId));
  if (!entry) return [];
  const forSubject = ctx.assignments.filter((a) => a.subjectId === entry.subjectId);
  const ids = [...new Set(forSubject.map((a) => a.teacherId))]
    .filter((t) => t && t !== entry.teacherId);
  return ids
    .filter((t) => !busy(ctx, entry._id, (s) =>
      s.dayOfWeek === entry.dayOfWeek && s.periodId === entry.periodId && s.teacherId === t))
    .map((t) => ({
      teacherId:        t,
      teacherName:      ctx.teacherNames.get(t) || "Unknown teacher",
      teachesThisClass: forSubject.some((a) => a.teacherId === t && a.classId === entry.classId),
    }))
    .sort((a, b) => Number(b.teachesThisClass) - Number(a.teachesThisClass) ||
      a.teacherName.localeCompare(b.teacherName));
};

/**
 * Other lessons of the same class this entry can trade places with so that
 * neither lesson is left in a conflict.
 *
 * A swap is done by exchanging the two lessons' CONTENT (subject, teacher,
 * room) rather than their day and period. The class is the same, so the
 * result is identical — but each of the two saves is then valid on its own,
 * and no moment in between holds the class twice in one period.
 */
const swapOptions = (ctx, entryId) => {
  const entry = ctx.slots.find((s) => s._id === id(entryId));
  if (!entry) return [];
  const out = [];
  for (const other of ctx.slots) {
    if (other._id === entry._id || other.classId !== entry.classId) continue;
    if (other.dayOfWeek === entry.dayOfWeek && other.periodId === entry.periodId) continue;
    const a = { ...entry, subjectId: other.subjectId, teacherId: other.teacherId, room: other.room };
    const b = { ...other, subjectId: entry.subjectId, teacherId: entry.teacherId, room: entry.room };
    const next = { ...ctx, slots: ctx.slots.map((s) => (s._id === a._id ? a : s._id === b._id ? b : s)) };
    const clash = detectConflicts(next)
      .some((c) => c.entries.some((e) => e.entryId === a._id || e.entryId === b._id));
    if (clash) continue;
    const info = ctx.periodInfo.get(other.periodId);
    out.push({
      ...describeEntry(ctx, other),
      periodName: info?.name ?? null, periodNumber: info?.number ?? null,
      startTime:  info?.startTime ?? null, endTime: info?.endTime ?? null,
      // The two saves that perform the swap.
      updates: [
        { entryId: a._id, subjectId: a.subjectId, teacherId: a.teacherId, room: a.room },
        { entryId: b._id, subjectId: b.subjectId, teacherId: b.teacherId, room: b.room },
      ],
    });
  }
  return out.sort((x, y) =>
    (DAY_RANK[x.dayOfWeek] ?? 0) - (DAY_RANK[y.dayOfWeek] ?? 0) ||
    (ctx.periodInfo.get(x.periodId)?.sortOrder ?? 0) - (ctx.periodInfo.get(y.periodId)?.sortOrder ?? 0));
};

/** All three option lists for one entry. */
const resolutionOptions = (ctx, entryId) => ({
  freePeriods:  freePeriods(ctx, entryId),
  freeTeachers: freeTeachers(ctx, entryId),
  swaps:        swapOptions(ctx, entryId),
});

module.exports = {
  TYPES,
  LEGACY_KIND,
  buildContext,
  detectConflicts,
  checkSlot,
  conflictMessage,
  freePeriods,
  freeTeachers,
  swapOptions,
  resolutionOptions,
};
