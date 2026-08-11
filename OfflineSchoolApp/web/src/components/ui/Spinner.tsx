// web/src/components/ui/Spinner.tsx
import { cn } from "@/utils/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "inline-block border-2 border-gray-200 border-t-primary-600 rounded-full animate-spin",
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