#!/usr/bin/env node
"use strict";

/**
 * Moves inline base64 school logos out of MongoDB and onto disk.
 *
 * Before: School.logo held ~160 KB of base64 — about 99% of the document, so
 * reading any school from the remote cluster cost ~5 seconds.
 * After:  the bytes live in uploads/logos and the document holds a short
 *         public path like /uploads/logos/<id>-<hash>.jpg.
 *
 * Safe to run repeatedly: schools whose logo is already a path are skipped.
 *
 * Usage
 *   node scripts/migrate-school-logos.js --dry-run   # report only, no writes
 *   node scripts/migrate-school-logos.js             # perform the migration
 *   node scripts/migrate-school-logos.js --keep      # write files, keep base64
 *
 * --keep writes the files but leaves the documents untouched, so you can
 * verify the images render before committing to the field change.
 */

require("dotenv").config({ quiet: true });

const path     = require("path");
const mongoose = require("mongoose");

const School      = require("../src/db/models/School");
const logoStorage = require("../src/utils/logoStorage");

const argv    = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run") || argv.includes("-n");
const KEEP    = argv.includes("--keep");

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/** Never print a logo value in full — one of them is 160 KB of base64. */
const brief = (v, max = 60) => {
  const s = String(v ?? "");
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
};

const main = async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set — check backend/.env");
    process.exit(1);
  }

  console.log(
    DRY_RUN ? "DRY RUN — nothing will be written\n"
            : KEEP ? "Writing files, leaving documents unchanged\n"
                   : "Migrating logos to disk\n"
  );

  await mongoose.connect(uri);

  // Only pull _id here. Selecting `logo` for every school up front would
  // transfer every blob we are trying to get rid of, so each one is fetched
  // individually and released before the next.
  const ids = await School.find({}, { _id: 1 }).lean();
  console.log(`${ids.length} school(s) found\n`);

  const stats = {
    migrated: 0, alreadyDone: 0, empty: 0, failed: 0, bytesFreed: 0,
  };

  for (const { _id } of ids) {
    const doc = await School.findById(_id).select("name logo").lean();
    const name = doc?.name || String(_id);
    const logo = doc?.logo;

    if (!logo || !String(logo).trim()) {
      console.log(`  ─ ${name}: no logo`);
      stats.empty++;
      continue;
    }

    if (logoStorage.isLogoReference(logo)) {
      console.log(`  ✓ ${name}: already a path (${brief(logo)})`);
      stats.alreadyDone++;
      continue;
    }

    const inlineBytes = Buffer.byteLength(String(logo).trim());

    try {
      if (DRY_RUN) {
        // Decode only far enough to confirm it is a real image.
        const buf  = Buffer.from(logoStorage.stripDataUri(logo), "base64");
        const kind = logoStorage.sniffImage(buf);
        if (!kind) throw new Error("unrecognised image format");
        console.log(
          `  → ${name}: would write ${kind.ext} (${kb(buf.length)}), ` +
          `freeing ${kb(inlineBytes)} from the document`
        );
        stats.migrated++;
        stats.bytesFreed += inlineBytes;
        continue;
      }

      const saved = logoStorage.saveLogoFromBase64(String(_id), logo);

      if (KEEP) {
        console.log(
          `  → ${name}: wrote ${saved.filename} (${kb(saved.bytes)}) — document untouched`
        );
        stats.migrated++;
        continue;
      }

      await School.updateOne({ _id }, { $set: { logo: saved.publicPath } });

      console.log(
        `  ✓ ${name}: ${kb(inlineBytes)} inline → ${saved.publicPath} (${kb(saved.bytes)})`
      );
      stats.migrated++;
      stats.bytesFreed += inlineBytes;
    } catch (err) {
      console.log(`  ✗ ${name}: ${err.message}`);
      stats.failed++;
    }
  }

  console.log(
    `\nmigrated=${stats.migrated} already-done=${stats.alreadyDone} ` +
    `no-logo=${stats.empty} failed=${stats.failed}`
  );
  if (stats.bytesFreed) {
    console.log(`documents shrunk by ${kb(stats.bytesFreed)} in total`);
  }
  if (!DRY_RUN && !KEEP && stats.migrated) {
    console.log(`files written to ${path.relative(process.cwd(), logoStorage.LOGO_DIR)}`);
  }

  await mongoose.disconnect();
};

main().catch(async (err) => {
  console.error("\nMigration failed:", err.message);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
