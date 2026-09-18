// web/src/pages/platform/PlatformSettingsPage.tsx
//
// The operator's settings, above any school.
//
// /settings is a school's page: its name, its terms, its staff. An operator
// outside a school who followed the Settings link was sent straight back to
// the platform before it could render, so the button did nothing. This is the
// page that link now opens for them: their own account, and the platform's
// other administrators. The accounts here have no school and never get one.
import { useState }                  from "react";
import { useQuery, useQueryClient }  from "@tanstack/react-query";
import { useTranslation }            from "react-i18next";
import { KeyRound, Power, PowerOff, Pencil, Save, UserPlus, ShieldCheck } from "lucide-react";
import { PageHeader }                from "@/components/ui/PageHeader";
import { Card, CardHeader }          from "@/components/ui/Card";
import { Button }                    from "@/components/ui/Button";
import { Badge }                     from "@/components/ui/Badge";
import { Modal }                     from "@/components/ui/Modal";
import { PageSpinner }               from "@/components/ui/Spinner";
import { FormField, Input }          from "@/components/ui/FormField";
import { Table, THead, Th, TBody, Tr, Td, EmptyTable } from "@/components/ui/DataTable";
import { useToast }                  from "@/components/ui/Toast";
import { useFormat }                 from "@/i18n/format";
import { cn }                        from "@/utils/cn";
import { roleLabel }                 from "@/utils/roleLabel";
import { useAuthStore, useUser }     from "@/store/auth.store";
import { errorMessage }              from "@/components/platform/useEnterSchool";
import { changePassword }            from "@/services/auth.service";
import {
  fetchPlatformAdmins, createPlatformAdmin, updatePlatformAdmin, resetPlatformAdminPassword,
  updateMyProfile, type PlatformAdmin,
} from "@/services/platform.service";

type Tab = "profile" | "admins";
type S = (key: string, opts?: Record<string, unknown>) => string;

export default function PlatformSettingsPage() {
  const { t } = useTranslation();
  const s: S  = (k, o) => t(`platform.settings.${k}`, o);
  const [tab, setTab] = useState<Tab>("profile");

  return (
    <div className="space-y-5">
      <PageHeader title={s("title")} description={s("subtitle")} />

      <div role="tablist" className="inline-flex overflow-hidden rounded-lg border border-line">
        {(["profile", "admins"] as Tab[]).map((k) => (
          <button
            key={k}
            role="tab"
            type="button"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              "px-4 py-2 text-sm font-medium transition-colors",
              tab === k ? "bg-primary-600 text-white" : "bg-surface text-ink-body hover:bg-canvas",
            )}
          >
            {s(k === "profile" ? "tabProfile" : "tabAdmins")}
          </button>
        ))}
      </div>

      {tab === "profile" ? <ProfileSection s={s} /> : <AdminsSection s={s} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MY PROFILE
// ─────────────────────────────────────────────────────────────────────────────

function ProfileSection({ s }: { s: S }) {
  const { t }   = useTranslation();
  const user    = useUser();
  const setUser = useAuthStore((st) => st.setUser);
  const { toast } = useToast();

  const [name,  setName]  = useState(user?.name  ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [saving, setSaving] = useState(false);

  const [current, setCurrent] = useState("");
  const [next,    setNext]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [changing, setChanging] = useState(false);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { toast({ title: s("nameRequired"), kind: "error" }); return; }
    setSaving(true);
    try {
      const profile = await updateMyProfile({ name: name.trim(), email: email.trim() });
      // Only what changed: the role and the school scope are not on this form.
      setUser({ name: profile.name, email: profile.email });
      toast({ title: s("profileSaved"), kind: "success" });
    } catch (err) {
      toast({ title: s("profileFailed"), message: errorMessage(err) ?? undefined, kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) { toast({ title: s("passwordMismatch"), kind: "error" }); return; }
    setChanging(true);
    try {
      await changePassword({ currentPassword: current, newPassword: next, confirmPassword: confirm });
      setCurrent(""); setNext(""); setConfirm("");
      toast({ title: s("passwordChanged"), kind: "success" });
    } catch (err) {
      toast({ title: s("passwordFailed"), message: errorMessage(err) ?? undefined, kind: "error" });
    } finally {
      setChanging(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title={s("profileTitle")} subtitle={s("profileSubtitle")} />
        <form onSubmit={saveProfile} className="mt-4 space-y-3">
          <FormField label={t("common.fullName")} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label={t("common.email")} required>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormField>
          <dl className="grid grid-cols-2 gap-3 rounded-lg bg-canvas p-3 text-sm">
            <div>
              <dt className="text-xs text-ink-muted">{t("common.role")}</dt>
              <dd className="mt-0.5"><Badge variant="primary">{roleLabel(user?.role, t)}</Badge></dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">{s("status")}</dt>
              <dd className="mt-0.5">
                <Badge variant={user?.isActive === false ? "danger" : "success"}>
                  {s(user?.isActive === false ? "inactive" : "active")}
                </Badge>
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-ink-muted">{s("scope")}</dt>
              <dd className="mt-0.5 font-medium">{s("scopePlatform")}</dd>
            </div>
          </dl>
          <div className="flex justify-end">
            <Button type="submit" loading={saving} icon={<Save className="h-4 w-4" />}>{s("saveProfile")}</Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader title={s("securityTitle")} subtitle={s("securitySubtitle")} />
        <form onSubmit={savePassword} className="mt-4 space-y-3">
          <FormField label={s("currentPassword")} required>
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </FormField>
          <FormField label={s("newPassword")} required hint={s("passwordRules")}>
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </FormField>
          <FormField label={s("confirmPassword")} required>
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </FormField>
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" loading={changing} icon={<ShieldCheck className="h-4 w-4" />}>
              {s("changePassword")}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPER ADMINS
// ─────────────────────────────────────────────────────────────────────────────

function AdminsSection({ s }: { s: S }) {
  const { t } = useTranslation();
  const fmt   = useFormat();
  const qc    = useQueryClient();
  const me    = useUser();
  const { toast, confirm } = useToast();

  const listQ = useQuery({ queryKey: ["platform", "admins"], queryFn: fetchPlatformAdmins, retry: false });
  const admins = listQ.data?.admins ?? [];
  const emailConfigured = listQ.data?.emailConfigured ?? false;
  const activeCount = admins.filter((a) => a.isActive).length;
  const invalidate = () => qc.invalidateQueries({ queryKey: ["platform", "admins"] });

  const [adding,    setAdding]    = useState(false);
  const [editing,   setEditing]   = useState<PlatformAdmin | null>(null);
  const [resetting, setResetting] = useState<PlatformAdmin | null>(null);
  const [busyId,    setBusyId]    = useState<string | null>(null);

  const setActive = async (a: PlatformAdmin, isActive: boolean) => {
    if (!isActive) {
      const okay = await confirm({
        title: s("deactivate"), message: s("deactivateConfirm", { name: a.name }),
        confirmLabel: s("deactivate"), kind: "danger",
      });
      if (!okay) return;
    }
    setBusyId(a._id);
    try {
      await updatePlatformAdmin(a._id, { isActive });
      toast({ title: s(isActive ? "adminActivated" : "adminDeactivated"), kind: "success" });
      invalidate();
    } catch (err) {
      toast({ title: s("adminUpdateFailed"), message: errorMessage(err) ?? undefined, kind: "error" });
    } finally {
      setBusyId(null);
    }
  };

  if (listQ.isLoading) return <PageSpinner />;

  return (
    <div className="space-y-5">
      <Card padding={false}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-4">
          <CardHeader title={s("adminsTitle")} subtitle={s("adminsSubtitle")} />
          <Button size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => setAdding(true)}>{s("addAdmin")}</Button>
        </div>
        {listQ.isError ? (
          <EmptyTable title={s("loadFailed")} />
        ) : admins.length === 0 ? (
          <EmptyTable title={s("noAdmins")} />
        ) : (
          <Table>
            <THead>
              <Th>{t("common.name")}</Th>
              <Th>{t("common.status")}</Th>
              <Th>{s("created")}</Th>
              <Th>{s("updated")}</Th>
              <Th>{t("common.actions")}</Th>
            </THead>
            <TBody>
              {admins.map((a) => {
                const isMe = me?._id === a._id;
                const lastActive = a.isActive && activeCount <= 1;
                const cannotDeactivate = isMe || lastActive;
                return (
                  <Tr key={a._id}>
                    <Td className="max-w-[18rem]">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium" title={a.name}>{a.name}</span>
                        {isMe ? <Badge variant="secondary" className="shrink-0">{s("you")}</Badge> : null}
                      </div>
                      <div className="truncate text-xs text-ink-muted" title={a.email}>{a.email}</div>
                    </Td>
                    <Td>
                      <Badge variant={a.isActive ? "success" : "danger"}>{s(a.isActive ? "active" : "inactive")}</Badge>
                      {a.mustResetPassword ? <Badge variant="warning" className="ml-1">{s("mustReset")}</Badge> : null}
                    </Td>
                    <Td>{fmt.dateTime(a.createdAt)}</Td>
                    <Td>{fmt.dateTime(a.updatedAt)}</Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(a)}>
                          {t("common.edit")}
                        </Button>
                        <Button size="sm" variant="ghost" icon={<KeyRound className="h-4 w-4" />}
                          onClick={() => setResetting(a)}>
                          {s("resetPassword")}
                        </Button>
                        {a.isActive ? (
                          <Button size="sm" variant="ghost" icon={<PowerOff className="h-4 w-4" />}
                            disabled={cannotDeactivate} loading={busyId === a._id}
                            title={isMe ? s("selfHint") : lastActive ? s("lastAdminHint") : undefined}
                            onClick={() => setActive(a, false)}>
                            {s("deactivate")}
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" icon={<Power className="h-4 w-4" />}
                            loading={busyId === a._id} onClick={() => setActive(a, true)}>
                            {s("activate")}
                          </Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <AddAdminModal s={s} open={adding} onClose={() => setAdding(false)} onDone={invalidate} />
      <EditAdminModal s={s} admin={editing} onClose={() => setEditing(null)} onDone={invalidate} />
      <ResetPasswordModal s={s} admin={resetting} emailConfigured={emailConfigured}
        onClose={() => setResetting(null)} onDone={invalidate} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RESET / SET PASSWORD
//
// The password never comes back from the server, so there is nothing here to
// show afterwards: either the person is emailed a temporary one, or the
// operator types the new one in and passes it on themself. Which of the two is
// offered follows what the platform can actually do — with no mail configured,
// only the second is.
// ─────────────────────────────────────────────────────────────────────────────

function ResetPasswordModal({ s, admin, emailConfigured, onClose, onDone }: {
  s: S; admin: PlatformAdmin | null; emailConfigured: boolean; onClose: () => void; onDone: () => void;
}) {
  return admin
    ? <ResetPasswordForm key={admin._id} s={s} admin={admin} emailConfigured={emailConfigured} onClose={onClose} onDone={onDone} />
    : null;
}

function ResetPasswordForm({ s, admin, emailConfigured, onClose, onDone }: {
  s: S; admin: PlatformAdmin; emailConfigured: boolean; onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [setting, setSetting] = useState(!emailConfigured);
  const [next,    setNext]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy,    setBusy]    = useState(false);

  const finish = (title: string) => { toast({ title, kind: "success" }); onDone(); onClose(); };

  const sendEmail = async () => {
    setBusy(true);
    try {
      await resetPlatformAdminPassword(admin._id);
      finish(s("resetSent"));
    } catch (err) {
      toast({ title: s("resetFailed"), message: errorMessage(err) ?? undefined, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const setPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) { toast({ title: s("passwordMismatch"), kind: "error" }); return; }
    setBusy(true);
    try {
      await resetPlatformAdminPassword(admin._id, { newPassword: next, confirmPassword: confirm });
      setNext(""); setConfirm("");
      finish(s("passwordSet"));
    } catch (err) {
      toast({ title: s("resetFailed"), message: errorMessage(err) ?? undefined, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={setting ? s("setPassword") : s("resetPassword")} size="sm">
      {setting ? (
        <form onSubmit={setPassword} className="space-y-3">
          <p className="text-sm text-ink-muted">{emailConfigured ? s("setBody") : s("emailUnavailable")}</p>
          <p className="text-sm font-medium">{admin.email}</p>
          <FormField label={s("newPassword")} required hint={s("passwordRules")}>
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} autoFocus />
          </FormField>
          <FormField label={s("confirmPassword")} required>
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </FormField>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" loading={busy} icon={<KeyRound className="h-4 w-4" />}>{s("setPassword")}</Button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">{s("resetBody", { email: admin.email })}</p>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="button" variant="secondary" onClick={() => setSetting(true)}>{s("orSetInstead")}</Button>
            <Button type="button" loading={busy} onClick={sendEmail}>{s("sendReset")}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD
// ─────────────────────────────────────────────────────────────────────────────

function AddAdminModal({ s, open, onClose, onDone }: { s: S; open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [name,     setName]     = useState("");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [confirm,  setConfirm]  = useState("");
  const [busy,     setBusy]     = useState(false);

  const reset = () => { setName(""); setEmail(""); setPassword(""); setConfirm(""); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { toast({ title: s("passwordMismatch"), kind: "error" }); return; }
    setBusy(true);
    try {
      // The route makes one kind of account. No role, no school, on purpose.
      await createPlatformAdmin({ name: name.trim(), email: email.trim(), password, confirmPassword: confirm });
      toast({ title: s("adminCreated"), kind: "success" });
      reset(); onDone(); onClose();
    } catch (err) {
      toast({ title: s("adminCreateFailed"), message: errorMessage(err) ?? undefined, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={s("addAdmin")} size="sm">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-ink-muted">{s("addAdminBody")}</p>
        <FormField label={t("common.fullName")} required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></FormField>
        <FormField label={t("common.email")} required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></FormField>
        <FormField label={s("password")} required hint={s("passwordRules")}>
          <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormField>
        <FormField label={s("confirmPassword")} required>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </FormField>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" loading={busy}>{s("addAdmin")}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EDIT
// ─────────────────────────────────────────────────────────────────────────────

function EditAdminModal({ s, admin, onClose, onDone }: { s: S; admin: PlatformAdmin | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  // Keyed on the admin so the fields reset when a different row is opened.
  return admin ? <EditAdminForm key={admin._id} s={s} t={t} toast={toast} admin={admin} onClose={onClose} onDone={onDone} /> : null;
}

function EditAdminForm({ s, t, toast, admin, onClose, onDone }: {
  s: S; t: (k: string) => string; toast: ReturnType<typeof useToast>["toast"];
  admin: PlatformAdmin; onClose: () => void; onDone: () => void;
}) {
  const [name,  setName]  = useState(admin.name);
  const [email, setEmail] = useState(admin.email);
  const [busy,  setBusy]  = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await updatePlatformAdmin(admin._id, { name: name.trim(), email: email.trim() });
      toast({ title: s("adminUpdated"), kind: "success" });
      onDone(); onClose();
    } catch (err) {
      toast({ title: s("adminUpdateFailed"), message: errorMessage(err) ?? undefined, kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={s("editAdmin")} size="sm">
      <form onSubmit={submit} className="space-y-3">
        <FormField label={t("common.fullName")} required><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></FormField>
        <FormField label={t("common.email")} required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></FormField>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" loading={busy} icon={<Save className="h-4 w-4" />}>{t("common.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}
