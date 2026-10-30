// web/src/hooks/useUnsavedChangesGuard.ts
//
// Ask before leaving a form that has unsaved changes.
//
// The attendance sheet said "10 unsaved changes" and then let a click on the
// sidebar throw all ten away without a word. Two ways out have to be covered:
//
//   - leaving the app (closing the tab, reloading, typing an address): only
//     the browser's own beforeunload prompt can stop that, and it shows its
//     own fixed wording — a page cannot put its text in it;
//   - moving within the app (sidebar, links, back button): React Router's
//     useBlocker holds the navigation, and the app's own confirm dialog asks.
//
// The blocker reads refs, not the render's values, so a page that saves and
// then navigates in the same handler is not stopped by the dirty state it is
// about to clear: call allowNavigation() first.

import { useCallback, useEffect, useRef } from "react";
import { useBlocker }                     from "react-router-dom";
import { useTranslation }                 from "react-i18next";
import { useToast }                       from "@/components/ui/Toast";

interface Options {
  /** What would be lost, e.g. "10 marks". Defaults to a generic line. */
  message?: string;
}

export function useUnsavedChangesGuard(dirty: boolean, { message }: Options = {}) {
  const { t }       = useTranslation();
  const { confirm } = useToast();

  const dirtyRef  = useRef(dirty);
  const bypassRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
    if (!dirty) bypassRef.current = false;
  }, [dirty]);

  // ── Leaving the app ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (bypassRef.current) return;
      e.preventDefault();
      // Older Chromium and Safari still need returnValue set to prompt.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // ── Moving within the app ──────────────────────────────────────────────────
  const shouldBlock = useCallback(
    ({ currentLocation, nextLocation }: {
      currentLocation: { pathname: string; search: string };
      nextLocation:    { pathname: string; search: string };
    }) =>
      dirtyRef.current &&
      !bypassRef.current &&
      (currentLocation.pathname !== nextLocation.pathname ||
       currentLocation.search   !== nextLocation.search),
    [],
  );
  const blocker = useBlocker(shouldBlock);

  const askToLeave = useCallback(
    () =>
      confirm({
        title:        t("unsaved.title"),
        message:      message ?? t("unsaved.message"),
        confirmLabel: t("unsaved.leave"),
        cancelLabel:  t("unsaved.stay"),
        kind:         "warning",
      }),
    [confirm, message, t],
  );

  const asking = useRef(false);
  useEffect(() => {
    if (blocker.state !== "blocked" || asking.current) return;
    asking.current = true;
    void askToLeave().then((leave) => {
      asking.current = false;
      if (leave) {
        bypassRef.current = true;
        blocker.proceed?.();
      } else {
        blocker.reset?.();
      }
    });
  }, [blocker, askToLeave]);

  return {
    /** Let the next navigation through — call it just before navigating
     *  away from a form you have just saved. */
    allowNavigation: useCallback(() => { bypassRef.current = true; }, []),
    /** For a discard inside the page (closing a panel, switching register):
     *  resolves true straight away when there is nothing to lose. */
    confirmDiscard: useCallback(
      async () => (dirtyRef.current ? askToLeave() : true),
      [askToLeave],
    ),
  };
}
