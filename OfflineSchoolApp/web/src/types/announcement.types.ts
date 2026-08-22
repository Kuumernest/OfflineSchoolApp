// web/src/types/announcement.types.ts

export const AUDIENCES = ["all", "teachers", "students", "class"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const AUDIENCE_LABELS: Record<Audience, string> = {
  all:      "Everyone",
  teachers: "Teachers only",
  students: "Students only",
  class:    "Specific classes",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low:    "Low",
  normal: "Normal",
  high:   "High",
  urgent: "Urgent",
};

export interface AnnouncementAuthor {
  _id?:  string;
  name?: string;
  email?: string;
  role?: string;
}

export interface AnnouncementClassRef {
  _id:      string;
  name:     string;
  section?: string;
}

export interface Announcement {
  _id:        string;
  title:      string;
  body:       string;
  audience:   Audience;
  priority:   Priority;
  isPinned:   boolean;
  isActive:   boolean;

  author?:        AnnouncementAuthor | string | null;
  authorName?:    string | null;
  authorRole?:    string | null;
  targetClasses:  AnnouncementClassRef[] | string[];

  subjectId?:   string | null;
  subjectName?: string | null;

  publishAt?: string | null;
  expiresAt?: string | null;
  createdAt?: string;
  updatedAt?: string;

  // Added per-viewer by enrichForUser() on the server.
  readCount?:       number;
  acknowledgeCount?: number;
  isRead?:          boolean;
  isAcknowledged?:  boolean;
}

export interface CreateAnnouncementPayload {
  title:          string;
  body:           string;
  audience:       Audience;
  priority:       Priority;
  isPinned?:      boolean;
  targetClasses?: string[];
  publishAt?:     string | null;
  expiresAt?:     string | null;
  subjectId?:     string | null;
}

export type UpdateAnnouncementPayload = Partial<CreateAnnouncementPayload>;

export interface AnnouncementListResult {
  announcements: Announcement[];
  total:         number;
  page:          number;
  pages:         number;
}

export interface AnnouncementFilters {
  audience?: Audience | "";
  priority?: Priority | "";
  page?:     number;
  limit?:    number;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERMISSIONS
//
// The server enforces these (announcement.routes.js POST /), but the form has
// to know them too — otherwise a teacher fills in an "Everyone" announcement,
// hits save, and gets a 403 after the fact.
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ROLES = new Set(["super_admin", "school_admin", "admin"]);

export const isAdminRole = (role?: string | null): boolean =>
  ADMIN_ROLES.has(role ?? "");

/** Audiences the given role is allowed to publish to. */
export const allowedAudiences = (role?: string | null): Audience[] =>
  isAdminRole(role)
    ? ["all", "teachers", "students", "class"]
    // Teachers may address students, or classes they are assigned to teach.
    : ["students", "class"];

/** Only admins can pin. */
export const canPin = (role?: string | null): boolean => isAdminRole(role);
