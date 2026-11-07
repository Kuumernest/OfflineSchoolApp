// web/src/hooks/useSignOut.ts
//
// The one way the console signs somebody out.
//
// ── Why there has to be only one ──────────────────────────────────────────
//
// On the desktop, changes recorded offline wait in the outbox for the account
// that made them, and are sent the next time that account signs in on this
// computer. Signing out loses nothing — but somebody who does not know that
// will reasonably think it does, or worse, sign out at the end of the day
// believing the work has already reached the school. So when this person has
// unsent changes, signing out says so first and asks.
//
// Every sign-out button goes through this, so none of them can forget to ask.
// In a browser there is no outbox and it signs out at once, as before.
//
// The one deliberate exception is SignInAgainBanner: its own text has just
// said the changes are kept, so asking again would be noise.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/components/ui/Toast";
import { readUnsentForSession } from "@/lib/offline/unsent";
import { useAuthStore } from "@/store/auth.store";

/**
 * Returns signOut(): resolves true once signed out, false if the person chose
 * to stay. Callers navigate only on true.
 */
export function useSignOut(): () => Promise<boolean> {
  const { t } = useTranslation();
  const { confirm } = useToast();
  const logout = useAuthStore((s) => s.logout);

  return useCallback(async () => {
    const count = await readUnsentForSession();
    if (count > 0) {
      const ok = await confirm({
        title:        t("signOutGuard.title"),
        message:      t("signOutGuard.message", { count }),
        confirmLabel: t("common.signOut"),
        cancelLabel:  t("common.cancel"),
        kind:         "warning",
      });
      if (!ok) return false;
    }
    logout();
    return true;
  }, [confirm, logout, t]);
}
