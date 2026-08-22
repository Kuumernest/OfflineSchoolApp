// src/utils/timetableMappers.js
"use strict";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — DAY NORMALISATION
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every conceivable day-of-week input → the canonical uppercase 3-letter code
 * that the backend Mongoose schema enum accepts:
 *   ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
 *
 * This is the single source of truth on the frontend side.
 * The backend route's DAY_CANONICAL must map to the same values.
 */
const DAY_CANONICAL = {
  // ── full lowercase ─────────────────────────────────────────────────────────
  monday:    "MON",
  tuesday:   "TUE",
  wednesday: "WED",
  thursday:  "THU",
  friday:    "FRI",
  saturday:  "SAT",
  sunday:    "SUN",
  // ── 3-letter lowercase ─────────────────────────────────────────────────────
  mon:       "MON",
  tue:       "TUE",
  wed:       "WED",
  thu:       "THU",
  fri:       "FRI",
  sat:       "SAT",
  sun:       "SUN",
  // ── already-canonical UPPERCASE (idempotent) ───────────────────────────────
  MON:       "MON",
  TUE:       "TUE",
  WED:       "WED",
  THU:       "THU",
  FRI:       "FRI",
  SAT:       "SAT",
  SUN:       "SUN",
  // ── Title-case full names ──────────────────────────────────────────────────
  Monday:    "MON",
  Tuesday:   "TUE",
  Wednesday: "WED",
  Thursday:  "THU",
  Friday:    "FRI",
  Saturday:  "SAT",
  Sunday:    "SUN",
};

/**
 * Must match the Mongoose schema enum in TimetableSlot.js exactly.
 * Used as a hard guard before every server push.
 */
export const VALID_DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/**
 * Normalises ANY day-of-week string to the backend's canonical format.
 *
 *   "monday"    → "MON"
 *   "Tuesday"   → "TUE"
 *   "WED"       → "WED"  (idempotent)
 *   null / ""   → null
 *
 * Returns null when input cannot be resolved so callers can detect failure
 * gracefully rather than sending bad data to the server.
 */
export const canonicalDay = (raw) => {
  if (!raw) return null;

  const str = raw.toString().trim();

  // 1. Exact map hit — handles UPPERCASE codes, Title-case, lowercase codes
  if (DAY_CANONICAL[str] !== undefined) return DAY_CANONICAL[str];

  // 2. Case-insensitive full-string hit
  const lower = str.toLowerCase();
  if (DAY_CANONICAL[lower] !== undefined) return DAY_CANONICAL[lower];

  // 3. First 3 chars lowercased ("Thursday" → "thu" → "THU")
  const sliced = lower.slice(0, 3);
  if (DAY_CANONICAL[sliced] !== undefined) return DAY_CANONICAL[sliced];

  // 4. Unresolvable
  console.warn(
    `[timetableMappers] canonicalDay: unrecognised value "${raw}". ` +
    `Add it to DAY_CANONICAL if it is a legitimate input.`
  );
  return null;
};

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — LOCAL → BACKEND
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Maps a local timetable slot (SQLite row / JS object) to the payload shape
 * the backend expects.
 *
 * Returns null if the slot is structurally invalid so the caller can skip it
 * rather than sending a bad request.
 */
export const mapLocalSlotToBackend = (localSlot) => {
  if (!localSlot) return null;

  const id     = localSlot._id || localSlot.id || null;
  const rawDay = localSlot.dayOfWeek ?? localSlot.day_of_week ?? null;
  const day    = canonicalDay(rawDay);

  if (!day) {
    console.warn(
      `[timetableMappers] mapLocalSlotToBackend: ` +
      `slot ${id ?? "(no id)"} has unresolvable dayOfWeek "${rawDay}" — returning null`
    );
    return null;
  }

  return {
    _id:       id,
    schoolId:  localSlot.schoolId  ?? localSlot.school_id  ?? null,
    classId:   localSlot.classId   ?? localSlot.class_id   ?? null,
    subjectId: localSlot.subjectId ?? localSlot.subject_id ?? null,
    teacherId: localSlot.teacherId ?? localSlot.teacher_id ?? null,
    periodId:  localSlot.periodId  ?? localSlot.period_id  ?? null,
    dayOfWeek: day,                  // ✅ "MON", "TUE" … matches Mongoose enum
    room:      localSlot.room?.trim() || null,
    version:   localSlot.version   || 1,
    createdAt: localSlot.createdAt ?? localSlot.created_at ?? null,
    updatedAt: localSlot.updatedAt ?? localSlot.updated_at ?? new Date().toISOString(),
    deletedAt: localSlot.deletedAt ?? localSlot.deleted_at ?? null,
  };
};

/**
 * Maps multiple local slots to backend format.
 * Drops invalid slots (null) silently.
 */
export const mapLocalSlotsToBackend = (localSlots = []) =>
  localSlots.map(mapLocalSlotToBackend).filter(Boolean);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — BACKEND → LOCAL
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Maps a backend timetable slot response to the local SQLite / JS shape.
 *
 * Canonicalises the inbound dayOfWeek so SQLite always stores the canonical
 * uppercase 3-letter code regardless of what the server sends.
 *
 * Returns null for structurally invalid payloads.
 */
export const mapBackendSlotToLocal = (backendSlot) => {
  if (!backendSlot) return null;

  const id = backendSlot._id || backendSlot.id || null;
  if (!id) {
    console.warn(
      "[timetableMappers] mapBackendSlotToLocal: slot has no _id — skipping"
    );
    return null;
  }

  const rawDay = backendSlot.dayOfWeek ?? backendSlot.day_of_week ?? null;
  const day    = canonicalDay(rawDay);

  if (!day) {
    // Non-fatal — store null rather than losing the whole record
    console.warn(
      `[timetableMappers] mapBackendSlotToLocal: ` +
      `slot ${id} has unresolvable dayOfWeek "${rawDay}" — storing null`
    );
  }

  return {
    _id:         String(id),
    schoolId:    backendSlot.schoolId  ?? backendSlot.school_id  ?? null,
    classId:     backendSlot.classId   ?? backendSlot.class_id   ?? null,
    subjectId:   backendSlot.subjectId ?? backendSlot.subject_id ?? null,
    teacherId:   backendSlot.teacherId ?? backendSlot.teacher_id ?? null,
    periodId:    backendSlot.periodId  ?? backendSlot.period_id  ?? null,
    dayOfWeek:   day,                  // ✅ "MON", "TUE" … stored locally too
    room:        backendSlot.room?.trim() || null,
    version:     backendSlot.version   || 1,
    createdAt:   backendSlot.createdAt ?? backendSlot.created_at ?? null,
    updatedAt:   backendSlot.updatedAt ?? backendSlot.updated_at ?? null,
    deletedAt:   backendSlot.deletedAt ?? backendSlot.deleted_at ?? null,
    // Enriched / joined fields
    subjectName: backendSlot.subjectName ?? null,
    teacherName: backendSlot.teacherName ?? null,
    periodName:  backendSlot.periodName  ?? null,
    startTime:   backendSlot.startTime   ?? null,
    endTime:     backendSlot.endTime     ?? null,
    className:   backendSlot.className   ?? null,
  };
};

/**
 * Maps multiple backend slots to local format. Drops null results silently.
 */
export const mapBackendSlotsToLocal = (backendSlots = []) =>
  backendSlots.map(mapBackendSlotToLocal).filter(Boolean);