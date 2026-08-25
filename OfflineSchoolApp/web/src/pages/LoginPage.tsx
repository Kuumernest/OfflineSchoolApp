// web/src/pages/LoginPage.tsx
import { useEffect, useState }    from "react";
import { useNavigate }            from "react-router-dom";
import { useForm }                from "react-hook-form";
import { zodResolver }            from "@hookform/resolvers/zod";
import { z }                      from "zod";
import { Eye, EyeOff, GraduationCap, Loader2 } from "lucide-react";

import { useAuthStore, useMustResetPassword } from "@/store/auth.store";
import { useTranslation } from "react-i18next";

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  identifier: z.string().min(1, "Email or enrollment number is required").transform((v) => v.trim()),
  password:   z.string().min(1, "Password is required"),
});

type LoginForm = z.infer<typeof loginSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate        = useNavigate();
  const login           = useAuthStore((s) => s.login);
  const isLoading       = useAuthStore((s) => s.isLoading);
  const error           = useAuthStore((s) => s.error);
  const clearError      = useAuthStore((s) => s.clearError);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const mustReset       = useMustResetPassword();

  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (mustReset) {
      navigate("/change-password", { replace: true });
    } else {
      navigate("/dashboard", { replace: true });
    }
  }, [isAuthenticated, mustReset, navigate]);

  useEffect(() => {
    clearError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

  const identifier     = watch("identifier", "");
  const looksLikeEmail = identifier.includes("@");

  const onSubmit = async (data: LoginForm) => {
    try {
      const isEmail = data.identifier.includes("@");
      if (isEmail) {
        await login({ email: data.identifier.toLowerCase(), password: data.password });
      } else {
        await login({ enrollmentNo: data.identifier.toUpperCase(), password: data.password });
      }
    } catch {
      // Error shown via store
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-900 via-primary-800 to-primary-700 flex items-center justify-center p-4">
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/10 backdrop-blur rounded-2xl mb-4">
            <GraduationCap className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold text-white">{t("login.appName")}</h1>
          <p className="text-primary-200 mt-1">{t("login.signInToAccount")}</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">

          {/* Error banner */}
          {error && (
            <div role="alert" className="mb-5 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <span className="text-red-600 text-sm flex-1">{error}</span>
              <button type="button" onClick={clearError} aria-label={t("login.dismissError")} className="text-red-400 hover:text-red-600 text-xs shrink-0">✕</button>
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-5">

            {/* Identifier */}
            <div>
              <label htmlFor="identifier" className="block text-sm font-medium text-gray-700 mb-1">
                {t("login.identifier")}
              </label>
              <input
                id="identifier"
                type="text"
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={t("login.identifierPh")}
                aria-invalid={!!errors.identifier}
                aria-describedby={errors.identifier ? "identifier-error" : "identifier-hint"}
                className={`w-full px-4 py-3 rounded-lg border text-sm outline-none transition focus:ring-2 focus:ring-primary-500 ${errors.identifier ? "border-red-300 bg-red-50" : "border-gray-300"}`}
                {...register("identifier")}
              />
              {!errors.identifier && (
                <p id="identifier-hint" className="mt-1 text-xs text-gray-400">
                  {identifier.length === 0
                    ? t("login.identifierHint")
                    : looksLikeEmail
                      ? `✓ ${t("login.asStaff")}`
                      : `✓ ${t("login.asStudent")}`}
                </p>
              )}
              {errors.identifier && (
                <p id="identifier-error" className="mt-1 text-xs text-red-500">
                  {errors.identifier.message}
                </p>
              )}
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  aria-invalid={!!errors.password}
                  className={`w-full px-4 py-3 pr-11 rounded-lg border text-sm outline-none transition focus:ring-2 focus:ring-primary-500 ${errors.password ? "border-red-300 bg-red-50" : "border-gray-300"}`}
                  {...register("password")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {errors.password && (
                <p className="mt-1 text-xs text-red-500">{errors.password.message}</p>
              )}
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 bg-primary-600 hover:bg-primary-700 disabled:bg-primary-400 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition flex items-center justify-center gap-2"
            >
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              {isLoading ? "Signing in…" : "Sign In"}
            </button>

          </form>

          {/* Forgot password */}
          <p className="text-center text-gray-400 text-xs mt-5">
            {looksLikeEmail
              ? "Forgotten your password? Contact your system administrator."
              : "Forgotten your password? Ask your class teacher or school admin to reset it."}
          </p>
        </div>

        <p className="text-center text-primary-300 text-sm mt-6">
          {t("login.copyright", { year: new Date().getFullYear() })}
        </p>
      </div>
    </div>
  );
}