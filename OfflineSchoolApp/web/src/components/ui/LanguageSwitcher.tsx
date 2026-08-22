// web/src/components/ui/LanguageSwitcher.tsx
import { useTranslation } from "react-i18next";
import { Check, Languages } from "lucide-react";

import { SUPPORTED_LANGUAGES } from "@/i18n";
import { cn }                  from "@/utils/cn";

/**
 * Language choice, as a segmented pair rather than a dropdown.
 *
 * With exactly two languages a select costs a click to discover what the
 * options even are. Both are visible here, and the active one is obvious —
 * which matters when the interface a user is looking at is in the language
 * they cannot read.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const active = i18n.resolvedLanguage;

  return (
    <div className={cn("px-3 py-2", className)}>
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-faint">
        <Languages className="h-3 w-3" aria-hidden="true" />
        {t("common.language")}
      </p>

      <div
        role="group"
        aria-label={t("common.language")}
        className="flex gap-1"
      >
        {SUPPORTED_LANGUAGES.map((lang) => {
          const isActive = active === lang.code;
          return (
            <button
              key={lang.code}
              type="button"
              lang={lang.code}
              aria-pressed={isActive}
              onClick={() => { void i18n.changeLanguage(lang.code); }}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-control",
                "px-2 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "bg-primary-600 text-white"
                  : "border border-line-strong bg-surface text-ink-body hover:bg-canvas"
              )}
            >
              {isActive && <Check className="h-3 w-3" aria-hidden="true" />}
              {lang.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
