// web/src/components/ui/SearchInput.tsx
import { Search, X } from "lucide-react";
import { cn }        from "@/utils/cn";

interface SearchInputProps {
  value:        string;
  onChange:     (value: string) => void;
  placeholder?: string;
  className?:   string;
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
}: SearchInputProps) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="
          h-9 w-full rounded-control border border-line-strong bg-surface
          pl-9 pr-9 text-sm text-ink-body placeholder:text-ink-faint
          transition-colors hover:border-ink-faint
          focus:border-primary-500 focus:outline-none
        "
      />
      {value && (
        <button
          onClick={() => onChange("")}
          type="button"
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-control p-0.5 text-ink-faint transition-colors hover:text-ink-body"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}