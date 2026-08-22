import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams }           from "react-router-dom";
import { useQuery, useMutation }            from "@tanstack/react-query";
import {
  BookOpen,
  School,
  ChevronLeft,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

import { useUser }      from "@/store/auth.store";
import {
  fetchClasses,
  fetchSubjects,
  updateSubject,
}                       from "@/services/class.service";
import { fetchTeachers } from "@/services/teacher.service";
import { cn }           from "@/utils/cn";
import type { Class, Teacher, Subject } from "@/types";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface FormState {
  name:      string;
  code:      string;
  classId:   string;
  teacherId: string;
}

interface FormErrors {
  name?:    string;
  classId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_NAME_LENGTH = 80;
const MAX_CODE_LENGTH = 20;

const EMPTY_FORM: FormState = {
  name: "", code: "", classId: "", teacherId: "",
};

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const validate = (form: FormState): FormErrors => {
  const errors: FormErrors = {};
  const name = form.name.trim();

  if (!name)
    errors.name = "Subject name is required.";
  else if (name.length < 2)
    errors.name = "Subject name must be at least 2 characters.";
  else if (name.length > MAX_NAME_LENGTH)
    errors.name = `Subject name cannot exceed ${MAX_NAME_LENGTH} characters.`;

  if (!form.classId)
    errors.classId = "Please select a class.";

  return errors;
};

const subjectToForm = (s: Subject): FormState => ({
  name:      s.name      ?? "",
  code:      s.code      ?? "",
  classId:   s.classId   ?? "",
  teacherId: s.teacherId ?? "",
});

const formsDiffer = (a: FormState, b: FormState): boolean =>
  a.name.trim()  !== b.name.trim()  ||
  a.code.trim()  !== b.code.trim()  ||
  a.classId      !== b.classId      ||
  a.teacherId    !== b.teacherId;

// ─────────────────────────────────────────────────────────────────────────────
// FIELD WRAPPER
// ─────────────────────────────────────────────────────────────────────────────

interface FieldProps {
  label:     string;
  required?: boolean;
  error?:    string;
  hint?:     string;
  children:  React.ReactNode;
}

const Field = ({ label, required, error, hint, children }: FieldProps) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-sm font-semibold text-gray-700">
      {label}
      {required && <span className="ml-1 text-red-500">*</span>}
    </label>
    {children}
    {error && (
      <p className="flex items-center gap-1 text-xs font-medium text-red-600">
        <AlertCircle size={12} />
        {error}
      </p>
    )}
    {!error && hint && (
      <p className="text-xs text-gray-400">{hint}</p>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function EditSubjectPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { id }   = useParams<{ id: string }>();
  const user     = useUser();
  const schoolId = user?.schoolId ?? "";

  const [form,         setForm]         = useState<FormState>(EMPTY_FORM);
  const [originalForm, setOriginalForm] = useState<FormState>(EMPTY_FORM);
  const [errors,       setErrors]       = useState<FormErrors>({});
  const [submitError,  setSubmitError]  = useState<string | null>(null);

  // ── Fetch subject list and find the one being edited ──────────────────────

  const subjectQuery = useQuery<Subject[], Error>({
    queryKey:  ["subjects", schoolId],
    queryFn:   () => fetchSubjects(schoolId),
    enabled:   !!schoolId && !!id,
    staleTime: 30_000,
  });

  const subject = subjectQuery.data?.find(
    (s) => s._id === id || (s as Subject & { id?: string }).id === id
  );

  useEffect(() => {
    if (subject) {
      const initial = subjectToForm(subject);
      setForm(initial);
      setOriginalForm(initial);
    }
  }, [subject]);

  // ── Supporting data ───────────────────────────────────────────────────────

  const classesQuery = useQuery<Class[], Error>({
    queryKey:  ["classes", schoolId],
    queryFn:   () => fetchClasses(schoolId),
    enabled:   !!schoolId,
    staleTime: 60_000,
  });

  const teachersQuery = useQuery<{ teachers: Teacher[] }, Error>({
    queryKey:  ["teachers", schoolId],
    queryFn:   () => fetchTeachers({ schoolId, limit: 200 }),
    enabled:   !!schoolId,
    staleTime: 60_000,
  });

  const classes  = classesQuery.data           ?? [];
  const teachers = teachersQuery.data?.teachers ?? [];

  // ── Derived state ─────────────────────────────────────────────────────────
  const hasChanges  = formsDiffer(form, originalForm);
  const nameLen     = form.name.trim().length;
  const isNearLimit = nameLen > MAX_NAME_LENGTH - 15;
  const isLoading   = subjectQuery.isLoading;

  // ── Mutation ──────────────────────────────────────────────────────────────

  const mutation = useMutation({
    mutationFn: () => {
      if (!id) throw new Error("No subject ID");
      return updateSubject(id, {
        name:      form.name.trim(),
        code:      form.code.trim() || undefined,
        classId:   form.classId,
        teacherId: form.teacherId   || undefined,
      });
    },
    onSuccess: () => {
      navigate("/subjects", { state: { updated: true } });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })
          ?.response?.data?.message ??
        (err instanceof Error ? err.message : null) ??
        "Failed to update subject. Please try again.";
      setSubmitError(msg);
    },
  });

  const isBusy = mutation.isPending;

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleChange = useCallback(
    (field: keyof FormState, value: string) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      if (errors[field as keyof FormErrors]) {
        setErrors((prev) => ({ ...prev, [field]: undefined }));
      }
      setSubmitError(null);
    },
    [errors]
  );

  const handleReset = useCallback(() => {
    setForm(originalForm);
    setErrors({});
    setSubmitError(null);
  }, [originalForm]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const errs = validate(form);
      if (Object.keys(errs).length > 0) {
        setErrors(errs);
        return;
      }
      setErrors({});
      mutation.mutate();
    },
    [form, mutation]
  );

  const handleDiscard = useCallback(() => {
    if (hasChanges) {
      if (window.confirm("Discard unsaved changes and go back?")) {
        navigate(-1);
      }
    } else {
      navigate(-1);
    }
  }, [hasChanges, navigate]);

  // ── Loading ───────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-50">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        <p className="text-sm font-medium text-gray-500">Loading subject…</p>
      </div>
    );
  }

  // ── Not found ─────────────────────────────────────────────────────────────

  if (!isLoading && !subject) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 px-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50">
          <AlertCircle size={28} className="text-red-500" />
        </div>
        <p className="text-lg font-bold text-gray-900">{t("subjectsEdit.notFound")}</p>
        <p className="text-sm text-gray-500">
          The subject you are trying to edit does not exist or was deleted.
        </p>
        <button
          onClick={() => navigate("/subjects")}
          className="mt-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors"
        >
          {t("subjectsEdit.back")}
        </button>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">

      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-gray-200 bg-white px-6 py-4">
        <button
          type="button"
          onClick={handleDiscard}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
          title={t("common.goBack")}
        >
          <ChevronLeft size={20} />
        </button>

        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-gray-900">{t("subjectsEdit.title")}</h1>
          <p className="truncate text-sm text-gray-500">
            {subject?.name ?? "Update subject details"}
          </p>
        </div>

        {hasChanges && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isBusy}
            className="rounded-xl bg-indigo-50 px-4 py-2 text-sm font-bold text-indigo-600 hover:bg-indigo-100 disabled:opacity-50 transition-colors"
          >
            {isBusy
              ? <RefreshCw size={14} className="animate-spin" />
              : "Save"
            }
          </button>
        )}
      </header>

      <main className="mx-auto max-w-xl px-6 py-8">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">

          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm flex flex-col gap-5">

            {subject && (
              <div className="flex items-center gap-2 rounded-xl bg-blue-50 px-4 py-3">
                <BookOpen size={15} className="shrink-0 text-blue-600" />
                <p className="text-sm text-blue-800 font-medium">
                  Editing:{" "}
                  <span className="font-bold">"{subject.name}"</span>
                </p>
              </div>
            )}

            {hasChanges && (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-2.5">
                <p className="text-xs font-semibold text-amber-700">
                  ✎ You have unsaved changes
                </p>
                <button
                  type="button"
                  onClick={handleReset}
                  className="text-xs font-bold text-amber-700 underline hover:text-amber-900"
                >
                  {t("common.reset")}
                </button>
              </div>
            )}

            {/* Subject name */}
            <Field
              label={t("subjects.nameLabel")}
              required
              error={errors.name}
              hint="Use a clear, recognisable name."
            >
              <div
                className={cn(
                  "flex items-center gap-2 rounded-xl border-2 bg-gray-50 px-3 transition-colors",
                  errors.name
                    ? "border-red-400 bg-red-50"
                    : form.name.trim() !== originalForm.name.trim()
                      ? "border-indigo-400 bg-indigo-50"
                      : "border-gray-200 focus-within:border-indigo-500 focus-within:bg-white"
                )}
              >
                <BookOpen
                  size={16}
                  className={errors.name ? "text-red-400" : "text-gray-400"}
                />
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => handleChange("name", e.target.value)}
                  placeholder={t("subjectsAdd.namePh")}
                  maxLength={MAX_NAME_LENGTH + 5}
                  disabled={isBusy}
                  autoFocus
                  className="flex-1 bg-transparent py-3 text-sm text-gray-900 placeholder-gray-400 outline-none"
                />
                <span
                  className={cn(
                    "shrink-0 text-xs tabular-nums",
                    isNearLimit            ? "text-amber-500 font-semibold" : "text-gray-300",
                    nameLen > MAX_NAME_LENGTH && "text-red-500 font-bold"
                  )}
                >
                  {nameLen}/{MAX_NAME_LENGTH}
                </span>
              </div>
            </Field>

            {/* Subject code */}
            <Field
              label={t("subjects.codeLabel")}
              hint="Optional short code, e.g. MATH101"
            >
              <input
                type="text"
                value={form.code}
                onChange={(e) => handleChange("code", e.target.value)}
                placeholder={t("subjects.codePh")}
                maxLength={MAX_CODE_LENGTH}
                disabled={isBusy}
                className={cn(
                  "w-full rounded-xl border-2 bg-gray-50 px-3 py-3 text-sm",
                  "text-gray-900 placeholder-gray-400 outline-none transition-colors",
                  form.code.trim() !== originalForm.code.trim()
                    ? "border-indigo-300 bg-indigo-50"
                    : "border-gray-200 focus:border-indigo-500 focus:bg-white"
                )}
              />
            </Field>

            {/* Class */}
            <Field label={t("academic.class")} required error={errors.classId}>
              <div
                className={cn(
                  "flex items-center gap-2 rounded-xl border-2 bg-gray-50 px-3 transition-colors",
                  errors.classId
                    ? "border-red-400 bg-red-50"
                    : form.classId !== originalForm.classId
                      ? "border-indigo-300 bg-indigo-50"
                      : "border-gray-200 focus-within:border-indigo-500 focus-within:bg-white"
                )}
              >
                <School
                  size={16}
                  className={errors.classId ? "text-red-400" : "text-gray-400"}
                />
                <select
                  value={form.classId}
                  onChange={(e) => handleChange("classId", e.target.value)}
                  disabled={isBusy || classesQuery.isLoading}
                  className="flex-1 bg-transparent py-3 text-sm text-gray-900 outline-none"
                >
                  <option value="">
                    {classesQuery.isLoading ? "Loading classes…" : "Select a class"}
                  </option>
                  {classes.map((c) => (
                    <option key={c._id} value={c._id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </Field>

            {/* Teacher */}
            <Field
              label={t("classes.assignedTeacher")}
              hint="Optional — leave blank to unassign."
            >
              <select
                value={form.teacherId}
                onChange={(e) => handleChange("teacherId", e.target.value)}
                disabled={isBusy || teachersQuery.isLoading}
                className={cn(
                  "w-full rounded-xl border-2 bg-gray-50 px-3 py-3 text-sm",
                  "text-gray-900 outline-none transition-colors",
                  form.teacherId !== originalForm.teacherId
                    ? "border-indigo-300 bg-indigo-50"
                    : "border-gray-200 focus:border-indigo-500 focus:bg-white"
                )}
              >
                <option value="">
                  {teachersQuery.isLoading
                    ? "Loading teachers…"
                    : "No teacher assigned"}
                </option>
                {teachers.map((t) => (
                  <option key={t._id} value={t._id}>{t.name}</option>
                ))}
              </select>
            </Field>
          </div>

          {submitError && (
            <div className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3">
              <AlertCircle size={16} className="shrink-0 text-red-500" />
              <p className="text-sm font-medium text-red-700">{submitError}</p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <button
              type="submit"
              disabled={isBusy || !hasChanges}
              className={cn(
                "flex w-full items-center justify-center gap-2 rounded-xl py-3.5",
                "text-sm font-bold text-white transition-colors",
                isBusy || !hasChanges
                  ? "bg-gray-300 cursor-not-allowed"
                  : "bg-indigo-600 hover:bg-indigo-700"
              )}
            >
              {isBusy ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Saving…
                </>
              ) : (
                "Save Changes"
              )}
            </button>

            <button
              type="button"
              onClick={handleDiscard}
              disabled={isBusy}
              className="w-full py-3 text-sm font-medium text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
            >
              {hasChanges ? "Discard Changes" : "Go Back"}
            </button>
          </div>

        </form>
      </main>
    </div>
  );
}