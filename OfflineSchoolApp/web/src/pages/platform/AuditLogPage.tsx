// web/src/pages/platform/AuditLogPage.tsx
//
// What platform administrators did, and to which school. Read-only by
// construction: the API has no route that edits or removes an audit row.
import { useState }             from "react";
import { useQuery }             from "@tanstack/react-query";
import { useTranslation }       from "react-i18next";
import { roleLabel } from "@/utils/roleLabel";
import { auditActionLabel, auditSentences } from "@/utils/auditText";
import { Link }                 from "react-router-dom";
import { ScrollText }           from "lucide-react";
import { PageHeader }           from "@/components/ui/PageHeader";
import { Card }                 from "@/components/ui/Card";
import { Badge }                from "@/components/ui/Badge";
import { Pagination }           from "@/components/ui/Pagination";
import { FormField, Input, SelectField } from "@/components/ui/FormField";
import { Table, THead, Th, TBody, Tr, Td, EmptyTable } from "@/components/ui/DataTable";
import { useFormat }            from "@/i18n/format";
import {
  fetchAuditLog, fetchPlatformFilters, type AuditEntry,
} from "@/services/platform.service";

const ACTION_VARIANT = (action: string): "success" | "danger" | "warning" | "info" | "default" => {
  if (action.endsWith(".created") || action.endsWith(".activated") || action.endsWith(".restored")) return "success";
  if (action.endsWith(".deactivated") || action.endsWith(".removed") || action.endsWith(".unpublished")) return "danger";
  if (action.endsWith(".passwordReset") || action.endsWith(".updated") ||
      action.endsWith(".rulesChanged") || action.endsWith(".reissued")) return "warning";
  if (action.endsWith(".entered")) return "info";
  return "default";
};

function Details({ e }: { e: AuditEntry }) {
  const { t } = useTranslation();
  const sentences = auditSentences(e, t);
  return (
    <div className="space-y-1 text-xs leading-relaxed text-ink-muted">
      {sentences.map((line, i) => <p key={i} className="break-words">{line}</p>)}
      {e.reason ? <p className="break-words"><span className="font-medium">{t("platform.audit.reason")}:</span> {e.reason}</p> : null}
    </div>
  );
}

function SchoolCell({ e }: { e: AuditEntry }) {
  const { t } = useTranslation();
  if (!e.schoolId) return <>—</>;
  if (e.schoolDeleted || !e.schoolName) {
    return <span className="italic text-ink-muted" title={e.schoolName ?? undefined}>{t("platform.audit.deletedSchool")}</span>;
  }
  return <Link to={`/platform/schools/${e.schoolId}`} className="hover:underline">{e.schoolName}</Link>;
}

export default function AuditLogPage() {
  const { t } = useTranslation();
  const fmt   = useFormat();
  const a = (k: string) => t(`platform.audit.${k}`);

  const [schoolId, setSchoolId] = useState("");
  const [action, setAction]     = useState("");
  const [from, setFrom]         = useState("");
  const [to, setTo]             = useState("");
  const [page, setPage]         = useState(1);

  const optionsQ = useQuery({ queryKey: ["platform", "filters"], queryFn: fetchPlatformFilters });
  const logQ = useQuery({
    queryKey: ["platform", "audit", { schoolId, action, from, to, page }],
    queryFn:  () => fetchAuditLog({
      schoolId: schoolId || undefined, action: action || undefined,
      from: from || undefined, to: to ? `${to}T23:59:59` : undefined, page, limit: 50,
    }),
  });

  const actions = logQ.data?.actions ?? [];
  const entries = logQ.data?.items ?? [];
  const reset = () => setPage(1);

  return (
    <div className="space-y-6">
      <PageHeader title={a("title")} description={a("subtitle")} />

      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label={a("school")}>
            <SelectField value={schoolId} onChange={(e) => { setSchoolId(e.target.value); reset(); }}
              options={[{ value: "", label: t("platform.filters.allSchools") },
                ...(optionsQ.data?.schools ?? []).map((s) => ({ value: s._id, label: s.name }))]} />
          </FormField>
          <FormField label={a("action")}>
            <SelectField value={action} onChange={(e) => { setAction(e.target.value); reset(); }}
              options={[{ value: "", label: a("allActions") },
                ...actions.map((k) => ({ value: k, label: auditActionLabel(k, t) }))]} />
          </FormField>
          <FormField label={t("platform.filters.from")}>
            <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} />
          </FormField>
          <FormField label={t("platform.filters.to")}>
            <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} />
          </FormField>
        </div>
      </Card>

      <Card padding={false}>
        {logQ.isError ? (
          <EmptyTable icon={<ScrollText className="h-8 w-8" />} title={a("loadFailed")} />
        ) : !logQ.isLoading && entries.length === 0 ? (
          <EmptyTable icon={<ScrollText className="h-8 w-8" />} title={a("empty")} />
        ) : (
          <>
            <Table>
              <THead>
                <Th>{a("when")}</Th>
                <Th>{a("action")}</Th>
                <Th>{a("school")}</Th>
                <Th>{a("who")}</Th>
                <Th>{a("details")}</Th>
              </THead>
              <TBody>
                {entries.map((e) => (
                  <Tr key={e._id} className="align-top">
                    <Td className="whitespace-nowrap">{fmt.dateTime(e.at)}</Td>
                    <Td>
                      <Badge variant={ACTION_VARIANT(e.action)}>
                        {auditActionLabel(e.action, t)}
                      </Badge>
                    </Td>
                    <Td wrap className="max-w-xs">
                      <SchoolCell e={e} />
                    </Td>
                    <Td>
                      <div>{e.actorName ?? e.actorId ?? "—"}</div>
                      {e.actorRole ? <div className="text-xs text-ink-muted">{roleLabel(e.actorRole, t)}</div> : null}
                    </Td>
                    <Td wrap className="min-w-[14rem] max-w-md">
                      <Details e={e} />
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            {logQ.data && logQ.data.pages > 1 && (
              <div className="px-5 py-3">
                <Pagination page={logQ.data.page} pages={logQ.data.pages} total={logQ.data.total} onPageChange={setPage} />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
