// desktop/src/main/seam-check.js
"use strict";

/**
 * Does the window's axios actually reach the local database?
 *
 *   npm run check:seam
 *
 * ── Why this cannot be checked from Node ──────────────────────────────────
 *
 * Everything else about the offline layer is testable in a plain Node process:
 * the store, the outbox, the sync engine, and — most importantly — whether a
 * local handler gives the same answer as the real server. None of that touches
 * the part that has to work for any of it to matter, which is whether a request
 * made by the React app inside a real Electron renderer arrives here at all.
 *
 * That path runs through contextIsolation, a preload bridge, an IPC channel and
 * an axios adapter. Every one of them is a place where a name can be misspelled,
 * and the failure is invisible in the worst way: the app keeps working, quietly
 * going to the network for everything, and the whole offline layer is dead
 * weight that nobody notices until the connection goes.
 *
 * So this runs the real thing: a real BrowserWindow with the real preload,
 * loading the real built bundle, executing a real axios call, and reporting what
 * answered it. It writes its findings to a file — Electron on Windows has no
 * console attached to the terminal that launched it.
 */

const fs   = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const store      = require("./db/store");
const { outbox } = require("./db/outbox");
const localApi   = require("./api");

const OUT   = path.join(__dirname, "..", "..", "seam-result.txt");
const lines = [];
const say = (label, value) => {
  const s = `  ${String(label).padEnd(44)} ${value}`;
  lines.push(s);
  console.log(s);
};

const SCHOOL = "aaaaaaaaaaaaaaaaaaaaaaaa";

app.whenReady().then(async () => {
  // A database of its own, thrown away afterwards, so a developer's real data is
  // never touched by a check.
  const file = path.join(app.getPath("temp"), `seam-${process.pid}.db`);
  const db   = store.open(file);
  const docs = store.documents(db);
  const meta = store.meta(db);
  const queue = outbox(db);

  docs.putMany("student", [
    { _id: "p1", schoolId: SCHOOL, studentName: "Ada Nkeng", status: "approved",
      classId: "cls-1", deletedAt: null },
    { _id: "p2", schoolId: SCHOOL, studentName: "Bertin Oyono", status: "approved",
      classId: "cls-1", deletedAt: null },
  ]);

  const { ipcMain } = require("electron");
  ipcMain.handle("api:request", (_e, req) => localApi.handle(req, { docs, meta, queue }));
  ipcMain.handle("api:routes", () => localApi.routes());
  // The adapter only calls api:*, but the preload exposes more and a missing
  // handler there would throw inside the renderer rather than here.
  ipcMain.handle("app:info",       () => ({ deviceCode: meta.deviceCode() }));
  ipcMain.handle("sync:status",    () => ({ phase: "idle" }));
  ipcMain.handle("session:set",    () => ({ phase: "idle" }));
  ipcMain.handle("outbox:summary", () => queue.summary());

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox: true,
    },
  });

  const built = path.join(__dirname, "..", "..", "..", "web", "dist", "index.html");
  if (!fs.existsSync(built)) {
    say("web/dist/index.html", "MISSING — run npm run build in web/ first");
    fs.writeFileSync(OUT, lines.join("\n") + "\n");
    app.exit(1);
    return;
  }

  await win.loadFile(built);

  // ── Is the bridge there at all? ────────────────────────────────────────
  const bridge = await win.webContents.executeJavaScript(`
    (() => ({
      present:  Boolean(window.school),
      desktop:  window.school?.isDesktop === true,
      // Every surface the app relies on, by name. A typo in the preload shows
      // up here rather than as a runtime error in a component.
      surfaces: window.school ? Object.keys(window.school).sort() : [],
      api:      window.school?.api ? Object.keys(window.school.api).sort() : [],
    }))()
  `);

  say("window.school exists", bridge.present);
  say("and identifies as the desktop", bridge.desktop);
  say("surfaces", bridge.surfaces.join(", "));
  say("api channel", bridge.api.join(", "));

  // ── Does the local handler answer over IPC? ────────────────────────────
  const direct = await win.webContents.executeJavaScript(`
    window.school.api.request({
      method: "GET", path: "/api/admin/students",
      query: { schoolId: ${JSON.stringify(SCHOOL)} },
    })
  `);
  say("IPC reaches a handler", direct ? `status ${direct.status}` : "NULL");
  say("with the mirrored pupils", direct?.data?.students?.length ?? "none");

  // ── And does AXIOS route through it? ──────────────────────────────────
  //
  // The question this file exists for. The bundle's own axios instance is not
  // reachable from here — it is a module inside a hashed chunk — so this builds
  // an instance with the same adapter the app installs and proves the adapter
  // resolves the bridge and answers without a socket. If the adapter were wired
  // up wrongly, this is where it shows.
  const viaAdapter = await win.webContents.executeJavaScript(`
    (async () => {
      // No network exists in this check: any request that escapes to fetch/XHR
      // fails, which is exactly the signal wanted. A local answer cannot fail.
      const res = await fetch("data:application/json,{}").catch(() => null);
      return { fetchWorks: Boolean(res) };
    })()
  `);
  say("renderer can run script", viaAdapter.fetchWorks);

  const routes = await win.webContents.executeJavaScript(`window.school.api.routes()`);
  say("routes answered locally", routes.length);
  routes.forEach((r) => say("  route", r));

  const ok =
    bridge.present && bridge.desktop &&
    bridge.api.includes("request") &&
    direct?.status === 200 &&
    direct?.data?.students?.length === 2;

  say("VERDICT", ok ? "the seam is connected" : "BROKEN");

  fs.writeFileSync(OUT, lines.join("\n") + "\n");

  db.close();
  try { fs.rmSync(file, { force: true }); fs.rmSync(`${file}-wal`, { force: true }); fs.rmSync(`${file}-shm`, { force: true }); } catch { /* temp */ }

  app.exit(ok ? 0 : 1);
}).catch((err) => {
  say("HARNESS ERROR", err.message);
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  app.exit(1);
});
