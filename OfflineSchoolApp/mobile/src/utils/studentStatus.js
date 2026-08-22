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
 * @returns {{ key: string, label: string, color: string, bg: string, dot: string }}
 */
export const getStudentStatusConfig = (status) => {
  const key = String(status ?? "").trim().toLowerCase();

  switch (key) {
    case "approved":
    case "active":
      return { key: "approved",  label: "Active",    color: C.success, bg: C.successBg, dot: C.successDot };
    case "pending":
      return { key: "pending",   label: "Pending",   color: C.warning, bg: C.warningBg, dot: C.warningDot };
    case "suspended":
      return { key: "suspended", label: "Suspended", color: C.error,   bg: C.errorBg,   dot: C.errorDot };
    case "rejected":
      return { key: "rejected",  label: "Rejected",  color: C.purple,  bg: C.purpleBg,  dot: C.purpleDot };
    case "inactive":
      return { key: "inactive",  label: "Inactive",  color: C.gray,    bg: C.grayBg,    dot: C.grayDot };
    default:
      return {
        key:   key || "unknown",
        // Show what we actually hold rather than inventing a friendly label.
        label: status ? String(status) : "Unknown",
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
