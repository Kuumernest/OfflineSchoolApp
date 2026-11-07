// web/src/components/offline/OfflineBanner.tsx
//
// "You're offline", said across the top of the browser console.
//
// ── Why the browser needs this and the desktop does not ───────────────────
//
// The web console is online-only by decision: no service worker, no local
// copy, nowhere to keep a change until the connection returns. Without this a
// secretary offline saw spinners, then an error toast per action, and could
// fill in a whole form before learning that nothing could be saved. So it says
// so once, persistently, before anybody starts typing.
//
// The desktop keeps working offline and says so in its own words
// (SyncIndicator, NeedsInternetNotice); this renders nothing there.
//
// What counts as offline — the device's own events AND requests that got no
// response, so a link that is up with no internet behind it still shows this —
// is lib/offline/connectivity.ts.

import { WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isDesktop } from "@/lib/offline/bridge";
import { useConnectivity } from "@/lib/offline/connectivityWatch";
import { cn } from "@/utils/cn";

export default function OfflineBanner({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { offline, reason } = useConnectivity();

  if (!offline || isDesktop()) return null;

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 border-b border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning-text",
        className,
      )}
    >
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>
        <span className="font-semibold">
          {reason === "request" ? t("connection.unreachableTitle") : t("connection.offlineTitle")}
        </span>{" "}
        {t("connection.browserBody")}
      </p>
    </div>
  );
}
