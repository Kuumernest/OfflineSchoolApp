// web/src/pages/teachers/AddTeacherPage.tsx
import { useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/auth.store";
import api from "@/services/api";
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

const NEXT_STEPS = [
  {
    icon:  Key,
    color: "#4F46E5",
    bg:    "bg-indigo-50",
    text:  "A secure temporary password is generated automatically",
  },
  {
    icon:  Mail,
    color: "#0891B2",
    bg:    "bg-cyan-50",
    text:  "Login credentials are emailed to the teacher immediately",
  },
  {
    icon:  Lock,
    color: "#059669",
    bg:    "bg-emerald-50",
    text:  "Teacher sets a personal password on their first login",
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
      next.name = "Teacher name is required.";
    } else if (trimmedName.length < 2) {
      next.name = "Name must be at least 2 characters.";
    } else if (trimmedName.length > MAX_NAME_LENGTH) {
      next.name = `Name cannot exceed ${MAX_NAME_LENGTH} characters.`;
    }

    if (!trimmedEmail) {
      next.email = "Email address is required.";
    } else if (!EMAIL_REGEX.test(trimmedEmail)) {
      next.email = "Please enter a valid email address.";
    }

    setErrors(next);

    if (next.name)  { nameRef.current?.focus();  return false; }
    if (next.email) { emailRef.current?.focus(); return false; }
    return true;
  }, [trimmedName, trimmedEmail]);

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
      } catch (err: any) {
        const status    = err?.response?.status;
        const serverMsg = err?.response?.data?.message;

        if (status === 409) {
          setErrors({
            email:
              "This email address is already registered. " +
              "Check if the teacher already has an account or use a different email.",
          });
          emailRef.current?.focus();
        } else {
          setErrors({
            name: serverMsg || err.message || "Failed to create teacher. Please try again.",
          });
        }
      } finally {
        setSaving(false);
      }
    },
    [validate, trimmedName, trimmedEmail, user?.schoolId]
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
              {success.emailSent ? "Teacher Added!" : "Teacher Created"}
            </h2>

            <p className="text-sm text-gray-500 mb-6">
              {success.emailSent
                ? success.message ||
                  `"${success.teacherName}" has been added. A welcome email with
                   login instructions has been sent to ${success.teacherEmail}.`
                : `Teacher created, but the welcome email failed to deliver.
                   Share the credentials below with the teacher manually.`
              }
            </p>

            {/* Manual credentials — shown when email failed */}
            {!success.emailSent && success.tempPassword && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl
                              p-4 mb-6 text-left space-y-3">
                <p className="text-xs font-bold text-yellow-800 uppercase tracking-wide">
                  Share these credentials manually
                </p>
                <div>
                  <p className="text-xs text-yellow-700 font-medium">📧 Email</p>
                  <p className="text-sm font-mono text-gray-900 mt-0.5">
                    {success.teacherEmail}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-yellow-700 font-medium">🔑 Temp Password</p>
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
                        ? <><Check size={13} /> Copied</>
                        : <><Copy size={13} /> Copy</>
                      }
                    </button>
                  </div>
                </div>
                <p className="text-xs text-yellow-700">
                  The teacher must change this password on first login.
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
                Add Another Teacher
              </button>
              <button
                onClick={() => navigate("/teachers")}
                className="w-full bg-gray-100 hover:bg-gray-200 text-gray-700
                           font-semibold py-3 rounded-xl transition-colors"
              >
                Back to Teachers
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
          <p>
            A temporary password will be generated and emailed to the teacher
            automatically. They will be asked to set a personal password on
            their first login.
          </p>
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
              Teacher Name <span className="text-red-500">*</span>
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
                placeholder="e.g. Mr John Doe"
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
                  Full name as it will appear across the system.
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
              Email Address <span className="text-red-500">*</span>
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
                placeholder="teacher@school.com"
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
                Must be unique. Used for login and receiving credentials.
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
                Creating…
              </>
            ) : (
              <>
                <UserPlus size={18} />
                Create Teacher
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
            Discard &amp; Go Back
          </button>
        </form>

        {/* What happens next */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <h3 className="text-sm font-bold text-gray-700 mb-4">
            What happens next?
          </h3>
          <div className="space-y-3">
            {NEXT_STEPS.map(({ icon: Icon, color, bg, text }) => (
              <div key={text} className="flex items-center gap-3">
                <div className={`
                  w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${bg}
                `}>
                  <Icon size={16} style={{ color }} />
                </div>
                <p className="text-sm text-gray-600">{text}</p>
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
        <h1 className="text-lg font-bold text-gray-900">Add Teacher</h1>
        <p className="text-xs text-gray-500 mt-0.5">Create a new teacher profile</p>
      </div>
    </div>
  );
}