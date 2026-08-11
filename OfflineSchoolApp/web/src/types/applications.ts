// web/src/types/applications.ts

import type { Class } from "./index";

// ─────────────────────────────────────────────────────────
// DOCUMENT
// ─────────────────────────────────────────────────────────

export interface ApplicationDocument {
  id:       string;
  title:    string;
  uri:      string | null;
  url?:     string;
  fileUrl?: string;
  path?:    string;
  type:     string;
  size?:    number;
  mimeType?: string;
  name?:     string;
  fileName?: string;
}

// ─────────────────────────────────────────────────────────
// RAW SERVER SHAPE — what the API actually returns
// ─────────────────────────────────────────────────────────

export interface RawServerApplication {
  _id?:           string;
  id?:            string;

  // Name variants
  studentName?:   string;
  student_name?:  string;
  name?:          string;
  firstName?:     string;
  lastName?:      string;

  // Email variants
  email?:         string;
  studentEmail?:  string;
  parentEmail?:   string;

  // Phone variants
  phone?:         string;
  phoneNumber?:   string;
  phone_number?:  string;
  parentPhone?:   string;
  guardianPhone?: string;

  // Guardian variants
  guardianName?:  string;
  guardian_name?:  string;
  parentName?:    string;
  parent_name?:   string;
  guardian?:      string;

  // Class variants
  className?:     string;
  class_name?:    string;
  grade?:         string;
  classId?:       string;
  class_id?:      string;
  class?:         string | { _id?: string; id?: string; name?: string };

  // Dates
  createdAt?:     string;
  created_at?:    string;
  updatedAt?:     string;
  updated_at?:    string;

  // Other fields
  status?:        string;
  address?:       string;
  homeAddress?:   string;
  notes?:         string;
  schoolId?:      string;
  documents?:     unknown[];

  // Review fields
  reviewedBy?:    string | null;
  reviewedAt?:    string | null;
  rejectedAt?:    string | null;
  rejectReason?:  string | null;
  studentId?:     string | null;
  userId?:        string | null;

  // Admission
  admissionNo?:     string;
  admissionNumber?: string;
  admNo?:           string;

  [key: string]:    unknown;
}

// ─────────────────────────────────────────────────────────
// NORMALISED APPLICATION — stable shape for UI
// ─────────────────────────────────────────────────────────

export interface NormalisedApplication {
  id:            string;
  name:          string;
  firstName:     string | null;
  lastName:      string | null;
  email:         string;
  phone:         string;
  guardianName:  string;
  className:     string;
  classId:       string | null;
  status:        string;
  created_at:    string | null;
  updated_at:    string | null;
  documents:     ApplicationDocument[];
  address:       string;
  notes:         string;
  schoolId:      string | null;
}

// ─────────────────────────────────────────────────────────
// APPROVAL RESULT
// ─────────────────────────────────────────────────────────

export interface ApprovalResult {
  success?:      boolean;
  synced?:       boolean;
  emailSent?:    boolean;
  tempPassword?: string | null;
  warning?:      string | null;
  userId?:       string | null;
  message?:      string;
}

export interface RejectionResult {
  success?: boolean;
  synced?:  boolean;
  message?: string;
}

// ─────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────

export type ToastType = "success" | "warning" | "info" | "error";

export interface ToastMessage {
  type:    ToastType;
  message: string;
}

// ─────────────────────────────────────────────────────────
// CLASS — re-export for convenience, extended with id alias
// ─────────────────────────────────────────────────────────

export interface ClassOption {
  _id:       string;
  id:        string;
  name:      string;
  level?:    string | null;
  section?:  string;
  schoolId?: string;
  isActive?: boolean;
}