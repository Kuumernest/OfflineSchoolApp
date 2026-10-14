// web/src/utils/formatDate.ts

import i18n from "@/i18n";

/**
 * Formats a date value for display.
 * Returns the translated "Unknown date" for null / invalid inputs. This is a
 * plain function, not a component, so it reads the i18n instance directly
 * rather than the hook.
 */
export const formatDate = (value: string | Date | null | undefined): string => {
  if (!value) return i18n.t("common.unknownDate");
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? i18n.t("common.unknownDate")
    : d.toLocaleDateString(undefined, {
        year:  "numeric",
        month: "short",
        day:   "numeric",
      });
};