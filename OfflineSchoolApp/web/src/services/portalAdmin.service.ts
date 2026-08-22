// web/src/services/portalAdmin.service.ts
//
// The STAFF side of the guardian portal: issuing and revoking codes. Uses the
// ordinary authenticated client, unlike portal.service.ts which carries a
// guardian's own token.
//
// Keyed on a GUARDIAN, not a student: one code covers a whole family, so a
// parent with three children at the school signs in once.

import api from "@/services/api";

const BASE = "/documents/guardian-access";

export interface AccessChild {
  _id:          string;
  name:         string | null;
  enrollmentNo: string | null;
}

export interface GuardianAccessRow {
  _id:        string;
  label:      string | null;
  hasCode:    boolean;
  /** Last two characters, so the office can identify a code it cannot read. */
  hint:       string | null;
  issuedAt:   string | null;
  revokedAt:  string | null;
  lastSeenAt: string | null;
  children:   AccessChild[];
}

export async function fetchGuardianAccess(schoolId: string): Promise<GuardianAccessRow[]> {
  const { data } = await api.get(BASE, { params: { schoolId } });
  return (data as { data: GuardianAccessRow[] }).data ?? [];
}

/**
 * Issue a code. The plain code comes back once and is never retrievable again.
 *
 * Pass `studentIds` for a new guardian, or `accessId` to re-issue for the same
 * children — which is what "the parent lost the slip" needs.
 */
export async function issueGuardianCode(
  schoolId: string,
  payload: { studentIds?: string[]; accessId?: string; label?: string | null }
): Promise<{ code: string; accessId: string; hint: string }> {
  const { data } = await api.post(BASE, { schoolId, ...payload });
  return data as { code: string; accessId: string; hint: string };
}

/** Change which children a code covers, leaving the code itself alone. */
export async function setAccessChildren(
  accessId: string, schoolId: string, studentIds: string[]
): Promise<void> {
  await api.put(`${BASE}/${accessId}`, { schoolId, studentIds });
}

export async function revokeGuardianAccess(
  accessId: string, schoolId: string
): Promise<void> {
  await api.delete(`${BASE}/${accessId}`, { params: { schoolId } });
}
