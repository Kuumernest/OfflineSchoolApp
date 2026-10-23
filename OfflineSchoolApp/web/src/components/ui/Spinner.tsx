// web/src/components/ui/Spinner.tsx
import { useEffect, useState } from "react";
import { useTranslation }      from "react-i18next";
import { RefreshCw }           from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "@/components/ui/Button";

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-line-strong border-t-primary-600",
        "w-6 h-6",
        className
      )}
    />
  );
}

// The hosted API sleeps when idle and takes a while to answer the first
// request after (Render's free tier: commonly 30–60 s). A bare spinner over
// that wait reads as a hang, so the page says what is happening at 5 s and
// offers a way out at 60 s.
const WAKING_AFTER_MS = 5_000;
const RETRY_AFTER_MS  = 60_000;

/**
 * Full-area loading state.
 *
 * `onRetry` re-runs whatever is being waited for; without one, Retry reloads
 * the page. Pressing it starts the clock again.
 */
export function PageSpinner({ onRetry }: { onRetry?: () => void }) {
  const { t } = useTranslation();
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [elapsed, setElapsed]     = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setElapsed(Date.now() - startedAt), 1_000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const retry = () => {
    if (onRetry) { onRetry(); setStartedAt(Date.now()); setElapsed(0); }
    else window.location.reload();
  };

  const waking  = elapsed >= WAKING_AFTER_MS;
  const offered = elapsed >= RETRY_AFTER_MS;

  return (
    <div role="status" aria-live="polite" className="flex h-64 flex-col items-center justify-center gap-3 text-center">
      <Spinner className="w-8 h-8" />
      {/* Always announced; shown on screen under reduced motion, where the
          ring only pulses and a word says more than a fading circle. */}
      <p className={cn("text-sm text-ink-muted", waking ? "sr-only" : "sr-only motion-reduce:not-sr-only")}>
        {t("common.loading")}
      </p>
      {waking ? <p className="text-sm text-ink-muted">{t("common.wakingServer")}</p> : null}
      {offered ? (
        <Button size="sm" variant="secondary" icon={<RefreshCw className="h-4 w-4" />} onClick={retry}>
          {t("common.retry")}
        </Button>
      ) : null}
    </div>
  );
}
