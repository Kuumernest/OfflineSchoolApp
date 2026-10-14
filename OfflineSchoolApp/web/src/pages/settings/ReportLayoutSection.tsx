// web/src/pages/settings/ReportLayoutSection.tsx
//
// Which sections the school's report cards print (docs/39 §10.3; the API is
// Phase 2d, this screen Phase 5).
//
// Presentation only, and the screen says so: a hidden section's figures are
// still computed, stored, ranked and published — they are not printed.
// Every change is a new version; issued cards keep the version they were
// issued with, and that consequence is stated before saving. A section the
// school's own token template prints unconditionally cannot be hidden from
// here, and is named rather than silently ignored.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { LayoutTemplate, Save, AlertTriangle } from "lucide-react";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/FormField";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { getErrorMessage } from "@/lib/axios";
import {
  fetchLayout, fetchLayoutVersions, fetchSections, saveLayout,
} from "@/services/reportLayout.service";

export default function ReportLayoutSection({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const { toast, confirm } = useToast();
  const qc = useQueryClient();

  const [draft, setDraft] = useState<Record<string, boolean> | null>(null);

  const sectionsQ = useQuery({ queryKey: ["reportLayout", "sections", schoolId], queryFn: () => fetchSections(schoolId), enabled: Boolean(schoolId) });
  const layoutQ   = useQuery({ queryKey: ["reportLayout", "current", schoolId],  queryFn: () => fetchLayout(schoolId),   enabled: Boolean(schoolId) });
  const versionsQ = useQuery({ queryKey: ["reportLayout", "versions", schoolId], queryFn: () => fetchLayoutVersions(schoolId), enabled: Boolean(schoolId) });

  const saved = layoutQ.data?.layout?.sections ?? null;
  const form  = draft ?? saved;
  const dirty = useMemo(
    () => Boolean(draft && saved && Object.keys(draft).some((k) => draft[k] !== saved[k])),
    [draft, saved]
  );

  const save = useMutation({
    mutationFn: () => saveLayout(schoolId, draft!),
    onSuccess: async (res) => {
      toast({ kind: "success", title: res.changed ? t("reportLayout.saved", { version: res.layout?.version ?? "" }) : t("reportLayout.unchanged") });
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["reportLayout"] });
    },
    onError: (err) => toast({ kind: "error", title: t("reportLayout.saveFailed"), message: getErrorMessage(err) }),
  });

  const onSave = async () => {
    const off = Object.entries(draft ?? {}).filter(([, on]) => !on).map(([id]) => t(`reportLayout.section.${id}.label`));
    const ok = await confirm({
      title:   t("reportLayout.confirmTitle"),
      message: t("reportLayout.confirmMessage", {
        version: (layoutQ.data?.layout?.version ?? 0) + 1,
        hidden:  off.length ? off.join(", ") : t("reportLayout.nothingHidden"),
      }),
      confirmLabel: t("common.save"),
      kind: "warning",
    });
    if (ok) save.mutate();
  };

  if (sectionsQ.isLoading || layoutQ.isLoading) return <PageSpinner />;
  if (!form || !sectionsQ.data) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">
          {layoutQ.error ? getErrorMessage(layoutQ.error) : t("reportLayout.unavailable")}
        </p>
      </Card>
    );
  }

  const layout = layoutQ.data!.layout;
  const notHidden = new Set(layoutQ.data!.sectionsNotHiddenByTemplate);

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50">
            <LayoutTemplate className="h-4 w-4 text-primary-600" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">{t("reportLayout.title")}</h2>
            <p className="mt-1 text-sm text-ink-muted">{t("reportLayout.intro")}</p>
          </div>
          <Badge variant={layout.source === "default" ? "default" : "primary"}>
            {layout.source === "default" ? t("reportLayout.defaultLayout") : t("reportLayout.version", { version: layout.version })}
          </Badge>
        </div>
      </Card>

      <Card>
        <div className="space-y-2">
          {sectionsQ.data.map((s) => (
            <div key={s.id} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
              <Checkbox
                checked={form[s.id] ?? true}
                onChange={(e) => setDraft({ ...(draft ?? saved!), [s.id]: e.target.checked })}
                label={t(`reportLayout.section.${s.id}.label`)}
                hint={t(`reportLayout.section.${s.id}.desc`)}
              />
              {notHidden.has(s.id) && !(form[s.id] ?? true) && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t("reportLayout.templatePrintsIt")}
                </p>
              )}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-faint">{t("reportLayout.presentationOnly")}</p>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onSave} disabled={!dirty || save.isPending} icon={<Save className="h-4 w-4" />}>
          {save.isPending ? t("common.saving") : t("common.save")}
        </Button>
        <Button variant="secondary" disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>
          {t("common.cancel")}
        </Button>
        {dirty && <span className="text-xs text-ink-faint">{t("reportLayout.takesEffect")}</span>}
      </div>

      {(versionsQ.data?.length ?? 0) > 0 && (
        <Card>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t("reportLayout.history")}</h3>
          <ul className="mt-3 space-y-1 text-sm">
            {versionsQ.data!.map((v) => (
              <li key={v.id ?? v.version} className="flex flex-wrap justify-between gap-2 text-ink-muted">
                <span>{t("reportLayout.version", { version: v.version })}</span>
                <span className="text-xs">
                  {t("reportLayout.hiddenCount", { count: Object.values(v.sections).filter((on) => !on).length })}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
