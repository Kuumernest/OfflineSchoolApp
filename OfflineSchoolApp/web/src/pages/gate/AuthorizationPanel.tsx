// web/src/pages/gate/AuthorizationPanel.tsx
//
// Gate passes for one pupil: the ones in force, and issuing or revoking one.
//
// Rendered only for gate.authorize holders (administrators — the permission
// is not delegable). A pass lets a pupil through whatever they owe; it changes
// nothing about the money, which is why it lives here and not on the fee pages,
// and why a reason is required both ways: it is a decision somebody will be
// asked to explain.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ShieldCheck, ShieldOff, ShieldPlus } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { FormField, Input, Textarea } from "@/components/ui/FormField";
import { useToast } from "@/components/ui/Toast";
import { useFormat } from "@/i18n/format";
import { getErrorMessage } from "@/lib/axios";
import { useIsOffline } from "@/lib/offline/connectivityWatch";
import {
  createGateAuthorization, fetchGateAuthorizations, revokeGateAuthorization,
  type GateAuthorization,
} from "@/services/gate.service";

export function AuthorizationPanel({
  schoolId, studentId, studentName, onChanged,
}: {
  schoolId:    string;
  studentId:   string;
  studentName: string | null;
  onChanged:   () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const fmt = useFormat();
  const qc = useQueryClient();
  const offline = useIsOffline();

  const [granting, setGranting] = useState(false);
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [reason, setReason] = useState("");

  const [revoking, setRevoking] = useState<GateAuthorization | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  const key = ["gate", "authorizations", schoolId, studentId] as const;
  const passes = useQuery({
    queryKey: key,
    queryFn:  () => fetchGateAuthorizations(schoolId, studentId),
    enabled:  Boolean(schoolId && studentId),
  });

  const after = async () => {
    await qc.invalidateQueries({ queryKey: key });
    onChanged();
  };

  const grant = useMutation({
    mutationFn: () => createGateAuthorization({
      schoolId, studentId,
      validFrom:  validFrom || undefined,
      validUntil,
      reason:     reason.trim(),
    }),
    onSuccess: async () => {
      toast({ kind: "success", title: t("gatePage.auth.granted") });
      setGranting(false);
      setValidFrom(""); setValidUntil(""); setReason("");
      await after();
    },
    onError: (err) => toast({ kind: "error", title: t("gatePage.auth.grantFailed"), message: getErrorMessage(err) }),
  });

  const revoke = useMutation({
    mutationFn: (p: { id: string; reason: string }) => revokeGateAuthorization(schoolId, p.id, p.reason),
    onSuccess: async () => {
      toast({ kind: "success", title: t("gatePage.auth.revoked") });
      setRevoking(null); setRevokeReason("");
      await after();
    },
    onError: (err) => toast({ kind: "error", title: t("gatePage.auth.revokeFailed"), message: getErrorMessage(err) }),
  });

  const rows = (passes.data ?? []).filter((a) => !a.revokedAt);
  const offlineHint = offline ? t("gatePage.auth.needsConnection") : undefined;
  const datesOk = Boolean(validUntil) && (!validFrom || validFrom <= validUntil);

  return (
    <section className="space-y-3 border-t border-line pt-4" aria-labelledby={`gate-passes-${studentId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`gate-passes-${studentId}`} className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ShieldCheck className="h-4 w-4 text-info" aria-hidden="true" />
          {t("gatePage.auth.title")}
        </h3>
        <Button
          size="sm"
          variant="secondary"
          icon={<ShieldPlus className="h-4 w-4" />}
          disabled={offline}
          title={offlineHint}
          onClick={() => setGranting(true)}
        >
          {t("gatePage.auth.authorize")}
        </Button>
      </div>

      {passes.isError ? (
        <p className="text-sm text-ink-muted">{t("gatePage.auth.loadFailed")}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {passes.isLoading ? t("common.loading") : t("gatePage.auth.none")}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line">
          {rows.map((a) => (
            <li key={a._id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-ink">
                  {t("gatePage.auth.range", { from: fmt.date(a.validFrom), until: fmt.date(a.validUntil) })}
                </div>
                {a.reason && <div className="text-xs text-ink-muted">{a.reason}</div>}
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon={<ShieldOff className="h-4 w-4" />}
                disabled={offline}
                title={offlineHint}
                onClick={() => { setRevoking(a); setRevokeReason(""); }}
              >
                {t("gatePage.auth.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* ── Issue ───────────────────────────────────────────────────────── */}
      <Modal
        open={granting}
        onClose={() => setGranting(false)}
        title={t("gatePage.auth.grantTitle", { name: studentName ?? "" })}
      >
        <p className="text-sm text-ink-muted">{t("gatePage.auth.grantBlurb")}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <FormField label={t("gatePage.auth.validFrom")} hint={t("gatePage.auth.validFromHint")}>
            <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)}
                   aria-label={t("gatePage.auth.validFrom")} />
          </FormField>
          <FormField label={t("gatePage.auth.validUntil")} required
                     error={validFrom && validUntil && validFrom > validUntil ? t("gatePage.auth.endBeforeStart") : undefined}>
            <Input type="date" value={validUntil} required onChange={(e) => setValidUntil(e.target.value)}
                   aria-label={t("gatePage.auth.validUntil")} />
          </FormField>
        </div>
        <FormField label={t("gatePage.auth.reason")} required className="mt-3">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
                    aria-label={t("gatePage.auth.reason")} />
        </FormField>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setGranting(false)}>{t("common.cancel")}</Button>
          <Button
            loading={grant.isPending}
            disabled={!datesOk || !reason.trim() || offline}
            onClick={() => grant.mutate()}
          >
            {t("gatePage.auth.grant")}
          </Button>
        </div>
      </Modal>

      {/* ── Revoke ──────────────────────────────────────────────────────── */}
      <Modal
        open={Boolean(revoking)}
        onClose={() => { setRevoking(null); setRevokeReason(""); }}
        title={t("gatePage.auth.revokeTitle")}
      >
        {revoking && (
          <p className="text-sm text-ink-muted">
            {t("gatePage.auth.revokeBlurb", {
              name: studentName ?? "",
              from: fmt.date(revoking.validFrom),
              until: fmt.date(revoking.validUntil),
            })}
          </p>
        )}
        <FormField label={t("gatePage.auth.reason")} required className="mt-4">
          <Textarea rows={3} value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)}
                    aria-label={t("gatePage.auth.reason")} />
        </FormField>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => { setRevoking(null); setRevokeReason(""); }}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={revoke.isPending}
            disabled={!revokeReason.trim() || offline}
            onClick={() => revoking && revoke.mutate({ id: revoking._id, reason: revokeReason.trim() })}
          >
            {t("gatePage.auth.revoke")}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
