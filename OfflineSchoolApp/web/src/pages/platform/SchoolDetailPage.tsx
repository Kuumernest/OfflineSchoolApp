// web/src/pages/platform/SchoolDetailPage.tsx
//
// One school as the platform sees it: its identity, its status, who runs it,
// and what was last done to it. Appointing an administrator goes through the
// same POST /admin/settings/admins the school's own settings screen uses, with
// this school named — the platform does not keep a second copy of that flow.
import { useState }              from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation }        from "react-i18next";
import { Link, useParams }       from "react-router-dom";
import {
  ArrowLeft, LogIn, Power, PowerOff, UserPlus, KeyRound, Save, AlertTriangle, Building2,
  GraduationCap, Users, ShieldCheck, CalendarDays,
} from "lucide-react";
import { PageHeader }            from "@/components/ui/PageHeader";
import { Card, CardHeader }      from "@/components/ui/Card";
import { Button }                from "@/components/ui/Button";
import { Badge }                 from "@/components/ui/Badge";
import { Modal }                 from "@/components/ui/Modal";
import { PageSpinner }           from "@/components/ui/Spinner";
import { FormField, Input, SelectField, Textarea, Checkbox } from "@/components/ui/FormField";
import { Table, THead, Th, TBody, Tr, Td, EmptyTable } from "@/components/ui/DataTable";
import { useToast }              from "@/components/ui/Toast";
import { useFormat }             from "@/i18n/format";
import { useEnterSchool, errorMessage } from "@/components/platform/useEnterSchool";
import { MetricTile, MetricGrid } from "@/components/platform/MetricTile";
import {
  fetchSchool, updateSchool, activateSchool, deactivateSchool,
  appointSchoolAdmin, resetSchoolAdminPassword,
  type SchoolIdentity, type PlatformSchool, type AuditEntry,
} from "@/services/platform.service";

const IDENTITY: (keyof SchoolIdentity)[] = [
  "name", "code", "email", "phone", "address", "city", "state", "country", "website", "principalName",
];
const pick = (school: PlatformSchool): SchoolIdentity => ({
  name: school.name, code: school.code ?? "", email: school.email ?? "", phone: school.phone ?? "",
  address: school.address ?? "", city: school.city ?? "", state: school.state ?? "",
  country: school.country ?? "", website: school.website ?? "", principalName: school.principalName ?? "",
  verified: Boolean(school.verified),
});

interface Credentials { email: string; tempPassword?: string; emailSent?: boolean; }

export default function SchoolDetailPage() {
  const { schoolId = "" } = useParams();
  const { t }     = useTranslation();
  const fmt       = useFormat();
  const qc        = useQueryClient();
  const { toast, confirm } = useToast();
  const s = (k: string) => t(`platform.schools.${k}`);

  const detailQ = useQuery({
    queryKey: ["platform", "school", schoolId],
    queryFn:  () => fetchSchool(schoolId),
    enabled:  Boolean(schoolId),
    retry:    false,
  });
  const school = detailQ.data?.school;
  const { enter, enteringId } = useEnterSchool();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["platform"] });

  // ── Identity form ─────────────────────────────────────────────────────────
  const [form, setForm]       = useState<SchoolIdentity | null>(null);
  const [saving, setSaving]   = useState(false);
  // Seeded from the school, and re-seeded when the server sends a newer copy
  // (after a save or a status change). Derived during render rather than in an
  // effect — the documented way to reconcile state with a changed input, and
  // it does not paint a stale form for one frame first.
  const formKey = school ? `${school._id}:${school.updatedAt ?? ""}` : null;
  const [formFor, setFormFor] = useState<string | null>(null);
  if (school && formKey !== formFor) {
    setFormFor(formKey);
    setForm(pick(school));
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || !school) return;
    if (!form.name?.trim()) { toast({ title: s("nameRequired"), kind: "warning" }); return; }
    // Send only what differs; the server audits exactly those fields.
    const current = pick(school);
    const patch: SchoolIdentity = {};
    for (const k of IDENTITY) if ((form[k] ?? "") !== (current[k] ?? "")) (patch as Record<string, unknown>)[k] = form[k];
    if (Boolean(form.verified) !== Boolean(current.verified)) patch.verified = Boolean(form.verified);
    if (!Object.keys(patch).length) return;
    setSaving(true);
    try {
      await updateSchool(school._id, patch);
      toast({ title: s("updated"), kind: "success" });
      await invalidate();
    } catch (err) {
      toast({ title: errorMessage(err) ?? s("updateFailed"), kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  // ── Status ────────────────────────────────────────────────────────────────
  const [deactivating, setDeactivating] = useState(false);
  const [reason, setReason]             = useState("");
  const [statusBusy, setStatusBusy]     = useState(false);
  const setActive = async (active: boolean) => {
    if (!school) return;
    if (!active && !reason.trim()) { toast({ title: s("reasonRequired"), kind: "warning" }); return; }
    setStatusBusy(true);
    try {
      if (active) await activateSchool(school._id); else await deactivateSchool(school._id, reason.trim());
      toast({ title: s(active ? "activated" : "deactivated"), kind: "success" });
      setDeactivating(false); setReason("");
      await invalidate();
    } catch (err) {
      toast({ title: errorMessage(err) ?? s("statusFailed"), kind: "error" });
    } finally {
      setStatusBusy(false);
    }
  };

  // ── Staff ─────────────────────────────────────────────────────────────────
  const [appointing, setAppointing] = useState(false);
  const [staffName, setStaffName]   = useState("");
  const [staffEmail, setStaffEmail] = useState("");
  const [staffRole, setStaffRole]   = useState<"school_admin" | "bursar">("school_admin");
  const [staffBusy, setStaffBusy]   = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);

  const appoint = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!school) return;
    if (!staffName.trim()) { toast({ title: s("nameRequired"), kind: "warning" }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(staffEmail.trim())) { toast({ title: s("emailInvalid"), kind: "warning" }); return; }
    setStaffBusy(true);
    try {
      const res = await appointSchoolAdmin(school._id, { name: staffName.trim(), email: staffEmail.trim(), role: staffRole });
      toast({ title: s(res.restored ? "restored" : "appointed"), kind: "success" });
      setCredentials({ email: res.admin?.email ?? staffEmail.trim(), tempPassword: res.tempPassword, emailSent: res.emailSent });
      setAppointing(false); setStaffName(""); setStaffEmail("");
      await invalidate();
    } catch (err) {
      toast({ title: errorMessage(err) ?? s("appointFailed"), kind: "error" });
    } finally {
      setStaffBusy(false);
    }
  };

  const resetPassword = async (adminId: string, email: string) => {
    if (!school) return;
    const yes = await confirm({ title: s("resetPassword"), message: s("resetConfirm").replace("{{email}}", email), kind: "warning" });
    if (!yes) return;
    try {
      const res = await resetSchoolAdminPassword(school._id, adminId);
      toast({ title: s("passwordReset"), kind: "success" });
      setCredentials({ email, tempPassword: res.tempPassword, emailSent: res.emailSent });
      await invalidate();
    } catch (err) {
      toast({ title: errorMessage(err) ?? s("resetFailed"), kind: "error" });
    }
  };

  if (detailQ.isLoading) return <PageSpinner />;
  if (detailQ.isError || !school || !form) {
    return (
      <div className="space-y-4">
        <Link to="/platform/schools" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
          <ArrowLeft className="h-4 w-4" />{s("back")}
        </Link>
        <EmptyTable icon={<Building2 className="h-8 w-8" />} title={s("notFound")} />
      </div>
    );
  }

  const admins = detailQ.data?.admins ?? [];
  const recent = detailQ.data?.recentAudit ?? [];
  const setField = (k: keyof SchoolIdentity) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  return (
    <div className="space-y-6">
      <Link to="/platform/schools" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" />{s("back")}
      </Link>

      <PageHeader
        title={school.name}
        description={[school.code, school.city, school.country].filter(Boolean).join(" · ") || s("detail")}
        meta={
          <Badge variant={school.isActive ? "success" : "danger"}>
            {school.isActive ? s("statusActive") : s("statusInactive")}
          </Badge>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {school.isActive ? (
              <Button variant="secondary" icon={<PowerOff className="h-4 w-4" />} onClick={() => { setReason(""); setDeactivating(true); }}>
                {s("deactivate")}
              </Button>
            ) : (
              <Button variant="secondary" icon={<Power className="h-4 w-4" />} loading={statusBusy} onClick={() => setActive(true)}>
                {s("activate")}
              </Button>
            )}
            <Button icon={<LogIn className="h-4 w-4" />} loading={enteringId === school._id} onClick={() => enter(school._id)}>
              {s("enter")}
            </Button>
          </div>
        }
      />

      {!school.isActive && (
        <div role="status" className="flex items-start gap-2 rounded-card border border-warning-line bg-warning-soft px-4 py-3 text-sm text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span>{s("inactiveBanner")}</span>
        </div>
      )}

      <MetricGrid className="sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-4">
        <MetricTile tone="students" icon={GraduationCap} label={s("students")} value={fmt.number(school.counts.students)} />
        <MetricTile tone="teachers" icon={Users}         label={s("teachers")} value={fmt.number(school.counts.teachers)} />
        <MetricTile tone="schools"  icon={ShieldCheck}   label={s("admins")}   value={fmt.number(school.counts.admins)} />
        <MetricTile tone="neutral"  icon={CalendarDays}  label={s("academicYear")}
          value={school.settings?.academicYear || "—"} hint={school.settings?.currentTerm || undefined} />
      </MetricGrid>

      {/* Side by side from 1280px; at 1024px two half-width panels left the
          staff and activity tables scrolling inside their cards. */}
      <div className="grid gap-6 xl:grid-cols-2">
        {/* ── Identity ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title={s("identity")} />
          <form onSubmit={save} className="mt-3 space-y-3">
            <FormField label={s("name")} required><Input value={form.name ?? ""} onChange={setField("name")} /></FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={s("code")} hint={s("codeHint")}><Input value={form.code ?? ""} onChange={setField("code")} maxLength={10} /></FormField>
              <FormField label={s("principal")}><Input value={form.principalName ?? ""} onChange={setField("principalName")} /></FormField>
              <FormField label={s("email")}><Input type="email" value={form.email ?? ""} onChange={setField("email")} /></FormField>
              <FormField label={s("phone")}><Input value={form.phone ?? ""} onChange={setField("phone")} /></FormField>
              <FormField label={s("city")}><Input value={form.city ?? ""} onChange={setField("city")} /></FormField>
              <FormField label={s("state")}><Input value={form.state ?? ""} onChange={setField("state")} /></FormField>
              <FormField label={s("country")}><Input value={form.country ?? ""} onChange={setField("country")} /></FormField>
              <FormField label={s("website")}><Input value={form.website ?? ""} onChange={setField("website")} /></FormField>
            </div>
            <FormField label={s("address")}><Input value={form.address ?? ""} onChange={setField("address")} /></FormField>
            <Checkbox label={s("verified")} checked={Boolean(form.verified)}
              onChange={(e) => setForm((f) => (f ? { ...f, verified: e.target.checked } : f))} />
            <div className="flex justify-end">
              <Button type="submit" icon={<Save className="h-4 w-4" />} loading={saving}>{t("common.save")}</Button>
            </div>
          </form>
        </Card>

        {/* ── Staff ────────────────────────────────────────────────────── */}
        <div className="min-w-0 space-y-6">
          <Card padding={false}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4">
              <CardHeader title={s("staff")} />
              <Button size="sm" variant="secondary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAppointing(true)}>
                {s("appoint")}
              </Button>
            </div>
            {admins.length === 0 ? (
              <EmptyTable title={s("noStaff")} />
            ) : (
              <Table>
                <THead><Th>{t("common.name")}</Th><Th>{s("role")}</Th><Th>{t("common.actions")}</Th></THead>
                <TBody>
                  {admins.map((a) => (
                    <Tr key={a._id}>
                      <Td className="max-w-[16rem]">
                        <div className="truncate font-medium" title={a.name}>{a.name}</div>
                        <div className="truncate text-xs text-ink-muted" title={a.email}>{a.email}</div>
                      </Td>
                      <Td>
                        <Badge variant={a.role === "school_admin" ? "primary" : "info"}>
                          {s(a.role === "school_admin" ? "roleAdmin" : "roleBursar")}
                        </Badge>
                        {a.mustResetPassword ? <Badge variant="warning" className="ml-1">{s("mustReset")}</Badge> : null}
                      </Td>
                      <Td>
                        <Button size="sm" variant="ghost" icon={<KeyRound className="h-4 w-4" />} onClick={() => resetPassword(a._id, a.email)}>
                          {s("resetPassword")}
                        </Button>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          {credentials && (
            <Card>
              <CardHeader title={s("tempPassword")} subtitle={credentials.emailSent ? s("emailSent") : s("emailNotSent")} />
              <dl className="mt-2 text-sm">
                <div className="flex flex-wrap justify-between gap-x-2"><dt className="text-ink-muted">{s("email")}</dt><dd className="min-w-0 break-all font-medium">{credentials.email}</dd></div>
                {credentials.tempPassword ? (
                  <div className="flex flex-wrap justify-between gap-x-2"><dt className="text-ink-muted">{s("tempPassword")}</dt><dd className="min-w-0 break-all font-mono font-medium">{credentials.tempPassword}</dd></div>
                ) : null}
              </dl>
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => setCredentials(null)}>{t("common.close")}</Button>
              </div>
            </Card>
          )}

          <Card padding={false}>
            <div className="px-5 pt-4"><CardHeader title={s("recentActivity")} /></div>
            {recent.length === 0 ? (
              <EmptyTable title={s("noActivity")} />
            ) : (
              <Table>
                <THead><Th>{t("platform.audit.when")}</Th><Th>{t("platform.audit.action")}</Th><Th>{t("platform.audit.who")}</Th></THead>
                <TBody>
                  {recent.map((e: AuditEntry) => (
                    <Tr key={e._id}>
                      <Td>{fmt.dateTime(e.at)}</Td>
                      <Td wrap className="min-w-[10rem] max-w-xs">
                        {t(`platform.audit.actions.${e.action}`, { defaultValue: e.action })}
                        {e.resourceLabel && e.resourceType === "user" ? <span className="ml-1 text-ink-muted">· {e.resourceLabel}</span> : null}
                      </Td>
                      <Td>{e.actorName ?? e.actorId ?? "—"}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      </div>

      {/* ── Deactivate ─────────────────────────────────────────────────── */}
      <Modal open={deactivating} onClose={() => setDeactivating(false)} title={s("deactivateTitle").replace("{{name}}", school.name)} size="sm">
        <p className="text-sm text-ink-muted">{s("deactivateBody")}</p>
        <FormField label={s("reason")} required className="mt-3">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </FormField>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeactivating(false)}>{t("common.cancel")}</Button>
          <Button variant="danger" loading={statusBusy} onClick={() => setActive(false)}>{s("deactivate")}</Button>
        </div>
      </Modal>

      {/* ── Appoint ────────────────────────────────────────────────────── */}
      <Modal open={appointing} onClose={() => setAppointing(false)} title={s("appointTitle").replace("{{name}}", school.name)} size="sm">
        <form onSubmit={appoint} className="space-y-3">
          <p className="text-sm text-ink-muted">{s("appointBody")}</p>
          <FormField label={t("common.name")} required><Input value={staffName} onChange={(e) => setStaffName(e.target.value)} autoFocus /></FormField>
          <FormField label={s("email")} required><Input type="email" value={staffEmail} onChange={(e) => setStaffEmail(e.target.value)} /></FormField>
          <FormField label={s("role")}>
            <SelectField value={staffRole} onChange={(e) => setStaffRole(e.target.value as "school_admin" | "bursar")}
              options={[{ value: "school_admin", label: s("roleAdmin") }, { value: "bursar", label: s("roleBursar") }]} />
          </FormField>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAppointing(false)}>{t("common.cancel")}</Button>
            <Button type="submit" loading={staffBusy}>{s("appoint")}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
