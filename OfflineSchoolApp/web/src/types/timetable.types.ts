// web/src/types/timetable.types.ts

// ─────────────────────────────────────────────────────────────────────────────
// DAYS
//
// The backend stores and validates the canonical 3-letter uppercase code
// (see canonicalDay / VALID_DAYS in backend/src/routes/timetable.routes.js).
// Anything else is rejected with a 400 on write, so the client must speak the
// same alphabet rather than sending "Monday".
// ─────────────────────────────────────────────────────────────────────────────

export const DAY_CODES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type DayCode = (typeof DAY_CODES)[number];

export const DAY_LABELS: Record<DayCode, string> = {
  MON: "Monday",
  TUE: "Tuesday",
  WED: "Wednesday",
  THU: "Thursday",
  FRI: "Friday",
  SAT: "Saturday",
  SUN: "Sunday",
};

export const DAY_SHORT: Record<DayCode, string> = {
  MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu",
  FRI: "Fri", SAT: "Sat", SUN: "Sun",
};

/** The five days a timetable grid shows by default. */
export const SCHOOL_WEEK: DayCode[] = ["MON", "TUE", "WED", "THU", "FRI"];

// ─────────────────────────────────────────────────────────────────────────────
// PERIOD
// ─────────────────────────────────────────────────────────────────────────────

export interface Period {
  _id:       string;
  schoolId:  string;
  name:      string;
  /** "HH:MM" — the backend validates this format strictly. */
  startTime: string;
  endTime:   string;
  sortOrder: number;
  isBreak:   boolean;
  isActive:  boolean;
  version:   number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreatePeriodPayload {
  name:      string;
  startTime: string;
  endTime:   string;
  isBreak?:  boolean;
  schoolId?: string;
}

export type UpdatePeriodPayload = Partial<CreatePeriodPayload>;

// ─────────────────────────────────────────────────────────────────────────────
// SLOT
// ─────────────────────────────────────────────────────────────────────────────

export interface SlotRef {
  _id?:  string;
  name?: string;
  code?: string;
  email?: string;
  section?: string;
}

export interface TimetableSlot {
  _id:       string;
  schoolId:  string | null;
  classId:   string | null;
  subjectId: string | null;
  teacherId: string | null;
  periodId:  string | null;
  dayOfWeek: DayCode | null;
  room:      string | null;

  /**
   * Optimistic-concurrency token. The server rejects a PUT whose `version`
   * does not match the stored one with 409 { conflict: "version" }, so an edit
   * must round-trip whatever value it was loaded with.
   */
  version:   number;

  // Populated by the list endpoints; absent on a bare create response.
  subject?:     SlotRef | null;
  teacher?:     SlotRef | null;
  class?:       SlotRef | null;
  subjectName?: string | null;
  subjectCode?: string | null;
  className?:   string | null;

  createdAt?: string;
  updatedAt?: string;
}

export interface CreateSlotPayload {
  schoolId:  string;
  classId:   string;
  subjectId: string;
  teacherId: string;
  dayOfWeek: DayCode;
  periodId:  string;
  room?:     string | null;
}

export interface UpdateSlotPayload {
  subjectId?: string;
  teacherId?: string;
  classId?:   string;
  dayOfWeek?: DayCode;
  periodId?:  string;
  room?:      string | null;
  /** Send the version you loaded so a concurrent edit is caught, not clobbered. */
  version?:   number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFLICTS
//
// The write endpoints answer 409 with a discriminator naming what clashed.
// Surfacing which of the three it was is the difference between "couldn't save"
// and "Mr Bello already teaches period 3 on Tuesday".
// ─────────────────────────────────────────────────────────────────────────────

export type SlotConflictKind = "class" | "teacher" | "version";

export interface SlotConflict {
  kind:    SlotConflictKind;
  message: string;
  /** Present on a version conflict: the server's copy of the slot. */
  current?: TimetableSlot;
}

/** Thrown by the timetable service so callers can branch on `conflict`. */
export class TimetableConflictError extends Error {
  readonly conflict: SlotConflict;

  constructor(conflict: SlotConflict) {
    super(conflict.message);
    this.name     = "TimetableConflictError";
    this.conflict = conflict;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRID
// ─────────────────────────────────────────────────────────────────────────────

/** `grid[day][periodId]` → the slot in that cell, if any. */
export type TimetableGrid = Record<string, Record<string, TimetableSlot | undefined>>;

export interface TeacherWorkload {
  teacherId: string;
  name:      string;
  slots:     number;
}
