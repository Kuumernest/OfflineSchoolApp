// web/src/pages/gate/useGateQueue.ts
//
// Scans the server never answered, kept and sent again.
//
// A gate cannot tell a child to wait for the Wi-Fi, so a scan with no response
// is shown on the device (computed from the snapshot), kept here, and uploaded
// on the `online` event and on a timer. The server is replay-safe on the
// client `_id`: a scan that did reach it, but whose answer was lost, is
// recorded once however many times it is sent.
//
// Storage is the source of truth and every change is a read-modify-write of
// it: a scan queued while a flush is in flight must not be overwritten by the
// flush's older copy of the list.

import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  postGateScan, readQueue, writeQueue, type QueuedScan,
} from "@/services/gate.service";

const RETRY_EVERY_MS = 30_000;

/** A refusal that will not change on retry: unknown card, not enrolled, bad body. */
const isFinalRefusal = (err: unknown): boolean => {
  if (!axios.isAxiosError(err) || !err.response) return false;
  const s = err.response.status;
  // 401/403 are the session or a permission, not the scan — keep it for the
  // next sign-in rather than throw away a safeguarding record.
  return s >= 400 && s < 500 && s !== 401 && s !== 403 && s !== 408 && s !== 429;
};

export function useGateQueue({
  schoolId, userId, onUploaded, onRefused,
}: {
  schoolId: string;
  userId:   string;
  onUploaded?: (count: number) => void;
  onRefused?:  (item: QueuedScan, err: unknown) => void;
}) {
  const owner = `${schoolId}.${userId}`;
  const [state, setState] = useState(() => ({ owner, rows: readQueue(schoolId, userId) }));
  // A different school or account on the same screen has a different queue.
  // Adjusted during render rather than in an effect, so the old list is never
  // drawn under the new name.
  if (state.owner !== owner) setState({ owner, rows: readQueue(schoolId, userId) });

  const callbacks = useRef({ onUploaded, onRefused });
  useEffect(() => { callbacks.current = { onUploaded, onRefused }; }, [onUploaded, onRefused]);

  const flushing = useRef(false);

  const refresh = useCallback(() => {
    setState({ owner, rows: readQueue(schoolId, userId) });
  }, [owner, schoolId, userId]);

  const enqueue = useCallback((item: QueuedScan) => {
    const rows = readQueue(schoolId, userId);
    if (!rows.some((r) => r.body._id === item.body._id)) rows.push(item);
    writeQueue(schoolId, userId, rows);
    refresh();
  }, [schoolId, userId, refresh]);

  const remove = useCallback((id: string) => {
    writeQueue(schoolId, userId, readQueue(schoolId, userId).filter((r) => r.body._id !== id));
  }, [schoolId, userId]);

  const flush = useCallback(async () => {
    if (flushing.current || !schoolId || !userId) return;
    const pending = readQueue(schoolId, userId);
    if (!pending.length) return;

    flushing.current = true;
    let sent = 0;
    try {
      // Oldest first and one at a time: the server works out in/out from the
      // order of a pupil's passages.
      for (const item of pending) {
        try {
          await postGateScan(schoolId, item.body);
          remove(item.body._id);
          sent += 1;
        } catch (err) {
          if (isFinalRefusal(err)) {
            remove(item.body._id);
            callbacks.current.onRefused?.(item, err);
            continue;
          }
          // Still no server: count the attempt and stop — the rest would fail
          // the same way.
          writeQueue(schoolId, userId, readQueue(schoolId, userId).map((r) =>
            r.body._id === item.body._id ? { ...r, attempts: (r.attempts ?? 0) + 1 } : r));
          break;
        }
      }
    } finally {
      flushing.current = false;
      refresh();
      if (sent) callbacks.current.onUploaded?.(sent);
    }
  }, [schoolId, userId, remove, refresh]);

  useEffect(() => {
    const onOnline = () => { void flush(); };
    window.addEventListener("online", onOnline);
    const timer = window.setInterval(() => { void flush(); }, RETRY_EVERY_MS);
    // Whatever an earlier session left behind goes as soon as the screen opens.
    const first = window.setTimeout(() => { void flush(); }, 0);
    return () => {
      window.removeEventListener("online", onOnline);
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [flush]);

  return { queue: state.rows, enqueue, flush };
}
