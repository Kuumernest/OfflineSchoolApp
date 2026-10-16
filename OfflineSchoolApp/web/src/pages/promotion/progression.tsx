// web/src/pages/promotion/progression.tsx
//
// Which class leads to which, and the bar each class's pupils must reach.
//
// Destinations have to be stated because they cannot be derived. `level` is
// null on every real class here, and the names do not sort — "Form 10" comes
// before "Form 2", and nothing in "Form 5" says the next stop is "Lower
// Sixth". A rollover that guessed would put children in the wrong classroom
// for a year, so where this is blank the rollover refuses to move those
// students rather than inventing a destination.
//
// Bars are per year and out of 20 (shared/academicRules, docs/39 §14): every
// school promotes on the published annual average against the class's bar,
// the school's bar for classes without their own, the pass mark when the
// school sets none. They are saved through the year's rules, so each change
// is validated, refused while a draft run exists, and audited with a reason.
// The old 0–100 "promotion average" is shown beside the new bar until a bar is
// confirmed for that class; no run reads it, and nothing converts it.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check } from "lucide-react";

import { useUser }     from "@/store/auth.store";
import { PageHeader }  from "@/components/ui/PageHeader";
import { Card }        from "@/components/ui/Card";
import { Button }      from "@/components/ui/Button";
import { Badge }       from "@/components/ui/Badge";
import { PageSpinner } from "@/components/ui/Spinner";
import { SelectField, Checkbox, Input, FormField } from "@/components/ui/FormField";
import { useToast }    from "@/components/ui/Toast";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { getErrorMessage } from "@/lib/axios";
import { fetchProgression, saveProgression } from "@/services/promotion.service";
import { saveBars, type BarsWrite } from "@/services/academicRules.service";
import type { ProgressionClass } from "@/types/promotion.types";

const CURRENT_YEAR = new Date().getFullYear();
const ACADEMIC_YEARS = [
  `${CURRENT_YEAR - 1}/${CURRENT_YEAR}`,
  `${CURRENT_YEAR}/${CURRENT_YEAR + 1}`,
  `${CURRENT_YEAR + 1}/${CURRENT_YEAR + 2}`,
];

interface Entry {
  classId:     string;
  nextClassId: string | null;
  isFinalYear: boolean;
}

/** A bar as typed: "" is none, NaN is invalid. */
const parseBar = (raw: string): number | null => {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n <= 20 ? n : NaN;
};

export default function ProgressionPage() {
  const { t }    = useTranslation();
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useUser()?.schoolId ?? "";

  const [year, setYear] = useState(ACADEMIC_YEARS[0]);

  // Only what the user has CHANGED is held in state; everything else is read
  // straight from the query. Copying the server's version into state on arrival
  // would mean an effect that fires on every refetch, and a background refetch
  // mid-edit would silently discard what had been typed.
  const [overrides, setOverrides] = useState<Record<string, Partial<Entry>>>({});
  const [barEdits, setBarEdits]   = useState<Record<string, string>>({});
  const [schoolBarEdit, setSchoolBarEdit] = useState<string | null>(null);
  const [reason, setReason]       = useState("");

  const progQ = useQuery({
    queryKey: ["promotion", "progression", schoolId, year],
    queryFn:  () => fetchProgression(schoolId, year),
    enabled:  !!schoolId,
  });

  const classes = progQ.data?.data ?? [];
  const yr      = progQ.data?.year ?? null;

  const entryFor = (c: ProgressionClass): Entry => ({
    classId:     c._id,
    nextClassId: c.nextClassId,
    isFinalYear: c.isFinalYear,
    ...overrides[c._id],
  });

  // The bar edits as the API takes them; null removes a class's own bar.
  const barWrite = (): BarsWrite | null => {
    const out: BarsWrite = {};
    if (schoolBarEdit !== null) out.promotionThreshold = parseBar(schoolBarEdit);
    const ct: Record<string, number | null> = {};
    for (const [id, raw] of Object.entries(barEdits)) ct[id] = parseBar(raw);
    if (Object.keys(ct).length) out.classThresholds = ct;
    return Object.keys(out).length ? out : null;
  };
  const pendingBars = barWrite();
  const invalidBar = pendingBars !== null && [
    pendingBars.promotionThreshold, ...Object.values(pendingBars.classThresholds ?? {}),
  ].some((v) => typeof v === "number" && Number.isNaN(v));
  const barsLocked = (yr?.draftRuns ?? 0) > 0;

  const saveMutation = useMutation({
    mutationFn: async () => {
      await saveProgression(schoolId, classes.map(entryFor));
      if (pendingBars) await saveBars(schoolId, year, pendingBars, reason.trim());
    },
    onSuccess: () => {
      toast({ kind: "success", title: t("prog.saved") });
      // The server is the truth again, so the local edits are no longer edits.
      setOverrides({}); setBarEdits({}); setSchoolBarEdit(null); setReason("");
      void qc.invalidateQueries({ queryKey: ["promotion"] });
    },
    onError: (err) =>
      toast({ kind: "error", title: t("prog.title"), message: getErrorMessage(err) }),
  });

  if (progQ.isLoading) return <PageSpinner />;

  // Counted from what is on screen, not from the server's figure, so the
  // warning clears as the last gap is filled rather than only after a save.
  const incomplete = classes
    .map(entryFor)
    .filter((e) => !e.isFinalYear && !e.nextClassId).length;

  // Classes whose pupils a run would find no published annual result for:
  // every one of them would need a decision.
  const withoutResults = yr
    ? classes.filter((c) => !entryFor(c).isFinalYear && (yr.classes[c._id]?.pupils ?? 0) > 0
        && (yr.classes[c._id]?.publishedAnnual ?? 0) === 0)
    : [];

  const update = (classId: string, patch: Partial<Entry>) =>
    setOverrides((prev) => ({ ...prev, [classId]: { ...prev[classId], ...patch } }));

  const canSave = !invalidBar && (!pendingBars || (!barsLocked && reason.trim().length > 0));

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("prog.title")}
        description={t("prog.blurb")}
        actions={
          <Button loading={saveMutation.isPending} disabled={!canSave} onClick={() => saveMutation.mutate()}>
            {t("common.save")}
          </Button>
        }
      />

      {incomplete > 0 ? (
        <div className="flex items-start gap-2 rounded-card border border-warning/30 bg-warning/8 px-4 py-3 text-sm text-ink-body">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="font-medium">{t("prog.incomplete", { count: incomplete })}</p>
            <p className="text-ink-muted">{t("prog.incompleteHint")}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-card border border-success-line bg-success-soft px-4 py-3 text-sm text-success">
          <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{t("prog.complete")}</p>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-44">
            <FormField label={t("prog.year")}>
              <SelectField
                value={year}
                onChange={(e) => { setYear(e.target.value); setBarEdits({}); setSchoolBarEdit(null); }}
                options={ACADEMIC_YEARS.map((y) => ({ value: y, label: y }))}
              />
            </FormField>
          </div>
          {yr && (
            <div className="w-56">
              <FormField label={t("prog.schoolBar")} hint={t("prog.schoolBarHint", { passMark: yr.passMark })}>
                <Input
                  type="number" min={0} max={20} step={0.25} inputMode="decimal"
                  disabled={barsLocked}
                  placeholder={String(yr.passMark)}
                  value={schoolBarEdit ?? (yr.promotionThreshold == null ? "" : String(yr.promotionThreshold))}
                  onChange={(e) => setSchoolBarEdit(e.target.value)}
                />
              </FormField>
            </div>
          )}
        </div>
        <p className="mt-3 text-sm text-ink-muted">{t("prog.rule")}</p>
        {yr && !yr.hasStructure && (
          <p className="mt-2 text-sm text-warning">{t("prog.noStructure")}</p>
        )}
        {barsLocked && (
          <p className="mt-2 text-sm text-warning">{t("prog.draftLocks")}</p>
        )}
        {withoutResults.length > 0 && (
          <div className="mt-3 flex items-start gap-2 rounded-card border border-warning/30 bg-warning/8 px-4 py-3 text-sm text-ink-body">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <div>
              <p className="font-medium">{t("prog.noResults", { count: withoutResults.length })}</p>
              <p className="text-ink-muted">
                {withoutResults.map((c) => c.name).join(", ")} — {t("prog.noResultsHint")}
              </p>
            </div>
          </div>
        )}
      </Card>

      <Card padding={false}>
        {classes.length === 0 ? (
          <EmptyTable title={t("classes.none")} subtitle={t("classes.noneHint")} />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("academic.class")}</Th>
                <Th>{t("prog.nextClass")}</Th>
                <Th>{t("prog.finalYear")}</Th>
                <Th>{t("prog.bar")}</Th>
                <Th>{t("prog.results")}</Th>
              </Tr>
            </THead>
            <TBody>
              {classes.map((c) => {
                const entry = entryFor(c);
                const final = entry.isFinalYear;
                const yc    = yr?.classes[c._id];

                return (
                  <Tr key={c._id}>
                    <Td className="font-medium text-ink">{c.name}</Td>
                    <Td>
                      <SelectField
                        value={entry.nextClassId ?? ""}
                        disabled={final}
                        placeholder={t("prog.notSet")}
                        invalid={!final && !entry.nextClassId}
                        onChange={(e) =>
                          update(c._id, { nextClassId: e.target.value || null })
                        }
                        // A class leading to itself would promote a year group
                        // into the room it just left and look like a success.
                        options={classes
                          .filter((o) => o._id !== c._id)
                          .map((o) => ({ value: o._id, label: o.name }))}
                      />
                    </Td>
                    <Td>
                      <Checkbox
                        label={t("prog.finalYearHint")}
                        checked={final}
                        onChange={(e) =>
                          update(c._id, {
                            isFinalYear: e.target.checked,
                            // Leaving a stale destination on a final-year class
                            // would resurface the moment the box was unticked.
                            nextClassId: e.target.checked ? null : entry.nextClassId,
                          })
                        }
                      />
                    </Td>
                    <Td>
                      {final ? (
                        <span className="text-sm text-ink-muted">{t("prog.graduates")}</span>
                      ) : yr ? (
                        <div className="space-y-1">
                          <Input
                            type="number" min={0} max={20} step={0.25} inputMode="decimal"
                            aria-label={t("prog.bar")}
                            disabled={barsLocked}
                            placeholder={t("prog.barDefault", { bar: yr.defaultBar })}
                            value={barEdits[c._id] ?? (yc?.bar == null ? "" : String(yc.bar))}
                            onChange={(e) => setBarEdits((prev) => ({ ...prev, [c._id]: e.target.value }))}
                          />
                          {/* The old 0–100 figure, until a bar is confirmed for the year. */}
                          {!yc?.confirmed && c.promotionAverage != null && (
                            <p className="text-xs text-ink-muted">{t("prog.oldAverage", { value: c.promotionAverage })}</p>
                          )}
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      {yc && (
                        yc.publishedAnnual === 0 && yc.pupils > 0
                          ? <Badge variant="warning">{t("prog.noneOf", { pupils: yc.pupils })}</Badge>
                          : <span className="text-sm text-ink-body">{t("prog.publishedOf", { published: yc.publishedAnnual, pupils: yc.pupils })}</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      {pendingBars && (
        <Card>
          <FormField label={t("prog.reason")} hint={t("prog.reasonHint")}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
        </Card>
      )}
    </div>
  );
}
