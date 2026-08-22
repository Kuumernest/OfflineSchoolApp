// web/src/pages/promotion/progression.tsx
//
// Which class leads to which.
//
// This has to be stated because it cannot be derived. `level` is null on every
// real class here, and the names do not sort — "Form 10" comes before "Form 2",
// and nothing in "Form 5" says the next stop is "Lower Sixth". A rollover that
// guessed would put children in the wrong classroom for a year, so where this is
// blank the rollover refuses to move those students rather than inventing a
// destination.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check } from "lucide-react";

import { useUser }     from "@/store/auth.store";
import { PageHeader }  from "@/components/ui/PageHeader";
import { Card }        from "@/components/ui/Card";
import { Button }      from "@/components/ui/Button";
import { PageSpinner } from "@/components/ui/Spinner";
import { SelectField, Checkbox } from "@/components/ui/FormField";
import { useToast }    from "@/components/ui/Toast";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { getErrorMessage } from "@/lib/api";
import { fetchProgression, saveProgression } from "@/services/promotion.service";
import type { ProgressionClass } from "@/types/promotion.types";

interface Entry {
  classId:     string;
  nextClassId: string | null;
  isFinalYear: boolean;
}

export default function ProgressionPage() {
  const { t }    = useTranslation();
  const qc       = useQueryClient();
  const { toast } = useToast();
  const schoolId = useUser()?.schoolId ?? "";

  // Only what the user has CHANGED is held in state; everything else is read
  // straight from the query. Copying the server's version into state on arrival
  // would mean an effect that fires on every refetch, and a background refetch
  // mid-edit would silently discard what had been typed.
  const [overrides, setOverrides] = useState<Record<string, Partial<Entry>>>({});

  const progQ = useQuery({
    queryKey: ["promotion", "progression", schoolId],
    queryFn:  () => fetchProgression(schoolId),
    enabled:  !!schoolId,
  });

  const classes = progQ.data?.data ?? [];

  const entryFor = (c: ProgressionClass): Entry => ({
    classId:     c._id,
    nextClassId: c.nextClassId,
    isFinalYear: c.isFinalYear,
    ...overrides[c._id],
  });

  const saveMutation = useMutation({
    mutationFn: () => saveProgression(schoolId, classes.map(entryFor)),
    onSuccess: () => {
      toast({ kind: "success", title: t("prog.saved") });
      // The server is the truth again, so the local edits are no longer edits.
      setOverrides({});
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

  const update = (classId: string, patch: Partial<Entry>) =>
    setOverrides((prev) => ({ ...prev, [classId]: { ...prev[classId], ...patch } }));

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("prog.title")}
        description={t("prog.blurb")}
        actions={
          <Button loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
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
              </Tr>
            </THead>
            <TBody>
              {classes.map((c) => {
                const entry = entryFor(c);
                const final = entry.isFinalYear;

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
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
