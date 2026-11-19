// web/src/services/gate.service.ts
//
// The gate: recording passages and, for gate.verify holders, the fee
// compliance shown beside them (backend/src/routes/gate.routes.js).
//
// Also the two things this screen keeps in the browser, because the gate has to
// keep working when the connection does not:
//
//   the snapshot   every pupil's fee facts, pulled whole and replaced whole, so
//                  a card can be verified with no network (desktop offline).
//                  Only ever written for a gate.verify holder — it is the
//                  school's fee ledger in summary.
//   the queue      scans the server never answered. Replayed on reconnect; the
//                  server is replay-safe on the client _id, so sending one
//                  twice records it once.
//
// Every localStorage access is wrapped: a private window, blocked site data or
// a full quota must cost the offline copy, never the gate.

import api from "@/services/api";
import { useAuthStore } from "@/store/auth.store";
import type {
  ComplianceCharge, CompliancePayment, CompliancePlan, ComplianceResult,
  ComplianceStatus, GateAuthorizationFacts,
} from "../../../shared/compliance.js";

const BASE = "/gate";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GateDirection = "in" | "out";
export type GateMethod    = "card" | "manual";

/** What the gate shows of a pupil, besides the fees. */
export interface GateStudentCard {
  _id:          string;
  name:         string | null;
  enrollmentNo: string | null;
  classId:      string | null;
  className:    string | null;
  photoUrl:     string | null;
}

export interface SnapshotAuthorization extends GateAuthorizationFacts {
  _id: string;
}

export interface SnapshotStudent {
  studentId:      string;
  /** Null for a pupil with no card yet — still searchable by name. */
  token:          string | null;
  name:           string | null;
  enrollmentNo:   string | null;
  classId:        string | null;
  className:      string | null;
  photoUrl:       string | null;
  charges:        ComplianceCharge[];
  /** Server rows, so confirmed. */
  payments:       CompliancePayment[];
  plan:           CompliancePlan | null;
  authorizations: SnapshotAuthorization[];
}

export interface GateSnapshot {
  generatedAt:  string;
  academicYear: string | null;
  students:     SnapshotStudent[];
}

/**
 * The engine's result as it arrives over the wire or out of storage: its Date
 * fields are ISO strings by then. Read with `new Date(…)` / the formatters,
 * which accept either.
 */
export type WireCompliance = Omit<ComplianceResult, "asOf" | "lastPaymentDate" | "dataAsOf"> & {
  asOf:            string | Date;
  lastPaymentDate: string | Date | null;
  dataAsOf:        string | Date | null;
};

export interface ScanRequest {
  _id:           string;
  token?:        string;
  studentId?:    string;
  at:            string;
  direction?:    GateDirection;
  station:       string;
  verification?: WireCompliance | null;
}

export interface ScanResponse {
  success:      boolean;
  student:      GateStudentCard;
  direction:    GateDirection;
  at:           string;
  duplicate:    boolean;
  replay:       boolean;
  method:       GateMethod;
  /** The server's own engine result — only for gate.verify holders. */
  compliance?:  WireCompliance | null;
  notified:     boolean;
  notifyReason: string | null;
}

/** A gate event's stored verification (gate.service.js verificationSummary). */
export interface VerificationSummary {
  status:     ComplianceStatus;
  computedOn: "device" | "server";
  amountDue:        number | null;
  outstandingDue:   number | null;
  remainingBalance: number | null;
  dependsOnPending: boolean;
  stale:            boolean;
}

export interface GateHistoryRow {
  _id:          string;
  studentId:    string;
  studentName:  string | null;
  enrollmentNo: string | null;
  direction:    GateDirection;
  method:       GateMethod;
  at:           string;
  receivedAt?:  string | null;
  station?:     string | null;
  voided:       boolean;
  /** Absent for a caller without gate.verify. */
  verification?:       VerificationSummary | null;
  serverVerification?: VerificationSummary | null;
}

export interface GateAuthorization {
  _id:        string;
  studentId:  string;
  validFrom:  string;
  validUntil: string;
  reason:     string | null;
  grantedBy:  string | null;
  revokedAt?: string | null;
}

// ─── API ──────────────────────────────────────────────────────────────────────

/** GET /gate/snapshot — needs gate.verify. */
export async function fetchGateSnapshot(schoolId: string): Promise<GateSnapshot> {
  const { data } = await api.get(`${BASE}/snapshot`, { params: { schoolId } });
  return (data as { data: GateSnapshot }).data;
}

/**
 * POST /gate/scan — records a passage; replay-safe on `_id`.
 *
 * `timeout` is short at the gate on purpose: a queue of children is not kept
 * waiting thirty seconds for a slow link. A scan that times out is shown from
 * the snapshot and queued, and the replay is harmless if it did arrive.
 */
export async function postGateScan(
  schoolId: string, body: ScanRequest, opts: { timeout?: number } = {},
): Promise<ScanResponse> {
  const { data } = await api.post(`${BASE}/scan`, { ...body, schoolId }, opts.timeout ? { timeout: opts.timeout } : undefined);
  return data as ScanResponse;
}

/** GET /gate/search — the online name / admission-number lookup. */
export async function searchGate(schoolId: string, q: string): Promise<GateStudentCard[]> {
  const { data } = await api.get(`${BASE}/search`, { params: { schoolId, q } });
  return (data as { data?: GateStudentCard[] }).data ?? [];
}

/** GET /gate/verify/:studentId — compliance without recording a passage. */
export async function fetchGateVerification(
  schoolId: string, studentId: string,
): Promise<{ student: GateStudentCard; compliance: WireCompliance | null }> {
  const { data } = await api.get(`${BASE}/verify/${encodeURIComponent(studentId)}`, { params: { schoolId } });
  return (data as { data: { student: GateStudentCard; compliance: WireCompliance | null } }).data;
}

/** GET /gate/history — newest first. */
export async function fetchGateHistory(schoolId: string, limit = 30): Promise<GateHistoryRow[]> {
  const { data } = await api.get(`${BASE}/history`, { params: { schoolId, limit } });
  return (data as { data?: GateHistoryRow[] }).data ?? [];
}

/** GET /gate/authorizations?current=1 — the passes still in force or ahead. */
export async function fetchGateAuthorizations(schoolId: string, studentId: string): Promise<GateAuthorization[]> {
  const { data } = await api.get(`${BASE}/authorizations`, { params: { schoolId, studentId, current: 1 } });
  return (data as { data?: GateAuthorization[] }).data ?? [];
}

/** POST /gate/authorizations — gate.authorize only. Dates are YYYY-MM-DD. */
export async function createGateAuthorization(payload: {
  schoolId: string; studentId: string; validFrom?: string; validUntil: string; reason: string;
}): Promise<GateAuthorization> {
  const { data } = await api.post(`${BASE}/authorizations`, payload);
  return (data as { data: GateAuthorization }).data;
}

/** POST /gate/authorizations/:id/revoke — gate.authorize only. */
export async function revokeGateAuthorization(schoolId: string, id: string, reason: string): Promise<void> {
  await api.post(`${BASE}/authorizations/${encodeURIComponent(id)}/revoke`, { schoolId, reason });
}

// ─── Local copies ─────────────────────────────────────────────────────────────

const snapshotKey = (schoolId: string) => `gate.snapshot.${schoolId}`;
// Per user as well as per school: a queued scan is uploaded under whoever is
// signed in, and the audit says who scanned — it must not become the next
// person's on a shared gate machine.
const queueKey = (schoolId: string, userId: string) => `gate.queue.${schoolId}.${userId}`;

export function readStoredSnapshot(schoolId: string): GateSnapshot | null {
  if (!schoolId) return null;
  try {
    const raw = localStorage.getItem(snapshotKey(schoolId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GateSnapshot;
    return parsed && Array.isArray(parsed.students) && parsed.generatedAt ? parsed : null;
  } catch {
    return null;
  }
}

/** Replace the stored snapshot whole. Callers check gate.verify first. */
export function storeSnapshot(schoolId: string, snapshot: GateSnapshot): void {
  if (!schoolId) return;
  try {
    localStorage.setItem(snapshotKey(schoolId), JSON.stringify(snapshot));
  } catch {
    // Quota or blocked storage: the gate still works online.
  }
}

/**
 * Forget every stored gate snapshot. It is fee data pulled under gate.verify,
 * so it goes when the session does — sign-out, expiry or a forced logout —
 * and the next person on a shared gate machine pulls their own if they may.
 * The scan queue is NOT cleared: it is keyed by user, and it holds passages
 * that happened and must still reach the server.
 */
export function clearStoredSnapshots(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("gate.snapshot.")) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // Blocked storage: nothing was stored either.
  }
}

useAuthStore.subscribe((state, prev) => {
  if (prev.token && !state.token) clearStoredSnapshots();
});

/** A scan the server has not answered yet, with what the operator was shown. */
export interface QueuedScan {
  body:     ScanRequest;
  /** For the history list while it waits — never sent. */
  display:  {
    studentId: string | null;
    name:      string | null;
    enrollmentNo: string | null;
    status:    ComplianceStatus | null;
    method:    GateMethod;
  };
  attempts: number;
}

export function readQueue(schoolId: string, userId: string): QueuedScan[] {
  if (!schoolId || !userId) return [];
  try {
    const raw = localStorage.getItem(queueKey(schoolId, userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as QueuedScan[] : [];
  } catch {
    return [];
  }
}

export function writeQueue(schoolId: string, userId: string, rows: QueuedScan[]): void {
  if (!schoolId || !userId) return;
  try {
    if (rows.length) localStorage.setItem(queueKey(schoolId, userId), JSON.stringify(rows));
    else localStorage.removeItem(queueKey(schoolId, userId));
  } catch {
    // Nothing to do: the scan is still on screen, it just will not survive a reload.
  }
}
