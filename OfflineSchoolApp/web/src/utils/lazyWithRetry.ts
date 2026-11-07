// web/src/utils/lazyWithRetry.ts
//
// A route's chunk, fetched again before giving up.
//
// Every page in App.tsx is a separate chunk loaded on first navigation. On a
// flaky connection that one request fails and the browser rejects the import
// with "Failed to fetch dynamically imported module" — which reached the page
// as a raw crash. A second or third attempt a moment later usually succeeds.
//
// After a deploy the old chunk names are gone from the server, and no number
// of retries will find them; that case ends in RouteErrorBoundary, which
// recognises it with isChunkLoadError and offers a reload (the new build).
//
// Imports nothing, on purpose: scripts/check-chunk-retry.mjs runs it as is.

export interface RetryOptions {
  /** Total attempts, the first included. */
  attempts?: number;
  /** Wait before retry n (1-based) is baseDelayMs * n. */
  baseDelayMs?: number;
  /** Injected by the check so it does not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

export const CHUNK_RETRY_ATTEMPTS = 3;
export const CHUNK_RETRY_BASE_DELAY_MS = 400;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls `load` until it resolves, at most `attempts` times, waiting a little
 * longer before each retry. Rejects with the last error.
 */
export async function retryImport<T>(
  load: () => Promise<T>,
  {
    attempts    = CHUNK_RETRY_ATTEMPTS,
    baseDelayMs = CHUNK_RETRY_BASE_DELAY_MS,
    sleep       = realSleep,
  }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      return await load();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

/**
 * True for the errors a browser or the bundler raises when a chunk (script or
 * its CSS) could not be fetched — as opposed to a page that loaded and threw.
 */
export function isChunkLoadError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  if (typeof message !== "string") return false;
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk [\w-]+ failed/i
    .test(message);
}
