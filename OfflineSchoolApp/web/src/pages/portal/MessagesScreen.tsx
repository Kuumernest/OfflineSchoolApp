// web/src/pages/portal/MessagesScreen.tsx
//
// Messages: the family's conversations, the school's notices about each
// child, and the school's news, one tab each with its unread count. For the
// whole family rather than one child: a notice says which child it is about.
//
// Conversations are the one thing a guardian can write. Who they may reach is
// decided entirely by the server's communication policy, so nothing here
// filters the list it is handed.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft, Send, Loader2, MessageSquare, Bell, Megaphone, PenSquare, CheckCheck,
  LogIn, LogOut, AlertCircle, Wallet2, Receipt, GraduationCap,
} from "lucide-react";

import { useFormat } from "@/i18n/format";
import { cn } from "@/utils/cn";
import {
  fetchNotifications, fetchAnnouncements, markNoticeRead, markAllNoticesRead,
  fetchPortalConversations, fetchPortalRecipients, openPortalConversation,
  fetchPortalThread, sendPortalMessage, markPortalRead,
  type PortalNotification, type PortalMessage, type PortalRecipient, type PortalStudent,
} from "@/services/portal.service";
import { PortalCard, Skeleton, EmptyState, ChildAvatar } from "./ui";

export type MsgView = "messages" | "notices" | "news";

/**
 * One row per notification kind the portal may show, keyed on the kind the
 * server sends, so a kind added server-side falls back rather than being
 * mislabelled. The same keys and wording as the phone's NOTICE_META.
 */
const NOTICE_META: Record<string, { icon: React.ReactNode; tone: string; labelKey: string }> = {
  "gate.arrival":      { icon: <LogIn className="h-4 w-4" />,         tone: "bg-success-soft text-success",   labelKey: "portal.noticeArrival" },
  "gate.departure":    { icon: <LogOut className="h-4 w-4" />,        tone: "bg-primary-50 text-primary-700", labelKey: "portal.noticeDeparture" },
  "attendance.absent": { icon: <AlertCircle className="h-4 w-4" />,   tone: "bg-danger-soft text-danger",     labelKey: "portal.noticeAbsent" },
  "fee.reminder":      { icon: <Wallet2 className="h-4 w-4" />,       tone: "bg-warning-soft text-warning",   labelKey: "portal.noticeFeeReminder" },
  "fee.payment":       { icon: <Receipt className="h-4 w-4" />,       tone: "bg-success-soft text-success",   labelKey: "portal.noticePayment" },
  "result.published":  { icon: <GraduationCap className="h-4 w-4" />, tone: "bg-primary-50 text-primary-700", labelKey: "portal.noticeResults" },
  "announcement":      { icon: <Megaphone className="h-4 w-4" />,     tone: "bg-primary-50 text-primary-700", labelKey: "portal.noticeAnnouncement" },
  // Derived by the server from unread threads, not a row in the queue.
  "message":           { icon: <MessageSquare className="h-4 w-4" />, tone: "bg-primary-50 text-primary-700", labelKey: "portal.noticeMessage" },
  default:             { icon: <Bell className="h-4 w-4" />,          tone: "bg-canvas text-ink-muted",       labelKey: "portal.noticeOther" },
};

export function MessagesScreen({ view, onView, children, unreadMessages, unreadNotices }: {
  view: MsgView; onView: (v: MsgView) => void; children: PortalStudent[];
  unreadMessages: number; unreadNotices: number;
}) {
  const { t } = useTranslation();
  const tabs: [MsgView, string, number][] = [
    ["messages", t("portal.messagesScreen.tabMessages"), unreadMessages],
    ["notices", t("portal.messagesScreen.tabNotices"), unreadNotices],
    ["news", t("portal.messagesScreen.tabNews"), 0],
  ];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-ink">{t("portal.messages")}</h1>
      <div role="tablist" aria-label={t("portal.messages")} className="grid grid-cols-3 gap-1 rounded-card border border-line bg-surface p-1">
        {tabs.map(([key, label, n]) => (
          <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => onView(key)}
            className={cn("flex min-h-11 items-center justify-center gap-1.5 rounded-control px-1 text-sm font-medium transition-colors",
              view === key ? "bg-primary-600 text-white" : "text-ink-body hover:bg-canvas")}>
            <span className="truncate">{label}</span>
            {n > 0 && (
              <span aria-label={t("portal.unreadCount", { count: n })}
                className={cn("min-w-5 rounded-full px-1.5 text-xs font-bold leading-5", view === key ? "bg-white/25 text-white" : "bg-danger text-white")}>
                {n > 9 ? "9+" : n}
              </span>
            )}
          </button>
        ))}
      </div>
      {view === "messages" && <Conversations />}
      {view === "notices" && <Notices family={children} onOpenThread={() => onView("messages")} />}
      {view === "news" && <News family={children} />}
    </div>
  );
}

const nameOf = (family: PortalStudent[], id?: string | null) =>
  id ? family.find((c) => String(c._id) === String(id))?.name ?? null : null;

function ListSkeleton() {
  return (
    <PortalCard className="divide-y divide-line">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3 p-4"><Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-2"><Skeleton className="h-3 w-24" /><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-full" /></div>
        </div>
      ))}
    </PortalCard>
  );
}

// ── Notices ────────────────────────────────────────────────────────────────
function Notices({ family, onOpenThread }: { family: PortalStudent[]; onOpenThread: () => void }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["portal", "notifications"], queryFn: () => fetchNotifications(), refetchInterval: 25_000, retry: false });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["portal", "notifications"] });
    void qc.invalidateQueries({ queryKey: ["portal", "me"] });
  };

  const open = async (n: PortalNotification) => {
    if (n.conversationId) { onOpenThread(); return; }
    if (!n.read) { await markNoticeRead(n._id).catch(() => null); refresh(); }
  };
  const unread = (q.data ?? []).filter((n) => !n.conversationId && !n.read).length;

  if (q.isLoading) return <ListSkeleton />;
  if (!q.data?.length) return <PortalCard><EmptyState icon={<Bell className="h-6 w-6" />} title={t("portal.noNotices")} hint={t("portal.messagesScreen.noNoticesHint")} /></PortalCard>;

  return (
    <div className="space-y-3">
      {unread > 0 && (
        <div className="flex justify-end">
          <button type="button" onClick={async () => { await markAllNoticesRead().catch(() => null); refresh(); }}
            className="flex min-h-11 items-center gap-1.5 rounded-control px-3 text-sm font-medium text-primary-700 hover:bg-primary-50">
            <CheckCheck className="h-4 w-4" aria-hidden="true" />{t("portal.messagesScreen.markAllRead")}
          </button>
        </div>
      )}
      <PortalCard className="overflow-hidden">
        <ul>
          {q.data.map((n) => {
            const meta = NOTICE_META[n.kind] ?? NOTICE_META.default;
            const isNew = n.conversationId ? (n.unread ?? 0) > 0 : !n.read;
            const child = nameOf(family, n.studentId);
            return (
              <li key={n._id} className="border-t border-line first:border-t-0">
                <button type="button" onClick={() => open(n)}
                  className={cn("flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-muted", isNew && "bg-primary-50/40")}>
                  <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full", meta.tone)} aria-hidden="true">{meta.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-ink-muted">{t(meta.labelKey)}</span>
                      {isNew && <span className="rounded-full bg-primary-600 px-1.5 text-[10px] font-bold uppercase leading-4 text-white">{n.unread && n.unread > 1 ? n.unread : t("portal.messagesScreen.new")}</span>}
                      <span className="ml-auto shrink-0 text-xs text-ink-faint">{fmt.date(n.sentAt ?? n.createdAt)}</span>
                    </span>
                    {n.subject && <span className={cn("mt-0.5 block text-sm text-ink", isNew ? "font-semibold" : "font-medium")}>{n.subject}</span>}
                    {/* `body` is the plain-text rendering; the channel's HTML is not put on screen. */}
                    {n.body && <span className="mt-0.5 line-clamp-3 block text-sm text-ink-body">{n.body}</span>}
                    {child && <span className="mt-1 block text-xs text-ink-muted">{t("portal.messagesScreen.about", { names: child })}</span>}
                    {/* Only while the school is still trying, or has failed. */}
                    {(n.status === "pending" || n.status === "failed") && (
                      <span className={cn("mt-1 inline-block rounded-full px-2 text-xs", n.status === "failed" ? "bg-danger-soft text-danger" : "bg-canvas text-ink-muted")}>
                        {t(`portal.noticeStatus_${n.status}`)}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </PortalCard>
    </div>
  );
}

// ── News ───────────────────────────────────────────────────────────────────
function News({ family }: { family: PortalStudent[] }) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const q = useQuery({ queryKey: ["portal", "news"], queryFn: () => fetchAnnouncements(), retry: false });
  if (q.isLoading) return <ListSkeleton />;
  if (!q.data?.length) return <PortalCard><EmptyState icon={<Megaphone className="h-6 w-6" />} title={t("portal.noNews")} hint={t("portal.messagesScreen.noNewsHint")} /></PortalCard>;
  return (
    <div className="space-y-3">
      {q.data.map((a) => {
        // Which of the children it names, when it names any.
        const about = (a.forStudents ?? []).map((id) => nameOf(family, id)).filter(Boolean);
        return (
          <PortalCard key={a._id} as="article" className="p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-600" aria-hidden="true"><Megaphone className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold text-ink">{a.title ?? "—"}</h2>
                <p className="text-xs text-ink-faint">{fmt.date(a.createdAt)}{about.length ? ` · ${t("portal.messagesScreen.about", { names: about.join(", ") })}` : ""}</p>
                {a.body && <p className="mt-2 whitespace-pre-line text-sm text-ink-body">{a.body}</p>}
              </div>
            </div>
          </PortalCard>
        );
      })}
    </div>
  );
}

// ── Conversations ──────────────────────────────────────────────────────────
function BackBar({ title, onBack }: { title: string; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 border-b border-line px-2 py-2">
      <button type="button" onClick={onBack} aria-label={t("portal.messagesScreen.back")}
        className="flex h-11 w-11 items-center justify-center rounded-control text-ink-muted hover:bg-canvas hover:text-ink">
        <ArrowLeft className="h-5 w-5" aria-hidden="true" />
      </button>
      <p className="min-w-0 flex-1 truncate font-semibold text-ink">{title}</p>
    </div>
  );
}

function Conversations() {
  const { t } = useTranslation();
  const fmt = useFormat();
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const listQ = useQuery({ queryKey: ["portal-conversations"], queryFn: fetchPortalConversations, refetchInterval: 25_000 });
  const threadQ = useQuery({ queryKey: ["portal-thread", openId], queryFn: () => fetchPortalThread(openId as string), enabled: Boolean(openId), refetchInterval: 15_000 });
  const peopleQ = useQuery({ queryKey: ["portal-recipients"], queryFn: () => fetchPortalRecipients(""), enabled: picking });

  const messages: PortalMessage[] = [...(threadQ.data?.messages ?? [])].sort((a, b) => a.seq - b.seq);

  // Advance the read marker as the thread is shown.
  useEffect(() => {
    if (!openId || messages.length === 0) return;
    markPortalRead(openId, messages[messages.length - 1].seq)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["portal-conversations"] });
        void qc.invalidateQueries({ queryKey: ["portal", "me"] });
      })
      .catch(() => { /* a receipt failing is not worth telling a parent about */ });
  }, [openId, messages, qc]);

  const failure = (e: unknown) =>
    (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? (e as Error).message;

  const send = async () => {
    const body = draft.trim();
    if (!body || !openId || busy) return;
    setBusy(true); setErr(null);
    try {
      await sendPortalMessage(openId, body);
      setDraft("");
      void qc.invalidateQueries({ queryKey: ["portal-thread", openId] });
      void qc.invalidateQueries({ queryKey: ["portal-conversations"] });
    } catch (e) { setErr(failure(e)); } finally { setBusy(false); }
  };

  const start = async (r: PortalRecipient) => {
    setBusy(true); setErr(null);
    try {
      const c = await openPortalConversation(r.id, r.kind);
      setPicking(false); setOpenId(c._id);
      void qc.invalidateQueries({ queryKey: ["portal-conversations"] });
    } catch (e) { setErr(failure(e)); } finally { setBusy(false); }
  };

  // ── One thread ──
  if (openId) {
    const title = threadQ.data?.conversation?.title
      ?? threadQ.data?.conversation?.participants?.filter((p) => p.kind !== "guardian").map((p) => p.name).filter(Boolean).join(", ")
      ?? t("portal.messages");
    return (
      <PortalCard className="overflow-hidden">
        <BackBar title={title} onBack={() => { setOpenId(null); setErr(null); }} />
        <div className="max-h-[55vh] space-y-2 overflow-y-auto bg-canvas/60 px-3 py-4" aria-live="polite">
          {threadQ.isLoading && <Skeleton className="h-12 w-2/3" />}
          {messages.map((m) => {
            const mine = m.sender?.kind === "guardian";
            return (
              <div key={m._id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[85%] rounded-card px-3 py-2 shadow-card",
                  mine ? "rounded-br-sm bg-primary-600 text-white" : "rounded-bl-sm border border-line bg-surface text-ink-body")}>
                  {!mine && <p className="text-xs font-semibold text-primary-700">{m.sender?.name ?? "—"}</p>}
                  <p className="whitespace-pre-line text-sm">{m.isDeleted ? t("portal.messageDeleted") : m.body}</p>
                  {(m.attachments?.length ?? 0) > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {m.attachments!.map((a) => (
                        <li key={a.url}><a href={a.url} target="_blank" rel="noreferrer" className="text-xs underline">{a.name ?? a.url.split("/").pop()}</a></li>
                      ))}
                    </ul>
                  )}
                  <p className={cn("mt-0.5 text-right text-[10px]", mine ? "text-white/75" : "text-ink-faint")}>{fmt.dateTime(m.createdAt)}</p>
                </div>
              </div>
            );
          })}
          {!threadQ.isLoading && messages.length === 0 && <p className="py-6 text-center text-sm text-ink-muted">{t("portal.noMessages")}</p>}
        </div>
        {err && <p role="alert" className="px-4 pt-2 text-xs text-danger">{err}</p>}
        <div className="flex items-end gap-2 border-t border-line p-3">
          <label className="sr-only" htmlFor="portal-draft">{t("portal.writeMessage")}</label>
          <textarea id="portal-draft" value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            rows={1} placeholder={t("portal.writeMessage")}
            className="min-h-11 flex-1 resize-none rounded-control border border-line-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary-600" />
          <button type="button" onClick={() => void send()} disabled={!draft.trim() || busy} aria-label={t("portal.messagesScreen.send")}
            className="flex h-11 w-11 items-center justify-center rounded-control bg-primary-600 text-white disabled:opacity-50">
            {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Send className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </PortalCard>
    );
  }

  // ── Picking somebody to write to ──
  if (picking) {
    return (
      <PortalCard className="overflow-hidden">
        <BackBar title={t("portal.chooseRecipient")} onBack={() => setPicking(false)} />
        {err && <p role="alert" className="px-4 pt-2 text-xs text-danger">{err}</p>}
        {peopleQ.isLoading ? <div className="p-4"><Skeleton className="h-10 w-full" /></div>
          : (peopleQ.data?.length ?? 0) === 0 ? <EmptyState icon={<MessageSquare className="h-6 w-6" />} title={t("portal.noRecipients")} />
          : (
            <ul>
              {peopleQ.data!.map((r, i) => (
                <li key={`${r.kind}:${r.id}`} className="border-t border-line first:border-t-0">
                  <button type="button" onClick={() => start(r)} disabled={busy}
                    className="flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-muted disabled:opacity-50">
                    <ChildAvatar name={r.name} index={i} size="sm" />
                    <span className="min-w-0"><span className="block font-medium text-ink">{r.name}</span>
                      {r.subtitle && <span className="block truncate text-xs text-ink-muted">{r.subtitle}</span>}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </PortalCard>
    );
  }

  // ── The list ──
  const rows = listQ.data ?? [];
  return (
    <div className="space-y-3">
      <button type="button" onClick={() => { setPicking(true); setErr(null); }}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-control bg-primary-600 text-sm font-semibold text-white hover:bg-primary-700">
        <PenSquare className="h-4 w-4" aria-hidden="true" />{t("portal.newMessage")}
      </button>
      {listQ.isLoading ? <ListSkeleton /> : rows.length === 0 ? (
        <PortalCard><EmptyState icon={<MessageSquare className="h-6 w-6" />} title={t("portal.noConversations")} hint={t("portal.messagesScreen.noConversationsHint")} /></PortalCard>
      ) : (
        <PortalCard className="overflow-hidden">
          <ul>
            {rows.map((c, i) => {
              const title = c.title ?? c.participants?.filter((p) => p.kind !== "guardian").map((p) => p.name).filter(Boolean).join(", ") ?? "—";
              const n = c.unread ?? 0;
              return (
                <li key={c._id} className="border-t border-line first:border-t-0">
                  <button type="button" onClick={() => setOpenId(c._id)} className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-muted">
                    <ChildAvatar name={title} index={i} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={cn("truncate text-sm text-ink", n ? "font-semibold" : "font-medium")}>{title}</span>
                        {c.lastMessageAt && <span className="ml-auto shrink-0 text-xs text-ink-faint">{fmt.date(c.lastMessageAt)}</span>}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span className={cn("truncate text-sm", n ? "text-ink" : "text-ink-muted")}>{c.lastMessagePreview ?? "—"}</span>
                        {n > 0 && <span aria-label={t("portal.unreadCount", { count: n })} className="ml-auto min-w-5 shrink-0 rounded-full bg-primary-600 px-1.5 text-center text-xs font-bold leading-5 text-white">{n}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </PortalCard>
      )}
    </div>
  );
}
