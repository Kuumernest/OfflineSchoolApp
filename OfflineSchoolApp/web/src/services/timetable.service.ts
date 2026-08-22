// web/src/services/timetable.service.ts
"use strict";

import api from "@/lib/axios";
import axios from "axios";
import { unwrapList, unwrapSingle } from "@/utils/unwrap";
import {
  DAY_CODES,
  TimetableConflictError,
} from "@/types/timetable.types";
import type {
  DayCode,
  TimetableSlot,
  TimetableGrid,
  CreateSlotPayload,
  UpdateSlotPayload,
  SlotConflict,
  SlotConflictKind,
  Period,
  TeacherWorkload,
} from "@/types/timetable.types";

const BASE = "/admin/timetable";

// ─────────────────────────────────────────────────────────────────────────────
// NORMALISER
// ─────────────────────────────────────────────────────────────────────────────

const DAY_SET = new Set<string>(DAY_CODES);

/** Accepts "Monday" / "mon" / "MON" and returns the canonical code or null. */
export const toDayCode = (raw: unknown): DayCode | null => {
  if (!raw) return null;
  const code = String(raw).trim().slice(0, 3).toUpperCase();
  return DAY_SET.has(code) ? (code as DayCode) : null;
};

const asRef = (v: unknown) =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : null;

const normalise = (raw: Record<string, unknown>): TimetableSlot => {
  const subject = asRef(raw.subject);
  const teacher = asRef(raw.teacher);
  const cls     = asRef(raw.class);

  return {
    _id:       String(raw._id ?? raw.id ?? ""),
    schoolId:  (raw.schoolId  as string) ?? null,
    classId:   (raw.classId   as string) ?? null,
    subjectId: (raw.subjectId as string) ?? null,
    teacherId: (raw.teacherId as string) ?? null,
    periodId:  (raw.periodId  as string) ?? null,
    dayOfWeek: toDayCode(raw.dayOfWeek),
    room:      (raw.room as string) ?? null,
    version:   Number(raw.version ?? 1),

    subject: subject ? { _id: String(subject._id ?? ""), name: String(subject.name ?? ""), code: subject.code as string } : null,
    teacher: teacher ? { _id: String(teacher._id ?? ""), name: String(teacher.name ?? ""), email: teacher.email as string } : null,
    class:   cls     ? { _id: String(cls._id ?? ""),     name: String(cls.name ?? ""),     section: cls.section as string } : null,

    // my-schedule sends flat names; the admin list sends nested objects. Fill
    // both so a component can read either without knowing its source.
    subjectName: (raw.subjectName as string) ?? (subject?.name as string) ?? null,
    subjectCode: (raw.subjectCode as string) ?? (subject?.code as string) ?? null,
    className:   (raw.className   as string) ?? (cls?.name as string)     ?? null,

    createdAt: raw.createdAt as string | undefined,
    updatedAt: raw.updatedAt as string | undefined,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFLICT TRANSLATION
//
// All three write endpoints answer 409 with { conflict: "class"|"teacher"|
// "version" }. Turning that into a typed throw is what lets the grid say which
// constraint was hit instead of a generic "failed to save".
// ─────────────────────────────────────────────────────────────────────────────

const CONFLICT_MESSAGES: Record<SlotConflictKind, string> = {
  class:   "That class already has a lesson in this period.",
  teacher: "That teacher is already teaching in this period.",
  version: "Someone else changed this slot while you had it open.",
};

const asConflict = (err: unknown): SlotConflict | null => {
  if (!axios.isAxiosError(err) || err.response?.status !== 409) return null;

  const body = (err.response.data ?? {}) as Record<string, unknown>;
  const kind = String(body.conflict ?? "") as SlotConflictKind;
  if (!CONFLICT_MESSAGES[kind]) return null;

  return {
    kind,
    message: (body.error as string) || CONFLICT_MESSAGES[kind],
    current: body.current
      ? normalise(body.current as Record<string, unknown>)
      : undefined,
  };
};

/** Re-throws a 409 as a TimetableConflictError; anything else passes through. */
const rethrow = (err: unknown): never => {
  const conflict = asConflict(err);
  if (conflict) throw new TimetableConflictError(conflict);
  throw err;
};

// ─────────────────────────────────────────────────────────────────────────────
// QUERIES
// ─────────────────────────────────────────────────────────────────────────────

export interface TimetableQuery {
  schoolId:   string;
  classId?:   string | null;
  teacherId?: string | null;
}

export async function fetchSlots(q: TimetableQuery): Promise<TimetableSlot[]> {
  const { data } = await api.get(BASE, {
    params: {
      schoolId: q.schoolId,
      ...(q.classId   ? { classId:   q.classId   } : {}),
      ...(q.teacherId ? { teacherId: q.teacherId } : {}),
    },
  });
  return unwrapList<Record<string, unknown>>(data, "slots").map(normalise);
}

/** A teacher's own week. Staff-scoped, so it needs no teacherId argument. */
export async function fetchMySchedule(schoolId?: string): Promise<TimetableSlot[]> {
  const { data } = await api.get(`${BASE}/my-schedule`, {
    params: schoolId ? { schoolId } : undefined,
  });
  return unwrapList<Record<string, unknown>>(data, "slots").map(normalise);
}

export async function fetchTeacherSlots(
  teacherId: string,
  schoolId:  string,
): Promise<TimetableSlot[]> {
  const { data } = await api.get(`${BASE}/teacher/${teacherId}`, {
    params: { schoolId },
  });
  return unwrapList<Record<string, unknown>>(data, "slots").map(normalise);
}

// ─────────────────────────────────────────────────────────────────────────────
// MUTATIONS
// ─────────────────────────────────────────────────────────────────────────────

export async function createSlot(payload: CreateSlotPayload): Promise<TimetableSlot> {
  try {
    const { data } = await api.post(BASE, payload);
    return normalise(unwrapSingle<Record<string, unknown>>(data, "slot"));
  } catch (err) {
    return rethrow(err);
  }
}

export async function updateSlot(
  id:      string,
  payload: UpdateSlotPayload,
): Promise<TimetableSlot> {
  try {
    const { data } = await api.put(`${BASE}/${id}`, payload);
    return normalise(unwrapSingle<Record<string, unknown>>(data, "slot"));
  } catch (err) {
    return rethrow(err);
  }
}

export async function deleteSlot(id: string): Promise<void> {
  await api.delete(`${BASE}/${id}`);
}

/**
 * Moves a slot to a different day/period.
 *
 * Sends `version` so a stale drag loses to whoever saved first rather than
 * silently overwriting them — the 409 comes back as a version conflict
 * carrying the server's current copy, which the caller can show.
 */
export async function moveSlot(
  slot:      TimetableSlot,
  dayOfWeek: DayCode,
  periodId:  string,
): Promise<TimetableSlot> {
  return updateSlot(slot._id, { dayOfWeek, periodId, version: slot.version });
}

// ─────────────────────────────────────────────────────────────────────────────
// GRID
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Indexes slots by day and period for O(1) cell lookup.
 *
 * Rendering a 5-day × 8-period grid straight from the array means 40 cells ×
 * a linear scan each. The grid is rebuilt only when the slot list changes.
 */
export function buildGrid(slots: TimetableSlot[]): TimetableGrid {
  const grid: TimetableGrid = {};
  for (const slot of slots) {
    if (!slot.dayOfWeek || !slot.periodId) continue;
    grid[slot.dayOfWeek] ??= {};
    grid[slot.dayOfWeek][slot.periodId] = slot;
  }
  return grid;
}

export const slotAt = (
  grid:     TimetableGrid,
  day:      DayCode,
  periodId: string,
): TimetableSlot | undefined => grid[day]?.[periodId];

/**
 * Whether a teacher is free in a cell, given every slot in the school.
 *
 * The server checks this too and answers 409, but doing it client-side lets the
 * picker grey out a teacher who is already booked rather than offering them and
 * failing on save.
 */
export function isTeacherBusy(
  allSlots:  TimetableSlot[],
  teacherId: string,
  day:       DayCode,
  periodId:  string,
  ignoreSlotId?: string,
): boolean {
  return allSlots.some(
    (s) =>
      s.teacherId === teacherId &&
      s.dayOfWeek === day &&
      s.periodId  === periodId &&
      s._id       !== ignoreSlotId,
  );
}

/** Lessons per teacher, busiest first — the input for a workload panel. */
export function teacherWorkload(slots: TimetableSlot[]): TeacherWorkload[] {
  const counts = new Map<string, TeacherWorkload>();

  for (const s of slots) {
    if (!s.teacherId) continue;
    const existing = counts.get(s.teacherId);
    if (existing) {
      existing.slots += 1;
    } else {
      counts.set(s.teacherId, {
        teacherId: s.teacherId,
        name:      s.teacher?.name ?? "Unknown teacher",
        slots:     1,
      });
    }
  }

  return [...counts.values()].sort((a, b) => b.slots - a.slots);
}

/**
 * Cells with no lesson, for a "gaps" summary.
 *
 * Break periods are skipped — a free break is not a hole in the timetable.
 */
export function findGaps(
  grid:    TimetableGrid,
  days:    DayCode[],
  periods: Period[],
): { day: DayCode; period: Period }[] {
  const gaps: { day: DayCode; period: Period }[] = [];
  for (const day of days) {
    for (const period of periods) {
      if (period.isBreak) continue;
      if (!grid[day]?.[period._id]) gaps.push({ day, period });
    }
  }
  return gaps;
}
