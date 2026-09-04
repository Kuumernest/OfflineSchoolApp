// web/src/components/ui/ProgressBar.tsx
//
// Determinate progress for work that runs long enough to watch.
//
// A spinner says "something is happening". It cannot say how much is left, so
// it cannot tell anyone whether to wait or go away — and on a slow WAN link
// that is the only question the person in front of the screen has. Where the
// count is known, this shows it: a percentage, the running tally, and the name
// of the item being worked on.
//
// The percentage is never invented. Without a total this renders the
// indeterminate bar, which claims nothing — a made-up number that sticks at
// 90% is worse than an honest sweep, because the second time somebody sees it
// they stop believing the first 90% too.

import { cn } from "@/utils/cn";

export interface ProgressBarProps {
  /** Items finished. Ignored when `total` is absent. */
  done?:    number;
  /** Items expected. Omit — or pass 0 — when it genuinely is not known yet. */
  total?:   number;
  /** What is being done: "Generating report cards". */
  label?:   string;
  /** Which item, right now: a student's name, a collection, a file. */
  detail?:  string;
  /** Suppress the "12 / 40" tally, keeping the percentage. */
  hideCount?: boolean;
  className?: string;
}

export function ProgressBar({
  done = 0,
  total = 0,
  label,
  detail,
  hideCount = false,
  className,
}: ProgressBarProps) {
  const determinate = total > 0;

  // Clamped, because a caller that reports done after an early `continue` can
  // overshoot, and a bar wider than its track escapes the rounded corners.
  const pct = determinate
    ? Math.min(100, Math.max(0, Math.round((done / total) * 100)))
    : 0;

  return (
    <div className={cn("w-full", className)}>
      {(label || determinate) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
          {label && <span className="truncate text-ink-muted">{label}</span>}

          {determinate && (
            // tabular-nums: without it the digits are proportional, so the
            // percentage jitters sideways on every tick and reads as
            // instability rather than progress.
            <span className="shrink-0 font-medium text-ink tabular-nums">
              {pct}%
              {!hideCount && (
                <span className="ml-1.5 font-normal text-ink-muted">
                  {done} / {total}
                </span>
              )}
            </span>
          )}
        </div>
      )}

      <div
        className="h-2 w-full overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-label={label}
        // A determinate bar reports where it is. An indeterminate one reports
        // only that it is busy: aria-valuenow is left off entirely, which is
        // how a screen reader is told the total is unknown.
        {...(determinate
          ? { "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 }
          : {})}
      >
        {determinate ? (
          <div
            className="h-full rounded-full bg-primary-600 transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="progress-indeterminate h-full w-1/3 rounded-full bg-primary-600" />
        )}
      </div>

      {detail && (
        <p className="mt-1.5 truncate text-xs text-ink-muted" title={detail}>
          {detail}
        </p>
      )}
    </div>
  );
}
