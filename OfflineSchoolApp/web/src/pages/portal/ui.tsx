// web/src/pages/portal/ui.tsx
//
// The parent portal's small parts. Built on the app's tokens (rounded-card,
// shadow-card, the primary scale, ink levels) so the portal reads as the same
// product, just laid out for a phone first.

import { useTranslation } from "react-i18next";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { cn } from "@/utils/cn";

/** A grey block standing in for content while it loads: never a blank page. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-control bg-line", className)} />;
}

/** The portal's card: the app's card, with a little more air on a phone. */
export function PortalCard({ className, children, as: Tag = "section", ...rest }:
  { className?: string; children: React.ReactNode; as?: "section" | "div" | "article" } & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={cn("rounded-card border border-line bg-surface shadow-card", className)} {...rest}>
      {children}
    </Tag>
  );
}

/** Nothing to show yet, said kindly, with an icon rather than an empty box. */
export function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary-50 text-primary-600" aria-hidden="true">
        {icon}
      </div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 max-w-xs text-sm text-ink-muted">{hint}</p>}
    </div>
  );
}

const AVATAR_TONES = [
  "bg-primary-100 text-primary-800",
  "bg-success-soft text-success",
  "bg-warning-soft text-warning",
];

/** Initials in a circle; the same child keeps the same colour everywhere. */
export function ChildAvatar({ name, index = 0, size = "md" }: { name: string | null; index?: number; size?: "sm" | "md" | "lg" }) {
  const initials = (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
  return (
    <span aria-hidden="true" className={cn(
      "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
      AVATAR_TONES[index % AVATAR_TONES.length],
      size === "sm" && "h-8 w-8 text-xs", size === "md" && "h-10 w-10 text-sm", size === "lg" && "h-12 w-12 text-base",
    )}>
      {initials || "?"}
    </span>
  );
}

/** EN | FR in the header: two 44px targets, the current one filled. */
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const active = i18n.resolvedLanguage;
  return (
    <div role="group" aria-label={t("common.language")} className="flex rounded-control border border-line-strong bg-surface p-0.5">
      {SUPPORTED_LANGUAGES.map((lang) => (
        <button
          key={lang.code}
          type="button"
          lang={lang.code}
          aria-pressed={active === lang.code}
          aria-label={lang.label}
          onClick={() => { void i18n.changeLanguage(lang.code); }}
          className={cn(
            "min-h-10 min-w-10 rounded-[0.375rem] px-2 text-xs font-semibold uppercase tracking-wide transition-colors",
            active === lang.code ? "bg-primary-600 text-white" : "text-ink-muted hover:text-ink",
          )}
        >
          {lang.code}
        </button>
      ))}
    </div>
  );
}
