// backend/scripts/uploads-to-bucket.js
"use strict";

/**
 * Copy the files on this machine's uploads directory into the bucket, so the
 * records that point at them work again (src/storage/fileStore.js).
 *
 *   STORAGE_BUCKET=… STORAGE_ENDPOINT=… STORAGE_ACCESS_KEY_ID=… STORAGE_SECRET_ACCESS_KEY=… \
 *     npm run uploads:to-bucket            # dry run: what would be copied
 *   … npm run uploads:to-bucket -- --apply
 *
 * A file already in the bucket is left alone, so it can be run again. Local
 * files are never deleted. The URLs in the records do not change.
 */

const fs   = require("fs");
const path = require("path");
const { UPLOADS_ROOT, createStore, configFromEnv, keyOfLocalPath, contentTypeOf } = require("../src/storage/fileStore");

const walk = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : [])
  : [];

(async () => {
  require("dotenv").config({ quiet: true });
  const cfg = configFromEnv();
  if (cfg.driver !== "s3") { console.error("Set STORAGE_BUCKET (and the STORAGE_* credentials) first."); process.exit(2); }
  const store = createStore(cfg);
  const apply = process.argv.includes("--apply");
  let copied = 0, present = 0;
  for (const file of walk(UPLOADS_ROOT)) {
    const key = keyOfLocalPath(file);
    if (!key || path.basename(key).startsWith(".")) continue;
    if (await store.stat(key)) { present++; continue; }
    console.log(`${apply ? "copy" : "would copy"}  ${key}`);
    if (apply) await store.put(key, fs.readFileSync(file), { contentType: contentTypeOf(key) });
    copied++;
  }
  console.log(`\n${apply ? "Copied" : "To copy"}: ${copied}. Already in the bucket: ${present}.${apply ? "" : " Run with --apply to copy."}`);
})().catch((err) => { console.error(err.message); process.exit(1); });
