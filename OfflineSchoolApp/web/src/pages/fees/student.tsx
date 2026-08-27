// web/src/pages/fees/student.tsx
//
// One student's ledger: what was billed, what was paid, what is left.
//
// The balance shown here is the server's, never a sum computed in the browser.
// Two screens doing their own arithmetic is how a fee system starts giving two
// different answers to the same question.

import { useState, useMemo }              from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient }   from "@tanstack/react-query";
import { useTranslation }                 from "react-i18next";
import { ArrowLeft, Receipt, Undo2 }      from "lucide-react";

import { useUser }        from "@/store/auth.store";
import { PageHeader }     from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button }         from "@/components/ui/Button";
import { Badge }          from "@/components/ui/Badge";
import { Modal }          from "@/components/ui/Modal";
import { PageSpinner }    from "@/components/ui/Spinner";
import { FormField, Input, SelectField, Textarea } from "@/components/ui/FormField";
import { useToast }       from "@/components/ui/Toast";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat }      from "@/i18n/format";
import { getErrorMessage } from "@/lib/api";
import {
  fetchStudentAccount,
  recordPayment,
  reversePayment,
} from "@/services/fee.service";
import type { PaymentMethod } from "@/types/fees.types";
import PaymentPlanPanel from "@/pages/fees/PaymentPlanPanel";

const METHODS: PaymentMethod[] = [
  "cash", "mobile_money", "bank", "cheque", "waiver", "other",
];

export default function StudentFeeAccountPage() {
  const { t }        = useTranslation();
  const fmt          = useFormat();
  const navigate     = useNavigate();
  const qc           = useQueryClient();
  const { toast, confirm } = useToast();
  const schoolId     = useUser()?.schoolId ?? "";
  const { studentId = "" } = useParams();
  const [params]     = useSearchParams();
  const year         = params.get("year") ?? "";

  const [payOpen, setPayOpen] = useState(false);
  const [form, setForm] = useState({
    amount:    "",
    method:    "cash" as PaymentMethod,
    reference: "",
    note:      "",
  });

  const accountQ = useQuery({
    queryKey: ["fees", "account", studentId, schoolId, year],
    queryFn:  () => fetchStudentAccount(studentId, schoolId, year || undefined),
    enabled:  !!schoolId && !!studentId,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["fees"] });
  };

  const payMutation = useMutation({
    mutationFn: () =>
      recordPayment({
        schoolId,
        studentId,
        academicYear: year,
        amount:       Number(form.amount),
        method:       form.method,
        reference:    form.reference.trim() || null,
        note:         form.note.trim() || null,
      }),
    onSuccess: ({ payment }) => {
      toast({
        kind:    "success",
        title:   t("fees.recorded"),
        message: payment.receiptNo ?? undefined,
      });
      setPayOpen(false);
      setForm({ amount: "", method: "cash", reference: "", note: "" });
      invalidate();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("fees.recordFailed"), message: getErrorMessage(err) }),
  });

  const reverseMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      reversePayment(id, schoolId, reason),
    onSuccess: () => {
      toast({ kind: "success", title: t("fees.reversed") });
      invalidate();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("fees.reverseFailed"), message: getErrorMessage(err) }),
  });

  // Whole francs only. The server rejects anything else, but catching it here
  // means the bursar is told before the request rather than after.
  const amountError = useMemo(() => {
    if (form.amount === "") return undefined;
    const n = Number(form.amount);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return t("fees.amountHint");
    }
    return undefined;
  }, [form.amount, t]);

  if (accountQ.isLoading) return <PageSpinner />;

  const account  = accountQ.data;
  const totals   = account?.totals;
  const balance  = totals?.balance ?? 0;

  const askReverse = async (id: string, amount: number) => {
    const ok = await confirm({
      title:        t("fees.reverseTitle"),
      message:      t("fees.reverseBody", { amount: fmt.money(-amount) }),
      confirmLabel: t("fees.reverse"),
      kind:         "danger",
    });
    if (!ok) return;
    // The server requires a reason; the confirm dialog has no free-text field,
    // so the operator's intent is recorded as the standard correction note.
    reverseMutation.mutate({ id, reason: t("fees.reverseTitle") });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("fees.account")}
        meta={year ? <span>{year}</span> : undefined}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<ArrowLeft className="h-4 w-4" />}
              onClick={() => navigate("/fees")}
            >
              {t("common.back")}
            </Button>
            <Button icon={<Receipt className="h-4 w-4" />} onClick={() => setPayOpen(true)}>
              {t("fees.recordPayment")}
            </Button>
          </>
        }
      />

      {/* The arrangement, directly under the balance it reschedules.
          Renders nothing when there is no plan and nothing outstanding, and
          nothing at all if the school has taken fees.plan away from this role. */}
      <PaymentPlanPanel
        schoolId={schoolId}
        studentId={studentId}
        academicYear={year}
        balance={balance}
        paid={totals?.paid ?? 0}
        plan={account?.plan ?? null}
        status={account?.planStatus ?? null}
      />

      {/* Balance first — it is the reason anyone opens this page. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: t("fees.charged"), value: totals?.charged ?? 0 },
          { label: t("fees.waived"),  value: totals?.waived  ?? 0 },
          { label: t("fees.paid"),    value: totals?.paid    ?? 0 },
        ].map((s) => (
          <Card key={s.label}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
              {s.label}
            </p>
            <p className="mt-1.5 font-display text-[22px] leading-none text-ink tabular">
              {fmt.money(s.value)}
            </p>
          </Card>
        ))}

        <Card>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            {t("fees.balance")}
          </p>
          <p
            className={`mt-1.5 font-display text-[22px] leading-none tabular ${
              balance > 0 ? "text-danger" : "text-success"
            }`}
          >
            {fmt.money(balance)}
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            {balance > 0 ? t("fees.owes") : balance < 0 ? t("fees.credit") : t("fees.settled")}
          </p>
        </Card>
      </div>

      {/* Charges */}
      <Card padding={false}>
        <div className="p-5 pb-0">
          <CardHeader title={t("fees.charges")} />
        </div>
        {(account?.charges.length ?? 0) === 0 ? (
          <EmptyTable title={t("fees.noCharges")} subtitle={t("fees.noChargesHint")} />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("fees.itemLabel")}</Th>
                <Th>{t("academic.term")}</Th>
                <Th numeric>{t("fees.charged")}</Th>
                <Th numeric>{t("fees.waived")}</Th>
              </Tr>
            </THead>
            <TBody>
              {account?.charges.map((c) => (
                <Tr key={c._id}>
                  <Td className="font-medium text-ink">
                    {c.label}
                    {c.voidedAt && (
                      <Badge variant="default" className="ml-2">
                        {t("fees.reversed")}
                      </Badge>
                    )}
                  </Td>
                  <Td className="text-ink-muted">{c.term ?? t("fees.wholeYear")}</Td>
                  <Td numeric className={c.voidedAt ? "text-ink-faint line-through" : ""}>
                    {fmt.money(c.amount)}
                  </Td>
                  <Td numeric className="text-ink-muted">
                    {c.waivedAmount ? fmt.money(c.waivedAmount) : "—"}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {/* Payments */}
      <Card padding={false}>
        <div className="p-5 pb-0">
          <CardHeader title={t("fees.payments")} />
        </div>
        {(account?.payments.length ?? 0) === 0 ? (
          <EmptyTable title={t("fees.noPayments")} />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("fees.receiptNo")}</Th>
                <Th>{t("fees.receivedOn")}</Th>
                <Th>{t("fees.method")}</Th>
                <Th>{t("fees.reference")}</Th>
                <Th numeric>{t("fees.amount")}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {account?.payments.map((p) => {
                const isReversal = Boolean(p.reversesId);
                const isReversed = Boolean(p.reversedById);
                return (
                  <Tr key={p._id}>
                    <Td className="font-medium text-ink">{p.receiptNo ?? "—"}</Td>
                    <Td className="text-ink-muted">{fmt.dateShort(p.receivedAt)}</Td>
                    <Td className="text-ink-muted">{t(`method.${p.method}`)}</Td>
                    <Td className="text-ink-muted">{p.reference ?? "—"}</Td>
                    <Td
                      numeric
                      className={
                        isReversal
                          ? "text-danger"
                          : isReversed
                            ? "text-ink-faint line-through"
                            : "font-medium text-ink"
                      }
                    >
                      {fmt.money(p.amount)}
                    </Td>
                    <Td numeric>
                      {isReversal ? (
                        <Badge variant="danger">{t("fees.reversalOf")}</Badge>
                      ) : isReversed ? (
                        <Badge variant="default">{t("fees.reversed")}</Badge>
                      ) : (
                        <button
                          type="button"
                          onClick={() => askReverse(p._id, p.amount)}
                          className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-canvas hover:text-danger"
                        >
                          <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("fees.reverse")}
                        </button>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      {/* Record a payment */}
      <Modal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        title={t("fees.recordPayment")}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!amountError && form.amount) payMutation.mutate();
          }}
        >
          <FormField label={t("fees.amount")} required error={amountError} hint={t("fees.amountHint")}>
            <Input
              type="number"
              step="1"
              min="1"
              inputMode="numeric"
              value={form.amount}
              invalid={Boolean(amountError)}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              autoFocus
            />
          </FormField>

          <FormField label={t("fees.method")} required>
            <SelectField
              value={form.method}
              onChange={(e) =>
                setForm((f) => ({ ...f, method: e.target.value as PaymentMethod }))
              }
              options={METHODS.map((m) => ({ value: m, label: t(`method.${m}`) }))}
            />
          </FormField>

          <FormField label={t("fees.reference")} hint={t("fees.referenceHint")}>
            <Input
              value={form.reference}
              onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
            />
          </FormField>

          <FormField label={t("common.notes")}>
            <Textarea
              rows={2}
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </FormField>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="secondary" onClick={() => setPayOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={payMutation.isPending}
              disabled={!form.amount || Boolean(amountError)}
            >
              {t("fees.recordPayment")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
