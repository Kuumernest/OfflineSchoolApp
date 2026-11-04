// web/src/components/offline/NeedsInternet.tsx
//
// The inline notice for an online-only screen on a desktop that is offline,
// and — given children — the switch that turns the whole form off.
//
//   <NeedsInternet />                     the notice alone; the page disables
//                                         its own action buttons with
//                                         useNeedsInternet().blocked
//   <NeedsInternet>{form}</NeedsInternet> the notice, and every input and button
//                                         inside the form disabled (a native
//                                         <fieldset disabled>), so nothing can
//                                         be typed into a form that cannot be
//                                         saved
//
// Renders its children untouched, and no notice, whenever the action can work:
// in a browser (OfflineBanner covers it there) and on a desktop that is online.
// Why these screens: hooks/useNeedsInternet.ts.

import type { ReactNode } from "react";
import { WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNeedsInternet } from "@/hooks/useNeedsInternet";
import { cn } from "@/utils/cn";

export default function NeedsInternet({ children, className }: { children?: ReactNode; className?: string }) {
  const { t } = useTranslation();
  const { blocked } = useNeedsInternet();

  const notice = blocked ? (
    <div
      role="status"
      className={cn(
        "mb-4 flex items-start gap-3 rounded-card border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning-text",
        className,
      )}
    >
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-semibold">{t("connection.needsInternetTitle")}</p>
        <p className="mt-0.5">{t("connection.needsInternetBody")}</p>
      </div>
    </div>
  ) : null;

  if (children === undefined) return notice;

  return (
    <>
      {notice}
      {/* min-w-0: a fieldset's default min-width is its content's, which would
          let a wide table push the page sideways. */}
      <fieldset disabled={blocked} className="m-0 min-w-0 border-0 p-0" aria-disabled={blocked || undefined}>
        {children}
      </fieldset>
    </>
  );
}
