// web/src/types/index.ts

// ─────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────

export type UserRole =
  | "super_admin"
  | "school_admin"
  | "admin"
  | "teacher"
  | "student";

export interface User {
  _id:               string;
  id?:               string;
  name:              string;
  email:             string;
  role:              UserRole;
  schoolId:          string;
  schoolName?:       string;
  // Some endpoints populate the school instead of sending a flat schoolName.
  school?:           { name?: string } | null;
  isActive:          boolean;
  mustResetPassword?: boolean;
  createdAt?:        string;
  updatedAt?:        string;
}

export interface AuthState {
  user:    User | null;
  token:   string | null;
  isAuth:  boolean;
}

export interface LoginPayload {
  email:    string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  token:   string;
  user:    User;
  message?: string;
}

// ─────────────────────────────────────────────────────────
// SCHOOL
// ─────────────────────────────────────────────────────────

export interface School {
  _id:            string;
  name:           string;
  address?:       string;
  phone?:         string;
  email?:         string;
  logo?:          string;
  motto?:         string;
  website?:       string;
  principalName?: string;
}

// ─────────────────────────────────────────────────────────
// CLASS
// ─────────────────────────────────────────────────────────

export interface Class {
  _id:        string;
  // Mongo exposes an `id` virtual next to `_id`; some list endpoints send only
  // that one, so callers legitimately read either.
  id?:        string;
  name:       string;
  level?:     string;
  section?:   string;
  schoolId:   string;
  isActive:   boolean;
  createdAt?: string;
  updatedAt?: string;
}

// Alias used in some service files
export type SchoolClass = Class;

// ─────────────────────────────────────────────────────────
// SUBJECT
// ─────────────────────────────────────────────────────────

export interface Subject {
  _id:        string;
  name:       string;
  code?:      string;
  classId:    string;
  teacherId?: string;
  schoolId:   string;
  class?:     Class;
  teacher?:   User;
  createdAt?: string;
  updatedAt?: string;
}

// ─────────────────────────────────────────────────────────
// STUDENT
// ─────────────────────────────────────────────────────────

export interface Student {
  _id:      string;
  name:     string;
  email?:   string;
  phone?:   string;
  gender?:  string;
  classId?: string | null;
  schoolId: string;

  // ── Login identifier ──────────────────────────────────
  // Students log in using their enrollment number, not email.
  // Generated server-side when the application is approved.
  enrollmentNo?: string | null;

  // ── Legacy aliases ────────────────────────────────────
  // Both fields mirror enrollmentNo — kept for backwards
  // compatibility with older records and API responses.
  admissionNumber?: string;
  admissionNo?:     string | null;

  // ── Personal info ─────────────────────────────────────
  dateOfBirth?:  string;
  guardianName?: string | null;
  guardianPhone?: string | null;
  address?:      string | null;

  // ── Status ────────────────────────────────────────────
  // Matches backend enum: approved | pending | rejected | suspended
  status:   string;
  isActive: boolean;

  // Set when the account still holds its generated first password, so the UI
  // can surface "must reset" without a second request.
  mustResetPassword?: boolean;

  // ── Dates ─────────────────────────────────────────────
  enrolledAt?: string;
  createdAt?:  string;
  updatedAt?:  string;

  // ── Class (populated or lightweight shape) ────────────
  // Flat name sent by the list endpoints, which do not populate `class`.
  className?: string | null;

  class?: {
    _id?:  string | null;
    id?:   string;
    name:  string;
  } | null;
}

// ─────────────────────────────────────────────────────────
// TEACHER
// ─────────────────────────────────────────────────────────

export interface Teacher {
  _id:        string;
  name:       string;
  email:      string;
  phone?:     string;
  schoolId:   string;
  isActive:   boolean;
  subjects?:  Subject[];
  createdAt?: string;
  updatedAt?: string;
}

// ─────────────────────────────────────────────────────────
// EXAM
// ─────────────────────────────────────────────────────────

export interface Exam {
  _id:              string;
  name:             string;
  type:             string;
  term:             string;
  academicYear:     string;
  classId?:         string;
  classIds?:        string[];
  schoolId:         string;
  status:           "draft" | "scheduled" | "ongoing" | "completed" | "published" | "archived";
  startDate?:       string;
  endDate?:         string;
  totalMarks:       number;
  passMark:         number;
  description?:     string;
  resultsPublished: boolean;
  createdAt?:       string;
  updatedAt?:       string;
}

export interface ExamSubject {
  _id:              string;
  examId:           string;
  subjectId:        string;
  teacherId?:       string;
  subjectName:      string;
  teacherName?:     string;
  maxScore:         number;
  passMark:         number;
  submissionStatus: string;
}

// ─────────────────────────────────────────────────────────
// ANNOUNCEMENT
// ─────────────────────────────────────────────────────────

export interface Announcement {
  _id:         string;
  title:       string;
  body:        string;
  audience:    string;
  priority:    "low" | "normal" | "high" | "urgent";
  isPinned:    boolean;
  isActive:    boolean;
  authorName?: string;
  createdAt?:  string;
  expiresAt?:  string;
}

// ─────────────────────────────────────────────────────────
// API RESPONSE WRAPPER
// ─────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success:  boolean;
  data?:    T;
  message?: string;
  error?:   string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data:    T[];
  total:   number;
  page:    number;
  pages:   number;
}

// ─────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────

export interface DashboardStats {
  students: { total: number; active: number; new: number };
  teachers: { total: number; active: number };
  classes:  { total: number };
  exams:    { total: number; ongoing: number; completed: number };
}