// web/src/lib/offline/adapter.ts
//
// One seam in front of 225 call sites.
//
// ── What this is ──────────────────────────────────────────────────────────
//
// An axios adapter. Axios asks it to perform a request; on the desktop it offers
// the request to the local database first, and only goes to the network if
// nothing there can answer. No component, hook, service or query key changes —
// the app carries on making the same HTTP calls it always made.
//
// In a browser it is never installed, so the behaviour there is byte for byte
// what it is today.
//
// ── Why the adapter and not an interceptor ────────────────────────────────
//
// A request interceptor cannot answer a request; it can only alter one on its
// way out. Answering from a local database means never opening a socket, and the
// adapter is the only place axios lets you do that. Doing it in an interceptor
// would mean rejecting the request with a fake error and reconstructing a
// response from it in a response interceptor — two lies to arrange one truth.
//
// ── Writes are queued, never sent from here ───────────────────────────────
//
// A write that the main process accepts has been written to the local database
// AND queued as the original HTTP request, in one transaction. It is not sent
// from this adapter and does not wait for a connection: the sync loop replays it
// when there is one, with every server-side guard applying at that moment.
//
// The response handed back is the shape the server would have sent, with nothing
// added — deliberately no "queued" flag, because a field that exists only
// offline is a field some component will come to depend on, and it would then
// behave differently in a browser.
//
// ── Reads are local-first, not local-as-fallback ──────────────────────────
//
// A read that is answered locally is answered locally whether or not there is a
// connection. Trying the network first and falling back would make every screen
// behave differently depending on the weather: fast and current on a good
// connection, and then — on a slow one — hanging for the timeout before showing
// the same data it had all along. Worse, it would make the offline path the one
// that is almost never exercised, so the first time it ran for real would be the
// first time anybody found out whether it worked.

import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { desktop } from "./bridge";

// The one piece of this file with logic in it, and the only one whose mistakes
// are silent: a dropped parameter does not throw, it answers a slightly
// different question. Kept as plain JavaScript outside this package so it can
// be exercised from Node without a browser or a bundler.
//
// @ts-expect-error — a .js module reached by relative path; it ships no types.
import { requestPath } from "../../../../shared/requestPath.js";

const splitUrl = (config: InternalAxiosRequestConfig): { path: string; query: Record<string, string> } =>
  requestPath({ baseURL: config.baseURL, url: config.url, params: config.params });

/**
 * Wrap a local answer in the shape axios promises its callers.
 *
 * Every field the app might read has to be here. A response missing `headers`
 * or `config` does not fail at the adapter — it fails later, in a component,
 * as a property access on undefined.
 */
const asAxiosResponse = (
  config: InternalAxiosRequestConfig,
  local: { status: number; data: unknown }
): AxiosResponse => ({
  data:       local.data,
  status:     local.status,
  statusText: local.status === 200 ? "OK" : String(local.status),
  headers:    {},
  config,
  request:    null,
});

/**
 * Install the local-first adapter in front of whatever axios was using.
 *
 * @param fallback The adapter axios would otherwise use — the real network.
 */
export const offlineAdapter = (fallback: AxiosAdapter): AxiosAdapter =>
  async (config) => {
    const bridge = desktop();
    if (!bridge) return fallback(config);

    const method = String(config.method ?? "get").toUpperCase();
    const { path, query } = splitUrl(config);

    // A write goes to the same place, and the main process decides whether it
    // can be queued. If it cannot, it answers null and this falls through — so a
    // write to an endpoint with no offline handling behaves exactly as it does
    // today, including failing when there is no connection, rather than being
    // accepted and quietly lost.
    //
    // config.data is what axios would have serialised. It arrives as a string
    // when a caller set it themselves, so it is parsed back — the handlers read
    // fields off the body, and a string body would silently match nothing.
    let body: unknown;
    if (method !== "GET" && config.data !== undefined) {
      body = typeof config.data === "string"
        ? (() => { try { return JSON.parse(config.data as string); } catch { return config.data; } })()
        : config.data;
    }

    let local: { status: number; data: unknown } | null;
    try {
      local = await bridge.api.request({ method, path, query, body });
    } catch (err) {
      // The bridge itself failing is not the same as the request failing. Fall
      // back rather than surfacing an IPC error as an HTTP one, and say so —
      // this should not happen, and silence would make it invisible.
      console.warn(`[offline] local answer unavailable for ${method} ${path}:`, err);
      return fallback(config);
    }

    // Nothing local could answer: this endpoint is not mirrored yet, or the
    // handler declined because the request asked something a local database
    // cannot answer the same way. Either way, the network as before.
    if (!local) return fallback(config);

    return asAxiosResponse(config, local);
  };
