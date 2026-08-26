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
  MessageSquare, Send, Loader2, ArrowLeft,
} from "lucide-react";

import { Card }        from "@/components/ui/Card";
import { Button }      from "@/components/ui/Button";
import { Badge }       from "@/components/ui/Badge";
import { PageSpinner, Spinner } from "@/components/ui/Spinner";
import { FormField, Input } from "@/components/ui/FormField";
import { LanguageSwitcher } from "@/components/ui/LanguageSwitcher";
import { useFormat }   from "@/i18n/format";
import { cn }          from "@/utils/cn";
import { printHtml }   from "@/print/document";
import { resolveLogoSrc } from "@/utils/logoSrc";
import {
  portalLogin, getPortalToken, setPortalToken, clearPortalToken,
  fetchMe, fetchFees, fetchResults, fetchAttendance, fetchAnnouncements,
  fetchReceiptHtml,
  fetchPortalConversations, fetchPortalRecipients, openPortalConversation,
  fetchPortalThread, sendPortalMessage, markPortalRead,
  type PortalConversation, type PortalMessage, type PortalRecipient,
} from "@/services/portal.service";

type Tab = "fees" | "results" | "attendance" | "news" | "messages";

export default function ParentPortalPage() {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const qc  = useQueryClient();

  const [signedIn, setSignedIn] = useState(Boolean(getPortalToken()));
  const [tab, setTab]           = useState<Tab>("fees");
  // Null means "whichever the server picks first" — what a one-child parent
  // gets, and never has to think about.
  const [childId, setChildId]   = useState<string | null>(null);

  const [admissionNo, setAdmissionNo] = useState("");
  const [code, setCode]               = useState("");
  const [error, setError]             = useState<string | null>(null);
  const [busy, setBusy]               = useState(false);
  const [printing, setPrinting]       = useState<string | null>(null);

  const signOut = () => {
    clearPortalToken();
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

  const feesQ = useQuery({
    queryKey: ["portal", "fees", selected], queryFn: () => fetchFees(selected),
    enabled: signedIn && tab === "fees", retry: false,
  });
  const resultsQ = useQuery({
    queryKey: ["portal", "results", selected], queryFn: () => fetchResults(selected),
    enabled: signedIn && tab === "results", retry: false,
  });
  const attendanceQ = useQuery({
    queryKey: ["portal", "attendance", selected], queryFn: () => fetchAttendance(selected),
    enabled: signedIn && tab === "attendance", retry: false,
  });
  const newsQ = useQuery({
    queryKey: ["portal", "news", selected], queryFn: () => fetchAnnouncements(selected),
    enabled: signedIn && tab === "news", retry: false,
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await portalLogin(admissionNo.trim(), code.trim());
      setPortalToken(token);
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

  if (meQ.isLoading) return <PageSpinner />;

  const school  = meQ.data?.school;
  const student = meQ.data?.student;
  const fees    = feesQ.data;
  const logo    = resolveLogoSrc(school?.logo);

  const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "fees",       label: t("portal.fees"),       icon: <Wallet className="h-4 w-4" /> },
    { key: "results",    label: t("portal.results"),    icon: <GraduationCap className="h-4 w-4" /> },
    { key: "attendance", label: t("portal.attendance"), icon: <CalendarCheck className="h-4 w-4" /> },
    { key: "news",       label: t("portal.news"),       icon: <Megaphone className="h-4 w-4" /> },
    { key: "messages",   label: t("portal.messages"),   icon: <MessageSquare className="h-4 w-4" /> },
  ];

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          {/* resolveLogoSrc returns null for anything it cannot resolve, so the
              guard is on the RESOLVED value — checking school.logo alone would
              still render an <img src={null}> and show a broken-image icon. */}
          {logo && <img src={logo} alt="" className="h-9 w-9 object-contain" />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">{school?.name ?? ""}</p>
            <p className="truncate text-xs text-ink-muted">
              {student?.name} · {student?.enrollmentNo}
              {student?.className ? ` · ${student.className}` : ""}
            </p>
          </div>
          <LanguageSwitcher />
          <Button variant="ghost" size="sm" icon={<LogOut className="h-4 w-4" />} onClick={signOut}>
            {t("portal.signOut")}
          </Button>
        </div>
      </header>

      {/* Child switcher — only when there is a choice. A parent with one child
          should not be shown a control with one option in it. */}
      {(meQ.data?.children.length ?? 0) > 1 && (
        <div className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-3xl gap-2 overflow-x-auto px-4 py-2">
            {meQ.data?.children.map((c) => (
              <button
                key={c._id}
                type="button"
                onClick={() => setChildId(c._id)}
                className={cn(
                  "min-w-[110px] shrink-0 rounded-control border px-3 py-1.5 text-left transition-colors",
                  selected === c._id
                    ? "border-primary-600 bg-primary-600 text-white"
                    : "border-line-strong bg-surface text-ink-body hover:bg-surface-muted"
                )}
              >
                <span className="block truncate text-sm font-medium">
                  {c.name || c.enrollmentNo}
                </span>
                {c.className && (
                  <span className={cn(
                    "block truncate text-[11px]",
                    selected === c._id ? "text-white/75" : "text-ink-faint"
                  )}>
                    {c.className}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <nav className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl gap-1 overflow-x-auto px-4">
          {TABS.map((tb) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => setTab(tb.key)}
              className={cn(
                "flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                tab === tb.key
                  ? "border-primary-600 text-primary-600"
                  : "border-transparent text-ink-muted hover:text-ink-body"
              )}
            >
              {tb.icon}
              {tb.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-5">
        {/* ── Fees ── */}
        {tab === "fees" && (
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
            </>
          )
        )}

        {/* ── Results ── */}
        {tab === "results" && (
          resultsQ.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> :
          (resultsQ.data?.length ?? 0) === 0 ? (
            <Card><p className="py-6 text-center text-sm text-ink-muted">{t("portal.noResults")}</p></Card>
          ) : (
            resultsQ.data?.map((r) => (
              <Card key={r._id} padding={false}>
                <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">
                      {r.term ?? "—"} · {r.academicYear ?? "—"}
                    </p>
                    <p className="text-xs text-ink-muted">{r.className ?? ""}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold text-ink tabular">
                      {r.average ?? "—"}
                    </p>
                    {r.classPosition && (
                      <p className="text-xs text-ink-muted">
                        {t("portal.position")} {r.classPosition}
                        {r.totalInClass ? ` / ${r.totalInClass}` : ""}
                      </p>
                    )}
                  </div>
                </div>
                <ul className="divide-y divide-line">
                  {r.subjects.map((s, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 px-4 py-2">
                      <span className="truncate text-sm text-ink-body">{s.subjectName ?? "—"}</span>
                      <span className="flex items-center gap-3">
                        <span className="text-sm tabular text-ink-muted">
                          {s.normalizedMark ?? "—"}
                        </span>
                        <Badge variant={s.isPassing ? "success" : "danger"}>
                          {s.grade ?? "—"}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))
          )
        )}

        {/* ── Attendance ── */}
        {tab === "attendance" && (
          attendanceQ.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> :
          (attendanceQ.data?.total ?? 0) === 0 ? (
            <Card><p className="py-6 text-center text-sm text-ink-muted">{t("portal.noAttendance")}</p></Card>
          ) : (
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
                  <Badge key={status} variant={status === "present" ? "success" : "default"}>
                    {status} · {n}
                  </Badge>
                ))}
              </div>
            </Card>
          )
        )}

        {/* ── News ── */}
        {tab === "news" && (
          newsQ.isLoading ? <div className="flex justify-center py-10"><Spinner /></div> :
          (newsQ.data?.length ?? 0) === 0 ? (
            <Card><p className="py-6 text-center text-sm text-ink-muted">{t("portal.noNews")}</p></Card>
          ) : (
            newsQ.data?.map((a) => (
              <Card key={a._id}>
                <p className="text-sm font-semibold text-ink">{a.title ?? "—"}</p>
                <p className="mt-0.5 text-xs text-ink-faint">{fmt.dateShort(a.createdAt)}</p>
                {a.body && (
                  <p className="mt-2 whitespace-pre-line text-sm text-ink-body">{a.body}</p>
                )}
              </Card>
            ))
          )
        )}

        {tab === "messages" && <PortalMessages enabled={signedIn} />}
      </main>
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
