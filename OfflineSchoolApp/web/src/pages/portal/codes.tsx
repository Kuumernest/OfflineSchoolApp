// web/src/pages/portal/codes.tsx
//
// Issuing guardian codes.
//
// Keyed on a guardian, not a student: one code covers a whole family, so a
// parent with three children at the school signs in once rather than three
// times. Which children a code covers is chosen by the office, not inferred —
// the guardian fields on this roster are too sparse to infer from (2 of 16
// students have a phone recorded, none an email), and a wrong inference would
// show one family another family's children.
//
// A code is displayed exactly once. The server keeps only a bcrypt hash, so
// that is not an inconvenience to design around — it is what makes "the office
// cannot read a parent's code" true rather than a promise.

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { KeyRound, Copy, Check, Ban, Plus, Users } from "lucide-react";

import { useUser }     from "@/store/auth.store";
import { PageHeader }  from "@/components/ui/PageHeader";
import { Card }        from "@/components/ui/Card";
import { Button }      from "@/components/ui/Button";
import { Badge }       from "@/components/ui/Badge";
import { Modal }       from "@/components/ui/Modal";
import { PageSpinner, Spinner } from "@/components/ui/Spinner";
import { FormField, Input, Checkbox } from "@/components/ui/FormField";
import { SearchInput } from "@/components/ui/SearchInput";
import { useToast }    from "@/components/ui/Toast";
import {
  Table, THead, Th, TBody, Tr, Td, EmptyTable,
} from "@/components/ui/DataTable";
import { useFormat }   from "@/i18n/format";
import { cn }          from "@/utils/cn";
import { getErrorMessage } from "@/lib/axios";
import { fetchStudents } from "@/services/student.service";
import {
  fetchGuardianAccess, issueGuardianCode, revokeGuardianAccess,
} from "@/services/portalAdmin.service";

export default function GuardianCodesPage() {
  const { t }    = useTranslation();
  const fmt      = useFormat();
  const qc       = useQueryClient();
  const { toast, confirm } = useToast();
  const schoolId = useUser()?.schoolId ?? "";

  const [open, setOpen]       = useState(false);
  const [label, setLabel]     = useState("");
  const [picked, setPicked]   = useState<string[]>([]);
  const [query, setQuery]     = useState("");
  const [issued, setIssued]   = useState<{ code: string; who: string } | null>(null);
  const [copied, setCopied]   = useState(false);

  const accessQ = useQuery({
    queryKey: ["guardianAccess", schoolId],
    queryFn:  () => fetchGuardianAccess(schoolId),
    enabled:  !!schoolId,
  });

  const studentsQ = useQuery({
    queryKey: ["students", "guardianPicker", schoolId],
    queryFn:  () => fetchStudents({ schoolId, status: "approved" }),
    enabled:  !!schoolId && open,
  });

  const issueMutation = useMutation({
    mutationFn: (payload: { studentIds?: string[]; accessId?: string; label?: string | null }) =>
      issueGuardianCode(schoolId, payload),
    onSuccess: (res, payload) => {
      const who = payload.accessId
        ? (accessQ.data?.find((a) => a._id === payload.accessId)?.label ?? "")
        : label;
      setIssued({ code: res.code, who });
      setCopied(false);
      setOpen(false);
      setLabel("");
      setPicked([]);
      void qc.invalidateQueries({ queryKey: ["guardianAccess"] });
    },
    onError: (err) =>
      toast({ kind: "error", title: t("codes.issue"), message: getErrorMessage(err) }),
  });

  const revokeMutation = useMutation({
    mutationFn: (accessId: string) => revokeGuardianAccess(accessId, schoolId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["guardianAccess"] }); },
    onError: (err) =>
      toast({ kind: "error", title: t("codes.revoke"), message: getErrorMessage(err) }),
  });

  const students = useMemo(() => {
    const list = studentsQ.data?.students ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      `${s.name ?? ""} ${s.enrollmentNo ?? ""}`.toLowerCase().includes(q)
    );
  }, [studentsQ.data, query]);

  if (accessQ.isLoading) return <PageSpinner />;

  const rows = accessQ.data ?? [];

  const askRevoke = async (accessId: string) => {
    const ok = await confirm({
      title:        t("codes.revokeTitle"),
      message:      t("codes.revokeBody"),
      confirmLabel: t("codes.revoke"),
      kind:         "danger",
    });
    if (ok) revokeMutation.mutate(accessId);
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.code);
      setCopied(true);
    } catch {
      // Clipboard access is refused in plenty of contexts. The code is on
      // screen either way, which is what actually matters.
    }
  };

  const portalUrl = `${window.location.origin}/portal`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("codes.title")}
        description={t("codes.blurb")}
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
            {t("codes.newAccess")}
          </Button>
        }
      />

      <p className="text-xs text-ink-muted">
        {t("codes.portalAddress", { url: portalUrl })}
      </p>

      <Card padding={false}>
        {rows.length === 0 ? (
          <EmptyTable title={t("codes.noAccess2")} subtitle={t("codes.noAccessHint")} />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>{t("codes.guardian")}</Th>
                <Th>{t("codes.covers")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("codes.never")}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {rows.map((a) => (
                <Tr key={a._id}>
                  <Td className="font-medium text-ink">{a.label || "—"}</Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      {a.children.map((c) => (
                        <Badge key={c._id} variant="info">{c.name || c.enrollmentNo}</Badge>
                      ))}
                    </span>
                  </Td>
                  <Td>
                    {a.hasCode ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant="success">{t("codes.hasAccess")}</Badge>
                        {a.hint && (
                          <span className="text-xs text-ink-muted">
                            {t("codes.endingIn", { hint: a.hint })}
                          </span>
                        )}
                      </span>
                    ) : a.revokedAt ? (
                      <Badge variant="danger">{t("codes.revoked")}</Badge>
                    ) : (
                      <Badge variant="default">{t("codes.noAccess")}</Badge>
                    )}
                  </Td>
                  <Td className="text-xs text-ink-muted">
                    {a.lastSeenAt ? fmt.dateShort(a.lastSeenAt) : t("codes.never")}
                  </Td>
                  <Td numeric>
                    <span className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<KeyRound className="h-3.5 w-3.5" />}
                        loading={
                          issueMutation.isPending &&
                          issueMutation.variables?.accessId === a._id
                        }
                        onClick={() => issueMutation.mutate({ accessId: a._id })}
                      >
                        {t("codes.reissue")}
                      </Button>
                      {a.hasCode && (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Ban className="h-3.5 w-3.5" />}
                          onClick={() => askRevoke(a._id)}
                        >
                          {t("codes.revoke")}
                        </Button>
                      )}
                    </span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {/* New guardian */}
      <Modal open={open} onClose={() => setOpen(false)} title={t("codes.newAccess")} size="lg">
        <div className="space-y-4">
          <FormField label={t("codes.guardianLabel")} hint={t("codes.guardianHint")}>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("codes.guardianPh")}
              autoFocus
            />
          </FormField>

          <div>
            <p className="mb-1 text-sm font-medium text-ink">{t("codes.pickChildren")}</p>
            <p className="mb-2 text-xs text-ink-muted">{t("codes.childrenHint")}</p>

            <SearchInput value={query} onChange={setQuery} placeholder={t("codes.searchChild")} />

            {studentsQ.isLoading ? (
              <div className="flex justify-center py-8"><Spinner /></div>
            ) : (
              <div className="mt-2 max-h-[300px] overflow-y-auto rounded-card border border-line">
                {students.map((s) => (
                  <label
                    key={s._id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 last:border-b-0",
                      picked.includes(s._id) ? "bg-primary-50/60" : "hover:bg-canvas"
                    )}
                  >
                    <Checkbox
                      label=""
                      checked={picked.includes(s._id)}
                      onChange={(e) =>
                        setPicked((p) =>
                          e.target.checked ? [...p, s._id] : p.filter((id) => id !== s._id)
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {s.name || s.enrollmentNo || s._id}
                    </span>
                    <span className="shrink-0 text-xs text-ink-muted">
                      {s.enrollmentNo ?? "—"}
                    </span>
                  </label>
                ))}
              </div>
            )}

            <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-muted">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {t("codes.selectedCount", { count: picked.length })}
            </p>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              loading={issueMutation.isPending}
              disabled={picked.length === 0}
              onClick={() =>
                issueMutation.mutate({ studentIds: picked, label: label.trim() || null })
              }
            >
              {t("codes.issue")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Shown once. There is no way back to it. */}
      <Modal
        open={Boolean(issued)}
        onClose={() => setIssued(null)}
        title={t("codes.newCodeTitle")}
        size="sm"
        closeOnBackdrop={false}
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">{t("codes.newCodeBody")}</p>

          <div className="rounded-card border border-line bg-canvas px-4 py-5 text-center">
            {issued?.who && <p className="text-xs text-ink-muted">{issued.who}</p>}
            <p className="mt-2 font-mono text-2xl font-bold tracking-[0.15em] text-ink">
              {issued?.code}
            </p>
          </div>

          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button
              variant="secondary"
              icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              onClick={copy}
            >
              {copied ? t("codes.copied") : t("codes.copy")}
            </Button>
            <Button onClick={() => setIssued(null)}>{t("common.done")}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
