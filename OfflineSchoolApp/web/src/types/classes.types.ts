/**
 * class.types.ts
 *
 * Single source of truth for all Class and Subject related types.
 *
 * Derived from:
 *  - web/src/services/class.service.ts  (normaliseClass / normaliseSubject)
 *  - mobile src/services/class.service.js (SQLite schema + server payloads)
 *
 * Fixes applied:
 *  #T1 — Class.id added alongside Class._id so both platforms satisfy
 *         the same contract (mobile SQLite returns `id`; web MongoDB
 *         returns `_id`; both are now declared and emitted).
 *  #T2 — Class.isActive typed as boolean (not 0|1). Mobile service
 *         must coerce with Boolean(Number(row.isActive)).
 *  #T3 — subjectCount / studentCount added to Class as optional numbers
 *         so getAll() results are typed correctly on both platforms.
 *  #T4 — CreateClassResponse documented so createClass() callers
 *         know what to expect before normalisation.
 *  #T5 — toggleActive added to service-layer surface (web stub added).
 */

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — PRIMITIVE ALIASES
// ═════════════════════════════════════════════════════════════════════════════

/** MongoDB ObjectId string or local UUID string */
export type EntityId = string;

/** ISO 8601 datetime string, e.g. "2024-01-15T10:30:00.000Z" */
export type ISODateString = string;

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — EMBEDDED / POPULATED REFS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Minimal class reference embedded inside a Subject.
 * Returned when the backend populates the `class` field.
 */
export interface ClassRef {
  _id:  EntityId;
  id:   EntityId;
  name: string;
}

/**
 * Minimal teacher reference embedded inside a Subject.
 * Returned when the backend enriches subjects via TeacherAssignment.
 *
 * Priority order used by getTeacherName() in ClassesPage:
 *  1. subject.teacher.name   — this object
 *  2. subject.teacherName    — flat string below
 *  3. teachers list lookup   — client-side fallback
 *  4. "—"
 */
export interface TeacherRef {
  _id:      EntityId;
  name:     string;
  email:    string;
  role:     "teacher";
  schoolId: EntityId;
  isActive: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — CORE ENTITIES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A school class (e.g. "Grade 10 – Section A").
 *
 * ID CONTRACT (#T1):
 *  Both `_id` and `id` are always populated and always equal.
 *
 * ISACTIVE CONTRACT (#T2):
 *  Always a real boolean. Never 0 or 1.
 */
export interface Class {
  /** MongoDB ObjectId or local UUID — canonical web identifier */
  _id:           EntityId;

  /** Alias of _id — required for mobile SQLite compatibility */
  id:            EntityId;

  /** Display name, e.g. "Grade 10" */
  name:          string;

  /** Numeric or text level, e.g. "10" */
  level?:        string;

  /** Section within a level, e.g. "A" */
  section?:      string;

  /** Owning school identifier */
  schoolId:      EntityId;

  /** Whether the class is active. Always a real boolean. */
  isActive:      boolean;

  /** ISO 8601 creation timestamp */
  createdAt:     ISODateString;

  /** ISO 8601 last-update timestamp */
  updatedAt:     ISODateString;

  /**
   * Number of non-deleted subjects linked to this class.
   * Populated by ClassService.getAll() correlated subquery.
   */
  subjectCount?: number;

  /**
   * Number of students currently enrolled in this class.
   * Populated by ClassService.getAll() correlated subquery.
   */
  studentCount?: number;
}

/**
 * A subject taught within a class (e.g. "Mathematics – MATH101").
 *
 * TEACHER INFO:
 *  The backend may return teacher data in two shapes:
 *   A) Populated object: raw.teacher = { _id, name, email, … }
 *   B) Flat fields:      raw.teacherId, raw.teacherName, raw.teacherEmail
 */
export interface Subject {
  /** Primary identifier */
  _id:         EntityId;

  /** Alias of _id — mobile compatibility */
  id:          EntityId;

  /** Display name, e.g. "Mathematics" */
  name:        string;

  /** Short subject code, e.g. "MATH101". Empty string when not set. */
  code:        string;

  /** Foreign key to the parent Class */
  classId:     EntityId;

  /** Foreign key to the assigned Teacher. Empty string when unassigned. */
  teacherId:   EntityId;

  /** Flat teacher display name — fallback #2 in getTeacherName() */
  teacherName: string;

  /** Owning school identifier */
  schoolId:    EntityId;

  /** Populated Class object */
  class?:      Class;

  /** Populated Teacher object — priority #1 in getTeacherName() */
  teacher?:    TeacherRef;

  /** ISO 8601 creation timestamp */
  createdAt:   ISODateString;

  /** ISO 8601 last-update timestamp */
  updatedAt:   ISODateString;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — API REQUEST PAYLOADS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Body sent to POST /admin/classes.
 * `id` is included so the server can reconcile a locally-created
 * record whose ID was generated on-device before connectivity.
 */
export interface CreateClassPayload {
  /** Optional client-generated ID for offline reconciliation */
  id?:      EntityId;
  name:     string;
  level?:   string;
  section?: string;
  schoolId: EntityId;
}

/**
 * Body sent to PUT /admin/classes/:id.
 * All fields optional — send only what changed.
 */
export interface UpdateClassPayload {
  name?:     string;
  level?:    string;
  section?:  string;
  schoolId?: EntityId;
  /** Explicit flag sent by toggleActive() */
  isActive?: boolean;
}

/**
 * Body sent to POST /admin/subjects.
 */
export interface CreateSubjectPayload {
  name:       string;
  code?:      string;
  classId:    EntityId;
  teacherId?: EntityId;
  schoolId:   EntityId;
}

/**
 * Body sent to PUT /admin/subjects/:id.
 * All fields optional — send only what changed.
 */
export interface UpdateSubjectPayload {
  name?:      string;
  code?:      string;
  classId?:   EntityId;
  teacherId?: EntityId;
  schoolId?:  EntityId;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — API RESPONSE ENVELOPES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/classes — server may use any of these shapes.
 *   { classes: [...] }   ← preferred
 *   { data: [...] }      ← legacy
 *   [...]                ← bare array
 */
export interface ClassListResponse {
  classes?: Class[];
  data?:    Class[];
  total?:   number;
}

/**
 * GET /admin/subjects — server may use any of these shapes.
 */
export interface SubjectListResponse {
  subjects?: Subject[];
  data?:     Subject[];
  total?:    number;
}

/**
 * POST /admin/classes response.
 */
export interface CreateClassResponse {
  class?:    Partial<Class>;
  data?:     Partial<Class>;
  serverId?: EntityId;
  _id?:      EntityId;
  id?:       EntityId;
}

/**
 * POST /admin/subjects response.
 */
export interface CreateSubjectResponse {
  subject?: Partial<Subject>;
  data?:    Partial<Subject>;
  _id?:     EntityId;
  id?:      EntityId;
}

/**
 * DELETE /admin/classes/:id response.
 * Includes cascade-delete counts for user-facing confirmation messages.
 */
export interface DeleteClassResponse {
  deletedSubjects:     number;
  deletedAssignments?: number;
  message?:            string;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — SERVICE-LAYER RETURN TYPES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Returned by ClassService.delete() / deleteClass() after cascade delete.
 * Both platforms guarantee this shape.
 */
export interface DeleteClassResult {
  deletedSubjects:     number;
  deletedAssignments?: number;
}

/**
 * Aggregate statistics derived from a list of classes.
 * Computed by useMemo in AdminClasses and ClassesPage.
 */
export interface ClassStats {
  total:    number;
  active:   number;
  inactive: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — UI / COMPONENT PROP TYPES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Delete-confirm dialog state in ClassesPage.
 * Stored in useState and drives the confirm modal.
 */
export interface DeleteConfirmState {
  type: "class" | "subject";
  id:   EntityId;
  name: string;
}

/**
 * Options used in <select> / <SelectField> dropdowns.
 * Shared between class filter, subject class picker, teacher picker.
 */
export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Tab identifiers for ClassesPage.
 * Stored in URL search params: /classes?tab=subjects
 */
export type ClassPageTab = "classes" | "subjects";

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — MOBILE-ONLY TYPES
// Used by the React Native / Expo app. Web code ignores these.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Raw row returned by SQLite before service-layer normalisation.
 * Mirrors the `classes` table schema in class.service.js.
 *
 * is_active is 0|1 here — the service layer coerces to boolean
 * before this type ever reaches a UI component.
 */
export interface ClassSQLiteRow {
  id:            EntityId;
  name:          string;
  level:         string | null;
  section:       string | null;
  is_active:     0 | 1;
  created_at:    ISODateString | null;
  updated_at:    ISODateString | null;
  deleted_at:    ISODateString | null;
  schoolId:      EntityId | null;
  school_id:     EntityId | null;
  _synced:       0 | 1;
  _synced_at:    ISODateString | null;
  /** Injected by correlated subquery in getAll() */
  subjectCount?: number;
  /** Injected by correlated subquery in getAll() */
  studentCount?: number;
}

/**
 * Raw SQLite subject row — mirrors the `subjects` table schema.
 */
export interface SubjectSQLiteRow {
  id:         EntityId;
  name:       string;
  code:       string | null;
  class_id:   EntityId | null;
  classId:    EntityId | null;
  teacher_id: EntityId | null;
  teacherId:  EntityId | null;
  school_id:  EntityId | null;
  schoolId:   EntityId | null;
  deleted_at: ISODateString | null;
  created_at: ISODateString | null;
  updated_at: ISODateString | null;
  _synced:    0 | 1;
  _synced_at: ISODateString | null;
}