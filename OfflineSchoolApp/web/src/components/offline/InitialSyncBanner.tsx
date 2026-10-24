// web/src/components/offline/InitialSyncBanner.tsx
//
// "This computer has not received the school's data yet", said above the page.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// The desktop answers reads from its local mirror, whether or not the mirror
// has ever been filled (lib/offline/adapter.ts says why). So until the first
// full pull has finished, every list is empty — and if that pull failed, it
// stays empty, with nothing on screen to say so. A school that sees empty
// screens over data it can see on the web concludes the software lost it.
//
// This says what is actually happening — still downloading, or the download
// failed and why — and offers to try again. It disappears for good once a full
// pull has finished for this server and school (engine.js initialSync()).
//
// ── It renders nothing in a browser ───────────────────────────────────────
//
// A browser reads from the server directly; there is no mirror to wait for.

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { desktop, type SyncStatus } from "@/lib/offline/bridge";

export default function InitialSyncBanner() {
  const { t } = useTranslation();
  const bridge = desktop();

  const [status,  setStatus]  = useState<SyncStatus | null>(null);
  const [logFile, setLogFile] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    // In one continuation, as in SyncIndicator, so no setState runs
    // synchronously in the effect body.
    void (async () => {
      try {
        const [next, info] = await Promise.all([bridge.sync.status(), bridge.info()]);
        if (cancelled) return;
        setStatus(next);
        setLogFile(info.logFile ?? null);
      } catch {
        // A banner that cannot read the state stays quiet rather than break
        // the page under it.
      }
    })();

    const unsubscribe = bridge.sync.onStatus((next) => setStatus(next));
    return () => { cancelled = true; unsubscribe(); };
  }, [bridge]);

  if (!bridge || !status || status.initialSync !== "pending") return null;

  const failed =
    status.phase === "offline" || status.phase === "error" || status.phase === "unauthenticated";

  const retry = async () => {
    setRetrying(true);
    try {
      setStatus(await bridge.sync.now());
    } catch {
      // The status push reports the outcome; nothing to add here.
    } finally {
      setRetrying(false);
    }
  };

  if (!failed) {
    return (
      <div role="status" className="flex items-start gap-3 border-b border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
        <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
        <div>
          <p className="font-semibold">{t("initialSync.loadingTitle")}</p>
          <p className="mt-0.5 text-sky-800">{t("initialSync.loadingBody")}</p>
        </div>
      </div>
    );
  }

  return (
    <div role="alert" className="flex flex-wrap items-start gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{t("initialSync.failedTitle")}</p>
        <p className="mt-0.5">
          {status.phase === "offline"         ? t("initialSync.failedOffline") :
           status.phase === "unauthenticated" ? t("initialSync.failedSession") :
           t("initialSync.failedError")}
        </p>
        {status.lastError && (
          <p className="mt-1 break-words font-mono text-xs text-amber-800">{status.lastError}</p>
        )}
        {logFile && (
          <p className="mt-1 break-all text-xs text-amber-800">{t("initialSync.logFile", { path: logFile })}</p>
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        loading={retrying}
        onClick={() => void retry()}
        icon={<RefreshCw className="h-3.5 w-3.5" />}
      >
        {t("initialSync.retry")}
      </Button>
    </div>
  );
}
