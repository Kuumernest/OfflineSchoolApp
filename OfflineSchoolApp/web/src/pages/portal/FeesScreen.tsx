// web/src/pages/portal/FeesScreen.tsx
//
// Fees for the selected child: the balance from the family ledger (the one
// fees.service function the office's own screens read), overdue and the due
// date by the school's own rule (the figure on Home), every charge with its
// due date, the payment plan when there is one, and every payment with its
// receipt.
//
// No charge is marked overdue on its own: a charge's date says nothing about
// whether the payments already made have covered it. Overdue is the account's
// state, said once, at the top.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Printer, Wallet, CheckCircle2, AlertCircle, CalendarClock, Receipt } from "lucide-react";

import { useFormat } from "@/i18n/format";
import { cn } from "@/utils/cn";
import { printHtml } from "@/print/document";
import { useSingleFlight } from "@/hooks/useSingleFlight";
import { fetchFees, fetchFeeReminders, fetchHome, fetchReceiptHtml } from "@/services/portal.service";
import { PortalCard, Skeleton, EmptyState } from "./ui";

export function FeesScreen({ studentId, childName }: { studentId: string | null; childName: string | null }) {
  const { t, i18n } = useTranslation();
  const fmt = useFormat();
  const receipts = useSingleFlight();
  const [failed, setFailed] = useState<string | null>(null);

  const feesQ = useQuery({ queryKey: ["portal", "fees", studentId], queryFn: () => fetchFees(studentId), enabled: Boolean(studentId), retry: false });
  const planQ = useQuery({ queryKey: ["portal", "fee-reminders", studentId], queryFn: () => fetchFeeReminders(studentId), enabled: Boolean(studentId), retry: false });
  // The same overdue figure Home shows: one rule, the school's.
  const homeQ = useQuery({ queryKey: ["portal", "home"], queryFn: fetchHome, retry: false, staleTime: 60_000 });
  const status = homeQ.data?.children.find((c) => c._id === studentId)?.fees ?? null;

  // One receipt at a time; its button says "Preparing…" until the print
  // dialog has it, and a second tap does nothing.
  const printReceipt = (paymentId: string) => receipts.run(paymentId, async () => {
    setFailed(null);
    try {
      await printHtml(await fetchReceiptHtml(paymentId, i18n.resolvedLanguage ?? "en", studentId));
    } catch {
      setFailed(paymentId);
    }
  });

  if (feesQ.isLoading || !studentId) return <FeesSkeleton />;
  const fees = feesQ.data;
  if (!fees || (fees.charges.length === 0 && fees.payments.length === 0)) {
    return (
      <PortalCard>
        <EmptyState icon={<Wallet className="h-6 w-6" />} title={t("portal.feesScreen.empty")} hint={t("portal.feesScreen.emptyHint")} />
      </PortalCard>
    );
  }

  const owes = fees.totals.balance > 0;
  const overdue = owes && Boolean(status?.isOverdue);
  const plan = planQ.data?.hasPlan ? planQ.data.plan : null;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-ink">{t("portal.feesScreen.title")}</h1>

      {/* The balance, said first and once. */}
      <PortalCard className={cn("p-5", overdue && "border-danger-line")}>
        {owes ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-ink-muted">{t("portal.feesScreen.balance")}</p>
              {overdue && (
                <span className="inline-flex items-center gap-1 rounded-full border border-danger-line bg-danger-soft px-2.5 py-0.5 text-xs font-semibold text-danger">
                  <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />{t("portal.feesScreen.overdue")}
                </span>
              )}
            </div>
            <p className={cn("mt-1 text-3xl font-semibold tabular-nums", overdue ? "text-danger" : "text-ink")}>{fmt.money(fees.totals.balance)}</p>
            {status?.dueDate && (
              <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-body">
                <CalendarClock className="h-4 w-4 text-ink-muted" aria-hidden="true" />
                {overdue ? t("portal.feesScreen.overdueSince", { date: fmt.date(status.dueDate) }) : t("portal.feesScreen.dueOn", { date: fmt.date(status.dueDate) })}
              </p>
            )}
          </>
        ) : (
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-9 w-9 shrink-0 text-success" aria-hidden="true" />
            <div>
              <p className="text-lg font-semibold text-ink">{t("portal.feesScreen.paidUp")}</p>
              <p className="text-sm text-ink-muted">{t("portal.feesScreen.paidUpHint", { name: childName ?? "" })}</p>
            </div>
          </div>
        )}
        <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
          <div className="flex justify-between gap-3"><dt className="text-ink-muted">{t("portal.feesScreen.charged")}</dt><dd className="font-medium tabular-nums text-ink">{fmt.money(fees.totals.charged)}</dd></div>
          {fees.totals.waived > 0 && (
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">{t("portal.feesScreen.waived")}</dt><dd className="font-medium tabular-nums text-ink">−{fmt.money(fees.totals.waived)}</dd></div>
          )}
          <div className="flex justify-between gap-3"><dt className="text-ink-muted">{t("portal.feesScreen.paid")}</dt><dd className="font-medium tabular-nums text-success">−{fmt.money(fees.totals.paid)}</dd></div>
        </dl>
      </PortalCard>

      {/* Charges, each with its due date. */}
      <PortalCard className="overflow-hidden">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">{t("portal.feesScreen.charges")}</h2>
        <ul>
          {fees.charges.map((c) => (
            <li key={c._id} className="flex min-h-14 items-center justify-between gap-3 border-t border-line px-4 py-3 first:border-t-0">
              <div className="min-w-0">
                <p className="font-medium text-ink">{c.label ?? c.code}</p>
                <p className="text-xs text-ink-muted">
                  {c.dueDate ? t("portal.feesScreen.dueBy", { date: fmt.date(c.dueDate) }) : t("portal.feesScreen.noDueDate")}
                  {c.waivedAmount > 0 ? ` · ${t("portal.feesScreen.waived")} ${fmt.money(c.waivedAmount)}` : ""}
                </p>
              </div>
              <p className="shrink-0 font-semibold tabular-nums text-ink">{fmt.money(c.amount)}</p>
            </li>
          ))}
        </ul>
      </PortalCard>

      {plan && (
        <PortalCard className="overflow-hidden">
          <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">{t("portal.feesScreen.plan")}</h2>
          <ul>
            {plan.instalments.map((i) => (
              <li key={i.seq} className="flex min-h-12 items-center justify-between border-t border-line px-4 py-2.5 text-sm first:border-t-0">
                <span className="text-ink">{t("portal.feesScreen.instalment", { seq: i.seq })} · <span className="text-ink-muted">{fmt.date(i.dueDate)}</span></span>
                <span className="font-medium tabular-nums text-ink">{fmt.money(i.amount)}</span>
              </li>
            ))}
          </ul>
        </PortalCard>
      )}

      {/* Payments, each with its receipt. */}
      <PortalCard className="overflow-hidden">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">{t("portal.feesScreen.payments")}</h2>
        {fees.payments.length === 0 ? (
          <EmptyState icon={<Receipt className="h-6 w-6" />} title={t("portal.feesScreen.noPayments")} />
        ) : (
          <ul>
            {[...fees.payments].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).map((p) => (
              <li key={p._id} className="border-t border-line px-4 py-3 first:border-t-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className={cn("font-semibold tabular-nums", p.isReversal ? "text-danger" : "text-ink")}>
                      {p.isReversal ? "−" : ""}{fmt.money(Math.abs(p.amount))}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {fmt.date(p.receivedAt)}
                      {p.method ? ` · ${t(`method.${p.method}`, { defaultValue: p.method })}` : ""}
                      {p.receiptNo ? ` · ${p.receiptNo}` : ""}
                      {p.isReversal ? ` · ${t("portal.feesScreen.reversal")}` : ""}
                    </p>
                  </div>
                  {!p.isReversal && (
                    <button type="button" onClick={() => printReceipt(p._id)} disabled={receipts.busy}
                      aria-label={t("portal.feesScreen.receiptFor", { no: p.receiptNo ?? "" })}
                      className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border border-line-strong px-3 text-sm font-medium text-ink hover:bg-surface-muted disabled:opacity-60">
                      <Printer className="h-4 w-4" aria-hidden="true" />{receipts.busyKey === p._id ? t("common.preparing") : t("portal.feesScreen.receipt")}
                    </button>
                  )}
                </div>
                {failed === p._id && <p role="alert" className="mt-1 text-xs text-danger">{t("portal.feesScreen.receiptFailed")}</p>}
              </li>
            ))}
          </ul>
        )}
      </PortalCard>
    </div>
  );
}

function FeesSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-20" />
      <Skeleton className="h-44 w-full rounded-card" />
      <Skeleton className="h-48 w-full rounded-card" />
    </div>
  );
}
