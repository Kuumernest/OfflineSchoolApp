// web/src/components/ui/Badge.tsx
import { cn } from "@/utils/cn";

type BadgeVariant =
  | "default"
  | "primary"
  | "secondary"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "purple";

/**
 * Status pills, tinted from the status tokens.
 *
 * Every variant is a soft fill plus a hairline and dark text, so they sit at
 * one visual weight — a row of badges reads as a row, and the eye is drawn by
 * *which* colour appears rather than by one variant shouting louder.
 */
const variants: Record<BadgeVariant, string> = {
  default:   "bg-canvas          text-ink-muted    ring-line",
  // primary/secondary are the selected / unselected pair used by tab counters.
  primary:   "bg-primary-600     text-white        ring-primary-600",
  secondary: "bg-canvas          text-ink-faint    ring-line",
  success:   "bg-success-soft    text-success      ring-success-line",
  warning:   "bg-warning-soft    text-warning      ring-warning-line",
  danger:    "bg-danger-soft     text-danger       ring-danger-line",
  info:      "bg-info-soft       text-info         ring-info-line",
  // Retained for callers that pass it; drawn from the info scale so it no
  // longer introduces a hue the rest of the system does not use.
  purple:    "bg-info-soft       text-info         ring-info-line",
};

interface BadgeProps {
  /** Either pass `label`, or pass the text as children — both are supported. */
  label?:     string;
  children?:  React.ReactNode;
  variant?:   BadgeVariant;
  className?: string;
}

export function Badge({
  label,
  children,
  variant = "default",
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-0.5",
        // semibold, not medium: a badge is read at a glance from across
        // a table, which is the one place weight earns its keep.
        "rounded-control text-xs font-semibold leading-5",
        // An inset ring instead of a border: it costs no layout height, so a
        // badge never nudges the table row it sits in.
        "ring-1 ring-inset",
        variants[variant],
        className
      )}
    >
      {label ?? children}
    </span>
  );
}
