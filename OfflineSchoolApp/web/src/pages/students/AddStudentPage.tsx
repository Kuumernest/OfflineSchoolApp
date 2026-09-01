// web/src/pages/students/AddStudentPage.tsx
//
// Direct enrollment — an admin adding a student who did not come through the
// public application form.
//
// StudentsPage and the dashboard's quick actions both navigate to /students/new,
// but the page did not exist, so both were dead ends.
//
// The result screen matters as much as the form. The server generates an
// enrollment number and a temporary password, and the student logs in with the
// enrollment number, not their email. If the email could not be sent, that
// pair is the only copy of the credentials — losing it means resetting the
// account, so it is shown prominently and copyably rather than in a toast that
// vanishes after four seconds.

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  UserPlus,
  ChevronLeft,
  Check,
  Copy,
  AlertCircle,
  Mail,
  MailWarning,
  KeyRound,
  IdCard,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { FormField, Input, SelectField } from "@/components/ui/FormField";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { enrollStudent } from "@/services/student.service";
import { fetchClasses } from "@/services/class.service";
import { useUser } from "@/store/auth.store";
import { getErrorMessage } from "@/lib/axios";
import { cn } from "@/utils/cn";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────

interface FormState {
  firstName:     string;
  lastName:      string;
  classId:       string;
  email:         string;
  phone:         string;
  gender:        string;
  dateOfBirth:   string;
  address:       string;
  guardianName:  string;
  guardianPhone: string;
}

const EMPTY: FormState = {
  firstName: "", lastName: "", classId: "", email: "", phone: "",
  gender: "", dateOfBirth: "", address: "", guardianName: "", guardianPhone: "",
};

const GENDERS = [
  { value: "male",   label: "Male" },
  { value: "female", label: "Female" },
  { value: "other",  label: "Other" },
];

interface EnrollResult {
  enrollmentNo: string;
  tempPassword: string;
  emailSent:    boolean;
  warning?:     string;
  name:         string;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function AddStudentPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();

  const user     = useUser();
  const schoolId = user?.schoolId ?? "";

  const [form, setForm]     = useState<FormState>(EMPTY);
  const [result, setResult] = useState<EnrollResult | null>(null);

  const classesQ = useQuery({
    queryKey: ["classes", schoolId],
    queryFn:  () => fetchClasses(schoolId),
    enabled:  !!schoolId,
  });

  const classes = useMemo(() => classesQ.data ?? [], [classesQ.data]);

  // Only active classes: the server rejects enrollment into an inactive class
  // with a 400, so offering them would be a guaranteed failure.
  const classOptions = useMemo(
    () =>
      classes
        .filter((c) => c.isActive !== false)
        .map((c) => ({
          value: c.id ?? c._id ?? "",
          label: [c.name, c.section].filter(Boolean).join(" "),
        })),
    [classes],
  );

  const emailValid =
    form.email.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  const canSubmit =
    form.firstName.trim().length > 0 &&
    form.lastName.trim().length > 0 &&
    !!form.classId &&
    emailValid;

  const mutation = useMutation({
    mutationFn: () =>
      enrollStudent({
        firstName: form.firstName.trim(),
        lastName:  form.lastName.trim(),
        classId:   form.classId,
        schoolId,
        // Empty strings are omitted rather than sent: an empty email would be
        // stored as "" and then collide with the next student who also has no
        // email, since the server dedupes on that field.
        ...(form.email.trim()         ? { email:         form.email.trim() }         : {}),
        ...(form.phone.trim()         ? { phone:         form.phone.trim() }         : {}),
        ...(form.gender               ? { gender:        form.gender }               : {}),
        ...(form.dateOfBirth          ? { dateOfBirth:   form.dateOfBirth }          : {}),
        ...(form.address.trim()       ? { address:       form.address.trim() }       : {}),
        ...(form.guardianName.trim()  ? { guardianName:  form.guardianName.trim() }  : {}),
        ...(form.guardianPhone.trim() ? { guardianPhone: form.guardianPhone.trim() } : {}),
      }),
    onSuccess: (data) => {
      setResult({
        enrollmentNo: data.enrollmentNo,
        tempPassword: data.tempPassword,
        emailSent:    data.emailSent,
        warning:      data.warning,
        name:         `${form.firstName.trim()} ${form.lastName.trim()}`,
      });
    },
    onError: (err) =>
      toast({ title: "Could not enroll the student", message: getErrorMessage(err), kind: "error" }),
  });

  const set = <K extends keyof FormState>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  if (classesQ.isLoading) return <PageSpinner />;

  // ── Result ─────────────────────────────────────────────────────────────────
  if (result) {
    return (
      <div className="max-w-xl mx-auto space-y-4">
        <Card>
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center mx-auto">
              <Check className="w-6 h-6 text-emerald-600" />
            </div>
            <h2 className="mt-4 text-base font-semibold text-gray-900">
              {result.name} is enrolled
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {result.emailSent
                ? "Their sign-in details have been emailed to them."
                : "No email was sent — pass these details on yourself."}
            </p>
          </div>

          {/* Credentials. Kept on screen (not in a toast) because when the
              email failed, this is the only copy. */}
          <div className="mt-5 space-y-2.5">
            <Credential
              icon={IdCard}
              label={t("academic.enrollmentNo")}
              value={result.enrollmentNo}
              hint="This is what they sign in with — not their email."
            />
            <Credential
              icon={KeyRound}
              label={t("students.tempPassword")}
              value={result.tempPassword}
              hint="They'll be asked to choose their own on first sign-in."
            />
          </div>

          <div
            className={cn(
              "mt-4 flex items-start gap-2.5 px-3 py-2.5 rounded-lg border",
              result.emailSent
                ? "bg-emerald-50 border-emerald-200"
                : "bg-amber-50 border-amber-200",
            )}
          >
            {result.emailSent ? (
              <Mail className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <MailWarning className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            )}
            <p
              className={cn(
                "text-xs",
                result.emailSent ? "text-emerald-800" : "text-amber-800",
              )}
            >
              {result.warning
                ? result.warning
                : result.emailSent
                  ? "The student has received their details by email."
                  : "Write these down before leaving this page — they are not shown again, and recovering them means resetting the account."}
            </p>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button
              onClick={() => { setResult(null); setForm({ ...EMPTY, classId: form.classId }); }}
              icon={<UserPlus className="w-4 h-4" />}
            >
              {t("students.enrollAnother")}
            </Button>
            <Button variant="secondary" onClick={() => navigate("/students")}>
              {t("students.backToStudents")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl mx-auto space-y-4">

      <Link
        to="/students"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
      >
        <ChevronLeft className="w-4 h-4" />
        {t("academic.student_other")}
      </Link>

      <div>
        <h1 className="text-lg font-semibold text-gray-900">{t("students.enroll")}</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          For a student joining directly. Applications that came through the
          public form are handled under{" "}
          <Link to="/students/admissions" className="text-primary-600 hover:underline">
            {t("admissions.title")}
          </Link>
          .
        </p>
      </div>

      {classOptions.length === 0 && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200">
          <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-800">
            There are no active classes to enroll into.{" "}
            <Link to="/classes" className="underline font-medium">{t("students.addAClass")}</Link>{" "}
            first.
          </p>
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); if (canSubmit) mutation.mutate(); }}
        className="space-y-4"
      >
        <Card>
          <CardHeader title={t("students.theStudent")} />
          <div className="grid sm:grid-cols-2 gap-3">
            <FormField label={t("common.firstName")} required>
              <Input value={form.firstName} onChange={set("firstName")} autoFocus />
            </FormField>
            <FormField label={t("common.lastName")} required>
              <Input value={form.lastName} onChange={set("lastName")} />
            </FormField>

            <FormField label={t("academic.class")} required>
              <SelectField
                options={classOptions}
                placeholder={t("students.chooseClass")}
                value={form.classId}
                onChange={set("classId")}
              />
            </FormField>
            <FormField label={t("common.gender")}>
              <SelectField
                options={GENDERS}
                placeholder={t("common.preferNotToSay")}
                value={form.gender}
                onChange={set("gender")}
              />
            </FormField>

            <FormField label={t("common.dateOfBirth")}>
              <Input type="date" value={form.dateOfBirth} onChange={set("dateOfBirth")} />
            </FormField>
            <FormField
              label={t("common.email")}
              hint="Optional. Used to send their sign-in details."
              error={!emailValid ? "That doesn't look like an email address." : undefined}
            >
              <Input
                type="email"
                value={form.email}
                onChange={set("email")}
                invalid={!emailValid}
                placeholder={t("students.emailPh")}
              />
            </FormField>

            <FormField label={t("common.phone")}>
              <Input value={form.phone} onChange={set("phone")} />
            </FormField>
            <FormField label={t("common.address")} className="sm:col-span-1">
              <Input value={form.address} onChange={set("address")} />
            </FormField>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={t("students.guardianLabel")}
            subtitle={t("common.optionalContact")}
          />
          <div className="grid sm:grid-cols-2 gap-3">
            <FormField label={t("common.name")}>
              <Input value={form.guardianName} onChange={set("guardianName")} />
            </FormField>
            <FormField label={t("common.phone")}>
              <Input value={form.guardianPhone} onChange={set("guardianPhone")} />
            </FormField>
          </div>
        </Card>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-gray-400">
            An enrollment number and temporary password are generated on save.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => navigate("/students")}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || classOptions.length === 0}
              loading={mutation.isPending}
              icon={<UserPlus className="w-4 h-4" />}
            >
              {t("students.enrollSubmit")}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Credential({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon:  React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint:  string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access is blocked outside a secure context, and over plain
      // HTTP on a LAN address that is the normal case. The value is on screen
      // either way, so this fails quietly.
    }
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-gray-50 border border-gray-200">
      <Icon className="w-4 h-4 text-gray-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-sm font-semibold text-gray-900 font-mono break-all">
          {value}
        </p>
        <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>
      </div>
      <button
        type="button"
        onClick={copy}
        title={`Copy ${label.toLowerCase()}`}
        className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-primary-600 hover:bg-white transition-colors"
      >
        {copied
          ? <Check className="w-4 h-4 text-emerald-600" />
          : <Copy className="w-4 h-4" />}
      </button>
    </div>
  );
}
