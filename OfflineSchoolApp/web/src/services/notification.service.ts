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
import { fetchConversations } from "./message.service";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Notification {
  _id:         string;
  title:       string;
  body:        string;
  type:        "announcement" | "attendance" | "grade" | "system" | "alert" | "message" | "general";
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
function alertToNotification(
  alert: DashAlert,
  t: (key: string, params?: Record<string, unknown>) => string,
): Notification {
  return {
    _id:       `alert-${alert.id}`,
    title:     getAlertTitle(alert, t),
    body:      t(alert.messageKey, alert.params),
    type:      "alert",
    priority:  ALERT_PRIORITY_MAP[alert.type] ?? "normal",
    isRead:    false, // Alerts are always live — never "read"
    createdAt: new Date().toISOString(),
    link:      alert.route,
  };
}

function getAlertTitle(alert: DashAlert, t: (key: string, params?: Record<string, unknown>) => string): string {
  switch (alert.id) {
    case "stale":                return t("alerts.titleAppsPending");
    case "unassigned":           return t("alerts.titleUnassigned");
    case "missing-subjects":     return t("alerts.titleMissingSubjects");
    case "conflicts":            return t("alerts.titleConflicts");
    case "timetable-incomplete": return t("alerts.titleNoTimetable");
    case "no-assignments":       return t("alerts.titleNoAssignments");
    default:                     return t("alerts.titleGeneric");
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
async function fetchSystemAlerts(
  schoolId: string,
  t: (key: string, params?: Record<string, unknown>) => string,
): Promise<Notification[]> {
  try {
    const stats: SystemHealthStats = await fetchSystemHealth(schoolId);
    const alerts: DashAlert[]      = deriveAlerts(stats);
    return alerts.map((a) => alertToNotification(a, t));
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

/**
 * Unread conversations, as notifications.
 *
 * Sending a message notified nobody. Not by a missing template — the school
 * never had a way to say it: there is no message kind in the Notification
 * queue, no push, and the unread count the server already returns was
 * rendered only inside the message list itself. You found out you had a
 * message by opening Messages and looking.
 *
 * Derived, not queued, and deliberately. The Notification collection is a
 * DELIVERY queue — `to`, `channel`, attempts, backoff — so a row added there
 * is an email or an SMS actually going out, one per message, which on a
 * live thread is unbearable. The bell is already assembled client-side from
 * announcements and derived alerts; this is a third source of the same kind,
 * and it costs one request that the messages page makes anyway.
 *
 * One entry per conversation rather than per message: a thread with nine
 * unread is one thing to go and read, not nine things.
 */
async function fetchMessageNotifications(limit = 20): Promise<Notification[]> {
  try {
    const conversations = await fetchConversations();

    return conversations
      .filter((c) => (c.unread ?? 0) > 0)
      .slice(0, limit)
      .map((c) => {
        // The thread is named for whoever is on the other end of it, the
        // same convention the list itself uses; a direct thread carries no
        // title of its own.
        const who =
          c.title ||
          (c.participants ?? [])
            .map((p) => p.name)
            .filter(Boolean)
            .join(", ");

        return {
          // Stable across polls, so the panel does not treat a re-fetch as
          // a new notification each time.
          _id:       `message-${c._id}`,
          title:     who || "",
          body:      c.lastMessagePreview ?? "",
          type:      "message" as const,
          priority:  "normal" as const,
          // Unread is the whole reason it is in this list.
          isRead:    false,
          createdAt: c.lastMessageAt ?? new Date().toISOString(),
          link:      `/messages?conversation=${encodeURIComponent(String(c._id))}`,
        };
      });
  } catch (err) {
    console.warn("[Notifications] Messages fetch failed:", err);
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
  /** Optional so the service stays usable outside React. */
  t: (key: string, params?: Record<string, unknown>) => string = (k) => k,
): Promise<NotificationListResponse> {
  // Fetch all sources in parallel
  const [announcementNotifs, alertNotifs, messageNotifs] = await Promise.all([
    fetchAnnouncementNotifications(schoolId, limit),
    fetchSystemAlerts(schoolId, t),
    fetchMessageNotifications(limit),
  ]);

  // Merge: alerts first, then messages, then announcements. Messages sit
  // above announcements because one is addressed to you by a person and the
  // other is addressed to everybody; the sort below reorders by unread and
  // priority anyway, and this only settles ties.
  const allNotifications = [...alertNotifs, ...messageNotifs, ...announcementNotifs].sort(
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

  // Nor are message notifications, and this one is not merely a short-circuit:
  // a thread stops being unread when somebody opens and reads it, which is
  // what the panel's link does. Marking it read from the bell would clear the
  // badge on a message nobody has looked at. Without this guard the id would
  // be posted to /announcements/message-<id>/read, which is a 404.
  if (notificationId.startsWith("message-")) return true;

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