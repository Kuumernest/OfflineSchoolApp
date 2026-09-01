// web/src/pages/auth/ChangePasswordPage.tsx
//
// The wall a first-login user hits. LoginPage has always redirected here when
// `mustResetPassword` is set, but the route did not exist — so those accounts
// landed on a blank screen and could not get into the app at all.
//
// It deliberately sits OUTSIDE DashboardLayout: someone who has not chosen a
// password yet should not be able to read the nav, let alone click through it.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound, Check, X, LogOut } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { changePassword } from "@/services/auth.service";
import { useAuthStore } from "@/store/auth.store";
import { getErrorMessage } from "@/lib/axios";
import { cn } from "@/utils/cn";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────
// POLICY
//
// These four mirror exactly what POST /auth/change-password enforces (length,
// upper, lower, digit). Nothing more is added: a client-side rule the server
// does not have — a required symbol, say — would reject a password the server
// would happily accept, and the user has no way to tell which side said no.
//
// The symbol suggestion below is shown as advice and deliberately does NOT
// gate submission.
// ─────────────────────────────────────────────────────────────────────────────

interface Rule {
  // Module scope cannot call a hook, so the rule carries its key and the
  // component resolves it at render.
  labelKey: string;
  test:     (v: string) => boolean;
}

const RULES: Rule[] = [
  { labelKey: "changePassword.rule8",     test: (v) => v.length >= 8 },
  { labelKey: "changePassword.ruleUpper", test: (v) => /[A-Z]/.test(v) },
  { labelKey: "changePassword.ruleLower", test: (v) => /[a-z]/.test(v) },
  { labelKey: "changePassword.ruleDigit", test: (v) => /\d/.test(v) },
];

// ─────────────────────────────────────────────────────────────────────────────

export default function ChangePasswordPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();

  const user   = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword,     setNewPassword]     = useState("");
  const [confirm,         setConfirm]         = useState("");
  const [reveal,          setReveal]          = useState(false);

  const checks  = useMemo(() => RULES.map((r) => ({ ...r, met: r.test(newPassword) })), [newPassword]);
  const allMet  = checks.every((c) => c.met);
  const matches = newPassword.length > 0 && newPassword === confirm;

  // The server only demands currentPassword when the account is NOT flagged
  // for a reset. Requiring it unconditionally would lock out the very users
  // this screen exists for — they were signed in with a temporary password
  // they may never have typed themselves.
  const mustReset       = Boolean(user?.mustResetPassword);
  const needsCurrent    = !mustReset;
  const hasCurrent      = currentPassword.length > 0;

  // Only meaningful once we actually have something to compare against.
  const reused = hasCurrent && newPassword.length > 0 && newPassword === currentPassword;

  const canSubmit =
    allMet && matches && !reused && (!needsCurrent || hasCurrent);

  const mutation = useMutation({
    mutationFn: () =>
      changePassword({
        currentPassword,
        newPassword,
        // Required by both the payload type and the server, which rejects a
        // mismatch itself rather than trusting the client's check.
        confirmPassword: confirm,
      }),
    onSuccess: () => {
      toast({ title: t("changePassword.success"), kind: "success" });
      // changePassword() writes the fresh token and user into the store, so
      // mustResetPassword is already false by the time we navigate.
      navigate("/dashboard", { replace: true });
    },
    onError: (err) =>
      toast({
        title:   t("changePassword.failed"),
        message: getErrorMessage(err),
        kind:    "error",
      }),
  });

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-md">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary-600 flex items-center justify-center mx-auto">
            <KeyRound className="w-6 h-6 text-white" />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-gray-900">
            {t("changePassword.choose")}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {user?.name
              ? `${t("changePassword.welcomeName", { name: user.name })} `
              : ""}
            {t("changePassword.tempIntro")}
          </p>
        </div>

        {/* ── Form ────────────────────────────────────────────────────── */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4"
        >
          <Field
            label={
              mustReset
                ? t("changePassword.tempOptional")
                : t("changePassword.current")
            }
            value={currentPassword}
            onChange={setCurrentPassword}
            reveal={reveal}
            autoComplete="current-password"
          />

          <div>
            <Field
              label={t("changePassword.new")}
              value={newPassword}
              onChange={setNewPassword}
              reveal={reveal}
              autoComplete="new-password"
              trailing={
                <button
                  type="button"
                  onClick={() => setReveal((r) => !r)}
                  className="text-gray-400 hover:text-gray-600"
                  aria-label={reveal ? t("login.hidePassword") : t("login.showPassword")}
                >
                  {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              }
            />

            {/* Requirement checklist — live, so there is no guessing. */}
            <ul className="mt-3 space-y-1">
              {checks.map((c) => (
                <li
                  key={c.labelKey}
                  className={cn(
                    "flex items-center gap-2 text-xs",
                    c.met ? "text-emerald-600" : "text-gray-400",
                  )}
                >
                  {c.met
                    ? <Check className="w-3.5 h-3.5 shrink-0" />
                    : <X className="w-3.5 h-3.5 shrink-0" />}
                  {t(c.labelKey)}
                </li>
              ))}
            </ul>

            {/* Advice, not a requirement — the server does not demand a symbol. */}
            {allMet && !/[^A-Za-z0-9]/.test(newPassword) && (
              <p className="mt-2 text-xs text-gray-500">
                {t("changePassword.symbolTip")}
              </p>
            )}

            {reused && (
              <p className="mt-2 text-xs text-red-600">
                {t("changePassword.hint")}
              </p>
            )}
          </div>

          <div>
            <Field
              label={t("changePassword.confirm")}
              value={confirm}
              onChange={setConfirm}
              reveal={reveal}
              autoComplete="new-password"
            />
            {confirm.length > 0 && !matches && (
              <p className="mt-2 text-xs text-red-600">
                {t("changePassword.noMatchYet")}
              </p>
            )}
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={!canSubmit}
            loading={mutation.isPending}
          >
            {t("changePassword.saveContinue")}
          </Button>
        </form>

        {/* Escape hatch: a user on the wrong account is otherwise stuck here,
            because every other route redirects back to this one. */}
        <button
          onClick={() => { logout(); navigate("/login", { replace: true }); }}
          className="mt-4 w-full inline-flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
        >
          <LogOut className="w-3.5 h-3.5" />
          {t("changePassword.signInOther")}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Field({
  label,
  value,
  onChange,
  reveal,
  autoComplete,
  trailing,
}: {
  label:        string;
  value:        string;
  onChange:     (v: string) => void;
  reveal:       boolean;
  autoComplete: string;
  trailing?:    React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1.5">
        {label}
      </span>
      <div className="relative">
        <input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          className={cn(
            "w-full px-3 py-2 pr-10 text-sm bg-white border border-gray-300 rounded-lg",
            "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
          )}
        />
        {trailing && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2">
            {trailing}
          </span>
        )}
      </div>
    </label>
  );
}
