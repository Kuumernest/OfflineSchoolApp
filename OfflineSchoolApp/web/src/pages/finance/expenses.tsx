// web/src/pages/finance/expenses.tsx
//
// Money going out. Same ledger rules as fees: whole XAF, append-only, and a
// mistake is voided rather than deleted — the row stays on the record and stops
// counting toward totals.

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation }  from "react-i18next";
import { Plus, Ban, Receipt } from "lucide-react";

import { useUser }          from "@/store/auth.store";
import { PageHeader }       from "@/components/ui/PageHeader";
import { Card }             from "@/components/ui/Card";
import { Button }           from "@/components/ui/Button";
import { Badge }            from "@/components/ui/Badge";
import { Modal }            from "@/components/ui/Modal";
import { PageSpinner }      from "@/components/ui/Spinner";
import { FormField, Input, SelectField, Textarea } from "@/components/ui/FormField";
import { useToast }         from "@/components/ui/Toast";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat }        from "@/i18n/format";
import { getErrorMessage }  from "@/lib/axios";
import {
  fetchCategories, createCategory,
  fetchExpenses, recordExpense, voidExpense,
} from "@/services/finance.service";
import type { SpendMethod } from "@/types/finance.types";
import { useAttemptId } from "@/hooks/useAttemptId";

const METHODS: SpendMethod[] = ["cash", "mobile_money", "bank", "cheque", "other"];

export default function ExpensesPage() {
  const { t }    = useTranslation();
  const fmt      = useFormat();
  const qc       = useQueryClient();
  const { toast, confirm } = useToast();
  const schoolId = useUser()?.schoolId ?? "";

  const [expenseOpen, setExpenseOpen]   = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);

  const [form, setForm] = useState({
    categoryId:  "",
    amount:      "",
    description: "",
    vendor:      "",
    method:      "cash" as SpendMethod,
    reference:   "",
  });
  const [catForm, setCatForm] = useState({ code: "", label: "", labelFr: "" });

  const categoriesQ = useQuery({
    queryKey: ["finance", "categories", schoolId],
    queryFn:  () => fetchCategories(schoolId),
    enabled:  !!schoolId,
  });

  const expensesQ = useQuery({
    queryKey: ["finance", "expenses", schoolId],
    queryFn:  () => fetchExpenses(schoolId),
    enabled:  !!schoolId,
  });

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["finance"] }); };

  // Expense carries no unique natural key at all — unlike a payment, which at
  // least has a receipt number — so a retried request is simply a second
  // expense. The server accepts a client-chosen _id and answers a repeat with
  // the row it already has.
  const attemptId = useAttemptId();

  const recordMutation = useMutation({
    mutationFn: () => {
      const payload = {
        schoolId,
        categoryId:  form.categoryId,
        amount:      Number(form.amount),
        description: form.description.trim() || null,
        vendor:      form.vendor.trim() || null,
        method:      form.method,
        reference:   form.reference.trim() || null,
      };
      return recordExpense({ _id: attemptId(payload), ...payload });
    },
    onSuccess: () => {
      toast({ kind: "success", title: t("expenses.recorded") });
      setExpenseOpen(false);
      setForm({ categoryId: "", amount: "", description: "", vendor: "", method: "cash", reference: "" });
      invalidate();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("expenses.record"), message: getErrorMessage(err) }),
  });

  const categoryMutation = useMutation({
    mutationFn: () =>
      createCategory({
        schoolId,
        code:    catForm.code.trim(),
        label:   catForm.label.trim(),
        labelFr: catForm.labelFr.trim() || null,
      }),
    onSuccess: () => {
      setCategoryOpen(false);
      setCatForm({ code: "", label: "", labelFr: "" });
      invalidate();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("expenses.newCategory"), message: getErrorMessage(err) }),
  });

  const voidMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      voidExpense(id, schoolId, reason),
    onSuccess: invalidate,
    onError: (err) =>
      toast({ kind: "error", title: t("expenses.void"), message: getErrorMessage(err) }),
  });

  // Whole francs only — told here rather than after the server rejects it.
  const amountError = useMemo(() => {
    if (form.amount === "") return undefined;
    const n = Number(form.amount);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return t("fees.amountHint");
    return undefined;
  }, [form.amount, t]);

  if (expensesQ.isLoading) return <PageSpinner />;

  const categories = categoriesQ.data ?? [];
  const rows       = expensesQ.data?.rows ?? [];
  const total      = expensesQ.data?.total ?? 0;
  const byId       = new Map(categories.map((c) => [c._id, c]));

  const askVoid = async (id: string) => {
    const ok = await confirm({
      title:        t("expenses.voidTitle"),
      message:      t("expenses.voidBody"),
      confirmLabel: t("expenses.void"),
      kind:         "danger",
    });
    if (ok) voidMutation.mutate({ id, reason: t("expenses.voidTitle") });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("expenses.title")}
        description={t("expenses.blurb")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setCategoryOpen(true)}>
              {t("expenses.newCategory")}
            </Button>
            <Button
              icon={<Receipt className="h-4 w-4" />}
              onClick={() => setExpenseOpen(true)}
              disabled={categories.length === 0}
            >
              {t("expenses.record")}
            </Button>
          </>
        }
      />

      <Card className="sm:max-w-xs">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          {t("expenses.totalSpent")}
        </p>
        <p className="mt-2 font-display text-[30px] leading-none text-ink tabular">
          {fmt.money(total)}
        </p>
      </Card>

      <Card padding={false}>
        {rows.length === 0 ? (
          <EmptyTable
            title={t("expenses.none")}
            subtitle={
              categories.length === 0 ? t("expenses.noCategories") : t("expenses.noneHint")
            }
          />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("expenses.incurredAt")}</Th>
                <Th>{t("expenses.category")}</Th>
                <Th>{t("common.description")}</Th>
                <Th>{t("expenses.vendor")}</Th>
                <Th numeric>{t("fees.amount")}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {rows.map((e) => {
                const void_ = Boolean(e.voidedAt);
                // A missing status is an expense from before approvals existed
                // and counts, exactly as the server reads it. Only an explicit
                // "pending" or "rejected" is outside the accounts.
                const waiting  = e.status === "pending";
                const refused  = e.status === "rejected";
                const excluded = void_ || waiting || refused;
                return (
                  <Tr key={e._id}>
                    <Td className="text-ink-muted">{fmt.dateShort(e.incurredAt)}</Td>
                    <Td className="font-medium text-ink">
                      {byId.get(e.categoryId)?.label ?? e.categoryId}
                    </Td>
                    <Td className="text-ink-muted">{e.description ?? "—"}</Td>
                    <Td className="text-ink-muted">{e.vendor ?? "—"}</Td>
                    <Td
                      numeric
                      className={
                        excluded ? "text-ink-faint line-through" : "font-medium text-ink"
                      }
                    >
                      {/*
                        Struck through while waiting, and that is the honest
                        rendering: the row exists, the money has left, and it is
                        not in the school's figures until somebody signs it off.
                        Showing it as a normal amount would have the bursar
                        reconcile against a total the reports do not contain.
                      */}
                      {fmt.money(e.amount)}
                    </Td>
                    <Td numeric>
                      {void_ ? (
                        <Badge variant="default">{t("expenses.voided")}</Badge>
                      ) : waiting ? (
                        <Badge variant="warning">{t("expenses.awaitingApproval")}</Badge>
                      ) : refused ? (
                        <Badge variant="default">{t("expenses.rejected")}</Badge>
                      ) : (
                        <button
                          type="button"
                          onClick={() => askVoid(e._id)}
                          className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-canvas hover:text-danger"
                        >
                          <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("expenses.void")}
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

      {/* Record an expense */}
      <Modal open={expenseOpen} onClose={() => setExpenseOpen(false)} title={t("expenses.record")}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!amountError && form.amount && form.categoryId) recordMutation.mutate();
          }}
        >
          <FormField label={t("expenses.category")} required>
            <SelectField
              value={form.categoryId}
              onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}
              placeholder={t("expenses.category")}
              options={categories.map((c) => ({ value: c._id, label: c.label }))}
            />
          </FormField>

          <FormField label={t("fees.amount")} required error={amountError} hint={t("fees.amountHint")}>
            <Input
              type="number" step="1" min="1" inputMode="numeric"
              value={form.amount}
              invalid={Boolean(amountError)}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              autoFocus
            />
          </FormField>

          <FormField label={t("common.description")}>
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </FormField>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label={t("expenses.vendor")}>
              <Input
                value={form.vendor}
                onChange={(e) => setForm((f) => ({ ...f, vendor: e.target.value }))}
              />
            </FormField>
            <FormField label={t("fees.method")} required>
              <SelectField
                value={form.method}
                onChange={(e) => setForm((f) => ({ ...f, method: e.target.value as SpendMethod }))}
                options={METHODS.map((m) => ({ value: m, label: t(`method.${m}`) }))}
              />
            </FormField>
          </div>

          <FormField label={t("fees.reference")}>
            <Input
              value={form.reference}
              onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
            />
          </FormField>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="secondary" onClick={() => setExpenseOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={recordMutation.isPending}
              disabled={!form.amount || !form.categoryId || Boolean(amountError)}
            >
              {t("expenses.record")}
            </Button>
          </div>
        </form>
      </Modal>

      {/* New category */}
      <Modal open={categoryOpen} onClose={() => setCategoryOpen(false)} title={t("expenses.newCategory")} size="sm">
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); categoryMutation.mutate(); }}
        >
          <FormField label={t("expenses.categoryCode")} required>
            <Input
              placeholder="utilities"
              value={catForm.code}
              onChange={(e) => setCatForm((f) => ({ ...f, code: e.target.value }))}
            />
          </FormField>
          <FormField label={t("expenses.categoryLabel")} required>
            <Input
              value={catForm.label}
              onChange={(e) => setCatForm((f) => ({ ...f, label: e.target.value }))}
            />
          </FormField>
          <FormField label={t("fees.itemLabelFr")}>
            <Input
              value={catForm.labelFr}
              onChange={(e) => setCatForm((f) => ({ ...f, labelFr: e.target.value }))}
            />
          </FormField>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="secondary" onClick={() => setCategoryOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              icon={<Plus className="h-4 w-4" />}
              loading={categoryMutation.isPending}
              disabled={!catForm.code.trim() || !catForm.label.trim()}
            >
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
