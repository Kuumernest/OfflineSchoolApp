// web/src/components/ui/FormField.tsx
//
// The label + control + error triple, plus the two controls that go inside it.
// ClassesPage imports all three; the file did not exist.
//
// Input and SelectField forward their ref. That is not optional here: they are
// used with react-hook-form's `register()`, which passes a ref to read the
// value and to focus the field on a validation failure. Without forwardRef the
// ref lands on nothing, and the form silently reads undefined for every field.

import { forwardRef, useId } from "react";
import { cn } from "@/utils/cn";

// ─────────────────────────────────────────────────────────────────────────────
// FIELD WRAPPER
// ─────────────────────────────────────────────────────────────────────────────

interface FormFieldProps {
  label:     string;
  children:  React.ReactNode;
  error?:    string;
  hint?:     string;
  required?: boolean;
  className?: string;
}

export function FormField({
  label,
  children,
  error,
  hint,
  required = false,
  className,
}: FormFieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label className="block text-[13px] font-medium text-ink-body">
        {label}
        {required && (
          <span className="ml-0.5 text-danger" aria-hidden="true">*</span>
        )}
      </label>

      {children}

      {/* An error replaces the hint rather than stacking under it — two lines
          of guidance under one input reads as noise. */}
      {error ? (
        <p className="text-xs text-danger" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-xs text-ink-muted">{hint}</p>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS
// ─────────────────────────────────────────────────────────────────────────────

// One height (36px) shared with Button, Select and SearchInput, so a filter
// bar of mixed controls lines up without per-page nudging. The focus state is
// a border change plus the global :focus-visible outline — the old ring-2 sat
// outside the control and shifted neighbouring fields on focus.
const CONTROL_BASE = cn(
  "w-full rounded-control border border-line-strong bg-surface px-3 text-sm",
  "text-ink placeholder:text-ink-faint",
  "transition-colors hover:border-ink-faint",
  "focus:border-primary-500 focus:outline-none",
  "disabled:cursor-not-allowed disabled:bg-canvas disabled:text-ink-faint",
);

/** Inputs and selects are fixed-height; a textarea grows, so it gets padding. */
const CONTROL_H = "h-9";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, invalid, ...props }, ref) {
    return (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          CONTROL_BASE,
          CONTROL_H,
          invalid && "border-danger focus:border-danger",
          className,
        )}
        {...props}
      />
    );
  },
);

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, invalid, rows = 4, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        aria-invalid={invalid || undefined}
        className={cn(
          CONTROL_BASE,
          "resize-y py-2 leading-relaxed",
          invalid && "border-danger focus:border-danger",
          className,
        )}
        {...props}
      />
    );
  },
);

export interface SelectOption {
  value:     string;
  label:     string;
  disabled?: boolean;
}

export type SelectFieldProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  options:      SelectOption[];
  placeholder?: string;
  invalid?:     boolean;
};

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(
  function SelectField(
    { options, placeholder, className, invalid, ...props },
    ref,
  ) {
    return (
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          CONTROL_BASE,
          CONTROL_H,
          "cursor-pointer",
          invalid && "border-danger focus:border-danger",
          className,
        )}
        {...props}
      >
        {/* value="" so an unselected optional field submits empty rather than
            the first real option — otherwise "no teacher" is impossible to
            express. */}
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// CHECKBOX
// ─────────────────────────────────────────────────────────────────────────────

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: string;
  hint?: string;
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox({ label, hint, className, id, ...props }, ref) {
    const autoId = useId();
    const inputId = id ?? autoId;

    return (
      <div className={cn("flex items-start gap-2.5", className)}>
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className="mt-0.5 w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 cursor-pointer"
          {...props}
        />
        <label htmlFor={inputId} className="cursor-pointer select-none">
          <span className="block text-sm text-gray-700">{label}</span>
          {hint && <span className="block text-xs text-gray-500">{hint}</span>}
        </label>
      </div>
    );
  },
);

export default FormField;
