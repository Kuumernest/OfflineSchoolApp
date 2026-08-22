// web/src/components/ui/Spinner.tsx
import { cn } from "@/utils/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-line-strong border-t-primary-600",
        "w-6 h-6",
        className
      )}
    />
  );
}

export function PageSpinner() {
  return (
    <div className="flex items-center justify-center h-64">
      <Spinner className="w-8 h-8" />
    </div>
  );
}