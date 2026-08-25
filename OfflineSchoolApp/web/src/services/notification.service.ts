// web/src/services/notification.service.ts
import api                       from "@/services/api";
import {
  fetchSystemHealth,
  type SystemHealthStats,
}                                from "@/services/dashboard.service";
import {
  deriveAlerts,
  type DashAlert,
}                                from "@/components/dashboard/AlertsPanel";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Notification {
  _id:         string;
  title:       string;
  body:        string;
  type:        "announcement" | "attendance" | "grade" | "system" | "alert" | "general";
  priority:    "low" | "normal" | "high" | "urgent";
  isRead:      boolean;
  authorName?: string;
  createdAt:   string;
  link?:       string;
}

export interface NotificationListResponse {
  notifications: Notification[];
  total:         number;
  unreadCount:   number;
}

// ─── Alert priority map ───────────────────────────────────────────────────────
const ALERT_PRIORITY_MAP: Record<string, Notification["priority"]> = {
  danger:  "urgent",
  warning: "high",
  info:    "normal",
};

// ─── Alert → Notification ─────────────────────────────────────────────────────
function alertToNotification(alert: DashAlert): Notification {
  return {
    _id:       `alert-${alert.id}`,
    title:     getAlertTitle(alert),
    body:      alert.message,
    type:      "alert",
    priority:  ALERT_PRIORITY_MAP[alert.type] ?? "normal",
    isRead:    false, // Alerts are always live — never "read"
    createdAt: new Date().toISOString(),
    link:      alert.route,
  };
}

function getAlertTitle(alert: DashAlert): string {
  switch (alert.id) {
    case "stale":                return "Pending Applications";
    case "unassigned":           return "Unassigned Teachers";
    case "missing-subjects":     return "Missing Subjects";
    case "conflicts":            return "Timetable Conflicts";
    case "timetable-incomplete": return "Incomplete Timetables";
    case "no-assignments":       return "No Teacher Assignments";
    default:                     return "System Alert";
  }
}

// ─── Normalise API notification ───────────────────────────────────────────────
function normaliseNotification(raw: Record<string, unknown>): Notification {
  return {
    _id:        String(raw._id        ?? raw.id       ?? ""),
    title:      String(raw.title      ?? ""),
    body:       String(raw.body       ?? raw.message  ?? raw.content ?? ""),
    type:       (raw.type             as Notification["type"])     ?? "general",
    priority:   (raw.priority         as Notification["priority"]) ?? "normal",
    isRead:     Boolean(raw.isRead    ?? raw.is_read  ?? false),
    authorName: String(raw.authorName ?? raw.author_name ?? ""),
    createdAt:  String(raw.createdAt  ?? raw.created_at  ?? ""),
    link:       String(raw.link       ?? raw.url         ?? ""),
  };
}

// ─── Fetch system alerts ──────────────────────────────────────────────────────
async function fetchSystemAlerts(schoolId: string): Promise<Notification[]> {
  try {
    const stats: SystemHealthStats = await fetchSystemHealth(schoolId);
    const alerts: DashAlert[]      = deriveAlerts(stats);
    return alerts.map(alertToNotification);
  } catch (err) {
    console.warn("[Notifications] System alerts fetch failed:", err);
    return [];
  }
}

// ─── Fetch announcement notifications ─────────────────────────────────────────
async function fetchAnnouncementNotifications(
  schoolId: string,
  limit = 20,
): Promise<Notification[]> {
  try {
    // Announcements live at /announcements, not /admin/announcements — the
    // latter 404s. The catch below swallowed it, so the notification bell just
    // showed nothing rather than reporting a problem.
    const { data } = await api.get("/announcements", {
      params: {
        schoolId,
        limit,
        sort: "-createdAt",
      },
    });

    const rawList: unknown[] =
      data?.announcements ??
      data?.notifications ??
      data?.data          ??
      (Array.isArray(data) ? data : []);

    return (rawList as Record<string, unknown>[]).map(normaliseNotification);
  } catch (err) {
    console.warn("[Notifications] Announcements fetch failed:", err);
    return [];
  }
}

// ─── Priority sort weight ─────────────────────────────────────────────────────
const PRIORITY_WEIGHT: Record<Notification["priority"], number> = {
  urgent: 4,
  high:   3,
  normal: 2,
  low:    1,
};

// ─── Main fetch — combines all sources ────────────────────────────────────────
export async function fetchNotifications(
  schoolId: string,
  limit = 20,
): Promise<NotificationListResponse> {
  // Fetch all sources in parallel
  const [announcementNotifs, alertNotifs] = await Promise.all([
    fetchAnnouncementNotifications(schoolId, limit),
    fetchSystemAlerts(schoolId),
  ]);

  // Merge: alerts first, then announcements
  const allNotifications = [...alertNotifs, ...announcementNotifs].sort(
    (a, b) => {
      // Unread first
      if (a.isRead !== b.isRead) return a.isRead ? 1 : -1;
      // Then by priority weight
      const pDiff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
      if (pDiff !== 0) return pDiff;
      // Then by date — newest first
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
  );

  // NOTE: unreadCount counts only REAL notifications (announcements).
  // System alerts are derived/live data — they are hardcoded isRead:false
  // above and can never be marked read (markAsRead skips "alert-" ids,
  // read-all only touches announcements). Including them here meant the
  // badge could never reach zero while any alert was active, so opening
  // the bell appeared to never change the count.
  const unreadCount = allNotifications.filter(
    (n) => !n.isRead && n.type !== "alert"
  ).length;

  return {
    notifications: allNotifications,
    total:         allNotifications.length,
    unreadCount,
  };
}

// ─── Mark single as read ──────────────────────────────────────────────────────
// Returns true when the server confirmed the receipt (or the item needs no
// receipt). The caller must NOT update its local unread state on false —
// otherwise the badge optimistically clears and then snaps back on the next
// reload, which reads as "the count never changes".
export async function markAsRead(notificationId: string): Promise<boolean> {
  // Alert notifications are derived/live — not stored in DB
  if (notificationId.startsWith("alert-")) return true;

  try {
    // POST, not PATCH, and /announcements rather than /admin/announcements.
    await api.post(`/announcements/${notificationId}/read`);
    return true;
  } catch (err) {
    console.warn("[Notifications] Mark as read failed:", err);
    return false;
  }
}

// ─── Mark all as read ─────────────────────────────────────────────────────────
// Returns the number of receipts written (0 = nothing was unread), or -1 when
// the request failed — the caller should keep its current unread state then.
export async function markAllAsRead(schoolId: string): Promise<number> {
  try {
    // schoolId must be in the body — the handler destructures req.body and
    // would otherwise 500, or match every school if it got through.
    const { data } = await api.post("/announcements/read-all", { schoolId });
    return Number((data as Record<string, unknown>)?.marked ?? 0);
  } catch (err) {
    console.warn("[Notifications] Mark all as read failed:", err);
    return -1;
  }
}