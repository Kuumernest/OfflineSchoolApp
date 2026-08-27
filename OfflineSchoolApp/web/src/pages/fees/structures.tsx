// web/src/pages/fees/structures.tsx
//
// Fee structures: what a class is charged, per year and term.
//
// A structure is published, not edited. Once it has raised charges, changing it
// would silently rewrite what a parent was told they owed — so the only edit
// offered here is "deactivate and publish a replacement".

import { useState }        from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate }     from "react-router-dom";
import { useTranslation }  from "react-i18next";
import { Plus, Trash2, Play, ArrowLeft, Check } from "lucide-react";

import { useUser }          from "@/store/auth.store";
import { PageHeader }       from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button }           from "@/components/ui/Button";
import { Badge }            from "@/components/ui/Badge";
import { Modal }            from "@/components/ui/Modal";
import { PageSpinner }      from "@/components/ui/Spinner";
import { FormField, Input, Checkbox } from "@/components/ui/FormField";
import { useToast }         from "@/components/ui/Toast";
import { EmptyTable }       from "@/components/ui/DataTable";
import { useFormat }        from "@/i18n/format";
import { cn }               from "@/utils/cn";
import { getErrorMessage }  from "@/lib/api";
import {
  fetchStructures,
  createStructure,
  deactivateStructure,
  applyStructure,
} from "@/services/fee.service";
import { fetchClasses }     from "@/services/class.service";
import type { FeeItem }     from "@/types/fees.types";

const emptyItem = (): FeeItem => ({
  code: "", label: "", labelFr: "", amount: 0, isOptional: false,
});

// Academic year options: last year through two years ahead, "YYYY/YYYY+1".
const ACADEMIC_YEAR_OPTIONS = (() => {
  const y = new Date().getFullYear();
  return [-1, 0, 1, 2].map((i) => `${y + i}/${y + i + 1}`);
})();

export default function FeeStructuresPage() {
  const { t }    = useTranslation();
  const fmt      = useFormat();
  const navigate = useNavigate();
  const qc       = useQueryClient();
  const { toast, confirm } = useToast();
  const schoolId = useUser()?.schoolId ?? "";

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    academicYear: ACADEMIC_YEAR_OPTIONS[1],
    classIds:     [] as string[],
    term:         "",
    /**
     * The last day these fees may be paid without being late.
     *
     * Held as the "YYYY-MM-DD" string a native date input produces and sent as
     * that string, never as a Date. Turning it into a Date in the browser and
     * serialising it would shift the day by one for anybody west of UTC, and a
     * fee due on the 15th arriving at the server as the 14th is the kind of bug
     * that surfaces as an angry parent.
     */
    dueDate:      "",
    penaltyMode:  "none" as "none" | "fixed" | "percent",
    penaltyAmount: "",
    penaltyGrace: "0",
    items:        [emptyItem()],
  });

  const classesQ = useQuery({
    queryKey: ["classes", schoolId],
    queryFn:  () => fetchClasses(schoolId),
    enabled:  !!schoolId,
  });

  const structuresQ = useQuery({
    queryKey: ["fees", "structures", schoolId],
    queryFn:  () => fetchStructures(schoolId),
    enabled:  !!schoolId,
  });

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["fees"] }); };

  const createMutation = useMutation({
    mutationFn: () =>
      createStructure({
        schoolId,
        academicYear: form.academicYear.trim(),
        classIds:     form.classIds,
        term:         form.term.trim() || null,
        dueDate:      form.dueDate,
        penalty: {
          mode:      form.penaltyMode,
          amount:    form.penaltyMode === "none" ? 0 : Number(form.penaltyAmount) || 0,
          graceDays: Number(form.penaltyGrace) || 0,
        },
        items: form.items
          .filter((i) => i.code.trim() && i.label.trim())
          .map((i) => ({
            code:       i.code.trim(),
            label:      i.label.trim(),
            labelFr:    i.labelFr?.trim() || null,
            amount:     Number(i.amount),
            isOptional: Boolean(i.isOptional),
          })),
      }),
    onSuccess: () => {
      setOpen(false);
      setForm({
        academicYear: "", classIds: [], term: "", dueDate: "",
        penaltyMode: "none", penaltyAmount: "", penaltyGrace: "0",
        items: [emptyItem()],
      });
      invalidate();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("common.save"), message: getErrorMessage(err) }),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateStructure(id, schoolId),
    onSuccess:  invalidate,
    onError: (err) => toast({ kind: "error", title: t("fees.deactivate"), message: getErrorMessage(err) }),
  });

  const applyMutation = useMutation({
    mutationFn: (id: string) => applyStructure(id, schoolId),
    onSuccess: (res) => {
      toast({ kind: "success", title: t("fees.applied"), message: res.message });
      invalidate();
    },
    onError: (err) =>
      toast({ kind: "error", title: t("fees.apply"), message: getErrorMessage(err) }),
  });

  const askApply = async (id: string) => {
    const ok = await confirm({
      title:        t("fees.applyTitle"),
      message:      t("fees.applyBody"),
      confirmLabel: t("fees.apply"),
    });
    if (ok) applyMutation.mutate(id);
  };

  if (structuresQ.isLoading) return <PageSpinner />;

  const structures  = structuresQ.data ?? [];
  const classes     = classesQ.data ?? [];
  const classesById = new Map(classes.map((c) => [c._id, c.name]));

  const setItem = (idx: number, patch: Partial<FeeItem>) =>
    setForm((f) => ({
      ...f,
      items: f.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    }));

  const formTotal = form.items.reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("fees.structures")}
        description={t("fees.structuresBlurb")}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<ArrowLeft className="h-4 w-4" />}
              onClick={() => navigate("/fees")}
            >
              {t("common.back")}
            </Button>
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
              {t("fees.newStructure")}
            </Button>
          </>
        }
      />

      {structures.length === 0 ? (
        <Card padding={false}>
          <EmptyTable
            title={t("fees.noStructures")}
            subtitle={t("fees.noStructuresHint")}
            action={
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
                {t("fees.newStructure")}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {structures.map((s) => (
            <Card key={s._id}>
              <CardHeader
                title={`${s.academicYear} · ${s.term ?? t("fees.wholeYear")}`}
                subtitle={
                  s.classIds?.length
                    ? s.classIds.map((id) => classesById.get(id) ?? id).join(", ")
                    : t("fees.everyClass")
                }
                action={
                  s.isActive
                    ? <Badge variant="success">{t("common.active")}</Badge>
                    : <Badge variant="default">{t("fees.inactive")}</Badge>
                }
              />

              <ul className="space-y-1.5">
                {s.items.map((item) => (
                  <li
                    key={item.code}
                    className="flex items-center justify-between gap-3 border-b border-line py-1.5 last:border-b-0"
                  >
                    <span className="min-w-0 truncate text-[13px] text-ink-body">
                      {item.label}
                      {item.isOptional && (
                        <Badge variant="default" className="ml-2">
                          {t("fees.optional")}
                        </Badge>
                      )}
                    </span>
                    <span className="shrink-0 text-sm font-medium text-ink tabular">
                      {fmt.money(item.amount)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                  {t("common.total")}
                </span>
                <span className="font-display text-lg text-ink tabular">
                  {fmt.money(s.items.reduce((sum, i) => sum + i.amount, 0))}
                </span>
              </div>

              {s.isActive && (
                <div className="mt-4 flex gap-2">
                  <Button
                    size="sm"
                    icon={<Play className="h-4 w-4" />}
                    loading={applyMutation.isPending}
                    onClick={() => askApply(s._id)}
                  >
                    {t("fees.apply")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => deactivateMutation.mutate(s._id)}
                  >
                    {t("fees.deactivate")}
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* New structure */}
      <Modal open={open} onClose={() => setOpen(false)} title={t("fees.newStructure")} size="lg">
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); createMutation.mutate(); }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label={t("fees.academicYear")} required>
              {/* Picked, not typed — free-text years caused mismatched
                  "2025/2026" vs "2025/2026 " keys across fee records. */}
              <select
                value={form.academicYear}
                onChange={(e) => setForm((f) => ({ ...f, academicYear: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 bg-white text-sm outline-none focus:ring-2 focus:ring-primary-500"
              >
                {(ACADEMIC_YEAR_OPTIONS.includes(form.academicYear)
                  ? ACADEMIC_YEAR_OPTIONS
                  : [form.academicYear, ...ACADEMIC_YEAR_OPTIONS]
                ).map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </FormField>

            {/*
              Required, and marked so. Everything that chases an unpaid bill —
              which families to remind, who has earned a late fee — is
              calculated from this date, so a structure without one is a bill
              nobody can ever be chased for. Asked here, at setup, while the
              person entering the price list still knows the answer.
            */}
            <FormField
              label={t("fees.dueDate")}
              hint={t("fees.dueDateHint")}
              required
            >
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
              />
            </FormField>

            <FormField label={t("academic.term")}>
              <Input
                placeholder={t("fees.wholeYear")}
                value={form.term}
                onChange={(e) => setForm((f) => ({ ...f, term: e.target.value }))}
              />
            </FormField>
          </div>

          {/*
            A checkbox grid, not <select multiple>. A native multiple select
            needs ctrl-click to add and drops the whole selection on a stray
            click — unusable for something that decides who gets billed. Here
            every class is visible and each is one tap.

            The query's three states stay distinguished: rendering an empty list
            for "loading", "failed" and "this school has no classes" told the
            user nothing and disguised a failure as an empty school.
          */}
          <FormField
            label={t("fees.classesLabel")}
            error={classesQ.isError ? getErrorMessage(classesQ.error) : undefined}
            hint={
              classesQ.isError
                ? undefined
                : classesQ.isLoading
                  ? t("fees.classesLoading")
                  : classes.length === 0
                    ? t("fees.noClassesYet")
                    : t("fees.classesHint")
            }
          >
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-xs text-ink-muted">
                  {form.classIds.length
                    ? t("fees.selectedCount", { count: form.classIds.length })
                    : t("fees.everyClass")}
                </span>
                {classes.length > 0 && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setForm((f) => ({ ...f, classIds: classes.map((c) => c._id) }))
                      }
                      className="rounded-control px-2 py-1 text-xs font-medium text-primary-600 hover:bg-primary-50"
                    >
                      {t("fees.selectAll")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, classIds: [] }))}
                      className="rounded-control px-2 py-1 text-xs font-medium text-ink-muted hover:bg-canvas"
                    >
                      {t("fees.clearSelection")}
                    </button>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {classes.map((c) => {
                  const on = form.classIds.includes(c._id);
                  return (
                    <button
                      key={c._id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          classIds: on
                            ? f.classIds.filter((id) => id !== c._id)
                            : [...f.classIds, c._id],
                        }))
                      }
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1.5",
                        "text-[13px] font-medium transition-colors",
                        on
                          ? "border-primary-600 bg-primary-600 text-white"
                          : "border-line-strong bg-surface text-ink-body hover:bg-canvas"
                      )}
                    >
                      {on && <Check className="h-3 w-3" aria-hidden="true" />}
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>
          </FormField>

          {/* ── Late fees ─────────────────────────────────────────────────
              Off unless a school asks for it. A late fee is money added to a
              family's bill, and a school that has not decided to charge one
              must not start charging it because a field defaulted.

              Never applied automatically either: the bursar raises them from a
              preview on the arrears page, so somebody has read the list of
              families first. */}
          <div>
            <p className="mb-2 text-[13px] font-medium text-ink-body">
              {t("fees.penalty")}
            </p>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <FormField label={t("fees.penaltyMode")}>
                <select
                  value={form.penaltyMode}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      penaltyMode: e.target.value as "none" | "fixed" | "percent",
                    }))
                  }
                  className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary-400"
                >
                  <option value="none">{t("fees.penaltyNone")}</option>
                  <option value="fixed">{t("fees.penaltyFixed")}</option>
                  <option value="percent">{t("fees.penaltyPercent")}</option>
                </select>
              </FormField>

              {form.penaltyMode !== "none" && (
                <>
                  <FormField
                    label={
                      form.penaltyMode === "percent"
                        ? t("fees.penaltyRate")
                        : t("fees.penaltyAmount")
                    }
                    hint={
                      form.penaltyMode === "percent"
                        ? t("fees.penaltyRateHint")
                        : undefined
                    }
                  >
                    <Input
                      inputMode="numeric"
                      value={form.penaltyAmount}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, penaltyAmount: e.target.value }))
                      }
                    />
                  </FormField>

                  <FormField
                    label={t("fees.penaltyGrace")}
                    hint={t("fees.penaltyGraceHint")}
                  >
                    <Input
                      inputMode="numeric"
                      value={form.penaltyGrace}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, penaltyGrace: e.target.value }))
                      }
                    />
                  </FormField>
                </>
              )}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[13px] font-medium text-ink-body">{t("fees.items")}</p>
              <span className="text-sm font-medium text-ink tabular">
                {fmt.money(formTotal)}
              </span>
            </div>

            <div className="space-y-2">
              {form.items.map((item, idx) => (
                <div
                  key={idx}
                  className="grid grid-cols-12 items-start gap-2 rounded-control border border-line p-2.5"
                >
                  <div className="col-span-3">
                    <Input
                      placeholder={t("fees.itemCode")}
                      value={item.code}
                      onChange={(e) => setItem(idx, { code: e.target.value })}
                    />
                  </div>
                  <div className="col-span-4">
                    <Input
                      placeholder={t("fees.itemLabel")}
                      value={item.label}
                      onChange={(e) => setItem(idx, { label: e.target.value })}
                    />
                  </div>
                  <div className="col-span-3">
                    <Input
                      type="number"
                      step="1"
                      min="0"
                      inputMode="numeric"
                      placeholder={t("fees.amount")}
                      value={item.amount || ""}
                      onChange={(e) => setItem(idx, { amount: Number(e.target.value) })}
                    />
                  </div>
                  <div className="col-span-2 flex h-9 items-center">
                    <Checkbox
                      label={t("fees.optional")}
                      checked={Boolean(item.isOptional)}
                      onChange={(e) => setItem(idx, { isOptional: e.target.checked })}
                    />
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-2 text-xs text-ink-muted">{t("fees.optionalHint")}</p>

            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-2"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => setForm((f) => ({ ...f, items: [...f.items, emptyItem()] }))}
            >
              {t("fees.addItem")}
            </Button>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={createMutation.isPending}
              disabled={!form.academicYear.trim() || !form.dueDate}
            >
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
