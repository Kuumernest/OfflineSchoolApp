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
        "px-3 py-2 text-sm bg-white border border-gray-300 rounded-lg",
        "focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent",
        "transition-colors appearance-none cursor-pointer",
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