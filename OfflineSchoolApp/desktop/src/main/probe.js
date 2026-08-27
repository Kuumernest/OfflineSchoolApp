// desktop/src/main/probe.js
"use strict";

/**
 * Does THIS Electron's bundled Node give us a database?
 *
 *   npm run probe
 *
 * The whole storage design turns on the answer. node:sqlite arrived in Node
 * 22.5 behind --experimental-sqlite and became available unflagged later, so
 * whether it works here depends on which Node this Electron happens to embed —
 * a question no documentation answers as reliably as asking the binary.
 *
 * It matters more than usual because there is no C++ toolchain on this machine:
 * if the built-in module is unavailable, the alternative is better-sqlite3,
 * which for Electron means either a matching prebuild or a compile that cannot
 * happen here. So this runs before any code is written against either.
 *
 * Opens no window, and writes its findings to a FILE as well as stdout.
 *
 * The file is not belt-and-braces. On Windows the electron binary is linked as
 * a GUI-subsystem application, so it has no console attached and nothing it
 * writes to stdout reaches the terminal that launched it — the first run of
 * this probe produced a completely silent hang, which looks exactly like a
 * crash. Anything a script needs to report from inside Electron on Windows has
 * to leave through the filesystem.
 */

const fs   = require("fs");
const path = require("path");
const { app } = require("electron");

const OUT   = path.join(__dirname, "..", "..", "probe-result.txt");
const lines = [];

const line = (label, value) => {
  const s = `  ${String(label).padEnd(30)} ${value}`;
  lines.push(s);
  console.log(s);
};

const finish = (code) => {
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  app.exit(code);
};

app.whenReady().then(() => {
  console.log("");
  line("electron", process.versions.electron);
  line("node", process.versions.node);
  line("chrome", process.versions.chrome);
  line("v8", process.versions.v8);
  console.log("");

  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
    line("require('node:sqlite')", "OK");
  } catch (err) {
    line("require('node:sqlite')", `UNAVAILABLE — ${err.message.split("\n")[0]}`);
    line("verdict", "FALL BACK to better-sqlite3, or --experimental-sqlite");
    finish(1);
    return;
  }

  try {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, json TEXT NOT NULL)");
    db.prepare("INSERT INTO t VALUES (?, ?)").run("a", JSON.stringify({ n: 41 }));

    // JSON1 and expression indexes are not optional for us: the document store
    // filters inside the payload rather than mirroring sixty schemas by hand.
    db.exec("CREATE INDEX idx_n ON t(json_extract(json, '$.n'))");
    const row = db.prepare("SELECT json_extract(json,'$.n') AS n FROM t WHERE id='a'").get();
    line("json1 + expression index", `OK (n=${row.n})`);

    // Durability, which is the reason this app exists on a desktop at all.
    const mode = db.prepare("PRAGMA journal_mode=WAL").get();
    db.exec("PRAGMA synchronous=FULL");
    const sync = db.prepare("PRAGMA synchronous").get();
    line("journal_mode", mode.journal_mode);
    line("synchronous", sync.synchronous === 2 ? "FULL (2)" : String(sync.synchronous));

    db.close();
    line("verdict", "USABLE — no native module required");
    finish(0);
  } catch (err) {
    line("sqlite exercise", `FAILED — ${err.message.split("\n")[0]}`);
    line("verdict", "FALL BACK to better-sqlite3");
    finish(1);
  }
});
