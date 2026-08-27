// web/src/lib/offline/bridge.ts
//
// The desktop application, as the web app sees it.
//
// ── Why this file exists at all ───────────────────────────────────────────
//
// The same bundle runs in a browser and inside Electron. In the browser there is
// no window.school and every one of these is unavailable; on the desktop they
// are the local database and the outbox. One typed accessor, checked once, keeps
// that difference out of every other file — the alternative is `(window as any)`
// scattered through the app, each occurrence its own small lie about what is
// guaranteed to be there.

/** What the request layer needs to know about a locally-answered call. */
export interface LocalResponse {
  status: number;
  data:   unknown;
}

export interface OutboxEntry {
  seq:         number;
  method:      string;
  path:        string;
  status:      string;
  attempts:    number;
  last_status: number | null;
  last_error:  string | null;
  created_at:  string;
}

export interface OutboxSummary {
  pending: number;
  blocked: number;
  stuck:   Array<{ seq: number; method: string; path: string; last_status: number | null; last_error: string | null }>;
  head:    OutboxSummary["stuck"][number] | null;
}

export interface SyncStatus {
  phase:       "idle" | "pushing" | "pulling" | "offline" | "blocked" | "unauthenticated";
  lastCycleAt: string | null;
  lastError:   string | null;
  pushed:      number;
  pulled:      number;
  refused?:    Array<{ collection: string; reason: string; permission?: string }>;
  heldBack?:   string[];
}

export interface DesktopInfo {
  platform:      string;
  appVersion:    string;
  electron:      string;
  node:          string;
  deviceCode:    string;
  dataDirectory: string;
  schemaVersion: number;
}

interface SchoolBridge {
  isDesktop: true;
  info:   () => Promise<DesktopInfo>;
  api:    {
    request: (req: { method: string; path: string; query: Record<string, string>; body?: unknown })
      => Promise<LocalResponse | null>;
    routes: () => Promise<string[]>;
  };
  docs: {
    get:   (collection: string, id: string) => Promise<unknown>;
    find:  (collection: string, filter?: unknown, opts?: unknown) => Promise<unknown[]>;
    count: (collection: string, filter?: unknown) => Promise<number>;
  };
  outbox: {
    summary: () => Promise<OutboxSummary>;
    list:    () => Promise<OutboxEntry[]>;
    unblock: (seq: number) => Promise<OutboxSummary>;
    discard: (seq: number) => Promise<OutboxSummary>;
  };
  sync: {
    state:    () => Promise<Array<{ collection: string; cursor: string | null; last_pull_at: string | null; last_error: string | null }>>;
    status:   () => Promise<SyncStatus>;
    now:      () => Promise<SyncStatus>;
    setToken: (token: string | null) => Promise<SyncStatus>;
    onStatus: (handler: (status: SyncStatus) => void) => () => void;
  };
  server: {
    get: () => Promise<string | null>;
    set: (url: string) => Promise<string | null>;
  };
}

declare global {
  interface Window { school?: SchoolBridge }
}

/**
 * The bridge, or null in a browser.
 *
 * Read through a function rather than exported as a constant: the preload script
 * runs before the bundle, so it is always present by the time anything calls
 * this — but a module-level constant would capture the value at import time and
 * that ordering is not something to depend on.
 */
export const desktop = (): SchoolBridge | null =>
  (typeof window !== "undefined" && window.school?.isDesktop) ? window.school : null;

/** Is this the desktop build? The one question most callers have. */
export const isDesktop = (): boolean => desktop() !== null;
