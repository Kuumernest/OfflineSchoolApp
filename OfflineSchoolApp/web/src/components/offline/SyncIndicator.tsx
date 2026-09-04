// web/src/components/offline/SyncIndicator.tsx
//
// Whether this machine is up to date, and what it is still holding.
//
// ── Why this is not decoration ────────────────────────────────────────────
//
// Everything built so far is invisible. A bursar takes a payment with no
// connection, the screen shows it immediately, and nothing tells them whether it
// has reached the school. That silence is the dangerous part: somebody who
// cannot tell whether a payment was recorded takes it again, and the school's
// books show a family paying twice.
//
// So this says three things, in order of how much they matter:
//
//   BLOCKED   the server refused something and the queue has stopped. Nothing
//             behind it is going anywhere until a person looks. This is the only
//             state that asks for action, and it is the loudest.
//   WAITING   n changes recorded here and not yet sent. Normal offline, and
//             reassuring rather than alarming — the number going down is the
//             machine catching up.
//   OFFLINE   the server cannot be reached at all.
//
// When there is nothing to say it says nothing: an indicator that is always
// present is an indicator nobody reads.
//
// ── It renders nothing in a browser ───────────────────────────────────────
//
// There is no local database there and no queue, so there is nothing to report.
// One check, at the top.

import { useCallback, useEffect, useState } from "react";
import { CloudOff, RefreshCw, AlertTriangle, Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToast }       from "@/components/ui/Toast";

import { desktop, type SyncStatus, type OutboxSummary } from "@/lib/offline/bridge";
import { cn } from "@/utils/cn";

export default function SyncIndicator() {
  const { t } = useTranslation();
  const { confirm } = useToast();
  const bridge = desktop();

  const [status,  setStatus]  = useState<SyncStatus | null>(null);
  const [outbox,  setOutbox]  = useState<OutboxSummary | null>(null);
  const [open,    setOpen]    = useState(false);
  const [busy,    setBusy]    = useState<number | null>(null);

  /**
   * Re-read the queue.
   *
   * Called on every status change rather than on a timer: the main process
   * pushes a status whenever a cycle changes phase, and a queue only changes as
   * a result of one of those or of a local write — which triggers a cycle.
   */
  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setOutbox(await bridge.outbox.summary());
    } catch {
      // The indicator failing to read the queue must not break the page it sits
      // in. Leaving the last known value is better than an error where a status
      // light should be.
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;

    let cancelled = false;

    // Both reads happen in one promise continuation rather than as two calls in
    // the effect body. The difference is not stylistic: a setState reached
    // synchronously from an effect triggers a second render before the first has
    // painted, which react-hooks/set-state-in-effect flags and which this file
    // has no reason to do — the main process is an external system and waiting
    // for it is exactly what an effect is for.
    void (async () => {
      try {
        const [next, queue] = await Promise.all([
          bridge.sync.status(),
          bridge.outbox.summary(),
        ]);
        if (cancelled) return;
        setStatus(next);
        setOutbox(queue);
      } catch {
        // A status light that cannot read its own state should stay quiet, not
        // break the page it sits in.
      }
    })();

    // Subsequent updates are pushed. setState inside a subscription callback is
    // the pattern the rule exists to permit.
    const unsubscribe = bridge.sync.onStatus((next) => {
      setStatus(next);
      void refresh();
    });

    return () => { cancelled = true; unsubscribe(); };
  }, [bridge, refresh]);

  if (!bridge) return null;

  const blocked = outbox?.blocked ?? 0;
  const waiting = outbox?.pending ?? 0;
  const offline = status?.phase === "offline";
  const syncing = status?.phase === "pushing" || status?.phase === "pulling";

  // Nothing worth saying. See the note above about always-present indicators.
  if (!blocked && !waiting && !offline && !syncing) return null;

  const tone =
    blocked ? "danger" :
    offline ? "warning" :
    "muted";

  const label =
    blocked ? t("sync.blocked", { count: blocked }) :
    offline ? t("sync.offline") :
    syncing ? t("sync.syncing") :
    t("sync.waiting", { count: waiting });

  const Icon =
    blocked ? AlertTriangle :
    offline ? CloudOff :
    RefreshCw;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={label}
        className={cn(
          "flex items-center gap-1.5 rounded-control px-2 py-1.5 text-xs font-semibold transition-colors",
          tone === "danger"  && "bg-red-50 text-red-600 hover:bg-red-100",
          tone === "warning" && "bg-amber-50 text-amber-700 hover:bg-amber-100",
          tone === "muted"   && "text-gray-500 hover:bg-gray-100"
        )}
      >
        <Icon className={cn("h-3.5 w-3.5", syncing && !blocked && "animate-spin")} />
        <span className="hidden sm:inline">{label}</span>
      </button>

      {open && (
        <>
          {/* Click-away. A plain overlay rather than a document listener, so it
              cannot outlive the panel. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          <div className="absolute right-0 z-50 mt-2 w-96 rounded-xl border border-gray-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <h3 className="text-sm font-bold text-gray-900">{t("sync.title")}</h3>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-4 py-3 text-xs text-gray-600">
              {/* Said plainly. "Everything here has reached the school" is the
                  sentence somebody is actually looking for. */}
              {blocked === 0 && waiting === 0 && (
                <p className="flex items-center gap-1.5 text-emerald-700">
                  <Check className="h-3.5 w-3.5" />
                  {t("sync.allSent")}
                </p>
              )}
              {waiting > 0 && <p>{t("sync.waitingBody", { count: waiting })}</p>}
              {offline && <p className="mt-1 text-amber-700">{t("sync.offlineBody")}</p>}
              {status?.lastCycleAt && (
                <p className="mt-1 text-gray-400">
                  {t("sync.lastChecked", {
                    time: new Date(status.lastCycleAt).toLocaleTimeString(),
                  })}
                </p>
              )}
            </div>

            {/* ── What is stuck, by name ─────────────────────────────────────
                A count is not something a bursar can act on. Each entry says
                what was refused and what the server said about it. */}
            {blocked > 0 && (
              <div className="border-t border-gray-100">
                <p className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-red-600">
                  {t("sync.needsAttention")}
                </p>
                <ul className="max-h-64 divide-y divide-gray-100 overflow-y-auto">
                  {(outbox?.stuck ?? []).map((item) => (
                    <li key={item.seq} className="px-4 py-3">
                      <p className="font-mono text-[11px] text-gray-500">
                        {item.method} {item.path}
                      </p>
                      <p className="mt-1 text-xs text-gray-800">
                        {item.last_error || t("sync.refused")}
                        {item.last_status ? ` (${item.last_status})` : ""}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          disabled={busy === item.seq}
                          onClick={async () => {
                            setBusy(item.seq);
                            try { setOutbox(await bridge.outbox.unblock(item.seq)); }
                            finally { setBusy(null); }
                          }}
                          className="rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] font-semibold text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                        >
                          {t("sync.tryAgain")}
                        </button>
                        <button
                          disabled={busy === item.seq}
                          onClick={async () => {
                            // Discarding removes the local row as well, in the
                            // main process — otherwise the desktop would keep
                            // showing a change the server never accepted.
                            const ok = await confirm({
                              title:   t("sync.discard"),
                              message: t("sync.discardConfirm"),
                              kind:    "danger",
                            });
                            if (!ok) return;
                            setBusy(item.seq);
                            try { setOutbox(await bridge.outbox.discard(item.seq)); }
                            finally { setBusy(null); }
                          }}
                          className="rounded-lg px-2.5 py-1 text-[11px] font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                        >
                          {t("sync.discard")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="border-t border-gray-100 px-4 py-3">
              <button
                onClick={async () => {
                  setStatus(await bridge.sync.now());
                  await refresh();
                }}
                className="w-full rounded-lg bg-gray-900 py-2 text-xs font-semibold text-white transition hover:bg-gray-800"
              >
                {t("sync.syncNow")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
