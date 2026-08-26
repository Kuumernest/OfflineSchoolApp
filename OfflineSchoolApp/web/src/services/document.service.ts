// web/src/services/document.service.ts
import api from "@/services/api";

const BASE = "/documents";

/**
 * Fetch a finished, printable document.
 *
 * Returns HTML rather than data because the template lives on the server — see
 * print/document.ts for why. `lang` goes with the request so the sheet is
 * printed in the language the user is reading the console in.
 */
async function fetchDocument(path: string, params: Record<string, string>): Promise<string> {
  const { data } = await api.get(`${BASE}${path}`, {
    params: { ...params, format: "html" },
    // Without this axios tries to parse an HTML body as JSON and hands back
    // something unusable.
    responseType: "text",
    transformResponse: [(body: string) => body],
  });
  return data as string;
}

export const fetchClassListHtml = (
  classId: string, schoolId: string, variant: string, lang: string
): Promise<string> =>
  fetchDocument(`/class-list/${classId}`, { schoolId, variant, lang });

export const fetchTranscriptHtml = (
  studentId: string, schoolId: string, lang: string
): Promise<string> =>
  fetchDocument(`/transcript/${studentId}`, { schoolId, lang });

/** A whole class of ID cards, ten to an A4 sheet. */
export const fetchIdCardsHtml = (
  classId: string, schoolId: string, lang: string
): Promise<string> =>
  fetchDocument(`/id-cards/${classId}`, { schoolId, lang });

// ─── Student photo (office side) ──────────────────────────────────────────────

/**
 * Set a student's ID-card photo from the office.
 *
 * The student can set their own from their profile, but most cannot — a young
 * child has no account they use, and the picture is normally taken at the desk
 * during enrolment. Sent as base64 rather than multipart to match how the
 * school logo already travels, so one upload path serves both.
 */
export async function uploadStudentPhoto(
  studentId: string, schoolId: string, photoBase64: string
): Promise<string> {
  const { data } = await api.put(`${BASE}/student-photo/${studentId}`, {
    schoolId, photoBase64,
  });
  return (data as { photoUrl: string }).photoUrl;
}

export async function deleteStudentPhoto(
  studentId: string, schoolId: string
): Promise<void> {
  await api.delete(`${BASE}/student-photo/${studentId}`, { params: { schoolId } });
}

// ─── Document verification (office side) ──────────────────────────────────────

export interface DocumentVerificationRow {
  _id:          string;
  kind:         "transcript" | "report_card";
  code:         string;
  examId:       string | null;
  examName:     string | null;
  term:         string | null;
  academicYear: string | null;
  issuedAt:     string;
  refreshedAt:  string;
  printCount:   number;
  revokedAt:    string | null;
  revokeReason: string | null;
}

/** Every verification code issued for one student's printed documents. */
export async function fetchVerifications(
  studentId: string, schoolId: string
): Promise<DocumentVerificationRow[]> {
  const { data } = await api.get(`${BASE}/verifications`, {
    params: { studentId, schoolId },
  });
  return (data as { data: DocumentVerificationRow[] }).data;
}

/** Withdraw a code — the public page then answers "withdrawn by the school". */
export async function revokeVerification(
  id: string, schoolId: string, reason: string
): Promise<void> {
  await api.post(`${BASE}/verifications/${id}/revoke`, { schoolId, reason });
}

/** Reinstate a code revoked by mistake. */
export async function restoreVerification(
  id: string, schoolId: string
): Promise<void> {
  await api.post(`${BASE}/verifications/${id}/restore`, { schoolId });
}
