// web/src/components/ui/Select.tsx
import { cn } from "@/utils/cn";

interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options:      { value: string; label: string }[];
  placeholder?: string;
}

export function Select({
  options,
  placeholder,
  className,
  ...props
}: SelectProps) {
  return (
    <select
      className={cn(
        "h-9 rounded-control border border-line-strong bg-surface",
        "pl-3 pr-8 text-sm text-ink-body",
        "cursor-pointer appearance-none transition-colors",
        "hover:border-ink-faint focus:border-primary-500 focus:outline-none",
        // appearance-none removes the native arrow; without a replacement the
        // control looked like a text input that ignored typing.
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"%23667085\" stroke-width=\"2.5\" stroke-linecap=\"round\"><path d=\"m6 9 6 6 6-6\"/></svg>')]",
        "bg-[right_0.625rem_center] bg-no-repeat",
        className
      )}
      {...props}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}