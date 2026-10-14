// web/src/services/portal.service.ts
//
// The guardian portal talks to the API with its OWN token, not the staff one.
// It therefore uses a bare axios instance rather than the shared `api` client:
// that client attaches the staff bearer token and, on a 401, tries to refresh a
// staff session. Pointed at the portal both behaviours are wrong — a guardian
// would send credentials they do not have, and a genuine "code revoked" would
// be swallowed by a refresh attempt that cannot succeed.

import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";

const BASE = (import.meta.env.VITE_API_URL ?? "/api") + "/portal";

// Two tokens, two jobs. The ACCESS token rides on every request and lasts
// twenty minutes. The REFRESH token is the session: it lasts ninety days and is
// what "signed in" means in this browser. The page asks hasPortalSession(),
// not whether an access token happens to be unexpired — the first version
// asked the latter, so a parent who came back the next morning was signed out
// before the first request had gone. A lapsed access token is renewed here,
// inside the client, and the request that hit it is sent again.
const TOKEN_KEY   = "portal_token";
const SESSION_KEY = "portal_refresh_token";

export const getPortalToken        = () => localStorage.getItem(TOKEN_KEY);
export const setPortalToken        = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const getPortalRefreshToken = () => localStorage.getItem(SESSION_KEY);
export const hasPortalSession      = () => Boolean(getPortalRefreshToken());

export const setPortalSession = ({ token, refreshToken }: { token: string; refreshToken: string }) => {
  localStorage.setItem(SESSION_KEY, refreshToken);
  setPortalToken(token);
};

/** Forget both tokens. Local only — portalLogout is what tells the server. */
export const clearPortalToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
};

const client = axios.create({ baseURL: BASE });

// One refresh at a time: every query on the page wakes together after a night
// away, and the answer is the same token.
let refreshing: Promise<string | null> | null = null;

/**
 * Renew the access token. A 401 from the server is final — the session ended
 * or the code was withdrawn — so both tokens are dropped and the error is
 * rethrown for the page to explain. Any other failure (offline, a timeout) is
 * rethrown WITH the session kept.
 */
const refreshAccessToken = (): Promise<string | null> => {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refreshToken = getPortalRefreshToken();
    if (!refreshToken) return null;
    try {
      const { data } = await axios.post(`${BASE}/refresh`, { refreshToken });
      setPortalToken(data.token as string);
      return data.token as string;
    } catch (err) {
      if ((err as { response?: { status?: number } })?.response?.status === 401) clearPortalToken();
      throw err;
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
};

client.interceptors.request.use(async (config) => {
  let token = getPortalToken();
  if (!token && getPortalRefreshToken()) token = await refreshAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Which 401s are about the access token rather than the parent. These are
// renewed and retried once; ACCESS_REVOKED and the rest go straight through.
const RENEWABLE = new Set(["TOKEN_EXPIRED", "NO_TOKEN", "INVALID_TOKEN"]);

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

client.interceptors.response.use(undefined, async (err: AxiosError<{ code?: string }>) => {
  const config = err.config as RetriableConfig | undefined;
  if (err.response?.status !== 401 || !config || config._retried) throw err;
  if (!RENEWABLE.has(err.response.data?.code ?? "")) throw err;
  if (!getPortalRefreshToken()) throw err;

  await refreshAccessToken();
  config._retried = true;
  return client.request(config);
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
  isPinned?: boolean;
  /**
   * Which of this parent's children the notice names, when it names any.
   *
   * The list carries notices for every child's class now rather than only the
   * one selected, which makes "bring PE kit on Thursday" ambiguous for a
   * parent with three children unless the card says whose Thursday it is.
   */
  forStudents?: string[];
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
): Promise<{ token: string; refreshToken: string; children: PortalStudent[] }> {
  const { data } = await axios.post(`${BASE}/login`, { admissionNo, code });
  return data as { token: string; refreshToken: string; children: PortalStudent[] };
}

/**
 * Sign this browser out. The server is told so the session cannot be resumed,
 * but the local tokens go first and regardless — a parent signing out offline
 * is signed out of this browser, which is what they asked for.
 */
export async function portalLogout(): Promise<void> {
  const refreshToken = getPortalRefreshToken();
  clearPortalToken();
  if (!refreshToken) return;
  await axios.post(`${BASE}/logout`, { refreshToken }).catch(() => { /* best effort */ });
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
  /**
   * Unread messages waiting, across every thread.
   *
   * On /me because this is the one request every screen makes whatever tab it
   * is showing. A badge that needs a second request to a tab the parent has
   * not opened is a badge no client draws, which is how a parent ended up with
   * no indication anywhere that a message had arrived.
   */
  unreadMessages?: number;
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
  /**
   * The message as displayable text.
   *
   * Not the channel payload: for email that is a whole HTML document, and the
   * server now sends the plain-text rendering under this name and the markup
   * under `html`. Anything that puts this on screen gets text.
   */
  body:      string | null;
  html?:     string | null;
  data:      Record<string, unknown>;
  status:    string;
  skipReason?: string | null;
  sentAt:    string | null;
  createdAt: string;

  /**
   * Set only on the derived "message" rows.
   *
   * An unread thread is a notice too, and it is not a row in the notification
   * queue — that queue has a channel and a retry backoff, so a row in it is an
   * email actually going out. The server derives these from the conversations
   * it already stores, which is why they carry a thread to open and a count
   * rather than a delivery status.
   */
  conversationId?: string;
  unread?:         number;
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
  (await client.get("/messages/recipients", { params: { q } })).data?.data ?? [];

export const fetchPortalConversations = async (): Promise<PortalConversation[]> =>
  (await client.get("/messages/conversations")).data?.data ?? [];

export const openPortalConversation = async (
  id: string,
  kind: "user" | "guardian" = "user",
): Promise<PortalConversation> =>
  (await client.post("/messages/conversations", { id, kind })).data?.data;

export const fetchPortalThread = async (
  conversationId: string,
): Promise<{ conversation: PortalConversation; messages: PortalMessage[] }> =>
  (await client.get(`/messages/conversations/${conversationId}`)).data?.data
    ?? { conversation: null, messages: [] };

export const sendPortalMessage = async (
  conversationId: string,
  body: string,
): Promise<PortalMessage> =>
  (await client.post(`/messages/conversations/${conversationId}`, { body }))
    .data?.data;

export const markPortalRead = async (
  conversationId: string,
  seq: number,
): Promise<void> => {
  await client.post(`/messages/conversations/${conversationId}/read`, { seq });
};

export async function fetchReceiptHtml(paymentId: string, lang: string): Promise<string> {
  const { data } = await client.get(`/receipt/${paymentId}`, {
    params: { lang },
    responseType: "text",
    transformResponse: [(body: string) => body],
  });
  return data as string;
}
