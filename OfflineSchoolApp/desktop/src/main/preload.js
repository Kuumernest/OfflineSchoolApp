// desktop/src/main/preload.js
"use strict";

/**
 * The only thing the window can reach.
 *
 * ── Why this file is small ────────────────────────────────────────────────
 *
 * Everything exposed here is reachable by any script that ends up running in
 * the renderer, and the renderer displays text the school did not write — a
 * pupil's name typed by a secretary, an announcement written by a teacher, a
 * field pulled from the server. If any of that were ever rendered unescaped,
 * this surface is what it would be holding.
 *
 * So it is a list of questions, not a capability. There is no channel that
 * takes SQL, none that takes a file path, and none that reads or writes outside
 * the school's own database. Adding one is a decision to be made deliberately
 * and not a convenience.
 *
 * ── Why it is exposed as school.* rather than patched onto fetch ──────────
 *
 * Because the web app has to keep working in a plain browser. The presence of
 * window.school is exactly how it knows it is running on the desktop — one
 * check, in one place, rather than a build flag threaded through the app.
 */

const { contextBridge, ipcRenderer } = require("electron");

/** A named, frozen surface. Nothing here is a passthrough. */
contextBridge.exposeInMainWorld("school", {
  /** Marks this as the desktop build. The web app branches on it once. */
  isDesktop: true,

  /** Version, platform, where the data is, and this installation's code. */
  info: () => ipcRenderer.invoke("app:info"),

  /** Reading the local mirror. */
  docs: {
    get:   (collection, id)           => ipcRenderer.invoke("docs:get",   collection, id),
    find:  (collection, filter, opts) => ipcRenderer.invoke("docs:find",  collection, filter, opts),
    count: (collection, filter)       => ipcRenderer.invoke("docs:count", collection, filter),
  },

  /**
   * Record something locally and queue the request that makes it real.
   *
   * One call, because the two must not come apart — see the handler.
   */
  write: (payload) => ipcRenderer.invoke("write:local", payload),

  /** What has not reached the server yet, and what is stuck. */
  outbox: {
    summary: ()    => ipcRenderer.invoke("outbox:summary"),
    list:    ()    => ipcRenderer.invoke("outbox:list"),
    unblock: (seq) => ipcRenderer.invoke("outbox:unblock", seq),
    discard: (seq) => ipcRenderer.invoke("outbox:discard", seq),
  },

  /**
   * Syncing.
   *
   * setToken is how the main process gets a credential at all — it cannot sign
   * in, and it deliberately keeps nothing on disk, so the renderer tells it
   * whenever the session changes.
   */
  sync: {
    state:    ()      => ipcRenderer.invoke("sync:state"),
    status:   ()      => ipcRenderer.invoke("sync:status"),
    now:      ()      => ipcRenderer.invoke("sync:now"),
    setToken: (token) => ipcRenderer.invoke("session:set", token),

    /**
     * Called whenever a cycle changes phase.
     *
     * Returns its own unsubscribe rather than exposing removeListener: a
     * renderer that could remove arbitrary listeners could remove another
     * component's.
     */
    onStatus: (handler) => {
      const wrapped = (_event, status) => handler(status);
      ipcRenderer.on("sync:status", wrapped);
      return () => ipcRenderer.removeListener("sync:status", wrapped);
    },
  },

  /** Which server this installation syncs with. */
  server: {
    get: ()    => ipcRenderer.invoke("server:get"),
    set: (url) => ipcRenderer.invoke("server:set", url),
  },
});
