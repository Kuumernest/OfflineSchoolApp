// web/src/components/ui/Button.tsx
import { cn }      from "@/utils/cn";
import { Loader2 } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize    = "sm" | "md" | "lg";

/**
 * Exactly one filled accent button belongs on a screen — the thing you came to
 * do. Everything else is `secondary` (bordered) or `ghost` (bare). When two
 * buttons are both filled, neither reads as the primary action.
 */
const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-primary-600 text-white hover:bg-primary-700 active:bg-primary-800 shadow-card",
  secondary:
    "bg-surface text-ink-body border border-line-strong hover:bg-surface-muted active:bg-canvas",
  danger:
    "bg-danger text-white hover:brightness-95 active:brightness-90 shadow-card",
  ghost:
    "text-ink-muted hover:bg-canvas hover:text-ink-body active:bg-line/60",
};

/* Fixed heights, not vertical padding. A row of controls only lines up if
   every control resolves to the same height regardless of whether it holds an
   icon, a label, or both. */
const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-8  px-2.5 text-xs  gap-1.5",
  md: "h-9  px-3.5 text-sm  gap-2",
  lg: "h-11 px-5   text-sm  gap-2",
};

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?:    ButtonSize;
  loading?: boolean;
  icon?:    React.ReactNode;
  children: React.ReactNode;
}

export function Button({
  variant  = "primary",
  size     = "md",
  loading  = false,
  icon,
  children,
  className,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap",
        "font-medium rounded-control transition-colors",
        "disabled:opacity-45 disabled:cursor-not-allowed disabled:shadow-none",
        // Icons inherit the button's text size rather than each call site
        // picking its own w-4 / w-5 and knocking the row out of alignment.
        "[&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0",
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
      {...props}
    >
      {loading
        ? <Loader2 className="animate-spin" aria-hidden="true" />
        : icon}
      {children}
    </button>
  );
}
