// web/src/components/applications/ClassPicker.tsx

import React from "react";
import type { ClassOption } from "../../types/applications";

interface ClassPickerProps {
  classes:         ClassOption[];
  selectedClassId: string | null;
  onSelect:        (cls: ClassOption) => void;
  open:            boolean;
  onToggle:        () => void;
  disabled?:       boolean;
}

export const ClassPicker: React.FC<ClassPickerProps> = ({
  classes,
  selectedClassId,
  onSelect,
  open,
  onToggle,
  disabled = false,
}) => {
  const selected = classes.find(
    (c) => String(c.id) === String(selectedClassId)
  ) ?? null;

  return (
    <div className="relative">
      {/* ── Trigger ── */}
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className={[
          "w-full flex items-center justify-between px-4 py-3.5",
          "rounded-xl border-[1.5px] text-left transition-colors",
          "focus:outline-none focus:ring-2 focus:ring-indigo-500",
          selected
            ? "border-indigo-500 bg-indigo-50/30"
            : "border-gray-200 bg-gray-50",
          disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
        ].join(" ")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span
          className={[
            "text-[15px] font-semibold",
            selected ? "text-gray-900" : "text-gray-400",
          ].join(" ")}
        >
          {selected ? selected.name : "Select a class…"}
        </span>

        <svg
          className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1
               1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0
               010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* ── Dropdown ── */}
      {open && (
        <ul
          role="listbox"
          className="absolute z-20 w-full mt-1 bg-white border border-gray-200
                     rounded-xl shadow-lg overflow-hidden max-h-52 overflow-y-auto"
        >
          {classes.map((cls) => {
            const isSelected = String(selectedClassId) === String(cls.id);
            return (
              <li key={cls.id} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onClick={() => onSelect(cls)}
                  className={[
                    "w-full flex items-center gap-2 px-4 py-3 text-left",
                    "border-b border-gray-50 last:border-b-0 transition-colors",
                    isSelected
                      ? "bg-indigo-50 text-indigo-700"
                      : "hover:bg-gray-50 text-gray-700",
                  ].join(" ")}
                >
                  {/* School icon */}
                  <svg
                    className="w-4 h-4 flex-shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke={isSelected ? "#4F46E5" : "#6B7280"}
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5
                         2.5 0 010-5H20"
                    />
                  </svg>

                  <span
                    className={`flex-1 text-sm ${
                      isSelected ? "font-bold text-indigo-700" : "font-medium"
                    }`}
                  >
                    {cls.name}
                  </span>

                  {isSelected && (
                    <svg
                      className="w-[18px] h-[18px] text-indigo-600 flex-shrink-0"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48
                               10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10
                               14.17l7.59-7.59L19 8l-9 9z" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};