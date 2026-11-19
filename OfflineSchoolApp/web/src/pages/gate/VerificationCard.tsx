// web/src/pages/gate/VerificationCard.tsx
//
// Who just came through, and — for gate.verify holders — whether their fees
// are up to date today.
//
// The status is said three ways at once: colour, icon and word. A gate is
// often in bright sunlight on a cheap screen, and a person who cannot tell red
// from green must still read "Non-compliant". Every figure is read-only: this
// screen records passages and nothing else — no payment, agreement, waiver or
// structure is ever changed from here.

import { useTranslation } from "react-i18next";
import {
  CheckCircle2, Clock, XOctagon, ShieldCheck, LogIn, LogOut, CloudOff,
  AlertTriangle, Hourglass, Ban, UploadCloud, CreditCard, Search, BellRing,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { StudentPhoto } from "@/components/students/StudentPhoto";
import { useFormat } from "@/i18n/format";
import { timeAgo } from "@/i18n";
import { cn } from "@/utils/cn";
import type { ComplianceStatus } from "../../../../shared/compliance.js";
import type { GateResult } from "./gateLogic";
import type { WireCompliance } from "@/services/gate.service";
import { AuthorizationPanel } from "./AuthorizationPanel";

const STATUS_META: Record<ComplianceStatus, { icon: LucideIcon; badge: string; pill: string; key: string }> = {
  compliant: {
    icon: CheckCircle2, key: "gatePage.status.compliant",
    badge: "bg-success-solid text-white",
    pill:  "bg-success-soft text-success-text border-success-line",
  },
  due: {
    icon: Clock, key: "gatePage.status.due",
    badge: "bg-warning-box text-warning-text border-2 border-warning",
    pill:  "bg-warning-soft text-warning-text border-warning-line",
  },
  non_compliant: {
    icon: XOctagon, key: "gatePage.status.non_compliant",
    badge: "bg-danger text-white",
    pill:  "bg-danger-soft text-danger-text border-danger-line",
  },
  authorized: {
    icon: ShieldCheck, key: "gatePage.status.authorized",
    badge: "bg-info text-white",
    pill:  "bg-info-soft text-info-text border-info-line",
  },
};

/** The small form, for the history list. */
export function StatusPill({ status }: { status: ComplianceStatus }) {
  const { t } = useTranslation();
  const meta = STATUS_META[status] ?? STATUS_META.non_compliant;
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", meta.pill)}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(meta.key)}
    </span>
  );
}

function StatusBadge({ status }: { status: ComplianceStatus }) {
  const { t } = useTranslation();
  const meta = STATUS_META[status] ?? STATUS_META.non_compliant;
  const Icon = meta.icon;
  return (
    <div className={cn("flex items-center gap-3 rounded-card px-4 py-3", meta.badge)}>
      <Icon className="h-8 w-8 shrink-0" aria-hidden="true" />
      <span className="text-2xl font-bold tracking-tight">{t(meta.key)}</span>
    </div>
  );
}

function Warning({ icon: Icon, tone, children }: {
  icon: LucideIcon; tone: "warning" | "danger" | "info"; children: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-control border px-3 py-2 text-sm",
        tone === "danger"  && "border-danger-line bg-danger-soft text-danger-text",
        tone === "warning" && "border-warning-line bg-warning-soft text-warning-text",
        tone === "info"    && "border-info-line bg-info-soft text-info-text",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

function Figure({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-sm text-ink", strong && "text-base font-semibold")}>{value}</dd>
    </div>
  );
}

function FeePanel({ c, computedLocally, localPending }: {
  c: WireCompliance;
  computedLocally: boolean;
  localPending: WireCompliance["pending"] | null;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  // Whole XAF with the locale's thousands separator, then the currency the
  // way it is written on every receipt in the school.
  // The app's one money format (i18n/format formatMoney), as on every fee screen.
  const money = (v: number | null | undefined) => fmt.money(v ?? 0);

  // The server cannot know what this desktop has not uploaded, so when its
  // answer is shown the device's own pending list is kept beside it.
  const pending = c.pending?.count ? c.pending : localPending?.count ? localPending : null;

  const arrangement =
    c.agreementState === "pending_approval" ? t("gatePage.arrangement.pendingApproval")
    : c.arrangement === "agreement"         ? t("gatePage.arrangement.agreement")
    : c.agreementState && c.agreementState !== "in_force"
      ? t("gatePage.arrangement.standardAgreementNotInForce")
      : t("gatePage.arrangement.standard");

  return (
    <div className="space-y-3">
      <StatusBadge status={c.status} />

      {c.status === "authorized" && c.authorization && (
        <p className="text-sm text-info-text">
          {t("gatePage.authorizedUntil", { date: fmt.date(c.authorization.validUntil) })}
          {c.authorization.reason ? ` — ${c.authorization.reason}` : ""}
        </p>
      )}

      <ul className="space-y-2" aria-label={t("gatePage.warningsLabel")}>
        {computedLocally && (
          <Warning icon={CloudOff} tone="info">
            {c.dataAsOf
              ? t("gatePage.warn.offline", { when: timeAgo(c.dataAsOf) })
              : t("gatePage.warn.offlineNoTime")}
          </Warning>
        )}
        {c.stale && (
          <Warning icon={AlertTriangle} tone="warning">{t("gatePage.warn.stale")}</Warning>
        )}
        {pending && (
          <Warning icon={Hourglass} tone="warning">
            {c.dependsOnPending || pending.statusIfConfirmed !== c.status
              ? t("gatePage.warn.pendingWouldBe", {
                  count: pending.count,
                  amount: money(pending.amount),
                  status: t(STATUS_META[pending.statusIfConfirmed]?.key ?? "gatePage.status.compliant"),
                })
              : t("gatePage.warn.pending", { count: pending.count, amount: money(pending.amount) })}
          </Warning>
        )}
        {c.rejected?.count > 0 && (
          <Warning icon={Ban} tone="danger">
            {t("gatePage.warn.rejected", { count: c.rejected.count, amount: money(c.rejected.amount) })}
          </Warning>
        )}
      </ul>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-line bg-canvas p-4 sm:grid-cols-3">
        <Figure label={t("gatePage.fig.totalFees")} value={money(c.totalFees)} />
        {c.arrangement === "agreement" && c.agreedTotal != null && c.agreedTotal !== c.totalFees && (
          <Figure label={t("gatePage.fig.agreedTotal")} value={money(c.agreedTotal)} />
        )}
        <Figure label={t("gatePage.fig.expectedInstalment")} value={money(c.expectedInstalment)} />
        <Figure label={t("gatePage.fig.totalPaid")} value={money(c.totalPaid)} />
        <Figure label={t("gatePage.fig.outstandingDue")} value={money(c.outstandingDue)} strong />
        <Figure label={t("gatePage.fig.remainingBalance")} value={money(c.remainingBalance)} />
        <Figure
          label={t("gatePage.fig.nextDue")}
          value={c.nextDueDate
            ? t("gatePage.nextDueValue", { date: fmt.date(c.nextDueDate), amount: money(c.nextDueAmount) })
            : t("gatePage.none")}
        />
        <Figure label={t("gatePage.fig.arrangement")} value={arrangement} />
        <Figure
          label={t("gatePage.fig.lastPayment")}
          value={c.lastPaymentDate ? fmt.date(c.lastPaymentDate) : t("gatePage.none")}
        />
        {c.overdueSince && (
          <Figure label={t("gatePage.fig.overdueSince")} value={fmt.date(c.overdueSince)} />
        )}
      </dl>
    </div>
  );
}

export function VerificationCard({
  result, canVerify, canAuthorize, academicYear, schoolId, onAuthorizationChanged,
}: {
  result:        GateResult;
  canVerify:     boolean;
  canAuthorize:  boolean;
  academicYear:  string | null;
  schoolId:      string;
  onAuthorizationChanged: (studentId: string) => void;
}) {
  const { t } = useTranslation();
  const fmt = useFormat();
  const s = result.student;
  const DirIcon = result.direction === "out" ? LogOut : LogIn;

  return (
    <Card className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row">
        <StudentPhoto photoUrl={s?.photoUrl} name={s?.name} size="xl" shape="card" />

        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-2xl font-semibold leading-tight text-ink">
            {s?.name ?? t("gatePage.unknownCard")}
          </h2>
          {s ? (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
              <div><dt className="inline text-ink-muted">{t("gatePage.admissionNo")}: </dt><dd className="inline text-ink">{s.enrollmentNo ?? "—"}</dd></div>
              <div><dt className="inline text-ink-muted">{t("gatePage.class")}: </dt><dd className="inline text-ink">{s.className ?? "—"}</dd></div>
              {academicYear && (
                <div><dt className="inline text-ink-muted">{t("gatePage.academicYear")}: </dt><dd className="inline text-ink">{academicYear}</dd></div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-ink-muted">{t("gatePage.unknownCardHint")}</p>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
            {result.direction ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 font-semibold text-ink">
                <DirIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {result.direction === "out" ? t("gatePage.dirOut") : t("gatePage.dirIn")}
              </span>
            ) : (
              <span className="rounded-full border border-line bg-surface px-2.5 py-1 text-ink-muted">
                {t("gatePage.dirLater")}
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-ink-muted">
              {result.method === "manual"
                ? <Search className="h-3.5 w-3.5" aria-hidden="true" />
                : <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />}
              {result.method === "manual" ? t("gatePage.methodManual") : t("gatePage.methodCard")}
            </span>
            <span className="text-ink-muted">{fmt.time(result.at)}</span>
            {result.notified && (
              <span className="inline-flex items-center gap-1 text-ink-muted">
                <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
                {t("gatePage.notified")}
              </span>
            )}
          </div>

          {result.duplicate && (
            <p className="text-sm font-medium text-warning-text">{t("gatePage.duplicate")}</p>
          )}
          {result.replay && !result.duplicate && (
            <p className="text-sm text-ink-muted">{t("gatePage.replay")}</p>
          )}
          {result.queued && (
            <p className="flex items-center gap-1.5 text-sm text-info-text">
              <UploadCloud className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t("gatePage.queued")}
            </p>
          )}
        </div>
      </div>

      {/* Always a fee section after a scan: the full card, or a sentence
          saying why there is none. It used to be left out silently whenever
          this browser's (possibly stale) permission list lacked gate.verify,
          which read as a card with no fees rather than as a problem. */}
      {s && (
        result.compliance
          ? <FeePanel c={result.compliance} computedLocally={result.computedLocally} localPending={result.localPending} />
          : (
            <div
              role="status"
              className="flex items-start gap-2 rounded-control border border-warning-line bg-warning-soft px-3 py-2 text-sm text-warning-text"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                <span className="font-medium">{t("gatePage.feeUnavailable.title")}</span>{" "}
                {t(`gatePage.feeUnavailable.${result.feeUnavailable ?? "server_missing"}`)}
              </span>
            </div>
          )
      )}

      {canVerify && canAuthorize && s && (
        <AuthorizationPanel
          schoolId={schoolId}
          studentId={s._id}
          studentName={s.name}
          onChanged={() => onAuthorizationChanged(s._id)}
        />
      )}
    </Card>
  );
}
