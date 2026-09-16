// web/src/services/platform.service.ts
//
// The platform: what sits above a school. Everything a super_admin does INSIDE
// a school goes through the ordinary services with the active school's id —
// see auth.store's enterSchool and the axios request interceptor. This module
// is only for the routes under /api/super-admin.

import api from "@/lib/axios";

const BASE = "/super-admin";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface SchoolCounts {
  students: number;
  teachers: number;
  admins:   number;
  bursars:  number;
}

export interface PlatformSchool {
  _id:            string;
  name:           string;
  code:           string | null;
  email?:         string | null;
  phone?:         string | null;
  address?:       string | null;
  city?:          string | null;
  state?:         string | null;
  country?:       string | null;
  website?:       string | null;
  principalName?: string | null;
  isActive:       boolean;
  verified?:      boolean;
  createdAt?:     string;
  updatedAt?:     string;
  settings?: {
    academicYear?: string | null;
    currentTerm?:  string | null;
    currency?:     string | null;
  };
  counts: SchoolCounts;
}

export interface SchoolIdentity {
  name?:          string;
  code?:          string | null;
  email?:         string | null;
  phone?:         string | null;
  address?:       string | null;
  city?:          string | null;
  state?:         string | null;
  country?:       string | null;
  website?:       string | null;
  principalName?: string | null;
  verified?:      boolean;
}

export interface CreateSchoolInput extends SchoolIdentity {
  name: string;
  settings?: { academicYear?: string; currentTerm?: string; currency?: string; timezone?: string };
}

export interface SchoolStaff {
  _id:               string;
  name:              string;
  email:             string;
  role:              "school_admin" | "bursar";
  isActive:          boolean;
  mustResetPassword: boolean;
  createdAt?:        string;
}

export interface AuditEntry {
  _id:           string;
  action:        string;
  actorId:       string | null;
  actorName:     string | null;
  actorRole:     string | null;
  schoolId:      string | null;
  schoolName:    string | null;
  resourceType:  string | null;
  resourceId:    string | null;
  resourceLabel: string | null;
  before:        Record<string, unknown> | null;
  after:         Record<string, unknown> | null;
  reason:        string | null;
  ip:            string | null;
  at:            string;
}

export interface Paged<T> {
  total: number;
  page:  number;
  pages: number;
  limit: number;
  items: T[];
}

export interface PlatformFilters {
  schoolId?:     string | null;
  academicYear?: string | null;
  term?:         number | null;
  from?:         string | null;
  to?:           string | null;
}

export interface AttendanceFigures {
  marked: number; present: number; late: number; absent: number; excused: number;
  rate: number | null;
}
export interface AcademicFigures {
  results: number; published: number; average: number | null; passRate: number | null;
}
export interface PromotionFigures {
  decided: number; promoted: number; repeated: number; conditional: number;
  graduated: number; pending: number; rate: number | null;
}
export interface FeeFigures {
  charged: number; waived: number; billed: number; paid: number; balance: number;
  collectionRate: number | null;
}

export interface SchoolRow {
  schoolId:     string;
  name:         string;
  code:         string | null;
  isActive:     boolean;
  academicYear: string | null;
  currentTerm:  string | null;
  students:     number;
  teachers:     number;
  attendance:   AttendanceFigures;
  academics:    AcademicFigures;
  promotion:    PromotionFigures;
  fees:         FeeFigures;
}

export interface PlatformTotals {
  schools:       number;
  activeSchools: number;
  students:      number;
  teachers:      number;
  attendance:    AttendanceFigures;
  academics:     AcademicFigures;
  promotion:     PromotionFigures;
  fees:          FeeFigures;
}

export interface PlatformStats {
  filters: PlatformFilters & { termAppliesTo: string[] };
  totals:  PlatformTotals;
  schools: SchoolRow[];
}

export interface FilterOptions {
  academicYears: string[];
  terms:         number[];
  schools:       { _id: string; name: string; isActive: boolean }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOLS
// ─────────────────────────────────────────────────────────────────────────────

const clean = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

export async function fetchSchools(opts: {
  search?: string; status?: "all" | "active" | "inactive"; page?: number; limit?: number;
} = {}): Promise<Paged<PlatformSchool>> {
  const { data } = await api.get(`${BASE}/schools`, { params: clean(opts) });
  return { total: data.total, page: data.page, pages: data.pages, limit: data.limit, items: data.schools };
}

export async function fetchSchool(schoolId: string): Promise<{
  school: PlatformSchool; admins: SchoolStaff[]; recentAudit: AuditEntry[];
}> {
  const { data } = await api.get(`${BASE}/schools/${schoolId}`);
  return { school: data.school, admins: data.admins, recentAudit: data.recentAudit };
}

export async function createSchool(input: CreateSchoolInput): Promise<PlatformSchool> {
  const { data } = await api.post(`${BASE}/schools`, input);
  return data.school;
}

export async function updateSchool(schoolId: string, patch: SchoolIdentity): Promise<PlatformSchool> {
  const { data } = await api.patch(`${BASE}/schools/${schoolId}`, patch);
  return data.school;
}

export async function activateSchool(schoolId: string): Promise<PlatformSchool> {
  const { data } = await api.post(`${BASE}/schools/${schoolId}/activate`, {});
  return data.school;
}

export async function deactivateSchool(schoolId: string, reason: string): Promise<PlatformSchool> {
  const { data } = await api.post(`${BASE}/schools/${schoolId}/deactivate`, { reason });
  return data.school;
}

export interface EnteredSchool {
  _id: string; name: string; code: string | null; isActive: boolean;
  academicYear: string | null; currentTerm: string | null;
}

/** Records the entry on the server and returns the context the shell shows. */
export async function enterSchoolOnServer(schoolId: string): Promise<EnteredSchool> {
  const { data } = await api.post(`${BASE}/schools/${schoolId}/enter`, {});
  return data.school;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL ADMINISTRATORS — through the existing route, with the school named
// ─────────────────────────────────────────────────────────────────────────────

export async function appointSchoolAdmin(schoolId: string, input: {
  name: string; email: string; role?: "school_admin" | "bursar";
}): Promise<{ admin: SchoolStaff; tempPassword?: string; emailSent?: boolean; restored?: boolean; message?: string }> {
  const { data } = await api.post("/admin/settings/admins", { ...input, schoolId });
  return data;
}

export async function resetSchoolAdminPassword(schoolId: string, adminId: string): Promise<{
  tempPassword?: string; emailSent?: boolean; message?: string;
}> {
  const { data } = await api.post(`/admin/settings/admins/${adminId}/reset-password`, { schoolId });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM ADMINISTRATORS — the operator accounts themselves. No school.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlatformAdmin {
  _id:               string;
  name:              string;
  email:             string;
  role:              "super_admin";
  schoolId:          null;
  isActive:          boolean;
  mustResetPassword: boolean;
  createdAt:         string | null;
  updatedAt:         string | null;
}

export async function fetchPlatformAdmins(): Promise<PlatformAdmin[]> {
  const { data } = await api.get(`${BASE}/admins`);
  return data.admins ?? [];
}

export async function createPlatformAdmin(input: {
  name: string; email: string; password: string; confirmPassword: string;
}): Promise<PlatformAdmin> {
  const { data } = await api.post(`${BASE}/admins`, input);
  return data.admin;
}

export async function updatePlatformAdmin(adminId: string, patch: {
  name?: string; email?: string; isActive?: boolean;
}): Promise<PlatformAdmin> {
  const { data } = await api.patch(`${BASE}/admins/${adminId}`, patch);
  return data.admin;
}

export async function resetPlatformAdminPassword(adminId: string): Promise<{
  tempPassword?: string; emailSent?: boolean; message?: string;
}> {
  const { data } = await api.post(`${BASE}/admins/${adminId}/reset-password`, {});
  return data;
}

/**
 * The operator's own name and email, through the same profile route every
 * member of staff uses. It reads the caller from the token, so it needs no
 * school — which a super_admin has none of.
 */
export async function updateMyProfile(input: { name: string; email: string }): Promise<{ name: string; email: string }> {
  const { data } = await api.put("/admin/settings/profile", input);
  return data.profile;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACROSS SCHOOLS
// ─────────────────────────────────────────────────────────────────────────────

const filterParams = (f: PlatformFilters) => clean({
  schoolId: f.schoolId, academicYear: f.academicYear,
  term: f.term ?? undefined, from: f.from, to: f.to,
});

export async function fetchPlatformDashboard(f: PlatformFilters = {}): Promise<PlatformStats> {
  const { data } = await api.get(`${BASE}/dashboard`, { params: filterParams(f) });
  return { filters: data.filters, totals: data.totals, schools: data.schools };
}

export async function fetchPlatformPerformance(f: PlatformFilters = {}): Promise<PlatformStats> {
  const { data } = await api.get(`${BASE}/performance`, { params: filterParams(f) });
  return { filters: data.filters, totals: data.totals, schools: data.schools };
}

export async function fetchPlatformFilters(): Promise<FilterOptions> {
  const { data } = await api.get(`${BASE}/filters`);
  return { academicYears: data.academicYears, terms: data.terms, schools: data.schools };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORD
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAuditLog(opts: {
  schoolId?: string; action?: string; actorId?: string; from?: string; to?: string;
  page?: number; limit?: number;
} = {}): Promise<Paged<AuditEntry> & { actions: string[] }> {
  const { data } = await api.get(`${BASE}/audit`, { params: clean(opts) });
  return {
    total: data.total, page: data.page, pages: data.pages, limit: data.limit,
    items: data.entries, actions: data.actions,
  };
}
