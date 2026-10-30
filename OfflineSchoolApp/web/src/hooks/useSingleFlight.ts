// web/src/hooks/useSingleFlight.ts
//
// One print or preview at a time, with something on screen while it runs.
//
// The print and preview buttons fetched a document and only then opened or
// printed it — seconds on a school connection — while the label stayed as it
// was, and a second click started a second job: two tabs, two print dialogs.
// A disabled attribute alone does not close that gap, because it takes a
// render to arrive; the ref here answers "already running" at once.
//
// Keyed, so a list of receipts can say which row is preparing while every
// other print waits.

import { useCallback, useRef, useState } from "react";

export function useSingleFlight() {
  const active = useRef<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  /** Run `fn` unless something is already running; the button stays busy
   *  until it settles — until the tab or the print dialog has its content. */
  const run = useCallback(async (key: string, fn: () => Promise<unknown>) => {
    if (active.current !== null) return;
    active.current = key;
    setBusyKey(key);
    try {
      await fn();
    } finally {
      active.current = null;
      setBusyKey(null);
    }
  }, []);

  return {
    /** The key running, or null. */
    busyKey,
    busy: busyKey !== null,
    run,
  };
}
