// web/src/pages/portal/index.tsx
//
// The guardian portal.
//
// Deliberately outside the admin shell: no sidebar, no staff navigation, and
// its own token. A parent should not land in a console that shows them controls
// they cannot use, and the page they see should make it obvious this is theirs
// rather than the school's back office.
//
// Fees, results, attendance and news are read-only. Messages are not: they
// are the one thing a guardian can write, and the only write endpoint the
// portal API exposes. Who they may write to is decided entirely by the
// server's communication policy — teachers, the office, and their own child —
// so nothing here filters the list it is handed.

import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Printer, LogOut, Wallet, GraduationCap, CalendarCheck, Megaphone,
  MessageSquare, Send, Loader2, ArrowLeft, Clock, BookOpen,
  Bell, LogIn, AlertCircle, Receipt, Wallet2, Home,
} from "lucide-react";

import { Card }        from "@/components/ui/Card";
import { Button }      from "@/components/ui/Button";
import { Badge }       from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { FormField, Input } from "@/components/ui/FormField";
import { LanguageSwitcher } from "@/components/ui/LanguageSwitcher";
import { useFormat }   from "@/i18n/format";
import { cn }          from "@/utils/cn";
import { printHtml }   from "@/print/document";
import { resolveLogoSrc } from "@/utils/logoSrc";
import { HomeScreen, type PortalScreen } from "./HomeScreen";
import { ResultsScreen } from "./ResultsScreen";
import { ChildAvatar, LanguageToggle, Skeleton } from "./ui";
import {
  portalLogin, portalLogout, hasPortalSession, setPortalSession,
  fetchMe, fetchFees, fetchAttendance, fetchAnnouncements,
  fetchFeeReminders, fetchNotifications,
  fetchReceiptHtml,
  fetchPortalConversations, fetchPortalRecipients, openPortalConversation,
  fetchPortalThread, sendPortalMessage, markPortalRead,
  type PortalConversation, type PortalMessage, type PortalRecipient,
} from "@/services/portal.service";

/** Inside Messages: the conversations, the school's notices about a child, the news. */
type MsgView = "messages" | "notices" | "news";

/**
 * One row per notification kind the portal is allowed to show.
 *
 * Keyed on the kind the server sends, so a kind added server-side and not
 * listed here falls back rather than being mislabelled — which is what the
 * card this replaced did: it chose between two fee wordings with a ternary, so
 * anything that was not a fee reminder was announced as a payment
 * confirmation.
 *
 * The same keys as the phone's NOTICE_META, and the same wording, because the
 * two catalogues are kept in step deliberately.
 */
const NOTICE_META: Record<
  string,
  { icon: React.ReactNode; tone: string; labelKey: string }
> = {
  "gate.arrival":      { icon: <LogIn className="h-3.5 w-3.5" />,        tone: "bg-success-50 text-success-700",  labelKey: "portal.noticeArrival" },
  "gate.departure":    { icon: <LogOut className="h-3.5 w-3.5" />,       tone: "bg-primary-50 text-primary-700",  labelKey: "portal.noticeDeparture" },
  "attendance.absent": { icon: <AlertCircle className="h-3.5 w-3.5" />,  tone: "bg-danger-50 text-danger-700",    labelKey: "portal.noticeAbsent" },
  "fee.reminder":      { icon: <Wallet2 className="h-3.5 w-3.5" />,      tone: "bg-warning-50 text-warning-700",  labelKey: "portal.noticeFeeReminder" },
  "fee.payment":       { icon: <Receipt className="h-3.5 w-3.5" />,      tone: "bg-success-50 text-success-700",  labelKey: "portal.noticePayment" },
  "result.published":  { icon: <GraduationCap className="h-3.5 w-3.5" />,tone: "bg-primary-50 text-primary-700",  labelKey: "portal.noticeResults" },
  "announcement":      { icon: <Megaphone className="h-3.5 w-3.5" />,    tone: "bg-primary-50 text-primary-700",  labelKey: "portal.noticeAnnouncement" },
  // Not a row in the notification queue — derived by the server from the
  // threads it already stores. See the /notifications route.
  "message":           { icon: <MessageSquare className="h-3.5 w-3.5" />,tone: "bg-primary-50 text-primary-700",  labelKey: "portal.noticeMessage" },
  default:             { icon: <Bell className="h-3.5 w-3.5" />,         tone: "bg-canvas text-ink-muted",        labelKey: "portal.noticeOther" },
};

export default function ParentPortalPage() {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const qc  = useQueryClient();

  // A session, not an access token: the client renews the latter on its own.
  const [signedIn, setSignedIn] = useState(hasPortalSession());
  const [screen, setScreen]     = useState<PortalScreen>("home");
  const [msgView, setMsgView]   = useState<MsgView>("messages");
  // Null means "whichever the server picks first" — what a one-child parent
  // gets, and never has to think about.
  const [childId, setChildId]   = useState<string | null>(null);

  const [admissionNo, setAdmissionNo] = useState("");
  const [code, setCode]               = useState("");
  const [error, setError]             = useState<string | null>(null);
  const [busy, setBusy]               = useState(false);
  const [printing, setPrinting]       = useState<string | null>(null);

  const signOut = () => {
    void portalLogout();
    setSignedIn(false);
    setChildId(null);
    qc.clear();
  };

  const meQ = useQuery({
    queryKey: ["portal", "me", childId],
    queryFn:  () => fetchMe(childId),
    enabled:  signedIn,
    retry:    false,
  });

  // The child is part of every query key. Keyed only by section, switching
  // child with a warm cache would show the eldest's figures under the
  // youngest's name until the refetch landed.
  const selected = childId ?? meQ.data?.selectedId ?? null;

  // Across every thread, from the one query that runs on every tab.
  const unreadMessages = meQ.data?.unreadMessages ?? 0;

  const feesQ = useQuery({
    queryKey: ["portal", "fees", selected], queryFn: () => fetchFees(selected),
    enabled: signedIn && screen === "fees", retry: false,
  });
  const attendanceQ = useQuery({
    queryKey: ["portal", "attendance", selected], queryFn: () => fetchAttendance(selected),
    enabled: signedIn && screen === "attendance", retry: false,
  });
  const newsQ = useQuery({
    queryKey: ["portal", "news", selected], queryFn: () => fetchAnnouncements(selected),
    enabled: signedIn && screen === "messages" && msgView === "news", retry: false,
  });

  const feeRemindersQ = useQuery({
    queryKey: ["portal", "fee-reminders", selected],
    queryFn:  () => fetchFeeReminders(selected),
    enabled:  signedIn && screen === "fees",
    retry:    false,
  });

  // Notices had no tab. They were a card at the bottom of Fees, fetched only
  // while that tab was open, so a gate arrival or an absence had nowhere to
  // appear at all — and the card titled every row with a two-way ternary
  // between "Fee Reminder" and "Payment Confirmation", which would have
  // labelled a child's arrival at school a payment confirmation.
  const notificationsQ = useQuery({
    queryKey: ["portal", "notifications", selected],
    queryFn:  () => fetchNotifications(selected),
    enabled:  signedIn && screen === "messages" && msgView === "notices",
    // A message arriving is the thing a parent most wants to know about and
    // the list is derived server-side from stored threads, so it is cheap to
    // ask again. Matches the conversation list's own interval.
    refetchInterval: 25_000,
    retry:    false,
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setPortalSession(await portalLogin(admissionNo.trim(), code.trim()));
      setSignedIn(true);
      setChildId(null);
      setCode("");
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      setError(status === 429 ? t("portal.locked") : t("portal.signInFailed"));
    } finally {
      setBusy(false);
    }
  };

  const printReceipt = async (paymentId: string) => {
    setPrinting(paymentId);
    try {
      const html = await fetchReceiptHtml(paymentId, i18n.resolvedLanguage ?? "en");
      printHtml(html);
    } finally {
      setPrinting(null);
    }
  };

  // ── Sign in ────────────────────────────────────────────────────────────────
  if (!signedIn) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-4 flex justify-end"><LanguageSwitcher /></div>

          <Card className="space-y-5">
            <div>
              <h1 className="font-display text-xl text-ink">{t("portal.title")}</h1>
              <p className="mt-1 text-sm text-ink-muted">{t("portal.intro")}</p>
            </div>

            <form className="space-y-4" onSubmit={submit}>
              <FormField label={t("portal.admissionNo")} hint={t("portal.admissionHint")} required>
                <Input
                  value={admissionNo}
                  onChange={(e) => setAdmissionNo(e.target.value)}
                  autoComplete="username"
                  autoFocus
                />
              </FormField>

              <FormField label={t("portal.code")} hint={t("portal.codeHint")} required>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  // Not type="password": the parent is reading this off a slip
                  // of paper, and hiding it only causes typos.
                  autoComplete="one-time-code"
                  spellCheck={false}
                  className="font-mono tracking-wider uppercase"
                />
              </FormField>

              {error && (
                <p className="rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">
                  {error}
                </p>
              )}

              <Button
                type="submit"
                className="w-full"
                loading={busy}
                disabled={!admissionNo.trim() || !code.trim()}
              >
                {t("portal.signIn")}
              </Button>
            </form>

            <p className="border-t border-line pt-4 text-xs text-ink-muted">
              {t("portal.noAccount")}
            </p>
          </Card>
        </div>
      </div>
    );
  }

  // React Query v5 removed `onError` from useQuery — passing it is accepted and
  // silently does nothing, so a revoked code cannot be handled there. It is
  // handled here instead, by rendering rather than by clearing state during a
  // render: a side effect in the render path is exactly the bug that produces
  // "cannot update state while rendering another component".
  if (meQ.isError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
        <Card className="max-w-sm space-y-3 text-center">
          <p className="text-sm text-ink-body">{t("portal.sessionExpired")}</p>
          <Button className="w-full" onClick={signOut}>{t("portal.signIn")}</Button>
        </Card>
      </div>
    );
  }

  if (meQ.isLoading) return <ShellSkeleton />;

  const school   = meQ.data?.school;
  const student  = meQ.data?.student;
  const fees     = feesQ.data;
  const logo     = resolveLogoSrc(school?.logo);
  const children = meQ.data?.children ?? [];
  const unreadNotices = meQ.data?.unreadNotices ?? 0;

  const NAV: { key: PortalScreen; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: "home",       label: t("portal.nav.home"),       icon: <Home className="h-5 w-5" /> },
    { key: "results",    label: t("portal.nav.results"),    icon: <GraduationCap className="h-5 w-5" /> },
    { key: "attendance", label: t("portal.nav.attendance"), icon: <CalendarCheck className="h-5 w-5" /> },
    { key: "fees",       label: t("portal.nav.fees"),       icon: <Wallet className="h-5 w-5" /> },
    { key: "messages",   label: t("portal.nav.messages"),   icon: <MessageSquare className="h-5 w-5" />,
      badge: unreadMessages + unreadNotices },
  ];

  /** From a Home card: that child, that screen. */
  const open = (id: string, next: PortalScreen) => {
    if (id) setChildId(id);
    setScreen(next);
    window.scrollTo({ top: 0 });
  };

  const badge = (n?: number) => (n ?? 0) > 0 && (
    <span className="absolute -right-1.5 -top-1 inline-flex min-w-[1.15rem] items-center justify-center rounded-full
                     bg-danger px-1 text-[0.65rem] font-bold leading-[1.15rem] text-white"
          aria-label={t("portal.unreadCount", { count: n })}>
      {(n ?? 0) > 9 ? "9+" : n}
    </span>
  );

  return (
    <div className="min-h-screen bg-canvas" data-portal-root>
      {/* Header: the school, the language, the way out. Sticky on a phone so
          the child being looked at is never off-screen. */}
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur lg:pl-64">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
          {/* resolveLogoSrc returns null for anything it cannot resolve, so the
              guard is on the RESOLVED value — checking school.logo alone would
              still render an <img src={null}> and show a broken-image icon. */}
          {logo && (
            <img src={logo} alt="" className="h-9 w-9 rounded-control object-contain"
              onError={(e) => { e.currentTarget.style.display = "none"; }} />
          )}
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{school?.name ?? ""}</p>
          <LanguageToggle />
          <button type="button" onClick={signOut} aria-label={t("portal.signOut")} title={t("portal.signOut")}
            className="flex h-10 w-10 items-center justify-center rounded-control text-ink-muted hover:bg-canvas hover:text-ink">
            <LogOut className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Child switcher — only when there is a choice, and not on Home,
            which shows every child at once. A parent with one child is not
            shown a control with one option in it. */}
        {screen !== "home" && children.length > 1 && (
          <div className="mx-auto max-w-3xl px-4 pb-2.5">
            <div role="radiogroup" aria-label={t("portal.childSwitcher")} className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5">
              {children.map((c, i) => {
                const on = selected === c._id;
                return (
                  <button key={c._id} type="button" role="radio" aria-checked={on} onClick={() => setChildId(c._id)}
                    className={cn(
                      "flex min-h-12 shrink-0 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-left transition-colors",
                      on ? "border-primary-600 bg-primary-50" : "border-line-strong bg-surface hover:bg-surface-muted",
                    )}>
                    <ChildAvatar name={c.name} index={i} size="sm" />
                    <span className="min-w-0">
                      <span className={cn("block truncate text-sm font-medium", on ? "text-primary-800" : "text-ink")}>
                        {(c.name || c.enrollmentNo || "").split(" ")[0]}
                      </span>
                      {c.className && <span className="block truncate text-[11px] text-ink-muted">{c.className}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </header>

      {/* Desktop: the sections down the side. */}
      <nav aria-label={t("portal.nav.main")} className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-line bg-surface px-3 py-5 lg:flex">
        <p className="mb-4 px-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("portal.title")}</p>
        {NAV.map((n) => (
          <button key={n.key} type="button" data-nav={n.key} aria-current={screen === n.key ? "page" : undefined}
            onClick={() => open("", n.key)}
            className={cn(
              "relative mb-1 flex min-h-11 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors",
              screen === n.key ? "bg-primary-50 text-primary-700" : "text-ink-body hover:bg-canvas",
            )}>
            <span className="relative" aria-hidden="true">{n.icon}{badge(n.badge)}</span>
            {n.label}
          </button>
        ))}
      </nav>

      <main className="mx-auto max-w-3xl space-y-4 px-4 pb-28 pt-4 lg:pb-10 lg:pl-[calc(16rem+1rem)] lg:max-w-[calc(48rem+16rem)]">
        {screen !== "home" && student && (
          <p className="text-xs text-ink-muted">
            {student.name}{student.className ? ` · ${student.className}` : ""}{student.enrollmentNo ? ` · ${student.enrollmentNo}` : ""}
          </p>
        )}
        {/* ── Fees ── */}
        {screen === "home" && <HomeScreen onOpen={open} />}

        {screen === "fees" && (
          feesQ.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> : (
            <>
              <Card>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                  {(fees?.totals.balance ?? 0) > 0 ? t("portal.balance") : t("portal.settled")}
                </p>
                <p className={cn(
                  "mt-2 font-display text-[32px] leading-none tabular",
                  (fees?.totals.balance ?? 0) > 0 ? "text-danger" : "text-success"
                )}>
                  {fmt.money(fees?.totals.balance ?? 0)}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-muted">
                  <span>{t("portal.charged")} {fmt.money(fees?.totals.charged ?? 0)}</span>
                  <span>{t("portal.paid")} {fmt.money(fees?.totals.paid ?? 0)}</span>
                </div>
              </Card>

              <Card padding={false}>
                <div className="border-b border-line px-4 py-2.5">
                  <h2 className="text-sm font-semibold text-ink">{t("fees.payments")}</h2>
                </div>
                {(fees?.payments.length ?? 0) === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-ink-muted">
                    {t("portal.noPayments")}
                  </p>
                ) : (
                  <ul className="divide-y divide-line">
                    {fees?.payments.map((p) => (
                      <li key={p._id} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">
                            {p.receiptNo ?? "—"}
                            {p.isReversal && (
                              <Badge variant="default" className="ml-2">
                                {t("portal.reversalNote")}
                              </Badge>
                            )}
                          </p>
                          <p className="text-xs text-ink-muted">{fmt.dateShort(p.receivedAt)}</p>
                        </div>
                        <span className={cn(
                          "text-sm font-semibold tabular",
                          p.amount < 0 ? "text-danger" : "text-ink"
                        )}>
                          {fmt.money(p.amount)}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Printer className="h-4 w-4" />}
                          loading={printing === p._id}
                          onClick={() => printReceipt(p._id)}
                        >
                          {t("portal.receipt")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card padding={false}>
                <div className="border-b border-line px-4 py-2.5">
                  <h2 className="text-sm font-semibold text-ink">{t("fees.charges")}</h2>
                </div>
                {(fees?.charges.length ?? 0) === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-ink-muted">
                    {t("portal.noCharges")}
                  </p>
                ) : (
                  <ul className="divide-y divide-line">
                    {fees?.charges.map((c) => (
                      <li key={c._id} className="flex items-center justify-between gap-3 px-4 py-3">
                        <span className="truncate text-sm text-ink-body">{c.label ?? c.code}</span>
                        <span className="text-sm font-medium text-ink tabular">
                          {fmt.money(c.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {/* ── Fee Reminders ── */}
              {feeRemindersQ.data && feeRemindersQ.data.reminders.length > 0 && (
                <Card padding={false}>
                  <div className="border-b border-line px-4 py-2.5">
                    <h2 className="text-sm font-semibold text-ink">
                      {t("portal.feeReminders", "Fee Reminders")}
                    </h2>
                    <p className="text-xs text-ink-muted">
                      {t("portal.feeRemindersHint", "What you owe and when it's due")}
                    </p>
                  </div>
                  <ul className="divide-y divide-line">
                    {feeRemindersQ.data.reminders.map((r) => (
                      <li key={r.chargeId} className="px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-ink truncate">
                              {r.label ?? r.code}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className={cn(
                                "text-xs",
                                r.isOverdue ? "text-danger font-medium" : "text-ink-muted",
                              )}>
                                {t("portal.dueBy", "Due by")} {fmt.dateShort(r.dueDate)}
                              </span>
                              {r.isOverdue && (
                                <Badge variant="danger">
                                  {t("portal.overdue", "Overdue")} · {r.daysOverdue}d
                                </Badge>
                              )}
                              {r.isDueSoon && !r.isOverdue && (
                                <Badge variant="warning">
                                  {t("portal.dueSoon", "Due soon")}
                                </Badge>
                              )}
                            </div>
                          </div>
                          <span className="text-sm font-semibold text-ink tabular">
                            {fmt.money(r.netAmount)}
                          </span>
                        </div>
                        {r.term && (
                          <p className="text-[11px] text-ink-faint mt-1">
                            {r.academicYear} · {r.term}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {/* Payment plan info */}
              {feeRemindersQ.data?.hasPlan && feeRemindersQ.data.plan && (
                <Card>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                    {t("portal.paymentPlan", "Payment Plan")}
                  </p>
                  {feeRemindersQ.data.plan.reason && (
                    <p className="mt-1 text-xs text-ink-muted">
                      {feeRemindersQ.data.plan.reason}
                    </p>
                  )}
                  <ul className="mt-2 space-y-1">
                    {feeRemindersQ.data.plan.instalments.map((inst) => {
                      const dueDate = new Date(inst.dueDate);
                      const isPast = dueDate < new Date();
                      return (
                        <li key={inst.seq} className="flex items-center justify-between text-xs">
                          <span className={cn(
                            isPast ? "text-ink-muted line-through" : "text-ink-body",
                          )}>
                            {t("portal.instalment", "Instalment")} {inst.seq} — {fmt.dateShort(inst.dueDate)}
                          </span>
                          <span className="font-medium text-ink tabular">
                            {fmt.money(inst.amount)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}

              {/* The notification card that used to sit here has moved to its
                  own tab. It was fetched only while Fees was open and titled
                  every row by a ternary between two fee wordings, so a gate
                  arrival would have read "Payment Confirmation". Two places
                  showing the same list, one of them wrong, is worse than one. */}
            </>
          )
        )}

        {/* ── Results ── */}
        {screen === "results" && <ResultsScreen studentId={selected} />}

        {/* ── Attendance ── */}
        {screen === "attendance" && (
          attendanceQ.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> :
          (attendanceQ.data?.total ?? 0) === 0 ? (
            <Card><p className="py-6 text-center text-sm text-ink-muted">{t("portal.noAttendance")}</p></Card>
          ) : (
            <>
              {/* Overall attendance rate */}
              <Card>
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                  {t("portal.attendanceRate")}
                </p>
                <p className="mt-2 font-display text-[32px] leading-none text-ink tabular">
                  {attendanceQ.data?.rate}%
                </p>
                <p className="mt-2 text-xs text-ink-muted">
                  {t("portal.daysRecorded", { count: attendanceQ.data?.total ?? 0 })}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {Object.entries(attendanceQ.data?.tally ?? {}).map(([status, n]) => (
                    <Badge key={status} variant={status === "present" ? "success" : status === "absent" ? "danger" : "default"}>
                      {status} · {n}
                    </Badge>
                  ))}
                  {(attendanceQ.data?.lateCount ?? 0) > 0 && (
                    <Badge variant="warning">
                      <Clock className="inline h-3 w-3 mr-1" />
                      {attendanceQ.data?.lateCount} late
                    </Badge>
                  )}
                </div>
              </Card>

              {/* Today's periods */}
              {attendanceQ.data?.dailySummaries && attendanceQ.data.dailySummaries.length > 0 && (
                <Card padding={false}>
                  <div className="border-b border-line px-4 py-2.5">
                    <h2 className="text-sm font-semibold text-ink">{t("portal.todayAttendance")}</h2>
                    <p className="text-xs text-ink-muted">
                      {attendanceQ.data.dailySummaries[0]?.date}
                    </p>
                  </div>
                  <div className="px-4 py-2">
                    <p className="text-xs font-medium text-ink-muted mb-2">
                      {attendanceQ.data.dailySummaries[0]?.status}
                    </p>
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      <span className="text-emerald-600">
                        {attendanceQ.data.dailySummaries[0]?.present} present
                      </span>
                      <span className="text-gray-300">·</span>
                      <span className="text-red-600">
                        {attendanceQ.data.dailySummaries[0]?.absent} absent
                      </span>
                      <span className="text-gray-300">·</span>
                      <span className="text-amber-600">
                        {attendanceQ.data.dailySummaries[0]?.late} late
                      </span>
                    </div>
                  </div>
                  <ul className="divide-y divide-line">
                    {(attendanceQ.data.dailySummaries[0]?.periods ?? []).map((p, i) => (
                      <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            {p.periodName && (
                              <span className="flex items-center gap-1 text-xs text-ink-muted">
                                <Clock className="h-3 w-3" />
                                {p.periodName}
                              </span>
                            )}
                            {p.periodTime && (
                              <span className="text-[10px] text-ink-faint">{p.periodTime}</span>
                            )}
                          </div>
                          <p className="text-sm font-medium text-ink truncate">
                            {p.subjectName ?? t("portal.general")}
                          </p>
                        </div>
                        <Badge
                          variant={
                            p.status === "present" ? "success"
                              : p.status === "absent" ? "danger"
                              : p.status === "late" ? "warning"
                              : "default"
                          }
                        >
                          {t(`academic.${String(p.status).toLowerCase()}`, { defaultValue: p.status })}
                        </Badge>
                      </li>
                    ))}
                    {(attendanceQ.data.dailySummaries[0]?.periods ?? []).length === 0 && (
                      <li className="px-4 py-4 text-center text-xs text-ink-muted">
                        {t("portal.noPeriodsToday")}
                      </li>
                    )}
                  </ul>
                </Card>
              )}

              {/* Per-subject breakdown */}
              {attendanceQ.data?.subjectSummary && attendanceQ.data.subjectSummary.length > 0 && (
                <Card padding={false}>
                  <div className="border-b border-line px-4 py-2.5">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                      <BookOpen className="h-4 w-4" />
                      {t("portal.attendanceBySubject")}
                    </h2>
                  </div>
                  <ul className="divide-y divide-line">
                    {attendanceQ.data.subjectSummary.map((s, i) => {
                      const rate = s.total > 0 ? Math.round((s.present / s.total) * 100) : 0;
                      return (
                        <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-ink truncate">
                              {s.subjectName ?? t("portal.general")}
                            </p>
                            <p className="text-[11px] text-ink-faint">
                              {s.present}P · {s.absent}A · {s.late}L · {s.excused}E
                            </p>
                          </div>
                          <span className={cn(
                            "text-sm font-semibold tabular",
                            rate >= 90 ? "text-emerald-600" : rate >= 70 ? "text-amber-600" : "text-red-600",
                          )}>
                            {rate}%
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              )}

              {/* Daily history */}
              {attendanceQ.data?.dailySummaries && attendanceQ.data.dailySummaries.length > 1 && (
                <Card padding={false}>
                  <div className="border-b border-line px-4 py-2.5">
                    <h2 className="text-sm font-semibold text-ink">{t("portal.recentDays")}</h2>
                  </div>
                  <ul className="divide-y divide-line">
                    {attendanceQ.data.dailySummaries.slice(1, 15).map((day) => (
                      <li key={day.date} className="flex items-center gap-3 px-4 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-ink">{day.date}</p>
                          <p className="text-[11px] text-ink-faint">
                            {day.present}P · {day.absent}A · {day.late}L
                          </p>
                        </div>
                        <Badge
                          variant={
                            day.status === "Present" ? "success"
                              : day.status === "Absent" ? "danger"
                              : "warning"
                          }
                        >
                          {t(`academic.${String(day.status).toLowerCase()}`, { defaultValue: day.status })}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          )
        )}

        {/* ── Notices ──────────────────────────────────────────────────────
            Everything the school has recorded for this parent: gate arrivals
            and departures, absences, fee reminders and payments, published
            results, and the threads with something unread in them.

            Every row is a stored record, which is the whole point. A notice is
            here because something happened, not because an email went out —
            so a school with no mail plan and a family with no email address
            still have a place where the parent is told, and it is still there
            tomorrow. The delivery status is shown only when the school tried
            and has not managed it yet. */}
        {screen === "messages" && (
          <div role="tablist" aria-label={t("portal.nav.messages")} className="grid grid-cols-3 gap-1 rounded-card border border-line bg-surface p-1">
            {([["messages", t("portal.messages"), unreadMessages], ["notices", t("portal.notices"), unreadNotices], ["news", t("portal.news"), 0]] as const).map(([key, label, n]) => (
              <button key={key} type="button" role="tab" aria-selected={msgView === key} onClick={() => setMsgView(key)}
                className={cn("relative min-h-11 rounded-control px-2 text-sm font-medium transition-colors",
                  msgView === key ? "bg-primary-600 text-white" : "text-ink-body hover:bg-canvas")}>
                {label}
                {n > 0 && <span className={cn("ml-1.5 rounded-full px-1.5 text-xs font-bold", msgView === key ? "bg-white/25" : "bg-danger text-white")}>{n > 9 ? "9+" : n}</span>}
              </button>
            ))}
          </div>
        )}

        {screen === "messages" && msgView === "notices" && (
          notificationsQ.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> :
          (notificationsQ.data?.length ?? 0) === 0 ? (
            <Card><p className="py-6 text-center text-sm text-ink-muted">{t("portal.noNotices")}</p></Card>
          ) : (
            <Card padding={false}>
              <ul className="divide-y divide-line">
                {notificationsQ.data?.map((n) => {
                  const meta = NOTICE_META[n.kind] ?? NOTICE_META.default;
                  const openable = Boolean(n.conversationId);
                  return (
                    <li key={n._id}>
                      <button
                        type="button"
                        disabled={!openable}
                        onClick={() => { if (openable) setMsgView("messages"); }}
                        className={cn(
                          "flex w-full items-start gap-3 px-4 py-3 text-left",
                          openable && "transition-colors hover:bg-canvas"
                        )}
                      >
                        <span className={cn(
                          "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                          meta.tone
                        )}>
                          {meta.icon}
                        </span>

                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                              {t(meta.labelKey)}
                            </span>
                            {(n.unread ?? 0) > 0 && (
                              <span className="inline-flex min-w-[1.1rem] items-center justify-center
                                               rounded-full bg-ink px-1 text-[0.65rem] font-bold
                                               leading-tight text-white">
                                {n.unread}
                              </span>
                            )}
                            <span className="ml-auto shrink-0 text-xs text-ink-faint">
                              {fmt.dateShort(n.sentAt ?? n.createdAt)}
                            </span>
                          </span>

                          {n.subject && (
                            <span className="mt-0.5 block truncate text-sm font-medium text-ink">
                              {n.subject}
                            </span>
                          )}
                          {/* `body` is the plain-text rendering. The HTML the
                              channel carried is under `html` and is not put on
                              screen — a whole email document in a text node is
                              what the phone was showing its readers. */}
                          {n.body && (
                            <span className="mt-0.5 block text-sm text-ink-body">{n.body}</span>
                          )}

                          {/* Only while the school is still trying, or has
                              failed. A skipped notice — an on-time arrival, or
                              a family with no address — needs no apology on the
                              screen where it is being read. */}
                          {(n.status === "pending" || n.status === "failed") && (
                            <span className="mt-1 block">
                              <Badge variant={n.status === "failed" ? "danger" : "default"}>
                                {t(`portal.noticeStatus_${n.status}`)}
                              </Badge>
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )
        )}

        {/* ── News ── */}
        {screen === "messages" && msgView === "news" && (
          newsQ.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> :
          (newsQ.data?.length ?? 0) === 0 ? (
            <Card><p className="py-6 text-center text-sm text-ink-muted">{t("portal.noNews")}</p></Card>
          ) : (
            newsQ.data?.map((a) => {
              // Whose notice it is, when it names a child. The list now
              // carries notices for every child's class rather than only the
              // one selected, so a parent with three children needs the card
              // to say which of them "bring PE kit on Thursday" is about.
              const about = (a.forStudents ?? [])
                .map((id) => meQ.data?.children
                  ?.find((c) => String(c._id) === String(id))?.name)
                .filter(Boolean);
              return (
                <Card key={a._id}>
                  <p className="text-sm font-semibold text-ink">{a.title ?? "—"}</p>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    {fmt.dateShort(a.createdAt)}
                    {about.length ? ` · ${about.join(", ")}` : ""}
                  </p>
                  {a.body && (
                    <p className="mt-2 whitespace-pre-line text-sm text-ink-body">{a.body}</p>
                  )}
                </Card>
              );
            })
          )
        )}

        {screen === "messages" && msgView === "messages" && <PortalMessages enabled={signedIn} />}
      </main>

      {/* Phone: the five sections along the bottom, within thumb reach. */}
      <nav aria-label={t("portal.nav.main")}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        <div className="mx-auto grid max-w-3xl grid-cols-5">
          {NAV.map((n) => (
            <button key={n.key} type="button" data-nav={n.key} aria-current={screen === n.key ? "page" : undefined}
              onClick={() => open("", n.key)}
              className={cn("flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                screen === n.key ? "text-primary-700" : "text-ink-muted")}>
              <span className={cn("relative flex h-8 w-12 items-center justify-center rounded-full", screen === n.key && "bg-primary-50")} aria-hidden="true">
                {n.icon}{badge(n.badge)}
              </span>
              {n.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

/** While /me loads: the shape of the page, not a spinner on a blank one. */
function ShellSkeleton() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="border-b border-line bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center gap-3"><Skeleton className="h-9 w-9" /><Skeleton className="h-4 w-40" /></div>
      </div>
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-4">
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-56 w-full rounded-card" />
        <Skeleton className="h-56 w-full rounded-card" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GUARDIAN MESSAGING
//
// The first part of this portal that writes anything. Who a parent may reach
// is decided entirely by the server's communication policy — teachers, the
// office, and their own child — so this component never filters the list it
// is given.
// ─────────────────────────────────────────────────────────────────────────────

function PortalMessages({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const qc    = useQueryClient();

  const [openId,  setOpenId]  = useState<string | null>(null);
  const [draft,   setDraft]   = useState("");
  const [picking, setPicking] = useState(false);
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  const listQ = useQuery({
    queryKey: ["portal-conversations"],
    queryFn:  fetchPortalConversations,
    enabled,
    refetchInterval: 25_000,
  });

  const threadQ = useQuery({
    queryKey: ["portal-thread", openId],
    queryFn:  () => fetchPortalThread(openId as string),
    enabled:  Boolean(openId),
    refetchInterval: 15_000,
  });

  const peopleQ = useQuery({
    queryKey: ["portal-recipients"],
    queryFn:  () => fetchPortalRecipients(""),
    enabled:  picking,
  });

  const messages: PortalMessage[] = [...(threadQ.data?.messages ?? [])]
    .sort((a, b) => a.seq - b.seq);

  // Advance the read marker as the thread is shown.
  useEffect(() => {
    if (!openId || messages.length === 0) return;
    markPortalRead(openId, messages[messages.length - 1].seq)
      .then(() => qc.invalidateQueries({ queryKey: ["portal-conversations"] }))
      .catch(() => { /* a receipt failing is not worth telling a parent about */ });
  }, [openId, messages, qc]);

  const send = async () => {
    const body = draft.trim();
    if (!body || !openId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await sendPortalMessage(openId, body);
      setDraft("");
      qc.invalidateQueries({ queryKey: ["portal-thread", openId] });
      qc.invalidateQueries({ queryKey: ["portal-conversations"] });
    } catch (e) {
      const r = (e as { response?: { data?: { message?: string } } })?.response?.data;
      setErr(r?.message ?? (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async (r: PortalRecipient) => {
    setBusy(true);
    setErr(null);
    try {
      const c = await openPortalConversation(r.id, r.kind);
      setPicking(false);
      setOpenId(c._id);
      qc.invalidateQueries({ queryKey: ["portal-conversations"] });
    } catch (e) {
      const d = (e as { response?: { data?: { message?: string } } })?.response?.data;
      setErr(d?.message ?? (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ── One thread ────────────────────────────────────────────────────────────
  if (openId) {
    return (
      <Card>
        <div className="flex items-center gap-2 border-b border-line pb-3">
          <button
            onClick={() => { setOpenId(null); setErr(null); }}
            className="text-ink-muted hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <p className="flex-1 truncate text-sm font-semibold text-ink">
            {threadQ.data?.conversation?.title
              ?? threadQ.data?.conversation?.participants
                   ?.map((p) => p.name).filter(Boolean).join(", ")
              ?? t("portal.messages")}
          </p>
        </div>

        <div className="max-h-80 space-y-2 overflow-y-auto py-3">
          {threadQ.isLoading && <div className="flex justify-center py-6"><Spinner /></div>}
          {messages.map((m) => (
            <div key={m._id} className="rounded-lg bg-canvas px-3 py-2">
              <p className="text-xs font-semibold text-ink-muted">
                {m.sender?.name ?? "—"}
              </p>
              <p className="whitespace-pre-line text-sm text-ink-body">
                {m.isDeleted ? t("portal.messageDeleted") : m.body}
              </p>
              {(m.attachments?.length ?? 0) > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {m.attachments!.map((a) => (
                    <li key={a.url}>
                      <a href={a.url} target="_blank" rel="noreferrer"
                         className="text-xs underline">
                        {a.name ?? a.url.split("/").pop()}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          {!threadQ.isLoading && messages.length === 0 && (
            <p className="py-6 text-center text-sm text-ink-muted">
              {t("portal.noMessages")}
            </p>
          )}
        </div>

        {err && <p className="pb-2 text-xs text-red-600">{err}</p>}

        <div className="flex items-end gap-2 border-t border-line pt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            rows={1}
            placeholder={t("portal.writeMessage")}
            className="flex-1 resize-none rounded-lg border border-line bg-canvas
                       px-3 py-2 text-sm outline-none focus:border-ink-muted"
          />
          <button
            onClick={send}
            disabled={!draft.trim() || busy}
            className="flex items-center gap-1.5 rounded-lg bg-ink px-3 py-2
                       text-sm font-semibold text-surface disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </Card>
    );
  }

  // ── Picking somebody to write to ──────────────────────────────────────────
  if (picking) {
    return (
      <Card>
        <div className="flex items-center gap-2 border-b border-line pb-3">
          <button onClick={() => setPicking(false)} className="text-ink-muted hover:text-ink">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <p className="flex-1 text-sm font-semibold text-ink">
            {t("portal.chooseRecipient")}
          </p>
        </div>

        {err && <p className="pt-2 text-xs text-red-600">{err}</p>}

        {peopleQ.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : (peopleQ.data?.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-sm text-ink-muted">
            {t("portal.noRecipients")}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {peopleQ.data?.map((r) => (
              <li key={`${r.kind}:${r.id}`}>
                <button
                  onClick={() => start(r)}
                  disabled={busy}
                  className="w-full py-3 text-left disabled:opacity-50"
                >
                  <p className="text-sm font-semibold text-ink">{r.name}</p>
                  {r.subtitle && (
                    <p className="text-xs text-ink-faint">{r.subtitle}</p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  // ── The list ──────────────────────────────────────────────────────────────
  const rows: PortalConversation[] = listQ.data ?? [];

  return (
    <>
      <button
        onClick={() => { setPicking(true); setErr(null); }}
        className="mb-3 w-full rounded-lg bg-ink px-4 py-2.5 text-sm
                   font-semibold text-surface"
      >
        {t("portal.newMessage")}
      </button>

      {listQ.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : rows.length === 0 ? (
        <Card>
          <p className="py-6 text-center text-sm text-ink-muted">
            {t("portal.noConversations")}
          </p>
        </Card>
      ) : (
        rows.map((c) => (
          <Card key={c._id}>
            <button onClick={() => setOpenId(c._id)} className="w-full text-left">
              <div className="flex items-center gap-2">
                <p className="flex-1 truncate text-sm font-semibold text-ink">
                  {c.title
                    ?? c.participants?.map((p) => p.name).filter(Boolean).join(", ")
                    ?? "—"}
                </p>
                {Boolean(c.unread) && (
                  <span className="rounded-full bg-ink px-1.5 py-0.5 text-[10px]
                                   font-bold text-surface">
                    {c.unread}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-ink-faint">
                {c.lastMessagePreview ?? "—"}
              </p>
            </button>
          </Card>
        ))
      )}
    </>
  );
}
