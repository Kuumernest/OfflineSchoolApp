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

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LogOut, Wallet, GraduationCap, CalendarCheck, MessageSquare, Home } from "lucide-react";

import { Card }        from "@/components/ui/Card";
import { Button }      from "@/components/ui/Button";
import { FormField, Input } from "@/components/ui/FormField";
import { LanguageSwitcher } from "@/components/ui/LanguageSwitcher";
import { cn }          from "@/utils/cn";
import { resolveLogoSrc } from "@/utils/logoSrc";
import { HomeScreen, type PortalScreen } from "./HomeScreen";
import { ResultsScreen } from "./ResultsScreen";
import { AttendanceScreen } from "./AttendanceScreen";
import { FeesScreen } from "./FeesScreen";
import { MessagesScreen, type MsgView } from "./MessagesScreen";
import { ChildAvatar, LanguageToggle, Skeleton } from "./ui";
import {
  portalLogin, portalLogout, hasPortalSession, setPortalSession, fetchMe,
} from "@/services/portal.service";

export default function ParentPortalPage() {
  const { t } = useTranslation();
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
        {screen !== "home" && screen !== "messages" && children.length > 1 && (
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
        {screen !== "home" && screen !== "messages" && student && (
          <p className="text-xs text-ink-muted">
            {student.name}{student.className ? ` · ${student.className}` : ""}{student.enrollmentNo ? ` · ${student.enrollmentNo}` : ""}
          </p>
        )}
        {/* ── Fees ── */}
        {screen === "home" && <HomeScreen onOpen={open} />}

        {screen === "fees" && <FeesScreen studentId={selected} childName={student?.name ?? null} />}

        {screen === "results" && <ResultsScreen studentId={selected} />}

        {/* ── Attendance ── */}
        {screen === "attendance" && <AttendanceScreen studentId={selected} />}

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
          <MessagesScreen view={msgView} onView={setMsgView} children={children}
            unreadMessages={unreadMessages} unreadNotices={unreadNotices} />
        )}
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
