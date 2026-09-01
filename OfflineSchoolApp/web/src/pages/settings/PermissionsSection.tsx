// web/src/pages/settings/PermissionsSection.tsx
//
// The screen that changes who may do what.
//
// Rendered entirely from what the API returns — the capability list, which
// module each belongs to, whether it can be changed, and what each role holds
// right now. Nothing about the matrix is hard-coded here, so a capability added
// in a later release appears on this screen with no client change. Hard-coding
// it would guarantee the opposite: a school ticking a box that the server has
// never heard of, or a new capability nobody can reach.
//
// ── Locked rows are shown, not hidden ─────────────────────────────────────
//
// A capability an administrator cannot change is still listed, with its
// checkbox disabled and the reason next to it. That is deliberate. A missing
// row reads as an oversight and produces a support conversation; a disabled row
// saying "the person who collects the fees must never be able to move the grade
// of the child who paid them" answers the question in place.
//
// It also makes the design legible. Someone opening this screen should be able
// to see the shape of the separation — what a school may hand out and what it
// may not — rather than having to infer it from what is absent.
//
// ── No effects ────────────────────────────────────────────────────────────
//
// The draft is not copied out of the server response by an effect, and the
// fetch is not started by one. Both would be setState inside useEffect, which
// this project's lint rules reject and which is the usual source of a screen
// that flickers back to stale values. The draft is instead a per-role override
// that starts absent, and everything else is derived during render.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Lock, ShieldCheck, RotateCcw, Save } from "lucide-react";

import api from "@/services/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { getErrorMessage } from "@/lib/axios";
import { cn } from "@/utils/cn";

// ─────────────────────────────────────────────────────────────────────────────
// WIRE SHAPES
// ─────────────────────────────────────────────────────────────────────────────

interface MatrixRow {
  key:       string;
  module:    string;
  delegable: boolean;
  /** English text from the server registry. The screen shows a translation. */
  note:      string | null;
  defaults:  string[];
}

interface MatrixResponse {
  matrix:          MatrixRow[];
  adjustableRoles: string[];
  lockedKeys:      string[];
  effective:       Record<string, string[]>;
}

const EMPTY_ROWS: MatrixRow[] = [];

// ─────────────────────────────────────────────────────────────────────────────

export default function PermissionsSection({ schoolId }: { schoolId: string }) {
  const { t }     = useTranslation();
  const { toast } = useToast();
  const qc        = useQueryClient();

  const [role, setRole] = useState<string>("bursar");

  /**
   * Unsaved edits, keyed by role.
   *
   * A role missing from this map means "nothing touched — show what the server
   * says", which is what lets the screen render the truth without an effect
   * copying it into state first. Switching roles therefore keeps each role's
   * pending edits rather than silently discarding them.
   */
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});

  const query = useQuery({
    queryKey: ["permissions", "matrix", schoolId],
    queryFn:  async (): Promise<MatrixResponse> => {
      const { data } = await api.get("/admin/permissions", {
        params: { schoolId },
      });
      return data?.data as MatrixResponse;
    },
    enabled: Boolean(schoolId),
  });

  const data  = query.data;
  const roles = useMemo(() => data?.adjustableRoles ?? [], [data]);

  // The role the tabs are on, corrected if the server does not offer it.
  // Derived rather than pushed into state on load, so there is no render where
  // the two disagree.
  const activeRole = roles.includes(role) ? role : roles[0] ?? role;

  const rows  = useMemo(() => data?.matrix ?? EMPTY_ROWS, [data]);
  const saved = useMemo(
    () => data?.effective?.[activeRole] ?? EMPTY_ROWS.map(String),
    [data, activeRole]
  );

  /** What the checkboxes show: the draft if there is one, else the server. */
  const held = useMemo(
    () => new Set(drafts[activeRole] ?? saved),
    [drafts, activeRole, saved]
  );

  const dirty = useMemo(() => {
    const draft = drafts[activeRole];
    if (!draft) return false;
    const savedSet = new Set(saved);
    return draft.length !== savedSet.size || draft.some((k) => !savedSet.has(k));
  }, [drafts, activeRole, saved]);

  /** Grouped by module, module order preserved from the API. */
  const grouped = useMemo(() => {
    const out: Array<{ module: string; rows: MatrixRow[] }> = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.module === r.module) last.rows.push(r);
      else out.push({ module: r.module, rows: [r] });
    }
    return out;
  }, [rows]);

  const toggle = (key: string) => {
    setDrafts((prev) => {
      const current = new Set(prev[activeRole] ?? saved);
      if (current.has(key)) current.delete(key);
      else current.add(key);
      return { ...prev, [activeRole]: [...current] };
    });
  };

  const discard = () => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[activeRole];
      return next;
    });
  };

  const mutation = useMutation({
    mutationFn: async (desired: string[]) => {
      await api.put(`/admin/permissions/${activeRole}`, {
        schoolId,
        permissions: desired,
      });
    },
    onSuccess: async () => {
      toast({ kind: "success", title: t("permissions.saved") });
      discard();
      await qc.invalidateQueries({
        queryKey: ["permissions", "matrix", schoolId],
      });
    },
    onError: (err) => {
      toast({
        kind:    "error",
        title:   t("permissions.saveFailed"),
        message: getErrorMessage(err),
      });
    },
  });

  if (query.isLoading) return <PageSpinner />;

  if (query.isError || !data) {
    return (
      <Card>
        <p className="text-sm text-ink-muted">
          {query.isError
            ? getErrorMessage(query.error)
            : t("permissions.unavailable")}
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">

      {/* ── What this screen is, before anybody starts ticking ───────────── */}
      <Card>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50">
            <ShieldCheck className="h-4 w-4 text-primary-600" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">
              {t("permissions.title")}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              {t("permissions.intro")}
            </p>
            <p className="mt-2 text-xs text-ink-faint">
              {t("permissions.lockedIntro")}
            </p>
          </div>
        </div>
      </Card>

      {/* ── Which role ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {roles.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRole(r)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-sm font-medium transition",
              r === activeRole
                ? "border-primary-300 bg-primary-50 text-primary-800"
                : "border-line bg-surface text-ink-muted hover:text-ink"
            )}
          >
            {t(`permissions.role.${r}`, { defaultValue: r })}
            {/* A dot on a tab whose edits have not been saved, so switching
                away and back does not look like the change was lost. */}
            {drafts[r] && (
              <span className="ml-1.5 text-[11px] text-primary-700">•</span>
            )}
          </button>
        ))}

        <span className="ml-auto text-xs text-ink-faint">
          {t("permissions.heldCount", { held: held.size, total: rows.length })}
        </span>
      </div>

      {/* ── The matrix ───────────────────────────────────────────────────── */}
      {grouped.map(({ module, rows: moduleRows }) => (
        <Card key={module}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {t(`permissions.module.${module}`, { defaultValue: module })}
          </h3>

          <ul className="mt-3 divide-y divide-line">
            {moduleRows.map((r) => {
              const on        = held.has(r.key);
              const isDefault = r.defaults.includes(activeRole);
              const changed   = on !== isDefault;
              const note      = t(`permissions.note.${r.key}`, { defaultValue: "" });

              return (
                <li key={r.key} className="flex items-start gap-3 py-3">
                  <input
                    id={`perm-${r.key}`}
                    type="checkbox"
                    checked={on}
                    disabled={!r.delegable || mutation.isPending}
                    onChange={() => toggle(r.key)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-line accent-primary-600 disabled:opacity-40"
                  />

                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor={`perm-${r.key}`}
                      className={cn(
                        "flex flex-wrap items-center gap-2 text-sm",
                        r.delegable ? "text-ink" : "text-ink-muted"
                      )}
                    >
                      <span className="font-medium">
                        {t(`permissions.key.${r.key}`, { defaultValue: r.key })}
                      </span>

                      {/* The raw key, because it is what a 403 names. Somebody
                          reading "requires payroll.setSalary" in a support
                          message needs to be able to find this row. */}
                      <code className="rounded bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-faint">
                        {r.key}
                      </code>

                      {!r.delegable && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning">
                          <Lock className="h-3 w-3" aria-hidden="true" />
                          {t("permissions.locked")}
                        </span>
                      )}

                      {changed && r.delegable && (
                        <span className="text-[11px] font-medium text-primary-700">
                          {on
                            ? t("permissions.addedToDefault")
                            : t("permissions.removedFromDefault")}
                        </span>
                      )}
                    </label>

                    {/* Translated rather than taken from r.note, which is the
                        English text in the server registry. Only the rows that
                        genuinely need explaining carry one — every lock does,
                        because "why can I not tick this" is the question this
                        screen exists to answer in place. */}
                    {note && (
                      <p className="mt-0.5 text-xs text-ink-faint">{note}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}

      {/* ── Save ─────────────────────────────────────────────────────────── */}
      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-line bg-surface/95 py-3 backdrop-blur">
        <Button
          onClick={() => mutation.mutate([...held])}
          disabled={!dirty || mutation.isPending}
          icon={<Save className="h-4 w-4" />}
        >
          {mutation.isPending ? t("common.saving") : t("common.save")}
        </Button>

        <Button
          variant="secondary"
          disabled={!dirty || mutation.isPending}
          onClick={discard}
          icon={<RotateCcw className="h-4 w-4" />}
        >
          {t("permissions.reset")}
        </Button>

        {/*
          Said next to the button rather than in a toast afterwards: a
          permission change reaches other signed-in staff on their next request
          at the latest, and the people affected will not be looking at this
          screen when it happens.
        */}
        {dirty && (
          <span className="text-xs text-ink-faint">
            {t("permissions.takesEffect")}
          </span>
        )}
      </div>
    </div>
  );
}
