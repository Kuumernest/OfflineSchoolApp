// web/src/services/attendance.service.ts
"use strict";

import api from "@/lib/axios";
import { unwrapList } from "@/utils/unwrap";
import type {
  AttendanceRecord,
  AttendanceStatus,
  AttendanceSubject,
  AttendanceOverview,
  AttendanceSummary,
  BulkAttendancePayload,
  BulkAttendanceResult,
  RosterEntry,
  TodayAttendance,
  WeeklyAttendancePoint,
} from "@/types/attendance.types";

const BASE = "/attendance";

// ─────────────────────────────────────────────────────────────────────────────
// DATES
//
// Every attendance endpoint keys on a "YYYY-MM-DD" string, and the records are
// looked up by exact string match. toISOString() would shift the date by the
// UTC offset — for a school in UTC+1 marking a register at 09:00, that is
// harmless, but at 00:30 it silently writes yesterday's register. Formatting
// from the local calendar fields avoids that entirely.
// ─────────────────────────────────────────────────────────────────────────────

export const toDateKey = (d: Date = new Date()): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const todayKey = (): string => toDateKey();

/** Shifts a "YYYY-MM-DD" key by whole days, staying in local time. */
export const shiftDateKey = (key: string, days: number): string => {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
};

export const isFutureDate = (key: string): boolean => key > todayKey();

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISERS
// ─────────────────────────────────────────────────────────────────────────────

const normaliseRecord = (raw: Record<string, unknown>): AttendanceRecord => ({
  _id:       raw._id ? String(raw._id) : undefined,
  schoolId:  raw.schoolId as string | undefined,
  studentId: raw.studentId ? String(raw.studentId) : undefined,
  teacherId: raw.teacherId ? String(raw.teacherId) : undefined,
  classId:   (raw.classId   as string) ?? null,
  subjectId: (raw.subjectId as string) ?? null,
  periodId:  (raw.periodId  as string) ?? null,
  date:      String(raw.date ?? ""),
  status:    String(raw.status ?? "absent") as AttendanceStatus,
  note:      (raw.note as string) ?? null,
  markedBy:  (raw.markedBy as string) ?? null,
  markedAt:  (raw.markedAt as string) ?? null,
  createdAt: raw.createdAt as string | undefined,
  updatedAt: raw.updatedAt as string | undefined,
});

/**
 * The roster endpoints return a person under several possible name fields
 * (`studentName`, `firstName`/`lastName`, or plain `name` for teachers), so the
 * display name is assembled rather than read from one key.
 */
const personName = (p: Record<string, unknown>): string => {
  const direct =
    (p.studentName as string) ||
    (p.name as string) ||
    "";
  if (direct.trim()) return direct.trim();

  const composed = [p.firstName, p.lastName]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join(" ");
  return composed || "Unnamed";
};

const normaliseSummary = (raw: unknown): AttendanceSummary => {
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    total:    Number(s.total    ?? 0),
    present:  Number(s.present  ?? 0),
    absent:   Number(s.absent   ?? 0),
    late:     Number(s.late     ?? 0),
    marked:   s.marked   !== undefined ? Number(s.marked)   : undefined,
    excused:  s.excused  !== undefined ? Number(s.excused)  : undefined,
    on_leave: s.on_leave !== undefined ? Number(s.on_leave) : undefined,
    unmarked: s.unmarked !== undefined ? Number(s.unmarked) : undefined,
    rate:     s.rate     !== undefined ? Number(s.rate)     : undefined,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// ROSTER
// ─────────────────────────────────────────────────────────────────────────────

interface RosterArgs {
  subject:  AttendanceSubject;
  schoolId: string;
  classId?: string | null;
}

/**
 * Everyone who should be on the register, before any marks are applied.
 *
 * Used for dates other than today: /students/today only builds a roster for
 * the current date, so a back-dated register is assembled from roster + records
 * instead.
 */
export async function fetchRoster(args: RosterArgs): Promise<RosterEntry[]> {
  const { data } = await api.get(`${BASE}/${args.subject}/roster`, {
    params: {
      schoolId: args.schoolId,
      ...(args.classId ? { classId: args.classId } : {}),
    },
  });

  const key = args.subject === "students" ? "students" : "teachers";
  return unwrapList<Record<string, unknown>>(data, key).map((p) => ({
    id:          String(p._id ?? p.id ?? ""),
    name:        personName(p),
    email:       (p.email as string) ?? null,
    admissionNo: (p.admissionNo as string) ?? null,
    classId:     (p.classId as string) ?? null,
    className:   (p.className as string) ?? null,
    attendance:  null,
  }));
}

async function fetchRecords(args: {
  subject:  AttendanceSubject;
  schoolId: string;
  classId?: string | null;
  date:     string;
}): Promise<AttendanceRecord[]> {
  const { data } = await api.get(`${BASE}/${args.subject}`, {
    params: {
      schoolId:  args.schoolId,
      startDate: args.date,
      endDate:   args.date,
      ...(args.classId ? { classId: args.classId } : {}),
    },
  });
  return unwrapList<Record<string, unknown>>(data, "records").map(normaliseRecord);
}

/**
 * The register for one day: everybody who should be there, each with their mark
 * for that date or null.
 *
 * Joining roster and records on the client rather than relying on
 * /students/today is what makes a past date work — and it keeps the two
 * subjects (students, teachers) on one code path.
 */
export async function fetchRegister(args: {
  subject:  AttendanceSubject;
  schoolId: string;
  classId?: string | null;
  date:     string;
}): Promise<TodayAttendance> {
  const [roster, records] = await Promise.all([
    fetchRoster(args),
    fetchRecords(args),
  ]);

  const idOf = (r: AttendanceRecord) =>
    args.subject === "students" ? r.studentId : r.teacherId;

  const byPerson = new Map<string, AttendanceRecord>();
  for (const r of records) {
    const id = idOf(r);
    if (id) byPerson.set(String(id), r);
  }

  const merged: RosterEntry[] = roster.map((entry) => ({
    ...entry,
    attendance: byPerson.get(entry.id) ?? null,
  }));

  const count = (s: AttendanceStatus) =>
    merged.filter((m) => m.attendance?.status === s).length;

  const marked = merged.filter((m) => m.attendance).length;

  return {
    date:    args.date,
    roster:  merged,
    records,
    summary: {
      total:    merged.length,
      marked,
      unmarked: merged.length - marked,
      present:  count("present"),
      absent:   count("absent"),
      late:     count("late"),
      excused:  args.subject === "students" ? count("excused")  : undefined,
      on_leave: args.subject === "teachers" ? count("on_leave") : undefined,
      rate: merged.length
        ? Math.round((count("present") / merged.length) * 100)
        : 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Saves a whole register in one request.
 *
 * The endpoint answers 201 even when individual rows were rejected, reporting
 * `saved`/`failed` as counts with the bad rows under `failedRecords`. Callers
 * must read the body — the status code alone will call a half-failed register
 * a success.
 */
export async function saveRegister(
  subject: AttendanceSubject,
  payload: BulkAttendancePayload,
): Promise<BulkAttendanceResult> {
  const { data } = await api.post(`${BASE}/${subject}/bulk`, payload);
  const body = (data ?? {}) as Record<string, unknown>;

  const failedRecords = Array.isArray(body.failedRecords)
    ? (body.failedRecords as BulkAttendanceResult["failedRecords"])
    : [];

  return {
    saved:  Number(body.saved ?? 0),
    // Prefer the explicit count, but fall back to the array length so a
    // future response that drops the counter still reports honestly.
    failed: Number(body.failed ?? failedRecords.length),
    failedRecords,
  };
}

/** Marks one person — used for a single inline correction. */
export async function markOne(
  subject: AttendanceSubject,
  payload: {
    schoolId?:  string;
    classId?:   string | null;
    subjectId?: string | null;
    periodId?:  string | null;
    date:       string;
    status:     AttendanceStatus;
    note?:      string | null;
  } & ({ studentId: string } | { teacherId: string }),
): Promise<AttendanceRecord> {
  const { data } = await api.post(`${BASE}/${subject}`, payload);
  const body = (data ?? {}) as Record<string, unknown>;
  return normaliseRecord(
    (body.record ?? body.data ?? body) as Record<string, unknown>,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchOverview(
  schoolId: string,
  date:     string = todayKey(),
): Promise<AttendanceOverview> {
  const { data } = await api.get(`${BASE}/report/overview`, {
    params: { schoolId, date },
  });
  const body = (data ?? {}) as Record<string, unknown>;
  return {
    date:     String(body.date ?? date),
    students: normaliseSummary(body.students),
    teachers: normaliseSummary(body.teachers),
  };
}

export async function fetchWeeklyTrend(
  schoolId: string,
): Promise<WeeklyAttendancePoint[]> {
  const { data } = await api.get(`${BASE}/report/weekly`, {
    params: { schoolId },
  });

  return unwrapList<Record<string, unknown>>(data, "trend").map((row) => ({
    date:     String(row.date ?? ""),
    students: normaliseSummary(row.students),
    teachers: normaliseSummary(row.teachers),
  }));
}

export async function fetchClassReport(
  classId:  string,
  schoolId: string,
  range:    { startDate: string; endDate: string },
): Promise<{ records: AttendanceRecord[]; summary: AttendanceSummary }> {
  const { data } = await api.get(`${BASE}/report/class/${classId}`, {
    params: { schoolId, ...range },
  });
  const body = (data ?? {}) as Record<string, unknown>;
  return {
    records: unwrapList<Record<string, unknown>>(body, "records").map(normaliseRecord),
    summary: normaliseSummary(body.summary),
  };
}
