// web/src/components/layout/NotificationPanel.tsx
import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate }                              from "react-router-dom";
import {
  Bell, X, CheckCheck,
  AlertTriangle, Megaphone, GraduationCap,
  ClipboardCheck, Settings, Clock,
  AlertCircle, ShieldAlert,
}                                                   from "lucide-react";
import { cn }                                       from "@/utils/cn";
import { useAuthStore }                             from "@/store/auth.store";
import { useTranslation } from "react-i18next";
import {
  fetchNotifications,
  markAsRead,
  markAllAsRead,
  type Notification,
}                                                   from "@/services/notification.service";

// ─── Config ───────────────────────────────────────────────────────────────────
const POLL_INTERVAL = 60_000; // 60 seconds

const TYPE_CONFIG: Record<
  Notification["type"],
  { icon: React.ReactNode; color: string }
> = {
  announcement: {
    icon:  <Megaphone      className="w-4 h-4" />,
    color: "bg-blue-100   text-blue-600",
  },
  attendance: {
    icon:  <ClipboardCheck className="w-4 h-4" />,
    color: "bg-green-100  text-green-600",
  },
  grade: {
    icon:  <GraduationCap  className="w-4 h-4" />,
    color: "bg-purple-100 text-purple-600",
  },
  system: {
    icon:  <Settings       className="w-4 h-4" />,
    color: "bg-gray-100   text-gray-600",
  },
  alert: {
    icon:  <ShieldAlert    className="w-4 h-4" />,
    color: "bg-red-100    text-red-600",
  },
  general: {
    icon:  <Bell           className="w-4 h-4" />,
    color: "bg-orange-100 text-orange-600",
  },
};

const PRIORITY_CONFIG: Record<
  Notification["priority"],
  { dot: string; border: string }
> = {
  low:    { dot: "bg-gray-400",   border: "" },
  normal: { dot: "bg-blue-400",   border: "" },
  high:   { dot: "bg-orange-400", border: "border-l-2 border-l-orange-400" },
  urgent: { dot: "bg-red-500",    border: "border-l-2 border-l-red-500" },
};

// ─── Time ago helper ──────────────────────────────────────────────────────────
function timeAgo(dateStr: string): string {
  if (!dateStr) return "";

  const now     = Date.now();
  const then    = new Date(dateStr).getTime();
  const diff    = Math.max(0, now - then);
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours   = Math.floor(minutes / 60);
  const days    = Math.floor(hours / 24);
  const weeks   = Math.floor(days / 7);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours   < 24) return `${hours}h ago`;
  if (days    < 7)  return `${days}d ago`;
  if (weeks   < 4)  return `${weeks}w ago`;

  return new Date(dateStr).toLocaleDateString();
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function NotificationPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const schoolId = useAuthStore((s) => s.user?.schoolId ?? "");

  const [isOpen,        setIsOpen]        = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount,   setUnreadCount]   = useState(0);
  const [isLoading,     setIsLoading]     = useState(false);
  const [filter,        setFilter]        = useState<"all" | "unread" | "alerts">("all");

  const panelRef = useRef<HTMLDivElement>(null);

  // ── Close on outside click ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
        if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Load notifications ──────────────────────────────────────────────────────
  const loadNotifications = useCallback(async () => {
    if (!schoolId) return;
    setIsLoading(true);
    try {
      const data = await fetchNotifications(schoolId);
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch (err) {
      console.warn("[NotificationPanel] Load failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [schoolId]);

  // ── Initial load + polling ──────────────────────────────────────────────────
  useEffect(() => {
    loadNotifications();
    const interval = setInterval(loadNotifications, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [loadNotifications]);

  // ── Reload when panel opens ─────────────────────────────────────────────────
  useEffect(() => {
    if (isOpen) loadNotifications();
  }, [isOpen, loadNotifications]);

  // ── Mark single as read ─────────────────────────────────────────────────────
  const handleRead = async (notification: Notification) => {
    if (!notification.isRead) {
      // Only touch local state when the server actually recorded the receipt.
      // Updating optimistically on failure made the badge clear and then snap
      // back on the next reload / poll.
      const ok = await markAsRead(notification._id);
      if (ok) {
        setNotifications((prev) =>
          prev.map((n) =>
            n._id === notification._id ? { ...n, isRead: true } : n
          )
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      }
    }

    if (notification.link) {
      navigate(notification.link);
      setIsOpen(false);
    }
  };

  // ── Mark all as read ────────────────────────────────────────────────────────
  const handleReadAll = async () => {
    const marked = await markAllAsRead(schoolId);
    // -1 = the request failed. Keep the current state so the badge doesn't
    // falsely clear and then reappear on reload.
    if (marked < 0) return;

    setNotifications((prev) =>
      prev.map((n) => ({ ...n, isRead: true }))
    );
    setUnreadCount(0);
  };

  // ── Filtered list ───────────────────────────────────────────────────────────
  const alertCount = notifications.filter((n) => n.type === "alert").length;

  const filtered = (() => {
    switch (filter) {
      case "unread": return notifications.filter((n) => !n.isRead);
      case "alerts": return notifications.filter((n) => n.type === "alert");
      default:       return notifications;
    }
  })();

  return (
    <div className="relative" ref={panelRef}>

      {/* ── Bell Button ────────────────────────────────────────────────────── */}
      <button
        onClick={() => setIsOpen((o) => !o)}
        className={cn(
          "relative p-2 rounded-lg transition-colors",
          isOpen
            ? "bg-primary-50 text-primary-600"
            : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"
        )}
      >
        <Bell className="w-5 h-5" />

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4.5 h-4.5 px-1 flex items-center justify-center bg-red-500 text-white text-[10px] font-bold rounded-full ring-2 ring-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* ── Dropdown Panel ─────────────────────────────────────────────────── */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-96 bg-white rounded-xl shadow-xl border border-gray-200 z-50 overflow-hidden">

          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-800">
                {t("notifications.title")}
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">
                {unreadCount > 0
                  ? `${unreadCount} unread`
                  : "All caught up!"}
                {alertCount > 0 && (
                  <span className="text-red-500 ml-1">
                    · {alertCount} alert{alertCount > 1 ? "s" : ""}
                  </span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={handleReadAll}
                  className="text-xs text-primary-600 hover:text-primary-700 font-medium flex items-center gap-1"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  {t("notifications.readAll")}
                </button>
              )}
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Filter tabs */}
          <div className="px-4 py-2 border-b border-gray-100 flex gap-2">
            {([
              { key: "all"    as const, label: "All"    },
              { key: "unread" as const, label: "Unread" },
              { key: "alerts" as const, label: "Alerts" },
            ]).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-full transition-colors",
                  filter === key
                    ? "bg-primary-100 text-primary-700"
                    : "text-gray-500 hover:bg-gray-100"
                )}
              >
                {label}
                {key === "unread" && unreadCount > 0 && (
                  <span className="ml-1 text-primary-500">({unreadCount})</span>
                )}
                {key === "alerts" && alertCount > 0 && (
                  <span className="ml-1 text-red-500">({alertCount})</span>
                )}
              </button>
            ))}
          </div>

          {/* List */}
          <div className="max-h-96 overflow-y-auto">

            {/* Loading */}
            {isLoading && notifications.length === 0 && (
              <div className="py-8 text-center">
                <div className="w-5 h-5 border-2 border-primary-400 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <p className="text-sm text-gray-400">Loading…</p>
              </div>
            )}

            {/* Empty state */}
            {!isLoading && filtered.length === 0 && (
              <div className="py-10 text-center">
                {filter === "alerts" ? (
                  <>
                    <AlertCircle className="w-10 h-10 text-green-200 mx-auto mb-3" />
                    <p className="text-sm font-medium text-gray-500">
                      {t("notifications.noAlerts")}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      {t("notifications.smooth")}
                    </p>
                  </>
                ) : filter === "unread" ? (
                  <>
                    <Bell className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                    <p className="text-sm font-medium text-gray-500">
                      {t("notifications.allRead")}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      {t("notifications.allReadHint")}
                    </p>
                  </>
                ) : (
                  <>
                    <Bell className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                    <p className="text-sm font-medium text-gray-500">
                      {t("notifications.none")}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      {t("notifications.noneHint")}
                    </p>
                  </>
                )}
              </div>
            )}

            {/* Notification items */}
            {filtered.map((n) => {
              const typeConf     = TYPE_CONFIG[n.type]         ?? TYPE_CONFIG.general;
              const priorityConf = PRIORITY_CONFIG[n.priority] ?? PRIORITY_CONFIG.normal;

              return (
                <button
                  key={n._id}
                  onClick={() => handleRead(n)}
                  className={cn(
                    "w-full text-left px-4 py-3 flex items-start gap-3 transition-colors border-b border-gray-50 last:border-0",
                    !n.isRead
                      ? "bg-blue-50/40 hover:bg-blue-50/70"
                      : "hover:bg-gray-50",
                    priorityConf.border
                  )}
                >
                  {/* Type icon */}
                  <div
                    className={cn(
                      "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
                      typeConf.color
                    )}
                  >
                    {typeConf.icon}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className={cn(
                          "text-sm truncate",
                          !n.isRead
                            ? "font-semibold text-gray-800"
                            : "font-medium text-gray-600"
                        )}
                      >
                        {n.title}
                      </p>

                      {/* Unread dot */}
                      {!n.isRead && (
                        <span
                          className={cn(
                            "w-2 h-2 rounded-full shrink-0 mt-1.5",
                            n.type === "alert"
                              ? priorityConf.dot
                              : "bg-primary-500"
                          )}
                        />
                      )}
                    </div>

                    {/* Body preview */}
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                      {n.body}
                    </p>

                    {/* Footer */}
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className="text-xs text-gray-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {timeAgo(n.createdAt)}
                      </span>

                      {n.type === "alert" && (
                        <span className="text-xs bg-red-50 text-red-600 px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5">
                          <ShieldAlert className="w-3 h-3" />
                          {t("notifications.alert")}
                        </span>
                      )}

                      {n.priority === "urgent" && n.type !== "alert" && (
                        <span className="text-xs text-red-600 bg-red-50 px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5">
                          <AlertTriangle className="w-3 h-3" />
                          {t("notifications.urgent")}
                        </span>
                      )}

                      {n.priority === "high" && n.type !== "alert" && (
                        <span className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded font-medium">
                          {t("notifications.high")}
                        </span>
                      )}

                      {n.authorName && (
                        <span className="text-xs text-gray-400">
                          by {n.authorName}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50">
              <button
                onClick={() => {
                  navigate("/announcements");
                  setIsOpen(false);
                }}
                className="w-full text-center text-xs font-medium text-primary-600 hover:text-primary-700 transition-colors"
              >
                View all notifications →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}