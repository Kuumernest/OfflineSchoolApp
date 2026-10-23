// web/src/utils/auditText.ts
//
// An audit row in words. The API stores a code ("results.unpublished") and the
// fields that changed as before/after objects; a person reading the log wants
// "Results unpublished" and "Email changed from a@x to b@x." One place turns
// the first into the second, so the audit page and a school's recent activity
// read the same.

import type { TFunction } from "i18next";
import type { AuditEntry } from "@/services/platform.service";
import { roleLabel } from "@/utils/roleLabel";

/** "results.unpublished" → "Results unpublished"; an unknown code is humanised, never shown raw. */
export function auditActionLabel(action: string, t: TFunction): string {
  return t(`platform.audit.actions.${action}`, { defaultValue: humanise(action.split(".").pop() ?? action) });
}

/** "principalName" → "Principal name". */
const humanise = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.]/g, " ").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const fieldLabel = (key: string, t: TFunction) =>
  t(`platform.audit.fields.${key}`, { defaultValue: humanise(key) });

const value = (v: unknown, t: TFunction): string => {
  if (typeof v === "boolean") return t(v ? "platform.audit.text.yes" : "platform.audit.text.no");
  if (typeof v === "object" && v !== null) {
    const n = Object.keys(v).length;
    return t("platform.audit.text.items", { count: n });
  }
  return String(v);
};

const empty = (v: unknown) => v == null || v === "" ||
  (typeof v === "object" && Object.keys(v as object).length === 0);

/** One sentence per field that differs between before and after. */
function changeSentences(before: Record<string, unknown>, after: Record<string, unknown>, t: TFunction, skip: string[] = []) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !skip.includes(k));
  return keys.flatMap((k) => {
    const b = before[k], a = after[k];
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) return [];
    const field = fieldLabel(k, t);
    if (empty(b)) return [t("platform.audit.text.set", { field, to: value(a, t) })];
    if (empty(a)) return [t("platform.audit.text.cleared", { field, from: value(b, t) })];
    return [t("platform.audit.text.changed", { field, from: value(b, t), to: value(a, t) })];
  });
}

/** The details of an audit row as plain sentences, reason excluded. */
export function auditSentences(e: AuditEntry, t: TFunction): string[] {
  const before = (e.before && typeof e.before === "object" ? e.before : {}) as Record<string, unknown>;
  const after  = (e.after  && typeof e.after  === "object" ? e.after  : {}) as Record<string, unknown>;
  const label  = e.resourceLabel ?? "";
  const x = (k: string, opts: Record<string, unknown> = {}) => t(`platform.audit.text.${k}`, opts);

  switch (e.action) {
    case "school.created":
      return [x("schoolCreated", { name: label || e.schoolName || "" })];
    case "school.activated":
      return [x("schoolActivated")];
    case "school.deactivated":
      return [x("schoolDeactivated")];
    case "school.entered":
      return [x("schoolEntered")];
    case "admin.created":
      return [x("adminCreated", { name: after.name ?? label, email: label, role: roleLabel(String(after.role ?? ""), t) })];
    case "admin.restored":
      return [x("adminRestored", { name: after.name ?? label, email: label, role: roleLabel(String(after.role ?? ""), t) })];
    case "admin.passwordReset":
    case "superAdmin.passwordReset":
      return [x("passwordReset", { email: label })];
    case "admin.removed":
      return [x("adminRemoved", { email: label, role: roleLabel(String(before.role ?? ""), t) })];
    case "superAdmin.created":
      return [x("superAdminCreated", { name: after.name ?? label, email: after.email ?? label })];
    case "superAdmin.activated":
      return [x("superAdminActivated", { email: label })];
    case "superAdmin.deactivated":
      return [x("superAdminDeactivated", { email: label })];
    case "superAdmin.updated":
      return [x("account", { email: label }), ...changeSentences(before, after, t)];
    case "academic.rulesChanged": {
      const out = [x("rulesFor", { year: label })];
      if (before.promotionThreshold !== after.promotionThreshold) {
        out.push(...changeSentences({ promotionThreshold: before.promotionThreshold }, { promotionThreshold: after.promotionThreshold }, t));
      }
      const bc = (before.classThresholds ?? {}) as Record<string, unknown>;
      const ac = (after.classThresholds  ?? {}) as Record<string, unknown>;
      const changed = [...new Set([...Object.keys(bc), ...Object.keys(ac)])].filter((k) => bc[k] !== ac[k]).length;
      if (changed) out.push(x("classThresholds", { count: changed }));
      return out;
    }
    case "reportCard.reissued": {
      const out = [x("reportCardReissued", { label })];
      if (before.templateId !== after.templateId || before.templateVersion !== after.templateVersion) {
        out.push(x("templateChanged", { from: before.templateVersion ?? "—", to: after.templateVersion ?? "—" }));
      }
      if (before.layoutVersion !== after.layoutVersion && after.layoutVersion != null) {
        out.push(x("layoutChanged", { from: before.layoutVersion ?? "—", to: after.layoutVersion }));
      }
      if (before.deleted) out.push(x("cardRevived"));
      if (after.verifyCode) out.push(x("verifyCode", { code: after.verifyCode }));
      return out;
    }
    case "results.unpublished": {
      const withdrawn = Number(before.published ?? 0) - Number(after.published ?? 0);
      const layer = e.resourceType
        ? t(`platform.audit.layers.${e.resourceType}`, { defaultValue: humanise(e.resourceType) })
        : "";
      return [x(layer ? "resultsUnpublishedLayer" : "resultsUnpublished", { layer, label, count: withdrawn })];
    }
    default:
      // school.updated, and anything added later: one sentence per changed field.
      return changeSentences(before, after, t);
  }
}
