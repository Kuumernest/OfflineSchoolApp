// web/src/pages/platform/SchoolsPage.tsx
//
// Every school: find one, create one, step into one, switch one off. The
// school's own screens are not duplicated here — "Enter" hands the operator
// the ordinary admin console for that school.
import { useState }             from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation }       from "react-i18next";
import { Link, useNavigate }    from "react-router-dom";
import { Building2, Plus, LogIn, Eye, Power, PowerOff } from "lucide-react";
import { PageHeader }           from "@/components/ui/PageHeader";
import { Card }                 from "@/components/ui/Card";
import { Button }               from "@/components/ui/Button";
import { Badge }                from "@/components/ui/Badge";
import { Modal }                from "@/components/ui/Modal";
import { SearchInput }          from "@/components/ui/SearchInput";
import { Pagination }           from "@/components/ui/Pagination";
import { FormField, Input, SelectField, Textarea } from "@/components/ui/FormField";
import { Table, THead, Th, TBody, Tr, Td, EmptyTable } from "@/components/ui/DataTable";
import { useToast }             from "@/components/ui/Toast";
import { useFormat }            from "@/i18n/format";
import { useEnterSchool, errorMessage } from "@/components/platform/useEnterSchool";
import {
  fetchSchools, createSchool, activateSchool, deactivateSchool,
  type PlatformSchool, type CreateSchoolInput,
} from "@/services/platform.service";

type Status = "all" | "active" | "inactive";

const EMPTY_FORM: CreateSchoolInput = { name: "", code: "", email: "", phone: "", city: "", country: "" };
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SchoolsPage() {
  const { t }     = useTranslation();
  const fmt       = useFormat();
  const qc        = useQueryClient();
  const navigate  = useNavigate();
  const { toast } = useToast();
  const s = (k: string) => t(`platform.schools.${k}`);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [page,   setPage]   = useState(1);

  const listQ = useQuery({
    queryKey: ["platform", "schools", { search, status, page }],
    queryFn:  () => fetchSchools({ search: search || undefined, status, page, limit: 25 }),
  });
  const { enter, enteringId } = useEnterSchool();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["platform"] });

  // ── Create ────────────────────────────────────────────────────────────────
  const [creating, setCreating] = useState(false);
  const [form, setForm]         = useState<CreateSchoolInput>(EMPTY_FORM);
  const [academicYear, setAcademicYear] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving]     = useState(false);

  const submitCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!form.name.trim()) { setFormError(s("nameRequired")); return; }
    if (form.email && !EMAIL_RX.test(form.email)) { setFormError(s("emailInvalid")); return; }
    setSaving(true);
    try {
      const created = await createSchool({
        ...form,
        name: form.name.trim(),
        settings: academicYear ? { academicYear } : undefined,
      });
      toast({ title: s("created"), kind: "success" });
      setCreating(false);
      setForm(EMPTY_FORM);
      setAcademicYear("");
      await invalidate();
      navigate(`/platform/schools/${created._id}`);
    } catch (err) {
      setFormError(errorMessage(err) ?? s("createFailed"));
    } finally {
      setSaving(false);
    }
  };

  // ── Switch on / off ───────────────────────────────────────────────────────
  const [deactivating, setDeactivating] = useState<PlatformSchool | null>(null);
  const [reason, setReason]             = useState("");
  const [busyId, setBusyId]             = useState<string | null>(null);

  const setActive = async (school: PlatformSchool, active: boolean) => {
    if (!active && !reason.trim()) { toast({ title: s("reasonRequired"), kind: "warning" }); return; }
    setBusyId(school._id);
    try {
      if (active) await activateSchool(school._id);
      else        await deactivateSchool(school._id, reason.trim());
      toast({ title: s(active ? "activated" : "deactivated"), kind: "success" });
      setDeactivating(null);
      setReason("");
      await invalidate();
    } catch (err) {
      toast({ title: errorMessage(err) ?? s("statusFailed"), kind: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const items = listQ.data?.items ?? [];
  const field = (k: keyof CreateSchoolInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={s("title")}
        description={s("subtitle")}
        actions={
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            {s("create")}
          </Button>
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[240px] flex-1">
            <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder={s("search")} />
          </div>
          <SelectField
            value={status}
            onChange={(e) => { setStatus(e.target.value as Status); setPage(1); }}
            options={[
              { value: "all",      label: s("statusAll") },
              { value: "active",   label: s("statusActive") },
              { value: "inactive", label: s("statusInactive") },
            ]}
            className="w-44"
          />
        </div>
      </Card>

      <Card padding={false}>
        {listQ.isError ? (
          <EmptyTable icon={<Building2 className="h-8 w-8" />} title={s("loadFailed")} />
        ) : !listQ.isLoading && items.length === 0 ? (
          <EmptyTable
            icon={<Building2 className="h-8 w-8" />}
            title={s("empty")}
            subtitle={s("emptyHint")}
            action={<Button size="sm" onClick={() => setCreating(true)}>{s("create")}</Button>}
          />
        ) : (
          <>
            <Table>
              <THead>
                <Th>{s("name")}</Th>
                <Th>{s("city")}</Th>
                <Th numeric>{s("students")}</Th>
                <Th numeric>{s("teachers")}</Th>
                <Th numeric>{s("admins")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>{t("common.actions")}</Th>
              </THead>
              <TBody>
                {items.map((sc) => (
                  <Tr key={sc._id}>
                    <Td wrap className="min-w-[14rem] max-w-md">
                      <Link to={`/platform/schools/${sc._id}`} className="font-medium text-ink hover:underline">{sc.name}</Link>
                      {sc.code ? <span className="ml-1 text-ink-muted">({sc.code})</span> : null}
                      {sc.settings?.academicYear ? (
                        <div className="text-xs text-ink-muted">{sc.settings.academicYear}{sc.settings.currentTerm ? ` · ${sc.settings.currentTerm}` : ""}</div>
                      ) : null}
                    </Td>
                    <Td wrap className="max-w-[12rem]">{[sc.city, sc.country].filter(Boolean).join(", ") || "—"}</Td>
                    <Td numeric>{fmt.number(sc.counts.students)}</Td>
                    <Td numeric>{fmt.number(sc.counts.teachers)}</Td>
                    <Td numeric>{fmt.number(sc.counts.admins)}</Td>
                    <Td>
                      <Badge variant={sc.isActive ? "success" : "danger"}>
                        {sc.isActive ? s("statusActive") : s("statusInactive")}
                      </Badge>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        <Link to={`/platform/schools/${sc._id}`}>
                          <Button size="sm" variant="ghost" icon={<Eye className="h-4 w-4" />}>{s("view")}</Button>
                        </Link>
                        <Button size="sm" variant="ghost" icon={<LogIn className="h-4 w-4" />}
                          loading={enteringId === sc._id} onClick={() => enter(sc._id)}>
                          {s("enter")}
                        </Button>
                        {sc.isActive ? (
                          <Button size="sm" variant="ghost" icon={<PowerOff className="h-4 w-4" />}
                            onClick={() => { setReason(""); setDeactivating(sc); }}>
                            {s("deactivate")}
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" icon={<Power className="h-4 w-4" />}
                            loading={busyId === sc._id} onClick={() => setActive(sc, true)}>
                            {s("activate")}
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            {listQ.data && listQ.data.pages > 1 && (
              <div className="px-5 py-3">
                <Pagination page={listQ.data.page} pages={listQ.data.pages} total={listQ.data.total} onPageChange={setPage} />
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── Create ─────────────────────────────────────────────────────── */}
      <Modal open={creating} onClose={() => setCreating(false)} title={s("createTitle")} size="md">
        <form onSubmit={submitCreate} className="space-y-3">
          <FormField label={s("name")} required>
            <Input value={form.name} onChange={field("name")} autoFocus />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={s("code")} hint={s("codeHint")}>
              <Input value={form.code ?? ""} onChange={field("code")} maxLength={10} />
            </FormField>
            <FormField label={s("academicYear")} hint={s("academicYearHint")}>
              <Input value={academicYear} onChange={(e) => setAcademicYear(e.target.value)} placeholder="2026/2027" />
            </FormField>
            <FormField label={s("email")}>
              <Input type="email" value={form.email ?? ""} onChange={field("email")} />
            </FormField>
            <FormField label={s("phone")}>
              <Input value={form.phone ?? ""} onChange={field("phone")} />
            </FormField>
            <FormField label={s("city")}>
              <Input value={form.city ?? ""} onChange={field("city")} />
            </FormField>
            <FormField label={s("country")}>
              <Input value={form.country ?? ""} onChange={field("country")} />
            </FormField>
          </div>
          {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setCreating(false)}>{t("common.cancel")}</Button>
            <Button type="submit" loading={saving}>{s("create")}</Button>
          </div>
        </form>
      </Modal>

      {/* ── Deactivate ─────────────────────────────────────────────────── */}
      <Modal open={Boolean(deactivating)} onClose={() => setDeactivating(null)}
        title={deactivating ? s("deactivateTitle").replace("{{name}}", deactivating.name) : ""} size="sm">
        <p className="text-sm text-ink-muted">{s("deactivateBody")}</p>
        <FormField label={s("reason")} required className="mt-3">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </FormField>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeactivating(null)}>{t("common.cancel")}</Button>
          <Button variant="danger" loading={Boolean(deactivating && busyId === deactivating._id)}
            onClick={() => deactivating && setActive(deactivating, false)}>
            {s("deactivate")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
