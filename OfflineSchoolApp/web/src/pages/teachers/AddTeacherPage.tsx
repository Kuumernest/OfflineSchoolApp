// web/src/pages/teachers/AddTeacherPage.tsx
import { useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";
import api from "@/services/api";
import { getErrorMessage, isConflict } from "@/lib/api";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft, UserPlus, Mail, User,
  Key, Lock, AlertCircle, CheckCircle,
  Copy, Check,
} from "lucide-react";

// ─────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────

const MAX_NAME_LENGTH = 60;
const EMAIL_REGEX     = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Module scope cannot call a hook, so each step carries its key and the
// component resolves it at render.
const NEXT_STEPS = [
  {
    icon:     Key,
    color:    "#4F46E5",
    bg:       "bg-indigo-50",
    labelKey: "teachersAdd.step1",
  },
  {
    icon:     Mail,
    color:    "#0891B2",
    bg:       "bg-cyan-50",
    labelKey: "teachersAdd.step2",
  },
  {
    icon:     Lock,
    color:    "#059669",
    bg:       "bg-emerald-50",
    labelKey: "teachersAdd.step3",
  },
];

// ─────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────

interface FormErrors {
  name?:  string;
  email?: string;
}

interface SuccessState {
  teacherName:  string;
  teacherEmail: string;
  emailSent:    boolean;
  tempPassword: string | null;
  message:      string | null;
}

// ─────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────

export default function AddTeacherPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user     = useAuthStore((s) => s.user);

  const nameRef  = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // ── Form state ──────────────────────────────────────────
  const [name,    setName]    = useState("");
  const [email,   setEmail]   = useState("");
  const [errors,  setErrors]  = useState<FormErrors>({});
  const [saving,  setSaving]  = useState(false);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [copied,  setCopied]  = useState(false);

  // ── Derived ─────────────────────────────────────────────
  const trimmedName  = name.trim();
  const trimmedEmail = email.trim();
  const isDisabled   = saving || !trimmedName || !trimmedEmail;
  const charCount    = trimmedName.length;
  const isNearLimit  = charCount > MAX_NAME_LENGTH - 10;

  // ── Validation ──────────────────────────────────────────
  const validate = useCallback((): boolean => {
    const next: FormErrors = {};

    if (!trimmedName) {
      next.name = t("teachersAdd.errNameRequired");
    } else if (trimmedName.length < 2) {
      next.name = t("teachersAdd.errNameMin");
    } else if (trimmedName.length > MAX_NAME_LENGTH) {
      next.name = t("teachersAdd.errNameMax", { max: MAX_NAME_LENGTH });
    }

    if (!trimmedEmail) {
      next.email = t("teachersAdd.errEmailRequired");
    } else if (!EMAIL_REGEX.test(trimmedEmail)) {
      next.email = t("teachersAdd.errEmailInvalid");
    }

    setErrors(next);

    if (next.name)  { nameRef.current?.focus();  return false; }
    if (next.email) { emailRef.current?.focus(); return false; }
    return true;
  }, [trimmedName, trimmedEmail, t]);

  // ── Copy password ───────────────────────────────────────
  const handleCopy = useCallback(async (pwd: string) => {
    try {
      await navigator.clipboard.writeText(pwd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, []);

  // ── Reset form ──────────────────────────────────────────
  const handleAddAnother = useCallback(() => {
    setName("");
    setEmail("");
    setErrors({});
    setSuccess(null);
    setCopied(false);
    setTimeout(() => nameRef.current?.focus(), 100);
  }, []);

  // ── Submit ──────────────────────────────────────────────
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!validate()) return;

      const submittedName  = trimmedName;
      const submittedEmail = trimmedEmail;

      setSaving(true);
      setErrors({});

      try {
        const res = await api.post("/admin/teachers", {
          name:     submittedName,
          email:    submittedEmail,
          schoolId: user?.schoolId,
        });

        const {
          emailSent    = false,
          tempPassword = null,
          message      = null,
        } = res.data ?? {};

        setSuccess({
          teacherName:  submittedName,
          teacherEmail: submittedEmail,
          emailSent,
          tempPassword,
          message,
        });
      } catch (err) {
        if (isConflict(err)) {
          setErrors({ email: t("teachersAdd.errEmailTaken") });
          emailRef.current?.focus();
        } else {
          setErrors({
            name: getErrorMessage(err) || t("teachersAdd.createFailed"),
          });
        }
      } finally {
        setSaving(false);
      }
    },
    [validate, trimmedName, trimmedEmail, user?.schoolId, t]
  );

  // ─────────────────────────────────────────────────────────
  // SUCCESS VIEW
  // ─────────────────────────────────────────────────────────

  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <Header onBack={() => navigate("/teachers")} />

        <div className="flex-1 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm
                          p-8 w-full max-w-md text-center">

            {/* Icon */}
            <div className={`
              w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4
              ${success.emailSent ? "bg-emerald-50" : "bg-yellow-50"}
            `}>
              {success.emailSent
                ? <CheckCircle size={32} className="text-emerald-600" />
                : <AlertCircle size={32} className="text-yellow-600" />
              }
            </div>

            <h2 className="text-xl font-bold text-gray-900 mb-1">
              {success.emailSent
                ? t("teachersAdd.addedTitle")
                : t("teachersAdd.createdTitle")}
            </h2>

            <p className="text-sm text-gray-500 mb-6">
              {success.emailSent
                ? success.message ||
                  t("teachersAdd.addedBody", {
                    name:  success.teacherName,
                    email: success.teacherEmail,
                  })
                : t("teachersAdd.emailFailedBody")
              }
            </p>

            {/* Manual credentials — shown when email failed */}
            {!success.emailSent && success.tempPassword && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl
                              p-4 mb-6 text-left space-y-3">
                <p className="text-xs font-bold text-yellow-800 uppercase tracking-wide">
                  {t("teachersAdd.shareManually")}
                </p>
                <div>
                  <p className="text-xs text-yellow-700 font-medium">📧 {t("common.email")}</p>
                  <p className="text-sm font-mono text-gray-900 mt-0.5">
                    {success.teacherEmail}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-yellow-700 font-medium">🔑 {t("students.tempPassword")}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-sm font-mono text-gray-900 flex-1">
                      {success.tempPassword}
                    </p>
                    <button
                      onClick={() => handleCopy(success.tempPassword!)}
                      className="flex items-center gap-1 text-xs font-semibold
                                 text-indigo-600 hover:text-indigo-800 transition-colors"
                    >
                      {copied
                        ? <><Check size={13} /> {t("common.copied")}</>
                        : <><Copy size={13} /> {t("common.copy")}</>
                      }
                    </button>
                  </div>
                </div>
                <p className="text-xs text-yellow-700">
                  {t("teachersAdd.mustChange")}
                </p>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col gap-3">
              <button
                onClick={handleAddAnother}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white
                           font-semibold py-3 rounded-xl transition-colors"
              >
                {t("teachersAdd.another")}
              </button>
              <button
                onClick={() => navigate("/teachers")}
                className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700
                           font-semibold py-3 rounded-xl transition-colors"
              >
                {t("teachersAdd.back")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────
  // FORM VIEW
  // ─────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header onBack={() => navigate("/teachers")} />

      <div className="flex-1 max-w-2xl mx-auto w-full px-6 py-8 space-y-6">

        {/* Info banner */}
        <div className="flex items-start gap-3 bg-blue-50 border border-blue-200
                        rounded-xl p-4 text-sm text-blue-700">
          <Mail size={18} className="mt-0.5 shrink-0 text-blue-600" />
          <p>{t("teachersAdd.infoBanner")}</p>
        </div>

        {/* Form card */}
        <form
          onSubmit={handleSubmit}
          noValidate
          className="bg-white rounded-2xl border border-gray-200 shadow-sm
                     p-6 space-y-5"
        >
          {/* Name field */}
          <div className="space-y-1.5">
            <label className="block text-sm font-semibold text-gray-700">
              {t("teachersAdd.nameLabel")} <span className="text-red-500">*</span>
            </label>
            <div className={`
              flex items-center gap-3 border rounded-xl px-4 py-3 bg-gray-50
              transition-colors
              ${errors.name
                ? "border-red-400 bg-red-50"
                : "border-gray-200 focus-within:border-indigo-500 focus-within:bg-white"}
            `}>
              <User
                size={18}
                className={errors.name ? "text-red-400" : "text-gray-400"}
              />
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
                }}
                placeholder={t("teachersAdd.namePh")}
                maxLength={MAX_NAME_LENGTH + 5}
                autoComplete="name"
                autoFocus
                className="flex-1 bg-transparent text-gray-900 placeholder-gray-400
                           text-sm focus:outline-none"
              />
            </div>
            <div className="flex items-center justify-between">
              {errors.name ? (
                <p className="flex items-center gap-1 text-xs text-red-600 font-medium">
                  <AlertCircle size={12} />
                  {errors.name}
                </p>
              ) : (
                <p className="text-xs text-gray-400">
                  {t("teachersAdd.nameHint")}
                </p>
              )}
              <p className={`
                text-xs ml-2 shrink-0
                ${charCount > MAX_NAME_LENGTH
                  ? "text-red-600 font-bold"
                  : isNearLimit
                    ? "text-yellow-600 font-semibold"
                    : "text-gray-400"}
              `}>
                {charCount}/{MAX_NAME_LENGTH}
              </p>
            </div>
          </div>

          {/* Email field */}
          <div className="space-y-1.5">
            <label className="block text-sm font-semibold text-gray-700">
              {t("common.email")} <span className="text-red-500">*</span>
            </label>
            <div className={`
              flex items-center gap-3 border rounded-xl px-4 py-3 bg-gray-50
              transition-colors
              ${errors.email
                ? "border-red-400 bg-red-50"
                : "border-gray-200 focus-within:border-indigo-500 focus-within:bg-white"}
            `}>
              <Mail
                size={18}
                className={errors.email ? "text-red-400" : "text-gray-400"}
              />
              <input
                ref={emailRef}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errors.email) setErrors((p) => ({ ...p, email: undefined }));
                }}
                placeholder={t("teachersAdd.emailPh")}
                autoComplete="email"
                className="flex-1 bg-transparent text-gray-900 placeholder-gray-400
                           text-sm focus:outline-none"
              />
            </div>
            {errors.email ? (
              <p className="flex items-center gap-1 text-xs text-red-600 font-medium">
                <AlertCircle size={12} />
                {errors.email}
              </p>
            ) : (
              <p className="text-xs text-gray-400">
                {t("teachersAdd.emailHint")}
              </p>
            )}
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={isDisabled}
            className="w-full flex items-center justify-center gap-2
                       bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300
                       text-white font-bold py-3.5 rounded-xl transition-colors mt-2"
          >
            {saving ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent
                                rounded-full animate-spin" />
                {t("teachersAdd.creating")}
              </>
            ) : (
              <>
                <UserPlus size={18} />
                {t("teachersAdd.submit")}
              </>
            )}
          </button>

          {/* Discard */}
          <button
            type="button"
            onClick={() => navigate("/teachers")}
            disabled={saving}
            className="w-full text-sm text-gray-400 hover:text-gray-600
                       font-medium py-2 transition-colors disabled:opacity-40"
          >
            {t("teachersAdd.discardBack")}
          </button>
        </form>

        {/* What happens next */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-sm font-bold text-gray-700 mb-4">
            {t("teachersAdd.whatNext")}
          </h3>
          <div className="space-y-3">
            {NEXT_STEPS.map(({ icon: Icon, color, bg, labelKey }) => (
              <div key={labelKey} className="flex items-center gap-3">
                <div className={`
                  w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${bg}
                `}>
                  <Icon size={16} style={{ color }} />
                </div>
                <p className="text-sm text-gray-600">{t(labelKey)}</p>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// HEADER
// ─────────────────────────────────────────────────────────

function Header({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="bg-white border-b border-gray-200 px-6 py-4 flex
                    items-center gap-4 shrink-0">
      <button
        onClick={onBack}
        className="w-9 h-9 flex items-center justify-center rounded-xl
                   bg-gray-100 hover:bg-gray-200 transition-colors"
      >
        <ArrowLeft size={20} className="text-gray-700" />
      </button>
      <div>
        <h1 className="text-lg font-bold text-gray-900">{t("teachersAdd.title")}</h1>
        <p className="text-xs text-gray-500 mt-0.5">{t("teachersAdd.blurb")}</p>
      </div>
    </div>
  );
}