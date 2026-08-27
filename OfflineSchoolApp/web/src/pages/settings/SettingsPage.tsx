// web/src/pages/settings/SettingsPage.tsx
import { useState, useEffect, useCallback } from "react";
import {
  Building2, User, GraduationCap, Shield, BarChart3,
  Save, Upload, Trash2, Plus, Eye, EyeOff, Loader2,
  ChevronRight, AlertCircle, X, CreditCard, ShieldCheck, ShieldAlert,
  KeyRound,
} from "lucide-react";

import PermissionsSection from "@/pages/settings/PermissionsSection";
import ApprovalsSection   from "@/pages/settings/ApprovalsSection";

import { useUser, useAuthStore } from "@/store/auth.store";
import { cn }                    from "@/utils/cn";
import { useToast }              from "@/components/ui/Toast";
import api                       from "@/services/api";
import { resolveLogoSrc }        from "@/utils/logoSrc";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface SchoolSettings {
  name:               string;
  motto:              string;
  email:              string;
  phone:              string;
  website:            string;
  address:            string;
  city:               string;
  state:              string;
  country:            string;
  postalCode:         string;
  schoolType:         string;
  termSystem:         string;
  schoolCode:         string;
  registrationNumber: string;
  foundedYear:        string;
  principalName:      string;
  description:        string;
  academicYearStart:  string;
  academicYearEnd:    string;
  schoolDays:         string[];
  schoolStartTime:    string;
  schoolEndTime:      string;
  logo:               string | null;
}

interface GradingConfig {
  passMark: number;
  useGpa:   boolean;
  grades?:  { label: string; min: number; max: number; gpa?: number }[];
}

interface AdminUser {
  _id:   string;
  name:  string;
  email: string;
  role:  string;
}

interface Analytics {
  summary: {
    totalTeachers: number;
    totalStudents: number;
    totalClasses:  number;
    totalSubjects: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Every list below is module scope, which cannot call a hook, so each entry
// carries a translation key and the component resolves it at render. The
// `value` / `id` fields stay English — they are compared, stored and sent to
// the API.
const SECTIONS = [
  { id: "school",      labelKey: "settings.secSchool",      icon: Building2     },
  { id: "profile",     labelKey: "settings.secProfile",     icon: User          },
  { id: "grading",     labelKey: "settings.secGrading",     icon: GraduationCap },
  { id: "admins",      labelKey: "settings.secAdmins",      icon: Shield        },
  // Sits next to Office accounts on purpose: appointing somebody and deciding
  // what they may do are two halves of one job, and a head who has just created
  // a bursar is exactly who wants this screen next.
  { id: "permissions", labelKey: "settings.secPermissions", icon: ShieldCheck   },
  // Next to Permissions, because the two answer neighbouring questions: what
  // may somebody do, and what may they do WITHOUT a second signature.
  { id: "approvals",   labelKey: "settings.secApprovals",   icon: ShieldAlert   },
  { id: "idcards",     labelKey: "settings.secIdCards",     icon: CreditCard    },
  { id: "analytics",   labelKey: "settings.secAnalytics",   icon: BarChart3     },
] as const;

type SectionId = typeof SECTIONS[number]["id"];

const SCHOOL_TYPES = [
  { value: "primary",    labelKey: "settings.typePrimary"    },
  { value: "jhs",        labelKey: "settings.typeJhs"        },
  { value: "shs",        labelKey: "settings.typeShs"        },
  { value: "combined",   labelKey: "settings.typeCombined"   },
  { value: "vocational", labelKey: "settings.typeVocational" },
  { value: "university", labelKey: "settings.typeUniversity" },
  { value: "other",      labelKey: "settings.typeOther"      },
];

const TERM_SYSTEMS = [
  { value: "trimester", labelKey: "settings.termTrimester" },
  { value: "semester",  labelKey: "settings.termSemester"  },
  { value: "quarter",   labelKey: "settings.termQuarter"   },
];

// `value` is what the API stores; `labelKey` is the three-letter chip.
const DAYS_OF_WEEK = [
  { value: "Monday",    labelKey: "settings.dayMon" },
  { value: "Tuesday",   labelKey: "settings.dayTue" },
  { value: "Wednesday", labelKey: "settings.dayWed" },
  { value: "Thursday",  labelKey: "settings.dayThu" },
  { value: "Friday",    labelKey: "settings.dayFri" },
  { value: "Saturday",  labelKey: "settings.daySat" },
];

// "admin" is kept in both maps below, and only in the maps. It is not a role
// the API will store — see backend/src/config/roles.js — but a school whose
// database predates the enum could still hold a row saying it, and a badge
// reading "admin" is better than one reading nothing.
const ROLE_COLORS: Record<string, string> = {
  super_admin:  "bg-red-100 text-red-700",
  school_admin: "bg-purple-100 text-purple-700",
  bursar:       "bg-amber-100 text-amber-700",
  admin:        "bg-indigo-100 text-indigo-700",
  teacher:      "bg-emerald-100 text-emerald-700",
};

const ROLE_LABEL_KEYS: Record<string, string> = {
  super_admin:  "settings.roleSuperAdmin",
  school_admin: "settings.schoolAdmin",
  bursar:       "settings.roleBursar",
  admin:        "settings.roleAdmin",
  teacher:      "academic.teacher",
};

/** The visible name for a role, falling back to the raw value we were sent. */
const roleLabel = (role: string | undefined, t: TFunction): string => {
  const key = ROLE_LABEL_KEYS[role ?? ""];
  return key ? t(key) : (role ?? "");
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Shared with the dashboard banner. This page had its own copy that could not
// render a stored "/uploads/logos/..." path — see utils/logoSrc.
const normaliseLogo = resolveLogoSrc;

// Takes the translator as a parameter — the fallback is shown to the user and
// module scope cannot call a hook.
const extractMessage = (err: unknown, t: TFunction): string =>
  (err as { response?: { data?: { message?: string } } })
    ?.response?.data?.message ??
  (err instanceof Error ? err.message : t("settings.somethingWrong"));

// ─────────────────────────────────────────────────────────────────────────────
// SHARED UI PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

function Card({
  children,
  className,
}: {
  children:  React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-gray-200 bg-white p-6 shadow-sm",
        className
      )}
    >
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-5 text-base font-bold text-gray-900">{children}</h3>
  );
}

function FieldLabel({
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?:    string;
}) {
  return (
    <div className="mb-1.5">
      <label className="block text-sm font-medium text-gray-700">
        {children}
      </label>
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  className,
  disabled,
}: {
  value:        string;
  onChange:     (v: string) => void;
  placeholder?: string;
  type?:        string;
  className?:   string;
  disabled?:    boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        "w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5",
        "text-sm text-gray-900 outline-none transition",
        "focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100",
        "disabled:opacity-50",
        className
      )}
    />
  );
}

function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value:        string;
  onChange:     (v: string) => void;
  placeholder?: string;
  rows?:        number;
}) {
  return (
    <textarea
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="
        w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5
        text-sm text-gray-900 outline-none transition resize-none
        focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100
      "
    />
  );
}

function SaveButton({
  onClick,
  loading,
  label,
}: {
  onClick:  () => void;
  loading:  boolean;
  label:    string;
}) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="
        mt-6 flex items-center gap-2 rounded-xl bg-indigo-600
        px-6 py-3 text-sm font-semibold text-white
        hover:bg-indigo-700 disabled:opacity-50 transition
      "
    >
      {loading
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : <Save className="h-4 w-4" />
      }
      {loading ? t("common.saving") : label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — SCHOOL SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

function SchoolSection({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const EMPTY: SchoolSettings = {
    name: "", motto: "", email: "", phone: "", website: "",
    address: "", city: "", state: "", country: "", postalCode: "",
    schoolType: "primary", termSystem: "trimester", schoolCode: "",
    registrationNumber: "", foundedYear: "", principalName: "",
    description: "", academicYearStart: "", academicYearEnd: "",
    // API values, never translated.
    schoolDays: ["Monday","Tuesday","Wednesday","Thursday","Friday"],
    schoolStartTime: "07:30", schoolEndTime: "15:30", logo: null,
  };

  const [form,     setForm]     = useState<SchoolSettings>(EMPTY);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo]   = useState(false);

  const set = <K extends keyof SchoolSettings>(key: K, val: SchoolSettings[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/admin/school-info", { params: { schoolId } });
        const s = data?.school || data;
        if (s) {
          setForm({
            name:               s.name               ?? "",
            motto:              s.motto              ?? "",
            email:              s.email              ?? "",
            phone:              s.phone              ?? "",
            website:            s.website            ?? "",
            address:            s.address            ?? "",
            city:               s.city               ?? "",
            state:              s.state              ?? "",
            country:            s.country            ?? "",
            postalCode:         s.postalCode         ?? "",
            schoolType:         s.schoolType         ?? "primary",
            termSystem:         s.termSystem         ?? "trimester",
            schoolCode:         s.schoolCode         ?? "",
            registrationNumber: s.registrationNumber ?? "",
            foundedYear:        s.foundedYear        ? String(s.foundedYear) : "",
            principalName:      s.principalName      ?? "",
            description:        s.description        ?? "",
            academicYearStart:  s.academicYearStart  ?? "",
            academicYearEnd:    s.academicYearEnd    ?? "",
            schoolDays:         Array.isArray(s.schoolDays) && s.schoolDays.length
              ? s.schoolDays
              : ["Monday","Tuesday","Wednesday","Thursday","Friday"],
            schoolStartTime:    s.schoolStartTime    ?? "07:30",
            schoolEndTime:      s.schoolEndTime      ?? "15:30",
            logo:               s.logo               ?? null,
          });
          const norm = normaliseLogo(s.logo || s.logoUrl);
          if (norm) setLogoPreview(norm);
        }
      } catch (err) {
        toast({ kind: "error", title: t("settings.loadFailed"), message: extractMessage(err, t) });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    setRemoveLogo(false);
    const reader = new FileReader();
    reader.onload = () => setLogoPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => {
    setLogoFile(null);
    setLogoPreview(null);
    setRemoveLogo(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast({ kind: "error", title: t("settings.validation"), message: t("settings.schoolNameRequired") });
      return;
    }

    setSaving(true);
    try {
      let logoBase64: string | undefined;

      if (logoFile) {
        logoBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => {
            const result = reader.result as string;
            // Strip the data URI prefix — backend stores raw base64
            resolve(result.replace(/^data:[^;]+;base64,/, ""));
          };
          reader.onerror = reject;
          reader.readAsDataURL(logoFile);
        });
      }

      const payload = {
        schoolId,
        ...form,
        foundedYear: form.foundedYear ? Number(form.foundedYear) : null,
        ...(logoBase64  ? { logoBase64 }   : {}),
        ...(removeLogo  ? { removeLogo: true } : {}),
      };

      await api.put("/admin/school-info", payload);
      toast({ kind: "success", title: t("settings.savedTitle"), message: t("settings.schoolSaved") });
      setLogoFile(null);
      setRemoveLogo(false);
    } catch (err) {
      toast({ kind: "error", title: t("settings.saveFailed"), message: extractMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  const toggleDay = (day: string) => {
    set("schoolDays",
      form.schoolDays.includes(day)
        ? form.schoolDays.filter((d) => d !== day)
        : [...form.schoolDays, day]
    );
  };

  return (
    <div className="space-y-5">

      {/* ── Logo ── */}
      <Card>
        <CardTitle>{t("settings.schoolLogo")}</CardTitle>
        <div className="flex items-start gap-6">
          {/* Preview */}
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded-2xl border-2 border-gray-200 bg-gray-50">
            {logoPreview
              ? <img src={logoPreview} alt={t("settings.schoolLogo")} className="h-full w-full object-cover" />
              : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1">
                  <Building2 className="h-8 w-8 text-gray-300" />
                  <span className="text-[10px] text-gray-400">{t("settings.noLogo")}</span>
                </div>
              )
            }
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-2">
            <label className="
              flex cursor-pointer items-center gap-2 rounded-xl border
              border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-semibold
              text-indigo-600 hover:bg-indigo-50 transition
            ">
              <Upload className="h-4 w-4" />
              {logoPreview ? t("settings.changeLogo") : t("settings.uploadLogo")}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleLogoChange}
              />
            </label>

            {logoPreview && (
              <button
                onClick={handleRemoveLogo}
                className="
                  flex items-center gap-2 rounded-xl border border-red-200
                  bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-600
                  hover:bg-red-100 transition
                "
              >
                <Trash2 className="h-4 w-4" />
                {t("settings.removeLogo")}
              </button>
            )}

            <p className="text-xs text-gray-400">
              {t("settings.logoHint")}
            </p>
          </div>
        </div>
      </Card>

      {/* ── Basic info ── */}
      <Card>
        <CardTitle>{t("settings.basicInfo")}</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <FieldLabel>{t("settings.schoolName")} *</FieldLabel>
            <Input value={form.name} onChange={(v) => set("name", v)} placeholder={t("settings.namePh")} />
          </div>
          <div className="sm:col-span-2">
            <FieldLabel>{t("settings.motto")}</FieldLabel>
            <Input value={form.motto} onChange={(v) => set("motto", v)} placeholder={t("settings.mottoPh")} />
          </div>

          {/* School type chips */}
          <div className="sm:col-span-2">
            <FieldLabel>{t("settings.schoolType")}</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {/* Named `opt`, not `t` — `t` here is the translator. */}
              {SCHOOL_TYPES.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => set("schoolType", opt.value)}
                  className={cn(
                    "rounded-full border px-4 py-1.5 text-sm font-medium transition",
                    form.schoolType === opt.value
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 bg-white text-gray-500 hover:border-indigo-300"
                  )}
                >
                  {t(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>{t("settings.schoolCode")}</FieldLabel>
            <Input value={form.schoolCode} onChange={(v) => set("schoolCode", v.toUpperCase())} placeholder={t("settings.codePh")} />
          </div>
          <div>
            <FieldLabel>{t("settings.regNumber")}</FieldLabel>
            <Input value={form.registrationNumber} onChange={(v) => set("registrationNumber", v)} placeholder={t("settings.regNumberHint")} />
          </div>
          <div>
            <FieldLabel>{t("settings.yearFounded")}</FieldLabel>
            <Input value={form.foundedYear} onChange={(v) => set("foundedYear", v)} placeholder={t("settings.foundedPh")} type="number" />
          </div>
          <div>
            <FieldLabel>{t("settings.principal")}</FieldLabel>
            <Input value={form.principalName} onChange={(v) => set("principalName", v)} placeholder={t("common.fullName")} />
          </div>
          <div className="sm:col-span-2">
            <FieldLabel>{t("common.about")}</FieldLabel>
            <Textarea value={form.description} onChange={(v) => set("description", v)} placeholder={t("settings.descriptionPh")} />
          </div>
        </div>
      </Card>

      {/* ── Contact ── */}
      <Card>
        <CardTitle>{t("settings.contactDetails")}</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel>{t("settings.schoolEmail")}</FieldLabel>
            <Input value={form.email} onChange={(v) => set("email", v)} placeholder={t("settings.schoolEmailPh")} type="email" />
          </div>
          <div>
            <FieldLabel>{t("common.phone")}</FieldLabel>
            <Input value={form.phone} onChange={(v) => set("phone", v)} placeholder="+233…" type="tel" />
          </div>
          <div className="sm:col-span-2">
            <FieldLabel>{t("common.website")}</FieldLabel>
            <Input value={form.website} onChange={(v) => set("website", v)} placeholder="https://…" type="url" />
          </div>
        </div>
      </Card>

      {/* ── Location ── */}
      <Card>
        <CardTitle>{t("common.location")}</CardTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <FieldLabel>{t("common.streetAddress")}</FieldLabel>
            <Textarea value={form.address} onChange={(v) => set("address", v)} placeholder={t("settings.streetPh")} rows={2} />
          </div>
          <div>
            <FieldLabel>{t("common.city")}</FieldLabel>
            <Input value={form.city} onChange={(v) => set("city", v)} placeholder={t("common.city")} />
          </div>
          <div>
            <FieldLabel>{t("common.state")}</FieldLabel>
            <Input value={form.state} onChange={(v) => set("state", v)} placeholder={t("common.state")} />
          </div>
          <div>
            <FieldLabel>{t("common.country")}</FieldLabel>
            <Input value={form.country} onChange={(v) => set("country", v)} placeholder={t("common.country")} />
          </div>
          <div>
            <FieldLabel>{t("common.postalCode")}</FieldLabel>
            <Input value={form.postalCode} onChange={(v) => set("postalCode", v)} placeholder={t("settings.postalPh")} />
          </div>
        </div>
      </Card>

      {/* ── Academic calendar ── */}
      <Card>
        <CardTitle>{t("settings.academicCalendar")}</CardTitle>
        <div className="space-y-4">

          {/* Term system */}
          <div>
            <FieldLabel>{t("settings.termSystem")}</FieldLabel>
            <div className="inline-flex rounded-xl border border-gray-200 bg-gray-100 p-1 gap-1">
              {/* Named `sys`, not `t` — `t` here is the translator. */}
              {TERM_SYSTEMS.map((sys) => (
                <button
                  key={sys.value}
                  onClick={() => set("termSystem", sys.value)}
                  className={cn(
                    "rounded-lg px-4 py-1.5 text-sm font-medium transition",
                    form.termSystem === sys.value
                      ? "bg-white text-gray-900 shadow-sm"
                      : "text-gray-500 hover:text-gray-700"
                  )}
                >
                  {t(sys.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Academic year */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel hint="YYYY-MM-DD">{t("settings.yearStart")}</FieldLabel>
              <Input type="date" value={form.academicYearStart} onChange={(v) => set("academicYearStart", v)} placeholder={t("settings.yearStartPh")} />
            </div>
            <div>
              <FieldLabel hint="YYYY-MM-DD">{t("settings.yearEnd")}</FieldLabel>
              <Input type="date" value={form.academicYearEnd} onChange={(v) => set("academicYearEnd", v)} placeholder={t("settings.yearEndPh")} />
            </div>
          </div>

          {/* School days */}
          <div>
            <FieldLabel>{t("settings.schoolDays")}</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {DAYS_OF_WEEK.map((day) => (
                <button
                  key={day.value}
                  onClick={() => toggleDay(day.value)}
                  className={cn(
                    "rounded-xl border px-4 py-1.5 text-sm font-medium transition",
                    form.schoolDays.includes(day.value)
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 bg-white text-gray-400 hover:border-gray-300"
                  )}
                >
                  {t(day.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Hours */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel>{t("settings.startTime")}</FieldLabel>
              <Input value={form.schoolStartTime} onChange={(v) => set("schoolStartTime", v)} type="time" />
            </div>
            <div>
              <FieldLabel>{t("settings.endTime")}</FieldLabel>
              <Input value={form.schoolEndTime} onChange={(v) => set("schoolEndTime", v)} type="time" />
            </div>
          </div>
        </div>
      </Card>

      <SaveButton onClick={handleSave} loading={saving} label={t("settings.saveSchool")} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — PROFILE
// ─────────────────────────────────────────────────────────────────────────────

function ProfileSection() {
  const { t } = useTranslation();
  const user       = useUser();
  const setUser    = useAuthStore((s) => s.setUser);
  const { toast }  = useToast();

  const [name,            setName]            = useState(user?.name  ?? "");
  const [email,           setEmail]           = useState(user?.email ?? "");
  const [saving,          setSaving]          = useState(false);

  const [showPwForm,      setShowPwForm]      = useState(false);
  const [currentPw,       setCurrentPw]       = useState("");
  const [newPw,           setNewPw]           = useState("");
  const [confirmPw,       setConfirmPw]       = useState("");
  const [showCurrentPw,   setShowCurrentPw]   = useState(false);
  const [showNewPw,       setShowNewPw]       = useState(false);
  const [savingPw,        setSavingPw]        = useState(false);

  const handleSaveProfile = async () => {
    if (!name.trim()) {
      toast({ kind: "error", title: t("settings.validation"), message: t("settings.nameRequired") });
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.put("/admin/settings/profile", {
        name: name.trim(),
        email: email.trim(),
      });
      const updated = data?.profile || data?.user;
      if (updated) setUser(updated);
      toast({ kind: "success", title: t("settings.profileUpdated") });
    } catch (err) {
      toast({ kind: "error", title: t("settings.failed"), message: extractMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPw || !newPw || !confirmPw) {
      toast({ kind: "error", title: t("settings.allFieldsRequired") });
      return;
    }
    if (newPw !== confirmPw) {
      toast({ kind: "error", title: t("settings.passwordsDiffer") });
      return;
    }
    if (newPw.length < 8) {
      toast({ kind: "error", title: t("settings.passwordMin8") });
      return;
    }
    setSavingPw(true);
    try {
      await api.post("/auth/change-password", {
        currentPassword: currentPw,
        newPassword:     newPw,
        confirmPassword: confirmPw,
      });
      toast({ kind: "success", title: t("changePassword.success") });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
      setShowPwForm(false);
    } catch (err) {
      toast({ kind: "error", title: t("settings.failed"), message: extractMessage(err, t) });
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <div className="space-y-5">

      {/* ── Personal info ── */}
      <Card>
        <CardTitle>{t("settings.personalInfo")}</CardTitle>
        <div className="space-y-4">
          <div>
            <FieldLabel>{t("common.fullName")}</FieldLabel>
            <Input value={name} onChange={setName} placeholder={t("settings.yourFullName")} />
          </div>
          <div>
            <FieldLabel>{t("common.email")}</FieldLabel>
            <Input value={email} onChange={setEmail} placeholder={t("settings.yourEmailPh")} type="email" />
          </div>
          <div>
            <FieldLabel>{t("common.role")}</FieldLabel>
            <span
              className={cn(
                "inline-flex rounded-full px-3 py-1 text-xs font-semibold",
                ROLE_COLORS[user?.role ?? ""] || "bg-gray-100 text-gray-600"
              )}
            >
              {roleLabel(user?.role, t) || "—"}
            </span>
          </div>
        </div>
        <SaveButton onClick={handleSaveProfile} loading={saving} label={t("settings.saveProfile")} />
      </Card>

      {/* ── Password ── */}
      <Card>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-bold text-gray-900">{t("common.password")}</h3>
          <button
            onClick={() => setShowPwForm((v) => !v)}
            className="text-sm font-medium text-indigo-600 hover:underline"
          >
            {showPwForm ? t("common.cancel") : t("settings.changePassword")}
          </button>
        </div>

        {showPwForm && (
          <div className="space-y-4">
            {/* Current password */}
            <div>
              <FieldLabel>{t("settings.currentPassword")}</FieldLabel>
              <div className="relative">
                <input
                  type={showCurrentPw ? "text" : "password"}
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  className="
                    w-full rounded-xl border border-gray-200 bg-gray-50
                    px-4 py-2.5 pr-11 text-sm outline-none
                    focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100
                  "
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPw((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"
                >
                  {showCurrentPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* New password */}
            <div>
              <FieldLabel>{t("settings.newPassword")}</FieldLabel>
              <div className="relative">
                <input
                  type={showNewPw ? "text" : "password"}
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  className="
                    w-full rounded-xl border border-gray-200 bg-gray-50
                    px-4 py-2.5 pr-11 text-sm outline-none
                    focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100
                  "
                  placeholder={t("settings.min8")}
                />
                <button
                  type="button"
                  onClick={() => setShowNewPw((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"
                >
                  {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Confirm */}
            <div>
              <FieldLabel>{t("settings.confirmPassword")}</FieldLabel>
              <input
                type="password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                className="
                  w-full rounded-xl border border-gray-200 bg-gray-50
                  px-4 py-2.5 text-sm outline-none
                  focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100
                "
                placeholder={t("settings.reenterPassword")}
              />
              {confirmPw && newPw !== confirmPw && (
                <p className="mt-1 text-xs text-red-500">{t("settings.passwordsDiffer")}</p>
              )}
            </div>

            <button
              onClick={handleChangePassword}
              disabled={savingPw}
              className="
                flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5
                text-sm font-semibold text-white hover:bg-indigo-700
                disabled:opacity-50 transition
              "
            >
              {savingPw && <Loader2 className="h-4 w-4 animate-spin" />}
              {savingPw ? t("settings.updating") : t("settings.updatePassword")}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — GRADING
// ─────────────────────────────────────────────────────────────────────────────

function GradingSection({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const { toast }   = useToast();
  const [config,    setConfig]  = useState<GradingConfig | null>(null);
  const [loading,   setLoading] = useState(true);
  const [saving,    setSaving]  = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/admin/settings/grading", { params: { schoolId } });
        setConfig(data?.grading || null);
      } catch (err) {
        toast({ kind: "error", title: t("settings.loadFailed"), message: extractMessage(err, t) });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await api.put("/admin/settings/grading", { ...config, schoolId });
      toast({ kind: "success", title: t("settings.gradingSaved") });
    } catch (err) {
      toast({ kind: "error", title: t("settings.saveFailed"), message: extractMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="flex justify-center py-20">
      <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
    </div>
  );

  if (!config) return (
    <Card>
      <div className="flex items-center gap-2 text-amber-600">
        <AlertCircle className="h-5 w-5" />
        <p className="text-sm">{t("settings.noGradingConfig")}</p>
      </div>
    </Card>
  );

  return (
    <div className="space-y-5">
      <Card>
        <CardTitle>{t("settings.gradingSettings")}</CardTitle>
        <div className="space-y-5">

          <div className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 p-4">
            <div>
              <p className="text-sm font-semibold text-gray-900">{t("settings.gpaSystem")}</p>
              <p className="text-xs text-gray-500">{t("settings.gpaEnable")}</p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={config.useGpa}
                onChange={(e) => setConfig({ ...config, useGpa: e.target.checked })}
              />
              <div className="
                h-6 w-11 rounded-full bg-gray-200 transition
                peer-checked:bg-indigo-600
                after:absolute after:left-0.5 after:top-0.5
                after:h-5 after:w-5 after:rounded-full after:bg-white
                after:transition peer-checked:after:translate-x-5
              " />
            </label>
          </div>

          <div>
            <FieldLabel>{t("settings.passMarkPct")}</FieldLabel>
            <input
              type="number"
              min={0}
              max={100}
              value={config.passMark}
              onChange={(e) =>
                setConfig({ ...config, passMark: Number(e.target.value) })
              }
              className="
                w-28 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5
                text-sm outline-none focus:border-indigo-400 focus:ring-2
                focus:ring-indigo-100
              "
            />
          </div>

          {/* Grade bands */}
          {Array.isArray(config.grades) && config.grades.length > 0 && (
            <div>
              <p className="mb-3 text-sm font-semibold text-gray-700">{t("settings.gradeBands")}</p>
              <div className="overflow-hidden rounded-xl border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs font-semibold uppercase text-gray-400">
                    <tr>
                      <th className="px-4 py-2.5 text-left">{t("academic.grade")}</th>
                      <th className="px-4 py-2.5 text-left">{t("settings.minPct")}</th>
                      <th className="px-4 py-2.5 text-left">{t("settings.maxPct")}</th>
                      {config.useGpa && <th className="px-4 py-2.5 text-left">GPA</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {config.grades.map((g, i) => (
                      <tr key={i} className="bg-white">
                        <td className="px-4 py-2.5 font-semibold text-indigo-700">
                          {g.label}
                        </td>
                        <td className="px-4 py-2.5">
                          <input
                            type="number"
                            value={g.min}
                            onChange={(e) => {
                              const grades = [...config.grades!];
                              grades[i] = { ...grades[i], min: Number(e.target.value) };
                              setConfig({ ...config, grades });
                            }}
                            className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-sm outline-none focus:border-indigo-400"
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <input
                            type="number"
                            value={g.max}
                            onChange={(e) => {
                              const grades = [...config.grades!];
                              grades[i] = { ...grades[i], max: Number(e.target.value) };
                              setConfig({ ...config, grades });
                            }}
                            className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-sm outline-none focus:border-indigo-400"
                          />
                        </td>
                        {config.useGpa && (
                          <td className="px-4 py-2.5">
                            <input
                              type="number"
                              step="0.1"
                              value={g.gpa ?? ""}
                              onChange={(e) => {
                                const grades = [...config.grades!];
                                grades[i] = { ...grades[i], gpa: Number(e.target.value) };
                                setConfig({ ...config, grades });
                              }}
                              className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-sm outline-none focus:border-indigo-400"
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <SaveButton onClick={handleSave} loading={saving} label={t("settings.saveGrading")} />
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — ADMIN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

function AdminsSection({
  schoolId,
  currentUserId,
}: {
  schoolId:      string;
  currentUserId: string;
}) {
  const { t } = useTranslation();
  const { toast }    = useToast();
  const [admins,     setAdmins]     = useState<AdminUser[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showModal,  setShowModal]  = useState(false);
  const [creating,   setCreating]   = useState(false);
  const [newName,    setNewName]    = useState("");
  const [newEmail,   setNewEmail]   = useState("");
  // school_admin, not "admin": the latter is not a role the API stores, so the
  // default selection was relying on the server aliasing it back. Say what is
  // meant.
  const [newRole,    setNewRole]    = useState("school_admin");

  /**
   * The account just created, and whether the email actually went.
   *
   * Held in state rather than announced in a toast, because when the email
   * failed this is the ONLY copy of the password. A toast disappears on a timer
   * and takes the new person's only way in with it — which is exactly what used
   * to happen: the API has always returned emailSent and tempPassword, and this
   * screen read neither.
   */
  const [created, setCreated] = useState<{
    name:         string;
    email:        string;
    role:         string;
    tempPassword: string;
    emailSent:    boolean;
  } | null>(null);

  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/admin/settings/admins", { params: { schoolId } });
      setAdmins(data?.admins || []);
    } catch (err) {
      toast({ kind: "error", title: t("settings.loadFailed"), message: extractMessage(err, t) });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newName.trim() || !newEmail.trim()) {
      toast({ kind: "error", title: t("settings.nameEmailRequired") });
      return;
    }
    setCreating(true);
    try {
      const { data } = await api.post("/admin/settings/admins", {
        name: newName.trim(), email: newEmail.trim(), role: newRole, schoolId,
      });
      if (data?.admin) setAdmins((prev) => [data.admin, ...prev]);

      // The modal switches to the credentials view rather than closing. It used
      // to close and claim "login details sent to {{email}}" unconditionally —
      // untrue whenever SMTP is unconfigured or the send failed, and the
      // password that would have rescued the situation was discarded with the
      // response. A new bursar then existed with a password nobody knew.
      setCreated({
        name:         newName.trim(),
        email:        newEmail.trim(),
        role:         newRole,
        tempPassword: data?.tempPassword ?? "",
        emailSent:    data?.emailSent === true,
      });
      setCopied(false);
      setNewName(""); setNewEmail(""); setNewRole("school_admin");
    } catch (err) {
      toast({ kind: "error", title: t("settings.failed"), message: extractMessage(err, t) });
    } finally {
      setCreating(false);
    }
  };

  /**
   * Re-issue somebody's password and show it.
   *
   * The endpoint has existed since staff accounts did and nothing called it, so
   * an account whose welcome email never arrived had no route back in from the
   * UI at all — the only fix was a database edit. That matters more than it
   * looks: a school whose mail is misconfigured cannot onboard anybody, and
   * will not discover why from this screen.
   *
   * Reuses the same credentials panel as creation, because it is the same
   * problem: a password that exists in exactly one place and has to be read
   * before the dialog closes.
   */
  const handleReset = async (admin: AdminUser) => {
    if (!window.confirm(t("settings.resetPasswordConfirm", { name: admin.name }))) return;
    try {
      const { data } = await api.post(
        `/admin/settings/admins/${admin._id}/reset-password`,
        { schoolId }
      );
      setCreated({
        name:         admin.name,
        email:        admin.email,
        role:         admin.role,
        tempPassword: data?.tempPassword ?? "",
        emailSent:    data?.emailSent === true,
      });
      setCopied(false);
      setShowModal(true);
    } catch (err) {
      toast({ kind: "error", title: t("settings.failed"), message: extractMessage(err, t) });
    }
  };

  /** Closing the dialog from any of its three buttons. */
  const closeModal = () => {
    setShowModal(false);
    setCreated(null);
    setCopied(false);
  };

  const handleRemove = async (adminId: string, adminName: string) => {
    if (adminId === currentUserId) {
      toast({ kind: "error", title: t("settings.cannotRemoveSelf") });
      return;
    }
    if (!window.confirm(t("settings.removeAdminConfirm", { name: adminName }))) return;
    try {
      await api.delete(`/admin/settings/admins/${adminId}`);
      setAdmins((prev) => prev.filter((a) => a._id !== adminId));
      toast({ kind: "success", title: t("settings.adminRemoved") });
    } catch (err) {
      toast({ kind: "error", title: t("settings.failed"), message: extractMessage(err, t) });
    }
  };

  if (loading) return (
    <div className="flex justify-center py-20">
      <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
    </div>
  );

  return (
    <div className="space-y-5">
      <Card>
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-base font-bold text-gray-900">
            {t("settings.adminUsers", { count: admins.length })}
          </h3>
          <button
            onClick={() => setShowModal(true)}
            className="
              flex items-center gap-1.5 rounded-xl bg-indigo-50 px-3 py-2
              text-sm font-semibold text-indigo-600 hover:bg-indigo-100 transition
            "
          >
            <Plus className="h-4 w-4" />
            {t("settings.addAdmin")}
          </button>
        </div>

        <div className="divide-y divide-gray-100">
          {admins.map((a) => (
            <div key={a._id} className="flex items-center gap-3 py-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-sm font-bold text-indigo-600">
                {(a.name || "?").charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900">
                  {a.name}
                  {a._id === currentUserId && (
                    <span className="ml-2 text-xs text-gray-400">{t("settings.you")}</span>
                  )}
                </p>
                <p className="text-xs text-gray-500">{a.email}</p>
              </div>
              <span className={cn(
                "rounded-full px-2.5 py-1 text-xs font-semibold",
                ROLE_COLORS[a.role] || "bg-gray-100 text-gray-600"
              )}>
                {roleLabel(a.role, t)}
              </span>
              {/* Available for everybody including yourself: re-issuing your
                  own password is a normal thing to need, and unlike removal it
                  cannot lock the school out. */}
              <button
                onClick={() => handleReset(a)}
                title={t("settings.resetPassword")}
                className="ml-2 rounded-lg p-1.5 text-gray-400 transition hover:bg-indigo-50 hover:text-indigo-600"
              >
                <KeyRound className="h-4 w-4" />
              </button>

              {a._id !== currentUserId && (
                <button
                  onClick={() => handleRemove(a._id, a.name)}
                  title={t("settings.removeAccount")}
                  className="ml-1 rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 transition"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}

          {admins.length === 0 && (
            <p className="py-6 text-center text-sm text-gray-400">
              {t("settings.noAdmins")}
            </p>
          )}
        </div>
      </Card>

      {/* Create modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-900">
                {created ? t("settings.credentials") : t("settings.addAdmin")}
              </h3>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* ── The credentials, once the account exists ─────────────────
                On screen and not in a toast: when the email did not go, this is
                the only copy of the password, and a toast takes it away on a
                timer. Same treatment the student enrolment screen already
                gives, for the same reason. */}
            {created ? (
              <div className="space-y-4">
                <p className="text-sm text-gray-500">
                  {t("settings.accountReadyBody", {
                    name: created.name,
                    role: roleLabel(created.role, t),
                  })}
                </p>

                <div className="space-y-2.5">
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      {t("common.email")}
                    </p>
                    <p className="mt-0.5 break-all font-mono text-sm text-gray-900">
                      {created.email}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      {t("settings.signsInWithEmail")}
                    </p>
                  </div>

                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                          {t("settings.tempPassword")}
                        </p>
                        <p className="mt-0.5 break-all font-mono text-sm text-gray-900">
                          {created.tempPassword || "—"}
                        </p>
                      </div>

                      {created.tempPassword && (
                        <button
                          type="button"
                          onClick={() => {
                            // Best-effort: the clipboard API needs a secure
                            // context, and this screen may be served over plain
                            // http on a school LAN. The password is on screen
                            // either way, so a failure here is cosmetic.
                            void navigator.clipboard
                              ?.writeText(created.tempPassword)
                              .then(() => setCopied(true))
                              .catch(() => setCopied(false));
                          }}
                          className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-600 transition hover:bg-white"
                        >
                          {copied ? t("common.copied") : t("common.copy")}
                        </button>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      {t("settings.mustChangeOnFirstSignIn")}
                    </p>
                  </div>
                </div>

                {/* Honest about the email, which is the whole bug this fixes. */}
                <div
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border px-3 py-2.5",
                    created.emailSent
                      ? "border-emerald-200 bg-emerald-50"
                      : "border-amber-200 bg-amber-50"
                  )}
                >
                  <AlertCircle
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      created.emailSent ? "text-emerald-600" : "text-amber-600"
                    )}
                  />
                  <p
                    className={cn(
                      "text-xs",
                      created.emailSent ? "text-emerald-800" : "text-amber-800"
                    )}
                  >
                    {created.emailSent
                      ? t("settings.emailSentTo", { email: created.email })
                      : t("settings.emailNotSent")}
                  </p>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={() => { setCreated(null); setCopied(false); }}
                    className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-600 transition hover:bg-gray-50"
                  >
                    {t("settings.addAnother")}
                  </button>
                  <button
                    onClick={closeModal}
                    className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700"
                  >
                    {t("common.done")}
                  </button>
                </div>
              </div>
            ) : (
            <>
            <div className="space-y-4">
              <div>
                <FieldLabel>{t("common.fullName")}</FieldLabel>
                <Input value={newName} onChange={setNewName} placeholder={t("settings.adminName")} />
              </div>
              <div>
                <FieldLabel>{t("common.email")}</FieldLabel>
                <Input value={newEmail} onChange={setNewEmail} placeholder={t("settings.adminEmailPh")} type="email" />
              </div>
              <div>
                <FieldLabel>{t("common.role")}</FieldLabel>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                  className="
                    w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5
                    text-sm outline-none focus:border-indigo-400
                  "
                >
                  {/* Values are the role identifiers the API stores. */}
                  <option value="school_admin">{t("settings.schoolAdmin")}</option>
                  <option value="bursar">{t("settings.roleBursar")}</option>
                </select>

                {/*
                  Said here rather than left to be discovered, because the two
                  options are not two flavours of the same thing. A school admin
                  runs the school; a bursar runs its money and cannot reach a
                  grade, a class list or these settings. Appointing the wrong one
                  is the difference between delegating the fee desk and handing
                  over the whole school.
                */}
                <p className="mt-2 text-xs text-gray-500">
                  {newRole === "bursar"
                    ? t("settings.roleBursarHint")
                    : t("settings.roleAdminHint")}
                </p>
              </div>
            </div>

            <div className="mt-5 flex gap-3">
              <button
                onClick={closeModal}
                className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition"
              >
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                {creating ? t("settings.creating") : t("settings.createAdmin")}
              </button>
            </div>
            </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

function AnalyticsSection({ schoolId }: { schoolId: string }) {
  const { t } = useTranslation();
  const { toast }      = useToast();
  const [analytics,    setAnalytics] = useState<Analytics | null>(null);
  const [loading,      setLoading]   = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/admin/settings/analytics", { params: { schoolId } });
        setAnalytics(data?.analytics || null);
      } catch (err) {
        toast({ kind: "error", title: t("settings.loadFailed"), message: extractMessage(err, t) });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  if (loading) return (
    <div className="flex justify-center py-20">
      <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
    </div>
  );

  if (!analytics) return (
    <Card>
      <div className="flex items-center gap-2 text-amber-600">
        <AlertCircle className="h-5 w-5" />
        <p className="text-sm">{t("settings.analyticsUnavailable")}</p>
      </div>
    </Card>
  );

  // `id` is the React key — a translated label would remount every tile on a
  // language switch.
  const stats = [
    { id: "teachers", label: t("academic.teacher_other"), value: analytics.summary.totalTeachers, bg: "bg-indigo-50",   text: "text-indigo-700"  },
    { id: "students", label: t("academic.student_other"), value: analytics.summary.totalStudents, bg: "bg-emerald-50",  text: "text-emerald-700" },
    { id: "classes",  label: t("academic.class_other"),   value: analytics.summary.totalClasses,  bg: "bg-purple-50",   text: "text-purple-700"  },
    { id: "subjects", label: t("academic.subject_other"), value: analytics.summary.totalSubjects, bg: "bg-amber-50",    text: "text-amber-700"   },
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardTitle>{t("settings.schoolSummary")}</CardTitle>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.id} className={cn("rounded-2xl p-5 text-center", s.bg)}>
              <p className={cn("text-3xl font-extrabold", s.text)}>{s.value ?? "—"}</p>
              <p className="mt-1 text-sm font-medium text-gray-600">{s.label}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

// -----------------------------------------------------------------------------
// ID CARDS AND THE GATE
// -----------------------------------------------------------------------------

interface IdCardSettings {
  idCard: { validUntil: string; defaultValidUntil: string; effectiveValidUntil: string };
  gate:   { notify: "off" | "exceptions" | "all"; lateAfter: string; earlyBefore: string };
}

/**
 * One screen, because from the office it is one decision: what the card says,
 * and what happens when somebody scans it.
 */
function IdCardSection({ schoolId }: { schoolId: string }) {
  const { t }     = useTranslation();
  const { toast } = useToast();

  const [settings, setSettings] = useState<IdCardSettings | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/admin/settings/id-card", { params: { schoolId } });
        setSettings({ idCard: data.idCard, gate: data.gate });
      } catch (err) {
        toast({ kind: "error", title: t("settings.loadFailed"), message: extractMessage(err, t) });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const { data } = await api.put("/admin/settings/id-card", {
        schoolId,
        validUntil:      settings.idCard.validUntil,
        gateNotify:      settings.gate.notify,
        gateLateAfter:   settings.gate.lateAfter,
        gateEarlyBefore: settings.gate.earlyBefore,
      });
      setSettings({ idCard: data.idCard, gate: data.gate });
      toast({
        kind: "success",
        title: t("settings.idCardSaved"),
        // Said every time, because it is the thing an admin gets wrong: this
        // changes cards printed from now on, not cards already laminated.
        message: t("settings.idCardReprint"),
      });
    } catch (err) {
      toast({ kind: "error", title: t("settings.saveFailed"), message: extractMessage(err, t) });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="flex justify-center py-20">
      <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
    </div>
  );

  if (!settings) return (
    <Card>
      <div className="flex items-center gap-2 text-amber-600">
        <AlertCircle className="h-5 w-5" />
        <p className="text-sm">{t("settings.loadFailed")}</p>
      </div>
    </Card>
  );

  const { idCard, gate } = settings;
  const usingDefault = !idCard.validUntil;

  const NOTIFY_CHOICES = [
    { value: "off",        label: t("settings.gateNotifyOff"), hint: t("settings.gateNotifyOffHint") },
    { value: "exceptions", label: t("settings.gateNotifyExc"), hint: t("settings.gateNotifyExcHint") },
    { value: "all",        label: t("settings.gateNotifyAll"), hint: t("settings.gateNotifyAllHint") },
  ] as const;

  return (
    <div className="space-y-5">

      <Card>
        <CardTitle>{t("settings.idCardExpiry")}</CardTitle>
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-gray-500">
            {t("settings.idCardExpiryBlurb")}
          </p>

          <div>
            <FieldLabel>{t("settings.validUntil")}</FieldLabel>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="date"
                value={idCard.validUntil}
                onChange={(e) =>
                  setSettings({ ...settings, idCard: { ...idCard, validUntil: e.target.value } })
                }
                className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
              {!usingDefault && (
                <button
                  type="button"
                  onClick={() =>
                    setSettings({ ...settings, idCard: { ...idCard, validUntil: "" } })
                  }
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                >
                  {t("settings.useDefaultDate")}
                </button>
              )}
            </div>

            {/* What an empty box actually means, spelled out - otherwise it
                reads as "no expiry" rather than "the usual date". */}
            <p className="mt-2 text-xs text-gray-500">
              {usingDefault
                ? t("settings.expiryDefaulting", { date: idCard.defaultValidUntil })
                : t("settings.expiryOverridden", { date: idCard.effectiveValidUntil })}
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>{t("settings.gateMessages")}</CardTitle>
        <div className="space-y-4">
          <p className="text-xs leading-relaxed text-gray-500">
            {t("settings.gateMessagesBlurb")}
          </p>

          <div className="space-y-2">
            {NOTIFY_CHOICES.map((choice) => (
              <label
                key={choice.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition",
                  gate.notify === choice.value
                    ? "border-indigo-300 bg-indigo-50"
                    : "border-gray-100 bg-gray-50 hover:border-gray-200"
                )}
              >
                <input
                  type="radio"
                  name="gateNotify"
                  className="mt-0.5 h-4 w-4 accent-indigo-600"
                  checked={gate.notify === choice.value}
                  onChange={() =>
                    setSettings({
                      ...settings,
                      gate: { ...gate, notify: choice.value as IdCardSettings["gate"]["notify"] },
                    })
                  }
                />
                <div>
                  <p className="text-sm font-semibold text-gray-900">{choice.label}</p>
                  <p className="text-xs text-gray-500">{choice.hint}</p>
                </div>
              </label>
            ))}
          </div>

          {/* Only meaningful under "exceptions" - the thresholds define what an
              exception IS, so they are hidden rather than left inert. */}
          {gate.notify === "exceptions" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel>{t("settings.lateAfter")}</FieldLabel>
                <input
                  type="time"
                  value={gate.lateAfter}
                  onChange={(e) =>
                    setSettings({ ...settings, gate: { ...gate, lateAfter: e.target.value } })
                  }
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <p className="mt-1.5 text-xs text-gray-500">{t("settings.lateAfterHint")}</p>
              </div>
              <div>
                <FieldLabel>{t("settings.earlyBefore")}</FieldLabel>
                <input
                  type="time"
                  value={gate.earlyBefore}
                  onChange={(e) =>
                    setSettings({ ...settings, gate: { ...gate, earlyBefore: e.target.value } })
                  }
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <p className="mt-1.5 text-xs text-gray-500">{t("settings.earlyBeforeHint")}</p>
              </div>
            </div>
          )}
        </div>
      </Card>

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const user = useUser();
  const [activeSection, setActiveSection] = useState<SectionId>("school");

  const schoolId     = user?.schoolId     ?? "";
  const currentUserId = user?._id ?? (user as unknown as Record<string, string>)?.id ?? "";

  return (
    <div className="flex flex-col gap-0 min-h-screen bg-gray-50">

      {/* ── Page header ── */}
      <div className="border-b border-gray-200 bg-white px-6 py-5">
        <h1 className="text-2xl font-bold text-gray-900">{t("settings.title")}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {t("settings.blurb")}
        </p>
      </div>

      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar nav ── */}
        <nav className="hidden w-56 shrink-0 border-r border-gray-200 bg-white p-4 md:block">
          <ul className="space-y-1">
            {SECTIONS.map((s) => {
              const Icon   = s.icon;
              const active = activeSection === s.id;
              return (
                <li key={s.id}>
                  <button
                    onClick={() => setActiveSection(s.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2.5",
                      "text-sm font-medium transition",
                      active
                        ? "bg-indigo-50 text-indigo-700"
                        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                    )}
                  >
                    <Icon className={cn("h-4 w-4", active ? "text-indigo-600" : "text-gray-400")} />
                    {t(s.labelKey)}
                    {active && <ChevronRight className="ml-auto h-3 w-3 text-indigo-400" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* ── Mobile tab bar ── */}
        <div className="md:hidden border-b border-gray-200 bg-white">
          <div className="flex overflow-x-auto px-4 gap-1 py-2">
            {SECTIONS.map((s) => {
              const Icon   = s.icon;
              const active = activeSection === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveSection(s.id)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2",
                    "text-xs font-medium transition whitespace-nowrap",
                    active
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-gray-500 hover:text-gray-700"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(s.labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Content ── */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl">
            {activeSection === "school"    && <SchoolSection    schoolId={schoolId} />}
            {activeSection === "profile"   && <ProfileSection />}
            {activeSection === "grading"   && <GradingSection   schoolId={schoolId} />}
            {activeSection === "admins"    && <AdminsSection    schoolId={schoolId} currentUserId={currentUserId} />}
            {activeSection === "permissions" && <PermissionsSection schoolId={schoolId} />}
            {activeSection === "approvals"   && <ApprovalsSection   schoolId={schoolId} />}
            {activeSection === "idcards"   && <IdCardSection    schoolId={schoolId} />}
            {activeSection === "analytics" && <AnalyticsSection schoolId={schoolId} />}
          </div>
        </main>

      </div>
    </div>
  );
}