// web/src/services/portal.service.ts
//
// The guardian portal talks to the API with its OWN token, not the staff one.
// It therefore uses a bare axios instance rather than the shared `api` client:
// that client attaches the staff bearer token and, on a 401, tries to refresh a
// staff session. Pointed at the portal both behaviours are wrong — a guardian
// would send credentials they do not have, and a genuine "code revoked" would
// be swallowed by a refresh attempt that cannot succeed.

import axios from "axios";

const BASE = (import.meta.env.VITE_API_URL ?? "/api") + "/portal";

const TOKEN_KEY = "portal_token";

export const getPortalToken = () => localStorage.getItem(TOKEN_KEY);
export const setPortalToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const clearPortalToken = () => localStorage.removeItem(TOKEN_KEY);

const client = axios.create({ baseURL: BASE });

client.interceptors.request.use((config) => {
  const token = getPortalToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export interface PortalStudent {
  _id: string;
  name: string | null;
  enrollmentNo: string | null;
  className?: string | null;
  status?: string;
}

export interface PortalSchool {
  name: string | null;
  logo: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  motto: string | null;
  academicYear?: string | null;
  currentTerm?: string | null;
}

export interface PortalFees {
  charges:  { _id: string; label: string | null; code: string | null;
              amount: number; waivedAmount: number;
              academicYear: string; term: string | null }[];
  payments: { _id: string; receiptNo: string | null; amount: number;
              method: string | null; reference: string | null;
              receivedAt: string; academicYear: string; isReversal: boolean }[];
  totals:   { charged: number; waived: number; paid: number; balance: number };
}

export interface PortalResult {
  _id: string; academicYear: string | null; term: string | null;
  className: string | null; average: number | null; percentage: number | null;
  overallGrade: string | null; classPosition: number | null;
  totalInClass: number | null; isPassing: boolean;
  subjects: { subjectName: string | null; normalizedMark: number | null;
              grade: string | null; isPassing: boolean; isAbsent?: boolean }[];
}

export interface PortalAttendance {
  tally: Record<string, number>;
  total: number;
  rate: number | null;
  lateCount?: number;
  excusedCount?: number;
  recent: {
    date: string;
    status: string;
    periodId: string | null;
    periodName: string | null;
    periodTime: string | null;
    subjectId: string | null;
    subjectName: string | null;
    note: string | null;
  }[];
  dailySummaries?: {
    date: string;
    status: string;
    present: number;
    absent: number;
    late: number;
    excused: number;
    total: number;
    periods: {
      date: string;
      status: string;
      periodId: string | null;
      periodName: string | null;
      periodTime: string | null;
      subjectId: string | null;
      subjectName: string | null;
      note: string | null;
    }[];
  }[];
  subjectSummary?: {
    subjectId: string | null;
    subjectName: string | null;
    present: number;
    absent: number;
    late: number;
    excused: number;
    total: number;
  }[];
}

export interface PortalAnnouncement {
  _id: string; title: string | null; body: string | null;
  createdAt: string; priority: string | null;
}

export interface PortalFeeReminder {
  chargeId:     string;
  code:         string;
  label:        string;
  amount:       number;
  waivedAmount: number;
  netAmount:    number;
  dueDate:      string;
  isOverdue:    boolean;
  isDueSoon:    boolean;
  daysOverdue:  number;
  academicYear: string;
  term:         string | null;
}

export interface PortalFeeReminders {
  balance:       number;
  totalCharged:  number;
  totalWaived:   number;
  totalPaid:     number;
  reminders:     PortalFeeReminder[];
  hasPlan:       boolean;
  plan: {
    _id:         string;
    reason:      string;
    instalments: Array<{ seq: number; amount: number; dueDate: string }>;
  } | null;
}

/** One code covers a whole family, so login returns every child it opens. */
export async function portalLogin(
  admissionNo: string, code: string
): Promise<{ token: string; children: PortalStudent[] }> {
  const { data } = await axios.post(`${BASE}/login`, { admissionNo, code });
  return data as { token: string; children: PortalStudent[] };
}

const unwrap = <T,>(body: unknown): T => (body as { data: T }).data;

/** Omitted studentId means "the first child", which is all a one-child parent needs. */
const childParams = (studentId?: string | null) =>
  studentId ? { params: { studentId } } : undefined;

export interface PortalMe {
  school:     PortalSchool;
  children:   PortalStudent[];
  selectedId: string;
  student:    PortalStudent;
}

export const fetchMe = async (studentId?: string | null): Promise<PortalMe> =>
  unwrap(await client.get("/me", childParams(studentId)).then((r) => r.data));

export const fetchFees = async (studentId?: string | null): Promise<PortalFees> =>
  unwrap(await client.get("/fees", childParams(studentId)).then((r) => r.data));

export const fetchResults = async (studentId?: string | null): Promise<PortalResult[]> =>
  unwrap(await client.get("/results", childParams(studentId)).then((r) => r.data));

export const fetchAttendance = async (studentId?: string | null): Promise<PortalAttendance> =>
  unwrap(await client.get("/attendance", childParams(studentId)).then((r) => r.data));

export const fetchAnnouncements = async (studentId?: string | null): Promise<PortalAnnouncement[]> =>
  unwrap(await client.get("/announcements", childParams(studentId)).then((r) => r.data));

export const fetchFeeReminders = async (studentId?: string | null): Promise<PortalFeeReminders> =>
  unwrap(await client.get("/fees/reminders", childParams(studentId)).then((r) => r.data));

export interface PortalNotification {
  _id:       string;
  kind:      string;
  subject:   string | null;
  body:      string | null;
  data:      Record<string, unknown>;
  status:    string;
  sentAt:    string | null;
  createdAt: string;
}

export const fetchNotifications = async (studentId?: string | null): Promise<PortalNotification[]> =>
  unwrap(await client.get("/notifications", childParams(studentId)).then((r) => r.data));

/** Fetches the printable receipt as HTML, using the portal token. */
// ─── Messaging ────────────────────────────────────────────────────────────────
//
// The portal was read-only until messaging arrived: these are the first write
// endpoints a guardian has. They mirror the staff routes exactly and are
// gated by the same communication policy on the server, so a parent can only
// reach teachers, the office, and their own child.

export interface PortalRecipient {
  kind:      "user" | "guardian";
  id:        string;
  name:      string;
  role?:     string | null;
  subtitle?: string | null;
}

export interface PortalConversation {
  _id:                 string;
  kind:                string;
  title?:              string | null;
  participants?:       { kind: string; id: string; name?: string | null }[];
  lastMessageAt?:      string | null;
  lastMessagePreview?: string | null;
  unread?:             number;
}

export interface PortalMessage {
  _id:        string;
  seq:        number;
  sender:     { kind: string; id: string; name?: string | null };
  body:       string | null;
  attachments?: { url: string; name?: string | null; kind?: string }[];
  createdAt:  string;
  isDeleted?: boolean;
}

export const fetchPortalRecipients = async (q = ""): Promise<PortalRecipient[]> =>
  (await client.get("/portal/messages/recipients", { params: { q } })).data?.data ?? [];

export const fetchPortalConversations = async (): Promise<PortalConversation[]> =>
  (await client.get("/portal/messages/conversations")).data?.data ?? [];

export const openPortalConversation = async (
  id: string,
  kind: "user" | "guardian" = "user",
): Promise<PortalConversation> =>
  (await client.post("/portal/messages/conversations", { id, kind })).data?.data;

export const fetchPortalThread = async (
  conversationId: string,
): Promise<{ conversation: PortalConversation; messages: PortalMessage[] }> =>
  (await client.get(`/portal/messages/conversations/${conversationId}`)).data?.data
    ?? { conversation: null, messages: [] };

export const sendPortalMessage = async (
  conversationId: string,
  body: string,
): Promise<PortalMessage> =>
  (await client.post(`/portal/messages/conversations/${conversationId}`, { body }))
    .data?.data;

export const markPortalRead = async (
  conversationId: string,
  seq: number,
): Promise<void> => {
  await client.post(`/portal/messages/conversations/${conversationId}/read`, { seq });
};

export async function fetchReceiptHtml(paymentId: string, lang: string): Promise<string> {
  const { data } = await client.get(`/receipt/${paymentId}`, {
    params: { lang },
    responseType: "text",
    transformResponse: [(body: string) => body],
  });
  return data as string;
}
