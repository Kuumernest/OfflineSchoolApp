// web/src/components/offline/SignInAgainBanner.tsx
//
// "Sign in again to send 3 unsent changes", across the top of the desktop.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// On the desktop almost nothing the window does reaches the server: reads are
// local and writes are queued (lib/offline/adapter.ts). So when the server
// stops accepting this machine's token, the window never hears a 401 of its
// own — only the sync engine does, and it stops sending. The indicator then
// said "3 waiting" in the calm grey of a machine that is merely offline, and
// the bursar went home believing the payments would go overnight. They would
// not have gone until somebody signed in again, which nothing asked for.
//
// So, in this order:
//
//   1. Try to renew quietly. The usual cause is an access token that expired
//      while the window had no reason to refresh it; the refresh token is
//      still good. If that works, the new token reaches the engine
//      (auth.store tellDesktop) and it carries on — nothing is shown.
//   2. If the server refuses the renewal, auth.store signs out and the window
//      goes to the sign-in page. Nothing is lost: the queue and the local data
//      stay on this computer and are sent when this person signs in again.
//   3. Otherwise — the renewal could not reach the server, or is being retried
//      — say so, persistently, with the count and a way to sign in.
//
// Renders nothing in a browser.

import { useEffect, useRef, useState } from "react";
import { LogIn } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { desktop, type OutboxSummary, type SyncStatus } from "@/lib/offline/bridge";
import { unsentForSession } from "@/lib/offline/unsent";
import { useAuthStore } from "@/store/auth.store";

/** At most one quiet renewal per this long, so a server that accepts the
 *  refresh but keeps refusing sync cannot turn this into a loop. */
const RENEW_EVERY_MS = 60_000;

export default function SignInAgainBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const bridge = desktop();

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [outbox, setOutbox] = useState<OutboxSummary | null>(null);
  const [renewing, setRenewing] = useState(false);
  const lastRenewAt = useRef(0);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    const read = async () => {
      try {
        const [next, queue] = await Promise.all([bridge.sync.status(), bridge.outbox.summary()]);
        if (cancelled) return;
        setStatus(next);
        setOutbox(queue);
      } catch {
        // A banner that cannot read the state stays quiet rather than break
        // the page under it.
      }
    };

    void read();
    const unsubscribe = bridge.sync.onStatus(() => { void read(); });
    return () => { cancelled = true; unsubscribe(); };
  }, [bridge]);

  const rejected = status?.phase === "unauthenticated" && status.sessionRejected === true;

  // Step 1: the quiet renewal. In an effect because it answers a status pushed
  // by the main process; its result arrives through the same push.
  useEffect(() => {
    if (!rejected) return;
    if (Date.now() - lastRenewAt.current < RENEW_EVERY_MS) return;
    lastRenewAt.current = Date.now();

    let cancelled = false;
    void (async () => {
      setRenewing(true);
      try {
        // "refreshed": the engine has the new token and cycles at once.
        // "refused":   signed out by the store; the route guard goes to /login.
        // "unreachable": the banner below stays.
        await useAuthStore.getState().refreshSession();
      } finally {
        if (!cancelled) setRenewing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [rejected, status]);

  if (!bridge || !rejected || renewing) return null;

  const count = unsentForSession(outbox);

  // Signing out here keeps the queue and the local data: the outbox is per
  // account and is sent when this person signs in again. No "you have unsent
  // changes" question either — this banner has just said so.
  const signInAgain = () => {
    useAuthStore.getState().logout();
    navigate("/login", { replace: true });
  };

  return (
    <div role="alert" className="flex flex-wrap items-start gap-3 border-b border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger-text">
      <LogIn className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {count > 0 ? t("sync.signInAgainTitle", { count }) : t("sync.signInAgainTitleNone")}
        </p>
        <p className="mt-0.5">{t("sync.signInAgainBody")}</p>
      </div>
      <Button size="sm" variant="secondary" onClick={signInAgain} icon={<LogIn className="h-3.5 w-3.5" />}>
        {t("sync.signInAgainAction")}
      </Button>
    </div>
  );
}
