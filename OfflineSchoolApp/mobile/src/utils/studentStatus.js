// src/utils/studentStatus.js
"use strict";

/**
 * The one mapping from a student's stored status to how it is displayed.
 *
 * There used to be two. The students list handled approved / pending /
 * suspended / rejected, while the detail screen carried a truncated copy that
 * only special-cased "suspended" and "inactive" and sent *everything else* to
 * a default of "Active". So one pending student was listed as **Pending** and,
 * on tapping through, described as **Active** — same row, same field, two
 * different answers.
 *
 * Statuses come from the Student model's enum:
 *   pending | approved | rejected | suspended
 *
 * "approved" is deliberately shown as **Active**: that is the product wording
 * for an enrolled student. Anything unrecognised is shown verbatim rather than
 * being assumed active — a status we do not understand must never be
 * presented as a good one.
 */

export const STUDENT_STATUS_COLORS = {
  success:   "#059669",
  successBg: "#D1FAE5",
  successDot:"#10B981",
  warning:   "#D97706",
  warningBg: "#FEF3C7",
  warningDot:"#F59E0B",
  error:     "#DC2626",
  errorBg:   "#FEE2E2",
  errorDot:  "#EF4444",
  purple:    "#7C3AED",
  purpleBg:  "#EDE9FE",
  purpleDot: "#8B5CF6",
  gray:      "#6B7280",
  grayBg:    "#F3F4F6",
  grayDot:   "#9CA3AF",
};

const C = STUDENT_STATUS_COLORS;

/**
 * @param {string|null|undefined} status
 * @returns {{ key: string, labelKey: string|null, label: string|null,
 *             color: string, bg: string, dot: string }}
 *
 * labelKey rather than label: this is a plain module, so it cannot call the
 * translator. It returned English words that two screens rendered straight
 * into a status chip, which is why an otherwise French roster said "Active".
 * The keys are the ones already used elsewhere for these five states, so the
 * wording matches the rest of the app rather than being a second set.
 */
export const getStudentStatusConfig = (status) => {
  const key = String(status ?? "").trim().toLowerCase();

  switch (key) {
    case "approved":
    case "active":
      return { key: "approved",  labelKey: "common.active",              color: C.success, bg: C.successBg, dot: C.successDot };
    case "pending":
      return { key: "pending",   labelKey: "common.pending",             color: C.warning, bg: C.warningBg, dot: C.warningDot };
    case "suspended":
      return { key: "suspended", labelKey: "approvedStudents.suspended", color: C.error,   bg: C.errorBg,   dot: C.errorDot };
    case "rejected":
      return { key: "rejected",  labelKey: "approvedStudents.rejected",  color: C.purple,  bg: C.purpleBg,  dot: C.purpleDot };
    case "inactive":
      return { key: "inactive",  labelKey: "common.inactive",            color: C.gray,    bg: C.grayBg,    dot: C.grayDot };
    default:
      return {
        key:   key || "unknown",
            // An unrecognised status is shown exactly as stored, because a
            // friendly substitute would hide real data. Only the empty case
            // gets a translated word.
            labelKey: status ? null : "common.unknown",
            label:    status ? String(status) : null,
        color: C.gray, bg: C.grayBg, dot: C.grayDot,
      };
  }
};

/** True when the student is enrolled and in good standing. */
export const isStudentActive = (status) =>
  getStudentStatusConfig(status).key === "approved";

/** True when the student is still awaiting an admission decision. */
export const isStudentPending = (status) =>
  getStudentStatusConfig(status).key === "pending";

export default { getStudentStatusConfig, isStudentActive, isStudentPending, STUDENT_STATUS_COLORS };
