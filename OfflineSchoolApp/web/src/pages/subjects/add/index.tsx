import { useState, useCallback, useId } from "react";
import { useNavigate }                  from "react-router-dom";
import { useQuery, useMutation }        from "@tanstack/react-query";
import {
  BookOpen,
  School,
  ChevronLeft,
  AlertCircle,
  CheckSquare,
  Square,
  X,
} from "lucide-react";

import { useUser }       from "@/store/auth.store";
import { fetchClasses }  from "@/services/class.service";
import { fetchTeachers } from "@/services/teacher.service";
import { createSubject } from "@/services/subject.service";
import { cn }            from "@/utils/cn";
import type { Class, Teacher } from "@/types";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface FormState {
  name:       string;
  code:       string;
  classIds:   string[];
  teacherId:  string;
}

interface FormErrors {
  name?:     string;
  classIds?: string;
}

interface FieldProps {
  id:        string;
  label:     string;
  required?: boolean;
  error?:    string;
  hint?:     string;
  children:  React.ReactNode;
}

interface CreateResult {
  classId:   string;
  className: string;
  ok:        boolean;
  error?:    string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MAX_NAME_LENGTH = 80;
const MAX_CODE_LENGTH = 20;

const INITIAL_FORM: FormState = {
  name:      "",
  code:      "",
  classIds:  [],
  teacherId: "",
};

const EXAMPLES = ["Mathematics", "English", "Biology", "History"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

const validate = (form: FormState): FormErrors => {
  const errors: FormErrors = {};
  const name = form.name.trim();

  if (!name) {
    errors.name = "Subject name is required.";
  } else if (name.length < 2) {
    errors.name = "Subject name must be at least 2 characters.";
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `Subject name cannot exceed ${MAX_NAME_LENGTH} characters.`;
  }

  if (form.classIds.length === 0) {
    errors.classIds = "Please select at least one class.";
  }

  return errors;
};

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const Field = ({ id, label, required, error, hint, children }: FieldProps) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={id} className="text-sm font-semibold text-gray-700">
      {label}
      {required && (
        <>
          <span className="ml-1 text-red-500" aria-hidden="true">*</span>
          <span className="sr-only">(required)</span>
        </>
      )}
    </label>

    {children}

    {error && (
      <p
        id={`${id}-error`}
        role="alert"
        className="flex items-center gap-1 text-xs font-medium text-red-600"
      >
        <AlertCircle size={12} aria-hidden="true" />
        {error}
      </p>
    )}

    {!error && hint && (
      <p id={`${id}-hint`} className="text-xs text-gray-400">
        {hint}
      </p>
    )}
  </div>
);

function ResultsSummary({
  results,
  onDone,
  onAddAnother,
}: {
  results:      CreateResult[];
  onDone:       () => void;
  onAddAnother: () => void;
}) {
  const { t } = useTranslation();
  const succeeded = results.filter((r) => r.ok);
  const failed    = results.filter((r) => !r.ok);

  return (
    <div className="flex flex-col gap-4">
      {succeeded.length > 0 && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="mb-2 text-sm font-bold text-emerald-800">
            ✅ Created in {succeeded.length}{" "}
            {succeeded.length === 1 ? "class" : "classes"}
          </p>
          <ul className="flex flex-col gap-1">
            {succeeded.map((r) => (
              <li key={r.classId} className="text-sm text-emerald-700">
                {r.className}
              </li>
            ))}
          </ul>
        </div>
      )}

      {failed.length > 0 && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p className="mb-2 text-sm font-bold text-red-800">
            ❌ Failed in {failed.length}{" "}
            {failed.length === 1 ? "class" : "classes"}
          </p>
          <ul className="flex flex-col gap-1">
            {failed.map((r) => (
              <li key={r.classId} className="text-sm text-red-700">
                {r.className}
                {r.error && (
                  <span className="ml-2 text-xs text-red-500">({r.error})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onAddAnother}
          className="w-full rounded-xl border-2 border-indigo-600 py-3 text-sm font-bold text-indigo-600 hover:bg-indigo-50 transition-colors"
        >
          {t("subjectsAdd.another")}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white hover:bg-emerald-700 transition-colors"
        >
          {t("common.done")}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function AddSubjectPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user     = useUser();
  const schoolId = user?.schoolId ?? "";

  const [form,        setForm]        = useState<FormState>(INITIAL_FORM);
  const [errors,      setErrors]      = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results,     setResults]     = useState<CreateResult[] | null>(null);

  const nameId     = useId();
  const codeId     = useId();
  const classesId  = useId();
  const teacherId  = useId();

  // Queries
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

  const allSelected = classes.length > 0 &&
    classes.every((c) => form.classIds.includes(c._id));

  const toggleClass = useCallback((id: string) => {
    setForm((prev) => ({
      ...prev,
      classIds: prev.classIds.includes(id)
        ? prev.classIds.filter((x) => x !== id)
        : [...prev.classIds, id],
    }));
    setErrors((prev) => ({ ...prev, classIds: undefined }));
    setSubmitError(null);
  }, []);

  const toggleAll = useCallback(() => {
    setForm((prev) => ({
      ...prev,
      classIds: allSelected ? [] : classes.map((c) => c._id),
    }));
    setErrors((prev) => ({ ...prev, classIds: undefined }));
    setSubmitError(null);
  }, [allSelected, classes]);

  const removeClass = useCallback((id: string) => {
    setForm((prev) => ({
      ...prev,
      classIds: prev.classIds.filter((x) => x !== id),
    }));
  }, []);

  const { mutate, isPending } = useMutation({
    mutationFn: async (values: FormState): Promise<CreateResult[]> => {
      const outcomes: CreateResult[] = [];

      for (const cid of values.classIds) {
        const cls = classes.find((c) => c._id === cid);
        try {
          await createSubject({
            name:      values.name.trim(),
            code:      values.code.trim() || undefined,
            classId:   cid,
            teacherId: values.teacherId || undefined,
            schoolId,
          });
          outcomes.push({
            classId:   cid,
            className: cls?.name ?? cid,
            ok:        true,
          });
        } catch (err: unknown) {
          const msg =
            (err as { response?: { data?: { message?: string } } })
              ?.response?.data?.message ??
            (err instanceof Error ? err.message : null) ??
            "Unknown error";
          outcomes.push({
            classId:   cid,
            className: cls?.name ?? cid,
            ok:        false,
            error:     msg,
          });
        }
      }

      return outcomes;
    },
    onSuccess: (outcomes) => {
      const allOk = outcomes.every((r) => r.ok);
      if (allOk && outcomes.length === 1) {
        navigate("/subjects", { state: { created: true } });
        return;
      }
      setResults(outcomes);
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { message?: string } } })
          ?.response?.data?.message ??
        (err instanceof Error ? err.message : null) ??
        "Failed to create subject. Please try again.";
      setSubmitError(msg);
    },
  });

  const handleChange = useCallback(
    (field: keyof Pick<FormState, "name" | "code" | "teacherId">, value: string) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      if (field === "name") {
        setErrors((prev) => ({ ...prev, name: undefined }));
      }
      setSubmitError(null);
    },
    []
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const errs = validate(form);
      if (Object.keys(errs).length > 0) {
        setErrors(errs);
        return;
      }
      setErrors({});
      mutate(form);
    },
    [form, mutate]
  );

  const handleDiscard = useCallback(() => {
    const isDirty =
      form.name.trim()     !== "" ||
      form.code.trim()     !== "" ||
      form.classIds.length  >  0  ||
      form.teacherId       !== "";

    if (isDirty) {
      if (window.confirm("Discard unsaved changes and go back?")) {
        navigate(-1);
      }
    } else {
      navigate(-1);
    }
  }, [form, navigate]);

  const nameLen     = form.name.trim().length;
  const isNearLimit = nameLen > MAX_NAME_LENGTH - 15;
  const isBusy      = isPending;

  if (results) {
    return (
      <div className="min-h-screen bg-gray-50">
        <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-gray-200 bg-white px-6 py-4">
          <div className="flex-1">
            <h1 className="text-xl font-bold text-gray-900">{t("subjectsAdd.created")}</h1>
            <p className="text-sm text-gray-500">
              "{form.name.trim()}" — results below
            </p>
          </div>
        </header>
        <main className="mx-auto max-w-xl px-6 py-8">
          <ResultsSummary
            results={results}
            onDone={() => navigate("/subjects", { state: { created: true } })}
            onAddAnother={() => {
              setForm(INITIAL_FORM);
              setResults(null);
              setErrors({});
              setSubmitError(null);
            }}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">

      <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-gray-200 bg-white px-6 py-4">
        <button
          type="button"
          onClick={handleDiscard}
          className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
          aria-label={t("common.goBack")}
        >
          <ChevronLeft size={20} aria-hidden="true" />
        </button>

        <div className="flex-1">
          <h1 className="text-xl font-bold text-gray-900">{t("subjectsAdd.title")}</h1>
          <p className="text-sm text-gray-500">
            {t("subjectsAdd.blurb")}
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-xl px-6 py-8">
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-6">

          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm flex flex-col gap-5">

            <div className="flex items-start gap-3 rounded-xl bg-blue-50 px-4 py-3" role="note">
              <BookOpen size={16} className="mt-0.5 shrink-0 text-blue-600" aria-hidden="true" />
              <p className="text-sm text-blue-800 font-medium leading-5">
                Select multiple classes to create this subject in all of them at once.
              </p>
            </div>

            {/* Subject name */}
            <Field
              id={nameId}
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
                    : "border-gray-200 focus-within:border-indigo-500 focus-within:bg-white"
                )}
              >
                <BookOpen
                  size={16}
                  aria-hidden="true"
                  className={errors.name ? "text-red-400" : "text-gray-400"}
                />
                <input
                  id={nameId}
                  type="text"
                  value={form.name}
                  onChange={(e) => handleChange("name", e.target.value)}
                  placeholder={t("subjectsAdd.namePh")}
                  maxLength={MAX_NAME_LENGTH + 5}
                  disabled={isBusy}
                  autoFocus
                  aria-required
                  aria-invalid={!!errors.name}
                  aria-describedby={errors.name ? `${nameId}-error` : `${nameId}-hint`}
                  className="flex-1 bg-transparent py-3 text-sm text-gray-900 placeholder-gray-400 outline-none"
                />
                {nameLen > 0 && (
                  <span
                    aria-live="polite"
                    aria-label={`${nameLen} of ${MAX_NAME_LENGTH} characters used`}
                    className={cn(
                      "shrink-0 text-xs tabular-nums",
                      isNearLimit ? "text-amber-500 font-semibold" : "text-gray-300",
                      nameLen > MAX_NAME_LENGTH && "text-red-500 font-bold"
                    )}
                  >
                    {nameLen}/{MAX_NAME_LENGTH}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-gray-400" aria-hidden="true">{t("subjectsAdd.examples")}</span>
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => handleChange("name", ex)}
                    aria-label={`Use example: ${ex}`}
                    className="rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-100 transition-colors"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </Field>

            {/* Subject code */}
            <Field
              id={codeId}
              label={t("subjects.codeLabel")}
              hint="Optional short code, e.g. MATH101"
            >
              <input
                id={codeId}
                type="text"
                value={form.code}
                onChange={(e) => handleChange("code", e.target.value)}
                placeholder={t("subjects.codePh")}
                maxLength={MAX_CODE_LENGTH}
                disabled={isBusy}
                aria-describedby={`${codeId}-hint`}
                className={cn(
                  "w-full rounded-xl border-2 bg-gray-50 px-3 py-3 text-sm",
                  "text-gray-900 placeholder-gray-400 outline-none transition-colors",
                  "border-gray-200 focus:border-indigo-500 focus:bg-white"
                )}
              />
            </Field>

            {/* Classes multi-select */}
            <Field
              id={classesId}
              label={t("academic.class_other")}
              required
              error={errors.classIds}
              hint="Select all classes that will teach this subject."
            >
              <div
                className={cn(
                  "rounded-xl border-2 bg-gray-50 overflow-hidden transition-colors",
                  errors.classIds ? "border-red-400" : "border-gray-200"
                )}
                aria-describedby={
                  errors.classIds ? `${classesId}-error` : `${classesId}-hint`
                }
              >
                {classesQuery.isLoading ? (
                  <p className="px-4 py-3 text-sm text-gray-400">
                    Loading classes…
                  </p>
                ) : classes.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-gray-400">
                    {t("subjectsAdd.noClasses")}
                  </p>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={toggleAll}
                      disabled={isBusy}
                      className="flex w-full items-center gap-3 border-b border-gray-200 bg-gray-100 px-4 py-2.5 text-left hover:bg-gray-200 transition-colors"
                    >
                      {allSelected
                        ? <CheckSquare size={16} className="text-indigo-600 shrink-0" />
                        : <Square      size={16} className="text-gray-400 shrink-0"   />
                      }
                      <span className="text-xs font-bold text-gray-600 uppercase tracking-wide">
                        {allSelected ? "Deselect All" : "Select All"}
                      </span>
                      <span className="ml-auto text-xs text-gray-400">
                        {form.classIds.length}/{classes.length}
                      </span>
                    </button>

                    <ul className="max-h-52 overflow-y-auto">
                      {classes.map((cls) => {
                        const checked = form.classIds.includes(cls._id);
                        return (
                          <li key={cls._id}>
                            <button
                              type="button"
                              onClick={() => toggleClass(cls._id)}
                              disabled={isBusy}
                              aria-pressed={checked}
                              className={cn(
                                "flex w-full items-center gap-3 px-4 py-3 text-left",
                                "border-b border-gray-100 last:border-b-0",
                                "transition-colors hover:bg-indigo-50",
                                checked && "bg-indigo-50"
                              )}
                            >
                              {checked
                                ? <CheckSquare size={16} className="text-indigo-600 shrink-0" />
                                : <Square      size={16} className="text-gray-300 shrink-0"   />
                              }
                              <span className={cn(
                                "text-sm",
                                checked ? "font-semibold text-indigo-900" : "text-gray-700"
                              )}>
                                {cls.name}
                              </span>
                              {cls.level && (
                                <span className="ml-auto text-xs text-gray-400">
                                  Level {cls.level}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>

              {form.classIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {form.classIds.map((id) => {
                    const cls = classes.find((c) => c._id === id);
                    return (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded-lg bg-indigo-100 px-2.5 py-1 text-xs font-semibold text-indigo-700"
                      >
                        <School size={11} aria-hidden="true" />
                        {cls?.name ?? id}
                        <button
                          type="button"
                          onClick={() => removeClass(id)}
                          aria-label={`Remove ${cls?.name ?? id}`}
                          className="ml-0.5 rounded text-indigo-500 hover:text-indigo-800"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
            </Field>

            {/* Teacher */}
            <Field
              id={teacherId}
              label={t("classes.assignedTeacher")}
              hint="Optional — you can assign a teacher later."
            >
              <select
                id={teacherId}
                value={form.teacherId}
                onChange={(e) => handleChange("teacherId", e.target.value)}
                disabled={isBusy || teachersQuery.isLoading}
                aria-describedby={`${teacherId}-hint`}
                className={cn(
                  "w-full rounded-xl border-2 bg-gray-50 px-3 py-3 text-sm",
                  "text-gray-900 outline-none transition-colors",
                  "border-gray-200 focus:border-indigo-500 focus:bg-white"
                )}
              >
                <option value="">
                  {teachersQuery.isLoading ? "Loading teachers…" : "No teacher assigned"}
                </option>
                {teachers.map((t) => (
                  <option key={t._id} value={t._id}>{t.name}</option>
                ))}
              </select>
            </Field>
          </div>

          {submitError && (
            <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3">
              <AlertCircle size={16} className="shrink-0 text-red-500" aria-hidden="true" />
              <p className="text-sm font-medium text-red-700">{submitError}</p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <button
              type="submit"
              disabled={isBusy}
              className={cn(
                "flex w-full items-center justify-center gap-2 rounded-xl py-3.5",
                "text-sm font-bold text-white transition-colors",
                isBusy
                  ? "bg-gray-400 cursor-not-allowed"
                  : "bg-emerald-600 hover:bg-emerald-700"
              )}
            >
              {isBusy ? (
                <>
                  <div
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                    role="status"
                    aria-label={t("subjectsAdd.creating")}
                  />
                  <span>
                    Creating in {form.classIds.length}{" "}
                    {form.classIds.length === 1 ? "class" : "classes"}…
                  </span>
                </>
              ) : (
                <>
                  Create Subject
                  {form.classIds.length > 1 && (
                    <span className="ml-1 rounded-full bg-emerald-500 px-2 py-0.5 text-xs">
                      {form.classIds.length} classes
                    </span>
                  )}
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleDiscard}
              disabled={isBusy}
              className="w-full py-3 text-sm font-medium text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
            >
              Discard &amp; Go Back
            </button>
          </div>

        </form>
      </main>
    </div>
  );
}