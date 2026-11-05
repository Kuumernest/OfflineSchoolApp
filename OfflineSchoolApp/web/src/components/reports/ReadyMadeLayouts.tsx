// web/src/components/reports/ReadyMadeLayouts.tsx
//
// The three ready-made report-card layouts (C12). A school picks one with a
// click; which sections print is switched in Settings > Report layout, and
// works the same on every layout. Custom HTML stays on this page as the
// advanced path. Layouts: backend/src/print/reportPresets.js.

import { useState }       from "react";
import { Link }           from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, LayoutTemplate, SlidersHorizontal } from "lucide-react";

import api                 from "@/services/api";
import { Button }          from "@/components/ui/Button";
import { Badge }           from "@/components/ui/Badge";
import { useToast }        from "@/components/ui/Toast";
import { getErrorMessage } from "@/lib/axios";
import { cn }              from "@/utils/cn";
import { DASH_TINT, categoryAccent, type DashAccent } from "@/config/dashboardTint";

/** The layout in use, ringed in its own colour (literal for Tailwind). */
const IN_USE_RING: Record<DashAccent, string> = {
  blue:   "ring-2 ring-accent-blue",
  violet: "ring-2 ring-accent-violet",
  indigo: "ring-2 ring-accent-indigo",
  slate:  "ring-2 ring-accent-slate",
  amber:  "ring-2 ring-accent-amber",
  green:  "ring-2 ring-accent-green",
  teal:   "ring-2 ring-accent-teal",
  sky:    "ring-2 ring-accent-sky",
  red:    "ring-2 ring-accent-red",
};

interface Preset { id: "classic" | "compact" | "clear"; name: string; description: string; inUse: boolean }

export function ReadyMadeLayouts({ schoolId, onChanged }: { schoolId: string; onChanged?: () => void }) {
  const { t }  = useTranslation();
  const { toast } = useToast();
  const qc     = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["reportPresets", schoolId],
    queryFn:  async () => {
      const { data } = await api.get("/templates/presets", { params: { schoolId } });
      return { presets: (data?.presets ?? []) as Preset[], custom: (data?.custom ?? null) as string | null };
    },
    enabled: !!schoolId,
  });

  const use = async (id: string) => {
    try {
      setBusy(id);
      await api.post(`/templates/presets/${id}/use`, { schoolId });
      await qc.invalidateQueries({ queryKey: ["reportPresets", schoolId] });
      onChanged?.();
      toast({ kind: "success", title: t("templates.layoutChosen") });
    } catch (err) {
      toast({ kind: "error", title: getErrorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const presets = q.data?.presets ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-ink">
            <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT.slate.box)} aria-hidden="true">
              <LayoutTemplate className="h-4 w-4" />
            </span>
            {t("templates.readyMade")}
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">{t("templates.readyMadeHint")}</p>
        </div>
        <Link to="/settings?section=reportLayout"
          className="flex items-center gap-1.5 text-sm font-semibold text-primary-600 hover:underline">
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          {t("templates.chooseSections")}
        </Link>
      </div>

      {q.data?.custom && (
        <p className="text-sm text-ink-muted">{t("templates.customInUse", { name: q.data.custom })}</p>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {presets.map((p) => (
          <div key={p.id}
            className={cn("flex flex-col p-4", DASH_TINT[categoryAccent(p.id)].card,
              p.inUse && IN_USE_RING[categoryAccent(p.id)])}>
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-control", DASH_TINT[categoryAccent(p.id)].box)} aria-hidden="true">
                  <LayoutTemplate className="h-4 w-4" />
                </span>
                <h3 className="font-semibold text-ink">{t(`templates.preset.${p.id}.name`)}</h3>
              </div>
              {p.inUse && <Badge variant="success">{t("templates.inUse")}</Badge>}
            </div>
            <p className="mb-4 flex-1 text-sm text-ink-muted">{t(`templates.preset.${p.id}.description`)}</p>
            {p.inUse ? (
              <span className="flex items-center gap-1.5 text-sm font-medium text-success-text">
                <Check className="h-4 w-4" aria-hidden />{t("templates.printingWithThis")}
              </span>
            ) : (
              <Button size="sm" loading={busy === p.id} onClick={() => use(p.id)}>
                {t("templates.useLayout")}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
