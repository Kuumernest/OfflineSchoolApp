// desktop/src/main/main.js
"use strict";

/**
 * The desktop application.
 *
 * ── What it is ────────────────────────────────────────────────────────────
 *
 * The same React console that runs in a browser, in a window, with a local
 * database behind it. Not a rewrite and not a port: web/dist is loaded as-is,
 * and the only thing that changes for it is what answers its HTTP calls.
 *
 * ── Where the data lives ─────────────────────────────────────────────────
 *
 * app.getPath("userData"), which on Windows is
 * %APPDATA%/school-desktop — outside the installation directory on purpose, so
 * an application update cannot touch the school's records and an uninstall does
 * not take them with it.
 *
 * ── Why the renderer gets no direct access to any of it ──────────────────
 *
 * contextIsolation on, nodeIntegration off, and a preload that exposes a small
 * named surface. The renderer runs the school's UI, but it also renders text
 * that came from the server and from other users — a pupil's name, an
 * announcement — and a renderer with Node in it turns any injection in that
 * text into a machine that reads the filesystem. The window gets to ask
 * questions; the main process decides how to answer them.
 */

const path = require("path");
const fs   = require("fs");

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");

const store        = require("./db/store");
const { outbox }   = require("./db/outbox");
const { client }   = require("./sync/client");
const { engine }   = require("./sync/engine");

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One window per installation.
 *
 * Two windows would mean two of everything the sync loop assumes is alone —
 * two pullers writing the same cursors, two pushers draining one queue. The
 * second launch focuses the first instead.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

let db      = null;
let docs    = null;
let queue   = null;
let syncState = null;
let metaBag = null;
let api     = null;
let sync    = null;

const DB_FILE = () => path.join(app.getPath("userData"), "data", "school.db");

/**
 * Open the database, or explain why not and stop.
 *
 * A failure here is not recoverable by carrying on: an app that runs without
 * its local database looks like it is working and silently has nowhere to put
 * the payment somebody is about to record. Better to say so and close.
 */
const openDatabase = () => {
  const file = DB_FILE();
  try {
    db        = store.open(file);
    docs      = store.documents(db);
    queue     = outbox(db);
    syncState = store.state(db);
    metaBag   = store.meta(db);

    console.log(`[db] ${file}`);
    console.log(`[db] installation ${metaBag.deviceCode()}`);

    api  = client({ meta: metaBag });
    sync = engine({
      docs, queue, state: syncState, client: api,
      // No collection list: the server decides what this caller may mirror, so
      // the desktop holds no copy of the feed table to drift from it.
      onChange: (status) => {
        // Pushed rather than polled, so a window can show "3 waiting to send"
        // without asking every second.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send("sync:status", status);
        }
      },
    });

    return true;
  } catch (err) {
    dialog.showErrorBox(
      "The local database could not be opened",
      `${err.message}\n\n${file}\n\n` +
      "The application cannot run without it. If this machine's disk is full " +
      "or the file is on a network share, that is the first thing to check."
    );
    return false;
  }
};

const createWindow = () => {
  const win = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  1024,
    minHeight: 640,
    // Shown only once there is something to look at, rather than a white
    // rectangle while the bundle parses.
    show: false,
    backgroundColor: "#F9FAFB",
    title: "School",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  // A link to somewhere else opens in the browser, not in here. A window that
  // can be navigated away from the app is a window that can be navigated to
  // somebody else's page while holding the app's session.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    const here   = new URL(win.webContents.getURL() || "file:///");
    if (target.origin !== here.origin) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // ── What to load ────────────────────────────────────────────────────────
  //
  // The dev server when one is running, so the same React hot-reload workflow
  // survives; otherwise the built bundle next door. Nothing is copied or
  // duplicated — this reads web/dist directly, so a `vite build` in the web
  // package is immediately what the desktop shows.
  const devServer = process.env.VITE_DEV_SERVER_URL;
  const built     = path.join(__dirname, "..", "..", "..", "web", "dist", "index.html");

  if (devServer) {
    console.log(`[window] ${devServer}`);
    win.loadURL(devServer);
    win.webContents.openDevTools({ mode: "detach" });
  } else if (fs.existsSync(built)) {
    console.log(`[window] ${built}`);
    win.loadFile(built);
  } else {
    // Said plainly rather than showing a blank window, because this is the
    // first thing that will go wrong for anybody building this.
    dialog.showErrorBox(
      "The interface has not been built",
      "Expected to find:\n\n" + built + "\n\n" +
      "Run `npm run build` in OfflineSchoolApp/web first, or set " +
      "VITE_DEV_SERVER_URL to a running dev server."
    );
    app.quit();
  }

  return win;
};

// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE WINDOW MAY ASK FOR
//
// Deliberately narrow, and shaped around what the renderer needs rather than
// around what the database can do. There is no "run this SQL" channel: the
// renderer is where server-supplied text is rendered, and a channel that
// executes arbitrary queries would make any injection in that text into a
// reader of the whole school's records.
// ─────────────────────────────────────────────────────────────────────────────

const registerHandlers = () => {
  // ── Facts about this installation ───────────────────────────────────────
  ipcMain.handle("app:info", () => ({
    platform:      process.platform,
    appVersion:    app.getVersion(),
    electron:      process.versions.electron,
    node:          process.versions.node,
    deviceCode:    metaBag.deviceCode(),
    dataDirectory: path.dirname(DB_FILE()),
    schemaVersion: store.SCHEMA_VERSION,
  }));

  // ── Reading the mirror ──────────────────────────────────────────────────
  ipcMain.handle("docs:get",   (_e, collection, id)            => docs.get(collection, id));
  ipcMain.handle("docs:find",  (_e, collection, filter, opts)  => docs.find(collection, filter, opts));
  ipcMain.handle("docs:count", (_e, collection, filter)        => docs.count(collection, filter));

  // ── Writing locally, and queueing the request that makes it real ────────
  //
  // One channel, because the two halves must not be separable. A document
  // written locally with no queued request is a change that will never reach
  // the school; a queued request with no local document is a screen that does
  // not show what the user just did. They commit together.
  ipcMain.handle("write:local", (_e, { collection, doc, request }) => {
    const result = docs.tx(() => {
      const id = docs.put(collection, doc, { pending: true });
      const queued = queue.add({ ...request, collection, docId: id });
      return { id, ...queued };
    });

    // Tried straight away rather than waiting for the interval. Online, this
    // makes a local write indistinguishable from a direct one; offline it costs
    // a failed connection attempt, which the backoff then spaces out.
    void sync.cycle();

    return result;
  });

  // ── The state of the queue, for the UI to show ──────────────────────────
  ipcMain.handle("outbox:summary", () => queue.summary());
  ipcMain.handle("outbox:list",    () => queue.all());
  ipcMain.handle("outbox:unblock", (_e, seq) => { queue.unblock(seq); return queue.summary(); });
  ipcMain.handle("outbox:discard", (_e, seq) => {
    const undo = queue.discard(seq);
    // The local row this request would have created has to go with it, or the
    // desktop keeps showing something the server has never heard of.
    if (undo?.collection && undo?.docId) docs.forget(undo.collection, undo.docId);
    return queue.summary();
  });

  // ── Sync bookkeeping ────────────────────────────────────────────────────
  ipcMain.handle("sync:state",  () => syncState.all());
  ipcMain.handle("sync:status", () => sync.status());

  /**
   * The renderer hands over its access token.
   *
   * The main process cannot obtain one itself — signing in is the UI's job, and
   * refreshing it is the axios layer's. So the arrangement is: whenever the
   * renderer's token changes, it says so, and the engine either starts or stops
   * accordingly. Held in memory only; see sync/client.js.
   */
  ipcMain.handle("session:set", (_e, tokenValue) => {
    api.setToken(tokenValue);
    if (tokenValue) {
      sync.start();
      // Immediately, not on the next interval: somebody who has just signed in
      // is waiting to see their data.
      void sync.cycle();
    } else {
      sync.stop();
    }
    return sync.status();
  });

  /** Which server this installation belongs to. Persisted. */
  ipcMain.handle("server:get", () => api.serverUrl() || null);
  ipcMain.handle("server:set", (_e, url) => {
    api.setServerUrl(url);
    return api.serverUrl() || null;
  });

  /** Sync now — a button, or straight after a local write. */
  ipcMain.handle("sync:now", () => sync.cycle());
};

// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (!openDatabase()) { app.quit(); return; }

  registerHandlers();
  createWindow();

  // A smoke mode, so a build can be checked without a person watching. Opens
  // everything the real launch opens, then leaves.
  if (process.env.SCHOOL_DESKTOP_SMOKE) {
    const out = path.join(__dirname, "..", "..", "smoke-result.txt");
    setTimeout(() => {
      const win = BrowserWindow.getAllWindows()[0];
      fs.writeFileSync(out, [
        `electron       ${process.versions.electron}`,
        `node           ${process.versions.node}`,
        `database       ${fs.existsSync(DB_FILE()) ? "opened" : "MISSING"}`,
        `device         ${metaBag.deviceCode()}`,
        `window         ${win ? "created" : "MISSING"}`,
        `title          ${win ? JSON.stringify(win.getTitle()) : "-"}`,
        `url            ${win ? win.webContents.getURL().slice(0, 120) : "-"}`,
        `schema         ${store.SCHEMA_VERSION}`,
      ].join("\n") + "\n");
      app.quit();
    }, Number(process.env.SCHOOL_DESKTOP_SMOKE) || 4000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the last window ends the app on every platform including macOS.
// This is a single-purpose tool for one machine in a school office, not
// something anybody wants living in a dock with no window.
app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  try { sync?.stop(); } catch { /* nothing useful to do while exiting */ }
  // Closed explicitly so WAL is checkpointed into the database file rather
  // than left beside it. It would recover either way, but a school that copies
  // school.db onto a memory stick as its backup should get a complete one.
  try { db?.close(); } catch { /* nothing useful to do while exiting */ }
});
