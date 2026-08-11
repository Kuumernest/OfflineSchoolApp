// web/src/components/dashboard/StatCard.tsx
import { useNavigate }     from "react-router-dom";
import { type LucideIcon } from "lucide-react";
import { cn }              from "@/utils/cn";

interface StatCardProps {
  title:          string;
  value:          string | number;
  subtitle?:      string;
  subtitleColor?: string;
  icon:           LucideIcon;
  iconColor?:     string;
  iconBg?:        string;
  href?:          string;
  loading?:       boolean;
}

export default function StatCard({
  title,
  value,
  subtitle,
  subtitleColor,
  icon: Icon,
  iconColor = "text-indigo-600",
  iconBg    = "bg-indigo-50 dark:bg-indigo-900/20",
  href,
  loading   = false,
}: StatCardProps) {
  const navigate = useNavigate();

  const handleClick = () => { if (href) navigate(href); };

  return (
    <div
      role={href ? "button" : undefined}
      tabIndex={href ? 0 : undefined}
      onClick={href ? handleClick : undefined}
      onKeyDown={href
        ? (e) => { if (e.key === "Enter" || e.key === " ") handleClick(); }
        : undefined
      }
      className={cn(
        "rounded-xl border border-gray-200 dark:border-gray-700",
        "bg-white dark:bg-gray-800",
        "p-4 shadow-sm",
        "flex flex-col gap-3",
        href && "cursor-pointer hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-700 transition-all"
      )}
    >
      {/* Icon */}
      <div className={cn("flex h-9 w-9 items-center justify-center rounded-lg", iconBg)}>
        <Icon className={cn("h-5 w-5", iconColor)} aria-hidden="true" />
      </div>

      {/* Value */}
      {loading ? (
        <div className="h-7 w-16 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
      ) : (
        <p className="text-2xl font-bold text-gray-900 dark:text-white leading-none">
          {value}
        </p>
      )}

      {/* Title + subtitle */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {title}
        </p>
        {subtitle && (
          <p className={cn(
            "mt-0.5 text-xs",
            subtitleColor ? subtitleColor : "text-gray-400 dark:text-gray-500"
          )}>
            {subtitle}
          </p>
        )}
      </div>
    </div>
  );
}