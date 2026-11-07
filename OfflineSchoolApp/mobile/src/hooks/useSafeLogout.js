// src/hooks/useSafeLogout.js
"use strict";

/**
 * Every "Sign out" button goes through here.
 *
 * Signing out does not delete the outbox — its rows belong to the account
 * that made them and are sent the next time that account signs in on this
 * phone — but a person who signs out with work unsent should know that
 * before they hand the phone over or wait for marks that never arrive. So
 * when this account has unsent changes, the sign-out asks first:
 *
 *   "You have N changes not yet sent. If you sign out, they'll be sent next
 *    time you sign in on this phone."   [Cancel] [Sign out]
 *
 * With nothing unsent, a screen keeps its own confirmation (or none).
 */

import { useCallback } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";
import { useAuthStore, getUnsentCount } from "../store/auth.store";
import { useTranslation } from "../i18n/useTranslation";

/**
 * What to ask before signing out.
 *
 * @param {number|null} unsent  this account's unsent changes; null = unknown
 * @param {boolean} hasConfirm  the screen has its own "Sign out?" question
 * @returns {"warnUnsent"|"confirm"|"direct"}
 */
export const decideLogoutPrompt = (unsent, hasConfirm) => {
  if (Number(unsent) > 0) return "warnUnsent";
  return hasConfirm ? "confirm" : "direct";
};

/**
 * The sign-out itself, independent of React so it can be checked.
 *
 * @param {object} o
 * @param {(key:string, opts?:object) => string} o.t
 * @param {() => Promise<any>} o.logout
 * @param {() => void} [o.onSignedOut]     e.g. navigate to the login screen
 * @param {{title:string, body:string, confirmLabel?:string, cancelLabel?:string}} [o.confirm]
 * @param {() => Promise<number|null>} [o.countUnsent]
 * @param {(title:string, body:string, buttons:Array) => void} [o.alert]
 * @returns {Promise<"warnUnsent"|"confirm"|"direct">}
 */
export const runSafeLogout = async ({
  t,
  logout,
  onSignedOut,
  confirm,
  countUnsent = getUnsentCount,
  alert = (title, body, buttons) => Alert.alert(title, body, buttons),
}) => {
  const signOut = async () => {
    try { await logout(); } catch (err) { console.warn("[logout] failed:", err?.message); }
    onSignedOut?.();
  };

  let unsent = null;
  try { unsent = await countUnsent(); } catch { unsent = null; }

  const plan = decideLogoutPrompt(unsent, Boolean(confirm));
  if (plan === "warnUnsent") {
    alert(
      t("logoutGuard.title"),
      t("logoutGuard.body", { count: Number(unsent) }),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("logoutGuard.signOut"), style: "destructive", onPress: signOut },
      ]
    );
  } else if (plan === "confirm") {
    alert(confirm.title, confirm.body, [
      { text: confirm.cancelLabel ?? t("common.cancel"), style: "cancel" },
      { text: confirm.confirmLabel ?? t("logoutGuard.signOut"), style: "destructive", onPress: signOut },
    ]);
  } else {
    await signOut();
  }
  return plan;
};

/**
 * @returns {(confirm?: {title:string, body:string, confirmLabel?:string, cancelLabel?:string}) => Promise<string>}
 *   Call it from the button. Pass the screen's own confirmation, if it has
 *   one, to keep asking it when nothing is unsent.
 */
export const useSafeLogout = ({ redirectTo = "/auth/login" } = {}) => {
  const { t } = useTranslation();
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);

  return useCallback(
    (confirm) =>
      runSafeLogout({
        t,
        logout,
        confirm,
        onSignedOut: redirectTo ? () => router.replace(redirectTo) : undefined,
      }),
    [t, logout, router, redirectTo]
  );
};

export default useSafeLogout;
