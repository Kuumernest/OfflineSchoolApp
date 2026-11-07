// web/src/hooks/useNeedsInternet.ts
//
// Is this an action the desktop cannot do right now?
//
// A few things are online-only by decision — settings that change who may do
// what (admins, permissions, profile, password), computing and publishing
// results, report cards and PDFs, exports, payroll, starting a conversation.
// Their requests go past the local database to the server, and offline they
// fail. Letting somebody fill a whole form first and then telling them is the
// worst order to find out in; this lets the page disable the action, and say
// why, before anything is typed.
//
// Only on the desktop. In a browser the whole console is online-only and the
// offline banner (OfflineBanner) already says so, once, for every page.
//
// Pair with components/offline/NeedsInternet for the notice:
//
//   const net = useNeedsInternet();
//   <NeedsInternet />
//   <Button disabled={net.blocked || …} title={net.hint}>Publish</Button>

import { useTranslation } from "react-i18next";
import { isDesktop } from "@/lib/offline/bridge";
import { useIsOffline } from "@/lib/offline/connectivityWatch";

export interface NeedsInternet {
  /** True on the desktop while the server cannot be reached. */
  blocked: boolean;
  /** The reason, for a disabled button's title; undefined when not blocked. */
  hint:    string | undefined;
}

export function useNeedsInternet(): NeedsInternet {
  const { t } = useTranslation();
  const offline = useIsOffline();
  const blocked = offline && isDesktop();
  return { blocked, hint: blocked ? t("connection.needsInternetShort") : undefined };
}
