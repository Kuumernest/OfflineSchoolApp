// backend/scripts/uploads-usage.js
"use strict";

/**
 * How much room uploads take in the database, per school.
 *
 *   npm run uploads:usage                (MONGODB_URI from the environment)
 *
 * Uploads live in GridFS (src/storage/fileStore.js) inside the app's own
 * database, and the Atlas free tier holds 512 MB for EVERYTHING — records and
 * files together. Prints the files and MB per school (largest first), files
 * filed under no school, and the database's total size against the limit.
 * Reads only.
 */

const mongoose = require("mongoose");
const { createStore, GRIDFS_BUCKET } = require("../src/storage/fileStore");

const LIMIT_MB = Number(process.env.ATLAS_LIMIT_MB) > 0 ? Number(process.env.ATLAS_LIMIT_MB) : 512;
const MB = (bytes) => bytes / 1024 / 1024;

/** The report as data: rows per school, the GridFS totals, the database's size. */
async function usage(db) {
  const rows = await createStore({ driver: "mongo", db }).usageBySchool();
  const ids  = rows.map((r) => r._id).filter(Boolean);
  const oids = ids.filter((id) => /^[0-9a-f]{24}$/i.test(id)).map((id) => new mongoose.Types.ObjectId(id));
  const schools = await db.collection("schools")
    .find({ _id: { $in: [...ids, ...oids] } }).project({ name: 1 }).toArray();
  const nameOf = new Map(schools.map((s) => [String(s._id), s.name]));

  const perSchool = rows.map((r) => ({
    schoolId: r._id ?? null,
    name:     r._id ? (nameOf.get(String(r._id)) ?? "(school no longer exists)") : "(no school)",
    files:    r.files,
    bytes:    r.bytes,
  }));
  const files = perSchool.reduce((n, r) => n + r.files, 0);
  const bytes = perSchool.reduce((n, r) => n + r.bytes, 0);

  // What the database itself reports: GridFS's two collections and the whole
  // database, as stored (Atlas counts the database's size against the limit).
  const sizeOf = async (name) => {
    try {
      const [s] = await db.collection(name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      return { size: s?.storageStats?.size ?? 0, storage: s?.storageStats?.storageSize ?? 0 };
    } catch { return { size: 0, storage: 0 }; }
  };
  const gridfsCollections = {
    files:  await sizeOf(`${GRIDFS_BUCKET}.files`),
    chunks: await sizeOf(`${GRIDFS_BUCKET}.chunks`),
  };
  const stats = await db.stats();

  return {
    perSchool, files, bytes, gridfsCollections,
    database: { dataSize: stats.dataSize ?? 0, storageSize: stats.storageSize ?? 0, indexSize: stats.indexSize ?? 0 },
    limitMb: LIMIT_MB,
  };
}

function print(u) {
  console.log("Uploads in GridFS, per school (largest first):\n");
  console.log(`  ${"School".padEnd(40)} ${"Files".padStart(7)} ${"MB".padStart(9)}`);
  for (const r of u.perSchool) {
    console.log(`  ${r.name.slice(0, 40).padEnd(40)} ${String(r.files).padStart(7)} ${MB(r.bytes).toFixed(2).padStart(9)}`);
  }
  console.log(`  ${"TOTAL".padEnd(40)} ${String(u.files).padStart(7)} ${MB(u.bytes).toFixed(2).padStart(9)}`);

  const used = u.database.dataSize + u.database.indexSize;
  console.log(`\nGridFS collections: ${MB(u.gridfsCollections.chunks.size + u.gridfsCollections.files.size).toFixed(2)} MB of data`);
  console.log(`Whole database: ${MB(u.database.dataSize).toFixed(2)} MB data + ${MB(u.database.indexSize).toFixed(2)} MB indexes` +
    ` = ${MB(used).toFixed(2)} MB of the ${u.limitMb} MB limit (${((MB(used) / u.limitMb) * 100).toFixed(1)}%)`);
  if (MB(used) > u.limitMb * 0.8) {
    console.log("⚠️  Over 80% of the limit — clean up, upgrade the cluster, or move uploads to a bucket (STORAGE_BUCKET).");
  }
}

module.exports = { usage, print };

if (require.main === module) {
  require("dotenv").config();
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    print(await usage(mongoose.connection.db));
    await mongoose.disconnect();
  })().catch(async (e) => {
    console.error(e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
