// web/src/utils/formatDate.ts

import i18n from "@/i18n";
import { formatDay } from "../../../shared/dateFormat.js";

/**
 * Formats a date value for display: DD/MM/YYYY (C7, shared/dateFormat.js).
 * Returns the translated "Unknown date" for null / invalid inputs. This is a
 * plain function, not a component, so it reads the i18n instance directly
 * rather than the hook.
 */
export const formatDate = (value: string | Date | null | undefined): string =>
  formatDay(value, i18n.t("common.unknownDate"));
