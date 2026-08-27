// web/src/pages/periods/index.tsx
//
// The school day: the ordered list of periods every timetable slot hangs off.
// This page has to exist before /timetable is usable at all — a timetable grid
// with no periods has no rows.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  Plus,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  Coffee,
  Eye,
  EyeOff,
  AlertCircle,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { FormField, Input, Checkbox } from "@/components/ui/FormField";
import { PageSpinner } from "@/components/ui/Spinner";
import { Table, THead, Th, TBody } from "@/components/ui/DataTable";
import { useToast } from "@/components/ui/Toast";
import {
  fetchPeriods,
  createPeriod,
  updatePeriod,
  deletePeriod,
  togglePeriodActive,
  movePeriod,
  findOverlap,
  validateTimes,
  toMinutes,
  padTime,
} from "@/services/period.service";
import { useUser } from "@/store/auth.store";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/utils/cn";
import type { Period } from "@/types/timetable.types";
import { useTranslation } from "react-i18next";

const QK = {
  periods: (schoolId: string, includeInactive: boolean) =>
    ["periods", schoolId, includeInactive] as const,
};

interface FormState {
  name:      string;
  startTime: string;
  endTime:   string;
  isBreak:   boolean;
}

const EMPTY_FORM: FormState = {
  name:      "",
  startTime: "",
  endTime:   "",
  isBreak:   false,
};

export default function PeriodsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast, confirm } = useToast();

  const user     = useUser();
  const schoolId = user?.schoolId ?? "";

  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Period | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const { data, isLoading, error } = useQuery({
    queryKey: QK.periods(schoolId, showInactive),
    queryFn:  () => fetchPeriods(schoolId, showInactive),
    enabled:  !!schoolId,
  });

  const periods = useMemo(() => data ?? [], [data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["periods"] });

  // ── Validation ─────────────────────────────────────────────────────────────
  // Both checks mirror the server (periods.controller.js) so the user is told
  // inline instead of after a failed request.
  const timeError = useMemo(() => {
    if (!form.startTime || !form.endTime) return null;
    return validateTimes(form.startTime, form.endTime);
  }, [form.startTime, form.endTime]);

  const overlap = useMemo(() => {
    if (timeError || !form.startTime || !form.endTime) return null;
    return findOverlap(periods, form.startTime, form.endTime, editing?._id ?? null);
  }, [periods, form.startTime, form.endTime, editing?._id, timeError]);

  const canSave =
    form.name.trim().length > 0 &&
    !!form.startTime &&
    !!form.endTime &&
    !timeError &&
    !overlap;

  // ── Mutations ──────────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name:      form.name.trim(),
        startTime: padTime(form.startTime),
        endTime:   padTime(form.endTime),
        isBreak:   form.isBreak,
        schoolId,
      };
      return editing
        ? updatePeriod(editing._id, payload)
        : createPeriod(payload);
    },
    onSuccess: () => {
      toast({ title: editing ? "Period updated" : "Period added", kind: "success" });
      closeModal();
      invalidate();
    },
    onError: (err) =>
      toast({ title: t("periods.errSave"), message: getErrorMessage(err), kind: "error" }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => deletePeriod(id),
    onSuccess: () => {
      toast({ title: t("periods.removed"), kind: "success" });
      invalidate();
    },
    onError: (err) =>
      toast({ title: t("periods.errRemove"), message: getErrorMessage(err), kind: "error" }),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => togglePeriodActive(id),
    onSuccess: invalidate,
    onError: (err) =>
      toast({ title: t("periods.errStatus"), message: getErrorMessage(err), kind: "error" }),
  });

  const moveMutation = useMutation({
    mutationFn: ({ id, direction }: { id: string; direction: "up" | "down" }) =>
      movePeriod(id, direction),
    onSuccess: invalidate,
    onError: (err) => {
      // The endpoint answers 400 for "already at the end", which is a no-op
      // rather than a failure — the arrows are disabled at the edges anyway,
      // so this only fires on a genuine race.
      toast({ title: t("periods.errReorder"), message: getErrorMessage(err), kind: "error" });
    },
  });

  // ── Modal helpers ──────────────────────────────────────────────────────────
  const openCreate = () => {
      // Prefill the start time with the last period's end, which is what the
    // next period almost always is.
    const last = [...periods].sort((a, b) => toMinutes(b.endTime) - toMinutes(a.endTime))[0];
    setEditing(null);
    setForm({ ...EMPTY_FORM, startTime: last?.endTime ?? "" });
    setModalOpen(true);
  };

  const openEdit = (p: Period) => {
    setEditing(p);
    setForm({
      name:      p.name,
      startTime: p.startTime,
      endTime:   p.endTime,
      isBreak:   p.isBreak,
    });
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
  };

  const askRemove = async (p: Period) => {
    const ok = await confirm({
      title:   `Remove "${p.name}"?`,
      message:
        "Any timetable lesson scheduled in this period will lose its slot. " +
        "If you only want to take it out of use for now, hide it instead — " +
        "that keeps the existing timetable intact.",
      confirmLabel: "Remove period",
      kind:         "danger",
    });
    if (ok) removeMutation.mutate(p._id);
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  const teaching = periods.filter((p) => !p.isBreak && p.isActive);

  const dayLength = useMemo(() => {
    if (!periods.length) return null;
    const starts = periods.map((p) => toMinutes(p.startTime)).filter((n) => !Number.isNaN(n));
    const ends   = periods.map((p) => toMinutes(p.endTime)).filter((n) => !Number.isNaN(n));
    if (!starts.length || !ends.length) return null;
    return { from: Math.min(...starts), to: Math.max(...ends) };
  }, [periods]);

  if (isLoading) return <PageSpinner />;

  if (error) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-gray-800">{t("periods.loadFailed")}</h3>
            <p className="text-sm text-gray-500 mt-0.5">{getErrorMessage(error)}</p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{t("periods.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {teaching.length} teaching {teaching.length === 1 ? "period" : "periods"}
            {dayLength && (
              <> · {fmtMinutes(dayLength.from)} to {fmtMinutes(dayLength.to)}</>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={showInactive
              ? <EyeOff className="w-4 h-4" />
              : <Eye className="w-4 h-4" />}
            onClick={() => setShowInactive((v) => !v)}
          >
            {showInactive ? "Hide inactive" : "Show inactive"}
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={openCreate}>
            {t("periods.add")}
          </Button>
        </div>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <Card padding={false}>
        <div className="p-4 border-b border-gray-100">
          <CardHeader
            title={t("periods.inOrder")}
            subtitle={t("periods.orderNote")}
          />
        </div>

        {periods.length === 0 ? (
          <div className="py-16 text-center">
            <Clock className="w-8 h-8 text-gray-300 mx-auto" />
            <p className="mt-3 text-sm font-medium text-gray-700">
              {t("periods.notSetUp")}
            </p>
            <p className="mt-1 text-sm text-gray-500 max-w-sm mx-auto">
              Add your periods — first lesson, break, and so on. The timetable
              builder uses these as its rows, so it needs them first.
            </p>
            <Button
              className="mt-4"
              size="sm"
              icon={<Plus className="w-4 h-4" />}
              onClick={openCreate}
            >
              {t("periods.addFirst")}
            </Button>
          </div>
        ) : (
          <Table>
            <THead>
              <tr>
                <Th className="w-16">{t("common.order")}</Th>
                <Th>{t("periods.period")}</Th>
                <Th>{t("common.time")}</Th>
                <Th>{t("periods.length")}</Th>
                <Th>{t("common.status")}</Th>
                <Th className="text-right">{t("common.actions")}</Th>
              </tr>
            </THead>
            <TBody>
              {periods.map((p, i) => {
                const mins = toMinutes(p.endTime) - toMinutes(p.startTime);
                return (
                  <tr
                    key={p._id}
                    className={cn(
                      "transition-colors hover:bg-gray-50",
                      !p.isActive && "opacity-55",
                    )}
                  >
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <button
                          type="button"
                          aria-label={t("periods.moveEarlier")}
                          disabled={i === 0 || moveMutation.isPending}
                          onClick={() => moveMutation.mutate({ id: p._id, direction: "up" })}
                          className="p-0.5 rounded text-gray-400 hover:text-primary-600 hover:bg-primary-50 disabled:opacity-25 disabled:hover:bg-transparent"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={t("periods.moveLater")}
                          disabled={i === periods.length - 1 || moveMutation.isPending}
                          onClick={() => moveMutation.mutate({ id: p._id, direction: "down" })}
                          className="p-0.5 rounded text-gray-400 hover:text-primary-600 hover:bg-primary-50 disabled:opacity-25 disabled:hover:bg-transparent"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {p.isBreak && <Coffee className="w-4 h-4 text-amber-500 shrink-0" />}
                        <span className="font-medium text-gray-800">{p.name}</span>
                      </div>
                    </td>

                    <td className="px-4 py-3 text-gray-600 tabular-nums">
                      {p.startTime} – {p.endTime}
                    </td>

                    <td className="px-4 py-3 text-gray-500">
                      {Number.isNaN(mins) ? "—" : `${mins} min`}
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Badge
                          label={p.isActive ? "In use" : "Hidden"}
                          variant={p.isActive ? "success" : "default"}
                        />
                        {p.isBreak && <Badge label={t("timetable.break")} variant="warning" />}
                      </div>
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconAction
                          title={p.isActive ? "Hide from timetable" : "Put back in use"}
                          onClick={() => toggleMutation.mutate(p._id)}
                        >
                          {p.isActive
                            ? <EyeOff className="w-4 h-4" />
                            : <Eye className="w-4 h-4" />}
                        </IconAction>
                        <IconAction title={t("common.edit")} onClick={() => openEdit(p)}>
                          <Pencil className="w-4 h-4" />
                        </IconAction>
                        <IconAction title={t("common.remove")} danger onClick={() => askRemove(p)}>
                          <Trash2 className="w-4 h-4" />
                        </IconAction>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      {/* ── Add / edit ──────────────────────────────────────────────────── */}
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? `Edit "${editing.name}"` : "Add a period"}
      >
        <form
          onSubmit={(e) => { e.preventDefault(); if (canSave) saveMutation.mutate(); }}
          className="space-y-4"
        >
          <FormField label={t("common.name")} required>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={t("periods.namePh")}
              autoFocus
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label={t("periods.starts")} required>
              <Input
                type="time"
                value={form.startTime}
                onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
              />
            </FormField>
            <FormField label={t("periods.ends")} required error={timeError ?? undefined}>
              <Input
                type="time"
                value={form.endTime}
                onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                invalid={!!timeError}
              />
            </FormField>
          </div>

          {overlap && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">
                {t("periods.overlaps")} <strong>{overlap.name}</strong> ({overlap.startTime}–
                {overlap.endTime}). Two periods can't run at the same time.
              </p>
            </div>
          )}

          <Checkbox
            label={t("periods.isBreak")}
            hint={t("periods.breakHint")}
            checked={form.isBreak}
            onChange={(e) => setForm((f) => ({ ...f, isBreak: e.target.checked }))}
          />

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={closeModal}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave} loading={saveMutation.isPending}>
              {editing ? "Save changes" : "Add period"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const fmtMinutes = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function IconAction({
  title,
  onClick,
  children,
  danger = false,
}: {
  title:    string;
  onClick:  () => void;
  children: React.ReactNode;
  danger?:  boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "p-1.5 rounded-lg transition-colors",
        danger
          ? "text-gray-400 hover:text-red-600 hover:bg-red-50"
          : "text-gray-400 hover:text-primary-600 hover:bg-primary-50",
      )}
    >
      {children}
    </button>
  );
}
