// backend/src/storage/fileStore.js
"use strict";

/**
 * Where uploaded files live — one small module, three drivers.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * Every upload (school logos, student photos, admission documents, teacher
 * content, message attachments) was written to backend/src/uploads on the
 * server's own disk. On Render that disk is rebuilt on every deploy, so each
 * deploy deleted every file while the records kept pointing at them: Green
 * Valley's logo went 404 after the 22:13 UTC redeploy of 2026-10-27.
 *
 *   local  the uploads directory, as before — development, tests, desktop
 *   mongo  GridFS in the app's own MongoDB (collections uploads.files and
 *          uploads.chunks) — production's default: no extra account, no
 *          extra variable, and the files go wherever the database goes
 *   s3     an S3-compatible bucket (Cloudflare R2, any S3), when one is set up
 *
 * ── Keys and URLs ─────────────────────────────────────────────────────────
 *
 * A file's key is its path under uploads/: "logos/<school>-<hash>.jpg". The
 * records keep the URL they always had, "/uploads/logos/…", and server.js
 * answers that URL from whichever driver is configured — streaming it from
 * GridFS, redirecting to a bucket — so nothing stored has to change and old
 * records keep working. A GridFS file is also reachable as /files/<id>.
 *
 * A file can carry the school it belongs to (put(…, { schoolId })): GridFS
 * keeps it in the file's metadata, which is what decides who may read it and
 * what deleting a school removes.
 *
 * The bucket stays PRIVATE. A file is handed out as a short-lived signed URL,
 * except under PUBLIC_DIRS (school logos, which the public school list shows
 * anyway) when STORAGE_PUBLIC_URL names the bucket's public domain.
 *
 * ── Configuration (environment) ───────────────────────────────────────────
 *
 *   STORAGE_DRIVER              local | mongo | s3   (default: s3 when STORAGE_BUCKET
 *                               is set, else mongo in production, else local)
 *   STORAGE_BUCKET              bucket name
 *   STORAGE_ENDPOINT            https://<account id>.r2.cloudflarestorage.com for R2
 *   STORAGE_REGION              "auto" for R2 (default)
 *   STORAGE_ACCESS_KEY_ID       an R2 API token's access key id
 *   STORAGE_SECRET_ACCESS_KEY   and its secret
 *   STORAGE_PUBLIC_URL          optional: https://files.example.com, for logos
 *   STORAGE_SIGNED_URL_SECONDS  optional: lifetime of a signed URL (default 3600)
 *
 * No secret is read anywhere else, and none is logged.
 */

const fs     = require("fs");
const path   = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const UPLOADS_ROOT = path.resolve(__dirname, "..", "uploads");

/** Directories whose files may be served from the bucket's public URL. */
const PUBLIC_DIRS = ["logos"];

/** Directories of images a missing file is replaced by a placeholder for. */
const IMAGE_DIRS = ["logos", "photos"];

const CONTENT_TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain", ".csv": "text/csv", ".zip": "application/zip",
};
/** GridFS bucket name: its collections are uploads.files and uploads.chunks. */
const GRIDFS_BUCKET = "uploads";

const contentTypeOf = (key) => CONTENT_TYPES[path.extname(String(key)).toLowerCase()] || "application/octet-stream";

// ─────────────────────────────────────────────────────────────────────────────
// KEYS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A key as stored, or null when it is not one: relative, forward slashes, no
 * "." or ".." segment, nothing empty. Every driver call goes through this, so
 * no caller can reach outside uploads/ or the bucket's own layout.
 */
const cleanKey = (key) => {
  const k = String(key ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!k || k.length > 512) return null;
  const parts = k.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  return parts.join("/");
};

/**
 * The key a stored value names: "/uploads/logos/x.jpg", "uploads/logos/x.jpg",
 * or an absolute URL to that path on any host (teacher content was stored with
 * the server's own origin in front). Null for anything else.
 */
const keyFromUrl = (value) => {
  if (!value || typeof value !== "string") return null;
  let p = value.trim();
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { return null; }
  }
  const m = /^\/?uploads\/([^?#]+)/i.exec(p.split("?")[0]);
  if (!m) return null;
  let rest;
  try { rest = decodeURIComponent(m[1]); } catch { return null; }
  return cleanKey(rest);
};

/** The key of a file written under the local uploads directory, or null. */
const keyOfLocalPath = (absPath, root = UPLOADS_ROOT) => {
  if (!absPath) return null;
  const rel = path.relative(path.resolve(root), path.resolve(String(absPath)));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return cleanKey(rel.split(path.sep).join("/"));
};

const dirOf = (key) => String(key).split("/")[0];

// ─────────────────────────────────────────────────────────────────────────────
// DRIVERS
// ─────────────────────────────────────────────────────────────────────────────

function localDriver({ root = UPLOADS_ROOT } = {}) {
  const base = path.resolve(root);
  const abs = (key) => {
    const k = cleanKey(key);
    if (!k) return null;
    const p = path.resolve(base, k);
    return p.startsWith(base + path.sep) ? p : null;
  };
  return {
    driver: "local",
    root: base,
    absolutePath: abs,
    async put(key, body) {
      const p = abs(key);
      if (!p) throw new Error(`Not a storable key: ${key}`);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, body);
    },
    async putFile(key, localPath) {
      const p = abs(key);
      if (!p) throw new Error(`Not a storable key: ${key}`);
      if (path.resolve(localPath) === p) return;          // already where it belongs
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.copyFile(localPath, p);
      await fs.promises.unlink(localPath).catch(() => {});
    },
    async stat(key) {
      const p = abs(key);
      try {
        const s = p && await fs.promises.stat(p);
        return s && s.isFile() ? { size: s.size, contentType: contentTypeOf(key) } : null;
      } catch { return null; }
    },
    async read(key) {
      const p = abs(key);
      try { return p ? await fs.promises.readFile(p) : null; } catch { return null; }
    },
    readSync(key) {
      const p = abs(key);
      try { return p && fs.statSync(p).isFile() ? fs.readFileSync(p) : null; } catch { return null; }
    },
    existsSync(key) {
      const p = abs(key);
      try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
    },
    async remove(key) {
      const p = abs(key);
      if (!p) return false;
      try { await fs.promises.unlink(p); return true; } catch { return false; }
    },
    /** Keys that start with `prefix` ("logos/<school id>-"), one directory deep. */
    async list(prefix) {
      const cut  = prefix.lastIndexOf("/");
      const dir  = cut >= 0 ? abs(prefix.slice(0, cut)) : base;
      const stem = prefix.slice(cut + 1);
      if (!dir) return [];
      try {
        return (await fs.promises.readdir(dir, { withFileTypes: true }))
          .filter((e) => e.isFile() && e.name.startsWith(stem))
          .map((e) => `${prefix.slice(0, cut + 1)}${e.name}`);
      } catch { return []; }
    },
    /** Local files are served by server.js itself, at the URL they always had. */
    async url(key) { return `/uploads/${key}`; },
  };
}

/**
 * GridFS in the app's MongoDB. A file's GridFS filename is its key; its
 * metadata holds { contentType, schoolId }. Writing a key again replaces it.
 *
 * @param {object} cfg
 * @param {object|Function} [cfg.db]  a Db, or () => Db; default mongoose's connection
 */
function mongoDriver(cfg = {}) {
  const mongoose   = require("mongoose");
  const { GridFSBucket, ObjectId } = mongoose.mongo;
  const bucketName = cfg.bucketName || GRIDFS_BUCKET;
  const getDb = () => {
    const db = typeof cfg.db === "function" ? cfg.db() : (cfg.db || mongoose.connection.db);
    if (!db) throw new Error("MongoDB is not connected — the mongo storage driver uses the app's connection");
    return db;
  };
  const bucket = () => new GridFSBucket(getDb(), { bucketName });
  const files  = () => getDb().collection(`${bucketName}.files`);
  const need = (key) => {
    const k = cleanKey(key);
    if (!k) throw new Error(`Not a storable key: ${key}`);
    return k;
  };
  let indexed = null;
  const ensureIndexes = () => (indexed ??= files().createIndex({ "metadata.schoolId": 1 })
    .catch((err) => { indexed = null; console.warn("[fileStore] GridFS index:", err.message); }));

  const latest = (k) => files().find({ filename: k }).sort({ uploadDate: -1, _id: -1 }).limit(1).next();
  const describe = (doc) => doc && {
    id:          String(doc._id),
    key:         doc.filename,
    size:        doc.length,
    contentType: doc.metadata?.contentType || contentTypeOf(doc.filename),
    schoolId:    doc.metadata?.schoolId ?? null,
    uploadDate:  doc.uploadDate,
  };

  const write = async (key, source, { contentType, schoolId } = {}) => {
    const k = need(key);
    await ensureIndexes();
    const up = bucket().openUploadStream(k, {
      metadata: { contentType: contentType || contentTypeOf(k), schoolId: schoolId ? String(schoolId) : null },
    });
    await pipeline(source, up);
    // The new copy is in; older ones under the same key go.
    const older = await files().find({ filename: k, _id: { $ne: up.id } }).project({ _id: 1 }).toArray();
    for (const o of older) await bucket().delete(o._id).catch(() => {});
    return String(up.id);
  };

  return {
    driver: "mongo",
    bucketName,
    async put(key, body, opts) { return write(key, Readable.from([Buffer.from(body)]), opts); },
    /** Upload a file from disk, then drop the local copy — the disk is not kept. */
    async putFile(key, localPath, opts) {
      const id = await write(key, fs.createReadStream(localPath), opts);
      await fs.promises.unlink(localPath).catch(() => {});
      return id;
    },
    async stat(key) {
      const k = cleanKey(key);
      return k ? describe(await latest(k)) : null;
    },
    /** A file by its GridFS id — what /files/<id> names. */
    async statId(id) {
      if (!ObjectId.isValid(String(id)) || !/^[0-9a-f]{24}$/i.test(String(id))) return null;
      return describe(await files().findOne({ _id: new ObjectId(String(id)) }));
    },
    /** A stream of a file's bytes, or of bytes [start, end] inclusive. */
    openStream(id, { start, end } = {}) {
      const range = start !== undefined ? { start, end: end + 1 } : {};
      return bucket().openDownloadStream(new ObjectId(String(id)), range);
    },
    async read(key) {
      const k = cleanKey(key);
      const doc = k && await latest(k);
      if (!doc) return null;
      const chunks = [];
      for await (const c of bucket().openDownloadStream(doc._id)) chunks.push(c);
      return Buffer.concat(chunks);
    },
    async remove(key) {
      const k = cleanKey(key);
      if (!k) return false;
      const all = await files().find({ filename: k }).project({ _id: 1 }).toArray();
      for (const o of all) await bucket().delete(o._id).catch(() => {});
      return all.length > 0;
    },
    async list(prefix) {
      const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return (await files().distinct("filename", { filename: new RegExp("^" + escaped) })).sort();
    },
    /** Files filed under a school: { count, bytes, keys }. */
    async schoolFiles(schoolId) {
      const docs = await files().find({ "metadata.schoolId": String(schoolId) })
        .project({ filename: 1, length: 1 }).toArray();
      return { count: docs.length, bytes: docs.reduce((n, d) => n + (d.length || 0), 0), keys: docs.map((d) => d.filename) };
    },
    /** Remove every file filed under a school. Returns how many went. */
    async removeSchool(schoolId) {
      const docs = await files().find({ "metadata.schoolId": String(schoolId) }).project({ _id: 1 }).toArray();
      let n = 0;
      for (const d of docs) { try { await bucket().delete(d._id); n++; } catch { /* gone already */ } }
      return n;
    },
    /** Bytes and files per school (null: files filed under no school). */
    async usageBySchool() {
      return files().aggregate([
        { $group: { _id: "$metadata.schoolId", files: { $sum: 1 }, bytes: { $sum: "$length" } } },
        { $sort: { bytes: -1 } },
      ]).toArray();
    },
    /** The app itself serves GridFS files, at the URL records keep. */
    async url(key) { return `/uploads/${need(key)}`; },
  };
}

/**
 * @param {object} cfg
 * @param {object} [cfg.client]   an S3Client, or anything with send(command) — the tests' fake
 * @param {Function} [cfg.presign] (key, seconds) => url; defaults to the SDK's presigner
 */
function s3Driver(cfg) {
  const sdk = require("@aws-sdk/client-s3");
  const { bucket, publicUrl = null, signedSeconds = 3600 } = cfg;
  if (!bucket) throw new Error("STORAGE_BUCKET is required for the s3 storage driver");
  const client = cfg.client || new sdk.S3Client({
    region:   cfg.region || "auto",
    endpoint: cfg.endpoint || undefined,
    forcePathStyle: !!cfg.endpoint,
    credentials: cfg.accessKeyId && cfg.secretAccessKey
      ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
      : undefined,
  });
  const presign = cfg.presign || ((key, expiresIn) => {
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
    return getSignedUrl(client, new sdk.GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
  });
  const missing = (err) => err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
  const need = (key) => {
    const k = cleanKey(key);
    if (!k) throw new Error(`Not a storable key: ${key}`);
    return k;
  };
  const toBuffer = async (body) => {
    if (!body) return null;
    if (Buffer.isBuffer(body)) return body;
    if (typeof body.transformToByteArray === "function") return Buffer.from(await body.transformToByteArray());
    const chunks = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  };

  return {
    driver: "s3",
    bucket,
    client,
    async put(key, body, { contentType } = {}) {
      const k = need(key);
      await client.send(new sdk.PutObjectCommand({
        Bucket: bucket, Key: k, Body: body, ContentType: contentType || contentTypeOf(k),
      }));
    },
    /** Upload a file from disk, then drop the local copy — the disk is not kept. */
    async putFile(key, localPath, { contentType } = {}) {
      const k = need(key);
      const { size } = await fs.promises.stat(localPath);
      await client.send(new sdk.PutObjectCommand({
        Bucket: bucket, Key: k, Body: fs.createReadStream(localPath), ContentLength: size,
        ContentType: contentType || contentTypeOf(k),
      }));
      await fs.promises.unlink(localPath).catch(() => {});
    },
    async stat(key) {
      const k = cleanKey(key);
      if (!k) return null;
      try {
        const h = await client.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: k }));
        return { size: h.ContentLength ?? null, contentType: h.ContentType || contentTypeOf(k) };
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    async read(key) {
      const k = cleanKey(key);
      if (!k) return null;
      try {
        const r = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: k }));
        return toBuffer(r.Body);
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    async remove(key) {
      const k = cleanKey(key);
      if (!k) return false;
      await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: k }));
      return true;
    },
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const r = await client.send(new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) keys.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    /** Where a client fetches the file: the public domain for logos, else a signed URL. */
    async url(key, { seconds = signedSeconds } = {}) {
      const k = need(key);
      if (publicUrl && PUBLIC_DIRS.includes(dirOf(k))) {
        return `${publicUrl.replace(/\/+$/, "")}/${k.split("/").map(encodeURIComponent).join("/")}`;
      }
      return presign(k, seconds);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE STORE
// ─────────────────────────────────────────────────────────────────────────────

/** A store from explicit settings — the tests', and fromEnv's. */
function createStore(cfg = {}) {
  const d = cfg.driver === "s3" ? s3Driver(cfg)
    : cfg.driver === "mongo" ? mongoDriver(cfg)
    : localDriver(cfg);

  // Images the print renderers embed, which they read synchronously: loaded
  // by warmImages() before a document is built. Small and short-lived.
  const cache = new Map();          // key → Buffer | null (known missing)
  const CACHE_MAX = 64;
  const remember = (key, buf) => {
    cache.delete(key);
    cache.set(key, buf);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  };

  const store = {
    ...d,
    contentTypeOf,
    isImageDir: (key) => IMAGE_DIRS.includes(dirOf(key)),
    isPublicDir: (key) => PUBLIC_DIRS.includes(dirOf(key)),

    /** Write bytes. opts: { contentType, schoolId }. */
    async put(key, body, opts) { const r = await d.put(key, body, opts); cache.delete(cleanKey(key)); return r; },

    /**
     * A file multer (or a base64 decoder) has just written under uploads/:
     * moved into the store. With the local driver it is already there.
     */
    async adoptLocal(localPath, { contentType, schoolId } = {}) {
      const key = keyOfLocalPath(localPath, d.driver === "local" ? d.root : UPLOADS_ROOT);
      if (!key) throw new Error(`Not under uploads/: ${localPath}`);
      await d.putFile(key, localPath, { contentType, schoolId });
      return key;
    },

    async remove(key) { cache.delete(cleanKey(key)); return d.remove(key); },

    /** Remove a file named by its local path (multer's), wherever it now lives. */
    async removeLocalPath(localPath) {
      if (!localPath) return false;
      await fs.promises.unlink(localPath).catch(() => {});
      const key = keyOfLocalPath(localPath, d.driver === "local" ? d.root : UPLOADS_ROOT);
      return key ? store.remove(key) : false;
    },

    /** Remove the file a stored URL names. Never throws. */
    async removeUrl(value) {
      const key = keyFromUrl(value);
      if (!key) return false;
      try { return await store.remove(key); } catch (err) {
        console.warn("[fileStore] remove failed:", err.message);
        return false;
      }
    },

    /** Load the logos and photos a document is about to embed. */
    async warmImages(values) {
      for (const v of [].concat(values || [])) {
        const key = keyFromUrl(v);
        if (!key || !IMAGE_DIRS.includes(dirOf(key)) || d.driver === "local" || cache.has(key)) continue;
        try { remember(key, await d.read(key)); } catch { /* left to link */ }
      }
    },

    /** Bytes of an image, synchronously: from disk, or what warmImages loaded. */
    readImageSync(key) {
      if (d.driver === "local") return d.readSync(key);
      return cache.get(cleanKey(key)) ?? null;
    },

    /**
     * Whether a file is there, synchronously, for the print renderers: the disk
     * for local; for a bucket, false only when warmImages found it missing —
     * otherwise the link is printed and server.js answers it (with a
     * placeholder if the file has gone).
     */
    existsSync(key) {
      if (d.driver === "local") return d.existsSync(key);
      const k = cleanKey(key);
      return !(cache.has(k) && cache.get(k) === null);
    },
  };
  return store;
}

/** The store the environment describes. */
function configFromEnv(env = process.env) {
  // Production keeps uploads in its own database unless a bucket is named:
  // the server's disk does not survive a deploy, and GridFS needs nothing new.
  const driver = (env.STORAGE_DRIVER
    || (env.STORAGE_BUCKET ? "s3" : env.NODE_ENV === "production" ? "mongo" : "local")).toLowerCase();
  return {
    driver,
    bucket:          env.STORAGE_BUCKET || null,
    endpoint:        env.STORAGE_ENDPOINT || null,
    region:          env.STORAGE_REGION || "auto",
    accessKeyId:     env.STORAGE_ACCESS_KEY_ID || null,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY || null,
    publicUrl:       env.STORAGE_PUBLIC_URL || null,
    signedSeconds:   Number(env.STORAGE_SIGNED_URL_SECONDS) > 0 ? Number(env.STORAGE_SIGNED_URL_SECONDS) : 3600,
  };
}

let current = null;

/** The app's store, made on first use from the environment. */
const getStore = () => (current ??= createStore(configFromEnv()));

/** Tests (and only tests) swap the store. */
const setStore = (store) => { current = store; };

module.exports = {
  UPLOADS_ROOT, PUBLIC_DIRS, IMAGE_DIRS, GRIDFS_BUCKET,
  cleanKey, keyFromUrl, keyOfLocalPath, contentTypeOf,
  createStore, configFromEnv, getStore, setStore,
};
