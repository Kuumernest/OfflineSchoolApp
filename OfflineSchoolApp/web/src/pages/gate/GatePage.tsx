// web/src/pages/gate/GatePage.tsx
//
// The gate: scan a card (or find a pupil by name), record the passage, and —
// for someone holding gate.verify — show whether the family is up to date with
// the fees due today.
//
// The desktop runs this same build, so this is also the desktop's gate screen,
// and the gate is where a lost connection matters most: the queue does not
// stop for it. So the screen keeps two things in the browser (gate.service.ts):
// the fee snapshot, to verify with no network, and the scans the server never
// answered, to upload when it is back. Offline answers are always labelled as
// computed on this device, with how old the data behind them is.
//
// Three permissions, three layers:
//   gate.scan       open this screen, record passages
//   gate.verify     the fee panel and the snapshot — without it no figure is
//                   fetched or stored at all
//   gate.authorize  issue and revoke gate passes (administrators)
// Nothing here records a payment or changes an agreement, waiver or structure.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import axios from "axios";
import {
  ScanLine, ShieldAlert, XOctagon, CloudOff, Search, UploadCloud, RefreshCw,
} from "lucide-react";

import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { StudentPhoto } from "@/components/students/StudentPhoto";
import { useUser, useAuthStore } from "@/store/auth.store";
import { usePermission } from "@/lib/permissions";
import { getErrorMessage } from "@/lib/axios";
import { isDesktop } from "@/lib/offline/bridge";
import { useIsOffline } from "@/lib/offline/connectivityWatch";
import { newClientId } from "@/lib/clientId";
import { timeAgo } from "@/i18n";
import { cn } from "@/utils/cn";
import {
  fetchGateHistory, fetchGateSnapshot, fetchGateVerification, postGateScan,
  readStoredSnapshot, searchGate, storeSnapshot,
  type GateDirection, type GateStudentCard, type ScanRequest, type WireCompliance,
} from "@/services/gate.service";
import {
  cardOf, findById, findByToken, localCompliance, searchSnapshot, type GateResult,
} from "./gateLogic";
import { desktopPendingPayments } from "./pendingPayments";
import { useGateQueue } from "./useGateQueue";
import { VerificationCard } from "./VerificationCard";
import { HistoryPanel } from "./HistoryPanel";
import { CameraScanner } from "./CameraScanner";

/** The snapshot is a whole-school pull; every five minutes is fresh enough at a door. */
const SNAPSHOT_EVERY_MS = 5 * 60_000;
const HISTORY_EVERY_MS  = 60_000;
/** See postGateScan: past this, the scan is shown from the snapshot and queued. */
const SCAN_TIMEOUT_MS   = 10_000;

type DirectionChoice = "auto" | GateDirection;

/**
 * The route sits in the staff group; this is the gate.scan half. A school can
 * take the gate away from a role, so the role alone does not decide it.
 */
export default function GatePage() {
  const canScan = usePermission("gate.scan");

  // gate.verify is the newest capability a session can hold, and the one this
  // page turns on: re-read the account's permissions on opening it, so a
  // browser signed in before it existed (or before an administrator granted
  // it) is not left showing passages without fees.
  useEffect(() => { void useAuthStore.getState().revalidateUser(); }, []);
  return canScan ? <GateScreen /> : <NoGateAccess />;
}

function NoGateAccess() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-10">
      <Card className="max-w-md text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-warning-soft">
          <ShieldAlert className="h-6 w-6 text-warning-text" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-base font-semibold text-ink">{t("requireRole.title")}</h1>
        <p className="mt-1.5 text-sm text-ink-muted">{t("gatePage.noAccess")}</p>
      </Card>
    </div>
  );
}

function GateScreen() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const user = useUser();
  const schoolId = user?.schoolId ?? "";
  const userId = String(user?._id ?? "");

  const canVerify    = usePermission("gate.verify");
  const canAuthorize = usePermission("gate.authorize");
  const canSeeFees   = usePermission("fees.view");
  const offline      = useIsOffline();

  // ── The snapshot (gate.verify only) ─────────────────────────────────────
  // Never read nor written without the permission: it is the fee ledger in
  // summary, and a browser shared at the gate must not keep it for someone
  // who may not see it.
  const stored = useMemo(
    () => (canVerify ? readStoredSnapshot(schoolId) : null),
    [canVerify, schoolId],
  );
  const snapshotQ = useQuery({
    queryKey: ["gate", "snapshot", schoolId],
    queryFn:  () => fetchGateSnapshot(schoolId),
    enabled:  canVerify && Boolean(schoolId),
    refetchInterval: offline ? false : SNAPSHOT_EVERY_MS,
    staleTime: SNAPSHOT_EVERY_MS - 30_000,
    retry: 1,
  });
  useEffect(() => {
    if (canVerify && snapshotQ.data) storeSnapshot(schoolId, snapshotQ.data);
  }, [canVerify, schoolId, snapshotQ.data]);
  const snapshot = canVerify ? (snapshotQ.data ?? stored) : null;

  // ── History ─────────────────────────────────────────────────────────────
  const historyQ = useQuery({
    queryKey: ["gate", "history", schoolId],
    queryFn:  () => fetchGateHistory(schoolId, 30),
    enabled:  Boolean(schoolId),
    refetchInterval: offline ? false : HISTORY_EVERY_MS,
    retry: 1,
  });

  // ── The upload queue ────────────────────────────────────────────────────
  const onUploaded = useCallback((count: number) => {
    toast({ kind: "success", title: t("gatePage.uploaded", { count }) });
    void qc.invalidateQueries({ queryKey: ["gate", "history", schoolId] });
  }, [toast, t, qc, schoolId]);
  const onRefused = useCallback((item: { display: { name: string | null } }, err: unknown) => {
    toast({
      kind: "warning",
      title: t("gatePage.refusedOnUpload", { name: item.display.name ?? t("gatePage.unknownCard") }),
      message: getErrorMessage(err),
      duration: 0,
    });
  }, [toast, t]);
  const { queue, enqueue, flush } = useGateQueue({ schoolId, userId, onUploaded, onRefused });

  // ── Scanning ────────────────────────────────────────────────────────────
  const [direction, setDirection] = useState<DirectionChoice>("auto");
  const [scanValue, setScanValue] = useState("");
  const [result, setResult] = useState<GateResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scanInput = useRef<HTMLInputElement>(null);
  /** Only the latest scan's answer is drawn; earlier ones still get recorded. */
  const latest = useRef(0);

  const refocus = useCallback(() => {
    window.setTimeout(() => scanInput.current?.focus(), 0);
  }, []);

  const recordScan = useCallback(async (p: {
    token?: string; studentId?: string; method: "card" | "manual"; card?: GateStudentCard;
  }) => {
    const id  = newClientId();
    const at  = new Date().toISOString();
    const seq = ++latest.current;
    setBusy(true);
    setFailure(null);

    const snap = canVerify
      ? (p.token ? findByToken(snapshot, p.token) : p.studentId ? findById(snapshot, p.studentId) : null)
      : null;

    let local: WireCompliance | null = null;
    if (snap && snapshot) {
      // Desktop only, and only for someone who may read the ledger it comes from.
      const pending = canSeeFees && isDesktop()
        ? await desktopPendingPayments(schoolId, snap.studentId, snapshot.academicYear)
        : [];
      local = localCompliance(snap, snapshot.generatedAt, pending);
    }

    const body: ScanRequest = {
      _id: id,
      ...(p.token ? { token: p.token } : { studentId: p.studentId }),
      at,
      station: "web",
      ...(direction !== "auto" ? { direction } : {}),
      // What the operator is about to be shown, kept beside the server's own
      // answer for the audit.
      ...(canVerify && local ? { verification: local } : {}),
    };
    const fallbackCard = snap ? cardOf(snap) : p.card ?? null;

    try {
      const res = await postGateScan(schoolId, body, { timeout: SCAN_TIMEOUT_MS });
      if (seq !== latest.current) return;
      // The server's answer whenever it sent one. It decides gate.verify from
      // the account's CURRENT permissions; this browser's list may be older
      // (it was, for up to 30 days, before revalidateUser) and must not hide
      // fees the server already chose to show.
      const shown = res.compliance ?? (canVerify ? local : null);
      setResult({
        id,
        student:   { ...(fallbackCard ?? {}), ...res.student } as GateStudentCard,
        token:     p.token ?? null,
        method:    res.method ?? p.method,
        at:        res.at ?? at,
        direction: res.direction ?? null,
        duplicate: Boolean(res.duplicate),
        replay:    Boolean(res.replay),
        notified:  Boolean(res.notified),
        compliance: shown,
        feeUnavailable: shown ? null : (canVerify ? "server_missing" : "not_permitted"),
        computedLocally: canVerify && !res.compliance && Boolean(local),
        localPending: local?.pending ?? null,
        queued: false,
      });
      void qc.invalidateQueries({ queryKey: ["gate", "history", schoolId] });
    } catch (err) {
      if (axios.isAxiosError(err) && !err.response) {
        // No answer at all: show what this device knows, keep the scan.
        enqueue({
          body,
          display: {
            studentId:    fallbackCard?._id ?? p.studentId ?? null,
            name:         fallbackCard?.name ?? null,
            enrollmentNo: fallbackCard?.enrollmentNo ?? null,
            status:       local?.status ?? null,
            method:       p.method,
          },
          attempts: 0,
        });
        if (seq !== latest.current) return;
        setResult({
          id,
          student: fallbackCard,
          token: p.token ?? null,
          method: p.method,
          at,
          direction: direction !== "auto" ? direction : null,
          duplicate: false,
          replay: false,
          notified: false,
          compliance: local,
          feeUnavailable: local ? null : (canVerify ? "no_offline_data" : "not_permitted"),
          computedLocally: Boolean(local),
          localPending: local?.pending ?? null,
          queued: true,
        });
      } else {
        if (seq !== latest.current) return;
        const code = axios.isAxiosError(err)
          ? (err.response?.data as { code?: string } | undefined)?.code
          : undefined;
        setResult(null);
        setFailure(
          code === "UNKNOWN_CARD" ? t("gatePage.err.unknownCard")
          : code === "NOT_ENROLLED" ? t("gatePage.err.notEnrolled")
          : code === "NOT_FOUND" ? t("gatePage.err.notFound")
          : getErrorMessage(err),
        );
      }
    } finally {
      if (seq === latest.current) {
        setBusy(false);
        refocus();
      }
    }
  }, [canVerify, canSeeFees, snapshot, schoolId, direction, enqueue, qc, t, refocus]);

  const submitScan = (e: React.FormEvent) => {
    e.preventDefault();
    // A wedge scanner types the token then Enter; anything around it is noise.
    const token = scanValue.trim();
    setScanValue("");
    if (token) void recordScan({ token, method: "card" });
  };

  // The field the scanner types into must stay focused, or the next card's
  // characters land nowhere. Taken back only when focus has gone to nothing —
  // never from the search box, a form field or an open dialog.
  const keepFocus = () => {
    window.setTimeout(() => {
      const el = document.activeElement;
      if (!el || el === document.body) scanInput.current?.focus();
    }, 0);
  };

  // ── Manual search ───────────────────────────────────────────────────────
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(id);
  }, [q]);

  // Over the snapshot first — it works with no connection; the server only
  // when there is nothing saved to search.
  const localMatches = useMemo(
    () => (snapshot ? searchSnapshot(snapshot, q).map(cardOf) : []),
    [snapshot, q],
  );
  const remoteQ = useQuery({
    queryKey: ["gate", "search", schoolId, debouncedQ],
    queryFn:  () => searchGate(schoolId, debouncedQ),
    enabled:  !snapshot && Boolean(schoolId) && debouncedQ.length >= 2,
    retry: false,
  });
  const matches: GateStudentCard[] = snapshot ? localMatches : (remoteQ.data ?? []);

  const pick = (card: GateStudentCard) => {
    setQ("");
    setDebouncedQ("");
    void recordScan({ studentId: card._id, method: "manual", card });
  };

  // ── After a gate pass is issued or revoked ──────────────────────────────
  const onAuthorizationChanged = useCallback(async (studentId: string) => {
    void qc.invalidateQueries({ queryKey: ["gate", "snapshot", schoolId] });
    try {
      const v = await fetchGateVerification(schoolId, studentId);
      setResult((prev) => (prev && prev.student?._id === studentId
        ? {
            ...prev,
            compliance: v.compliance ?? prev.compliance,
            feeUnavailable: (v.compliance ?? prev.compliance) ? null : prev.feeUnavailable,
            computedLocally: !v.compliance && prev.computedLocally,
          }
        : prev));
    } catch {
      // The pass is saved; the card catches up on the next scan.
    }
  }, [qc, schoolId]);

  if (!schoolId) return null;

  const snapshotAt = snapshot?.generatedAt ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("gatePage.title")}
        description={canVerify ? t("gatePage.blurbVerify") : t("gatePage.blurb")}
        icon={ScanLine}
        accent="teal"
        meta={
          <>
            {offline && (
              <span className="inline-flex items-center gap-1 text-warning-text">
                <CloudOff className="h-3.5 w-3.5" aria-hidden="true" />
                {t("gatePage.offline")}
              </span>
            )}
            {canVerify && (
              <span>
                {snapshotAt
                  ? t("gatePage.snapshotAt", { when: timeAgo(snapshotAt) })
                  : snapshotQ.isLoading ? t("gatePage.snapshotLoading") : t("gatePage.snapshotNone")}
              </span>
            )}
            {queue.length > 0 && (
              <span className="inline-flex items-center gap-1 text-info-text">
                <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
                {t("gatePage.waitingCount", { count: queue.length })}
              </span>
            )}
          </>
        }
        actions={
          queue.length > 0 && !offline ? (
            <Button size="sm" variant="secondary" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void flush()}>
              {t("gatePage.uploadNow")}
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          {/* ── Scan ─────────────────────────────────────────────────── */}
          <Card className="space-y-4">
            <form onSubmit={submitScan} className="space-y-2">
              <label htmlFor="gate-scan" className="block text-sm font-medium text-ink-body">
                {t("gatePage.scanLabel")}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="gate-scan"
                  ref={scanInput}
                  // The screen exists to take the next card; it starts ready.
                  autoFocus
                  value={scanValue}
                  onChange={(e) => setScanValue(e.target.value)}
                  onBlur={keepFocus}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  placeholder={t("gatePage.scanPlaceholder")}
                  aria-describedby="gate-scan-hint"
                  className={cn(
                    "h-12 w-full min-w-0 rounded-control border-2 border-primary-300 bg-surface px-4",
                    "font-mono text-lg text-ink placeholder:font-sans placeholder:text-base placeholder:text-ink-faint",
                    "focus:border-primary-500 focus:outline-none",
                  )}
                />
                {busy && <Spinner className="h-5 w-5 shrink-0" />}
              </div>
              <p id="gate-scan-hint" className="text-xs text-ink-muted">{t("gatePage.scanHint")}</p>
            </form>

            <div className="flex flex-wrap items-center gap-3">
              <fieldset className="flex flex-wrap items-center gap-2">
                <legend className="sr-only">{t("gatePage.directionLabel")}</legend>
                <span className="text-xs text-ink-muted" aria-hidden="true">{t("gatePage.directionLabel")}</span>
                {(["auto", "in", "out"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={direction === d}
                    onClick={() => { setDirection(d); refocus(); }}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium transition",
                      direction === d
                        ? "border-primary-300 bg-primary-50 text-primary-800"
                        : "border-line bg-surface text-ink-muted hover:text-ink",
                    )}
                  >
                    {t(`gatePage.direction.${d}`)}
                  </button>
                ))}
              </fieldset>
              <CameraScanner onDetected={(token) => void recordScan({ token, method: "card" })} />
            </div>
          </Card>

          {/* ── Result ───────────────────────────────────────────────── */}
          <div aria-live="polite">
            {failure ? (
              <Card className="border-danger-line bg-danger-soft">
                <div role="alert" className="flex items-start gap-3 text-danger-text">
                  <XOctagon className="h-7 w-7 shrink-0" aria-hidden="true" />
                  <div>
                    <p className="text-lg font-semibold">{t("gatePage.err.title")}</p>
                    <p className="text-sm">{failure}</p>
                  </div>
                </div>
              </Card>
            ) : result ? (
              <VerificationCard
                result={result}
                canVerify={canVerify}
                canAuthorize={canAuthorize && !result.queued}
                academicYear={snapshot?.academicYear ?? null}
                schoolId={schoolId}
                onAuthorizationChanged={(id) => void onAuthorizationChanged(id)}
              />
            ) : (
              <Card className="text-center">
                <ScanLine className="mx-auto h-10 w-10 text-ink-faint" aria-hidden="true" />
                <p className="mt-2 text-sm text-ink-muted">{t("gatePage.idle")}</p>
              </Card>
            )}
          </div>

          {/* ── Manual search ────────────────────────────────────────── */}
          <Card className="space-y-3">
            <label htmlFor="gate-search" className="flex items-center gap-2 text-sm font-medium text-ink-body">
              <Search className="h-4 w-4" aria-hidden="true" />
              {t("gatePage.searchLabel")}
            </label>
            <input
              id="gate-search"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
              placeholder={t("gatePage.searchPlaceholder")}
              className={cn(
                "h-10 w-full min-w-0 rounded-control border border-line-strong bg-surface px-3",
                "text-base text-ink placeholder:text-ink-faint sm:text-sm",
                "focus:border-primary-500 focus:outline-none",
              )}
            />
            {q.trim().length >= 2 && (
              matches.length > 0 ? (
                <ul className="divide-y divide-line rounded-card border border-line">
                  {matches.map((m) => (
                    <li key={m._id}>
                      <button
                        type="button"
                        onClick={() => pick(m)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-canvas focus:bg-canvas"
                      >
                        <StudentPhoto photoUrl={m.photoUrl} name={m.name} size="sm" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{m.name ?? "—"}</span>
                          <span className="block truncate text-xs text-ink-muted">
                            {[m.enrollmentNo, m.className].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        <span className="text-xs font-medium text-primary-700">{t("gatePage.recordPassage")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">
                  {!snapshot && remoteQ.isError ? t("gatePage.searchNeedsConnection")
                    : !snapshot && (remoteQ.isFetching || debouncedQ !== q.trim()) ? t("common.loading")
                    : t("gatePage.searchNone")}
                </p>
              )
            )}
          </Card>
        </div>

        <HistoryPanel
          rows={historyQ.data ?? []}
          queue={queue}
          showStatus={canVerify}
          loadFailed={historyQ.isError}
        />
      </div>
    </div>
  );
}
