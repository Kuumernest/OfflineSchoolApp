// web/src/utils/formatDate.ts

/**
 * Formats a date value for display.
 * Returns "Unknown date" for null / invalid inputs.
 */
export const formatDate = (value: string | Date | null | undefined): string => {
  if (!value) return "Unknown date";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "Unknown date"
    : d.toLocaleDateString(undefined, {
        year:  "numeric",
        month: "short",
        day:   "numeric",
      });
};