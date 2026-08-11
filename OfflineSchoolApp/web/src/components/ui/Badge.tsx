// web/src/components/ui/Badge.tsx
import { cn } from "@/utils/cn";

type BadgeVariant =
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "purple";

const variants: Record<BadgeVariant, string> = {
  default: "bg-gray-100  text-gray-700",
  success: "bg-green-100 text-green-700",
  warning: "bg-yellow-100 text-yellow-700",
  danger:  "bg-red-100   text-red-700",
  info:    "bg-blue-100  text-blue-700",
  purple:  "bg-purple-100 text-purple-700",
};

interface BadgeProps {
  label:     string;
  variant?:  BadgeVariant;
  className?: string;
}

export function Badge({
  label,
  variant = "default",
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium",
        variants[variant],
        className
      )}
    >
      {label}
    </span>
  );
}