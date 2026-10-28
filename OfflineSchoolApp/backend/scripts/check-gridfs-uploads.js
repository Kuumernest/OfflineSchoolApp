// backend/scripts/check-gridfs-uploads.js
"use strict";

/**
 * Uploads kept in the app's own MongoDB (GridFS), against an in-memory
 * MongoDB, real routers behind their real authentication, real tokens.
 *
 *   config      production with no bucket picks GridFS; a bucket still picks s3;
 *               development stays on disk
 *   upload      a pupil photo through PUT /api/documents/student-photo/:id lands
 *               in GridFS with its school; a multer file is adopted off the disk
 *   resize      a logo is ≤ 512 px WebP, a photo ≤ 400 px JPEG, turned upright,
 *               EXIF/GPS gone; over 5 MB, not an image, or a corrupt image with
 *               a JPEG header: refused, nothing stored
 *   serve       /uploads/… and /files/:id stream the file with its type, ETag,
 *               ranges, 304; logos public and immutable, the rest private
 *   permission  a logo needs nobody; a photo needs a login of its school or a
 *               Super Admin — no login 401, another school 404 — or a signed
 *               link; a printed card's photo link is signed and works with no
 *               login; GET /api/files/signed-link; applicant documents never;
 *               an old /uploads/… URL whose file is gone: the placeholder
 *   delete      delete-school's dry run counts the school's GridFS files and
 *               MB; --apply removes them and keeps the other school's
 *   usage       uploads:usage reports MB per school by name
 *
 *   node scripts/check-gridfs-uploads.js
 */

const fs       = require("fs");
const path     = require("path");
const express  = require("express");
const mongoose = require("mongoose");
const jwt      = require("jsonwebtoken");
const sharp    = require("sharp");
const { stopQuietly } = require("./stopQuietly");

const ROOT = path.join(__dirname, "..");
const SRC  = path.join(ROOT, "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

/** A real image of the given size, optionally carrying EXIF with a GPS-ish tag. */
const makeImage = (w, h, { format = "jpeg", exif = false, orientation } = {}) => {
  let img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 40 } } });
  if (exif || orientation) {
    img = img.withMetadata({
      ...(orientation && { orientation }),
      ...(exif && { exif: { IFD0: { Make: "CheckCam", Model: "Serial-12345" } } }),
    });
  }
  return img[format]({ quality: 95 }).toBuffer();
};

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret-that-is-long-enough";
  process.env.NODE_ENV   = "test";

  const fileStore = require(path.join(SRC, "storage/fileStore"));
  const { configFromEnv, createStore, setStore, keyFromUrl } = fileStore;

  console.log("--- config ---");
  check("production, no bucket: GridFS", configFromEnv({ NODE_ENV: "production" }).driver, "mongo");
  check("production with STORAGE_BUCKET: still the bucket", configFromEnv({ NODE_ENV: "production", STORAGE_BUCKET: "b" }).driver, "s3");
  check("development: the local disk", configFromEnv({}).driver, "local");
  check("STORAGE_DRIVER forces one", configFromEnv({ NODE_ENV: "production", STORAGE_DRIVER: "local" }).driver, "local");

  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  const db = mongoose.connection.db;

  require(path.join(SRC, "db/models"));
  const User = mongoose.model("User"), Student = mongoose.model("Student"), School = mongoose.model("School");

  const A = "68c0000000000000000000a1", B = "68c0000000000000000000b2";
  await School.create({ _id: A, name: "Green Valley Academy", email: "a@example.test" });
  await School.create({ _id: B, name: "Kena Academy", email: "b@example.test" });
  const person = (id, role, schoolId) => User.create({
    _id: id, name: id, email: `${id}@example.test`, password: "check-only-password", role, schoolId, isActive: true,
  });
  await person("u-adminA", "school_admin", A);
  await person("u-adminB", "school_admin", B);
  await person("u-super",  "super_admin",  null);
  const PUPIL_A = "68c0000000000000000000c1", PUPIL_B = "68c0000000000000000000c2";
  await Student.create({ _id: PUPIL_A, userId: "u-pupilA", schoolId: A, studentName: "Pupil A", enrollmentNo: "GVA-1", isActive: true, status: "approved" });
  await Student.create({ _id: PUPIL_B, userId: "u-pupilB", schoolId: B, studentName: "Pupil B", enrollmentNo: "KEN-1", isActive: true, status: "approved" });

  const store = createStore({ driver: "mongo" });
  setStore(store);
  const files = db.collection("uploads.files");

  // ── the app: the real routes server.js mounts ────────────────────────────
  const app  = express();
  app.use(express.json({ limit: "20mb" }));
  const auth = require(path.join(ROOT, "middleware/auth"));
  const access = require(path.join(SRC, "storage/fileAccess"));
  const serve  = require(path.join(SRC, "storage/serveUploads"));
  const gate   = access.makeFileGate(auth.authenticate);
  app.use("/uploads/applications", require(path.join(SRC, "utils/applicationDocuments")).blockPublicApplicationsPath);
  app.get("/uploads/{*path}", serve.serveUploads({ uploadsRoot: fileStore.UPLOADS_ROOT, mediaMime: {}, gate }));
  app.get("/files/:id", serve.serveFileById({ gate }));
  app.get("/api/files/signed-link", auth.authenticate, access.signedLink);
  app.use("/api/documents", auth.authenticate, require(path.join(SRC, "routes/documents.routes")));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  const port   = server.address().port;

  const token = (id, role, schoolId) => jwt.sign({ id, role, schoolId }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const asA     = { Authorization: `Bearer ${token("u-adminA", "school_admin", A)}` };
  const asB     = { Authorization: `Bearer ${token("u-adminB", "school_admin", B)}` };
  const asSuper = { Authorization: `Bearer ${token("u-super", "super_admin", null)}` };
  const get = async (url, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers });
    return { status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) };
  };
  const put = async (url, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    let out = {}; try { out = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: out };
  };

  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n--- upload + resize ---");
  const camera = await makeImage(3000, 2000, { exif: true, orientation: 6 });
  let r = await put(`/api/documents/student-photo/${PUPIL_A}`, { schoolId: A, photoBase64: camera.toString("base64") }, asA);
  const photoUrl = r.body.photoUrl;
  check("a pupil photo uploads through the office route", [r.status, /^\/uploads\/photos\/[0-9a-f]{24}-[0-9a-f]{12}\.jpg$/.test(photoUrl ?? "")], [200, true]);
  const photoKey = keyFromUrl(photoUrl);
  const photoDoc = await files.findOne({ filename: photoKey });
  check("it is in GridFS, filed under its school, as a JPEG", [!!photoDoc, photoDoc?.metadata?.schoolId, photoDoc?.metadata?.contentType], [true, A, "image/jpeg"]);
  check("and the record points at it", (await Student.findById(PUPIL_A).lean()).photoUrl, photoUrl);
  const photoBytes = await store.read(photoKey);
  const pm = await sharp(photoBytes).metadata();
  // 3000×2000 tagged "rotate 90°" is a portrait 2000×3000: upright, at most 400 px.
  check("photo: upright, at most 400 px, JPEG", [pm.format, pm.width, pm.height], ["jpeg", 267, 400]);
  check("photo: EXIF gone (camera, serial, orientation)", [pm.exif === undefined, pm.orientation === undefined], [true, true]);
  check("photo: a few KB instead of the camera's file", photoBytes.length < camera.length / 5 && photoBytes.length < 60 * 1024, true);

  const logoStorage = require(path.join(SRC, "utils/logoStorage"));
  const bigPng = await makeImage(2000, 1000, { format: "png" });
  const logo = await logoStorage.saveLogoFromBase64(A, bigPng.toString("base64"));
  const lm = await sharp(await store.read(keyFromUrl(logo.publicPath))).metadata();
  check("logo: at most 512 px, WebP, filed under its school",
    [lm.format, lm.width, lm.height, (await files.findOne({ filename: keyFromUrl(logo.publicPath) }))?.metadata?.schoolId], ["webp", 512, 256, A]);
  const small = await logoStorage.saveLogoFromBase64(A, (await makeImage(100, 80, { format: "png" })).toString("base64"));
  const sm = await sharp(await store.read(keyFromUrl(small.publicPath))).metadata();
  check("a small logo is not enlarged", [sm.width, sm.height], [100, 80]);

  const before = await files.countDocuments();
  const tooBig = Buffer.concat([await makeImage(10, 10), Buffer.alloc(5 * 1024 * 1024)]);
  r = await put(`/api/documents/student-photo/${PUPIL_A}`, { schoolId: A, photoBase64: tooBig.toString("base64") }, asA);
  check("over 5 MB: refused with the limit named", [r.status, /the limit is 5 MB/.test(r.body.message ?? "")], [400, true]);
  r = await put(`/api/documents/student-photo/${PUPIL_A}`, { schoolId: A, photoBase64: Buffer.from("%PDF-1.4 not a photo at all").toString("base64") }, asA);
  check("a PDF where a photo is expected: refused", [r.status, r.body.message], [400, "Photo is not a JPEG, PNG, GIF or WebP image"]);
  const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
  check("a corrupt file with a JPEG header: refused",
    await logoStorage.saveLogoFromBase64(A, corrupt.toString("base64")).then(() => "stored", (e) => e.code), "BAD_IMAGE");
  check("nothing refused was stored", await files.countDocuments(), before);

  const tmp = path.join(fileStore.UPLOADS_ROOT, "messages", `check-gridfs-${Date.now()}.pdf`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, "%PDF-1.4 attachment");
  const attachmentKey = await store.adoptLocal(tmp, { contentType: "application/pdf", schoolId: A });
  check("a multer upload is adopted into GridFS and off the disk",
    [(await store.read(attachmentKey))?.toString(), fs.existsSync(tmp), (await store.stat(attachmentKey))?.schoolId], ["%PDF-1.4 attachment", false, A]);
  await store.put("logos/x-1.webp", Buffer.from("v1"), { schoolId: A });
  await store.put("logos/x-1.webp", Buffer.from("v2"), { schoolId: A });
  check("writing a key again replaces it (one copy)", [await files.countDocuments({ filename: "logos/x-1.webp" }), (await store.read("logos/x-1.webp")).toString()], [1, "v2"]);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n--- serve ---");
  r = await get(logo.publicPath);
  check("a logo: no login, image/webp, public and immutable",
    [r.status, r.headers["content-type"], r.headers["cache-control"], r.body.subarray(8, 12).toString()],
    [200, "image/webp", "public, max-age=31536000, immutable", "WEBP"]);
  const logoId = (await store.stat(keyFromUrl(logo.publicPath))).id;
  r = await get(`/files/${logoId}`);
  check("the same logo at /files/:id", [r.status, r.headers.etag, r.body.equals(await store.read(keyFromUrl(logo.publicPath)))], [200, `"${logoId}"`, true]);
  r = await get(`/files/${logoId}`, { "If-None-Match": `"${logoId}"` });
  check("unchanged since last time: 304", r.status, 304);
  r = await get(photoUrl, { ...asA, Range: "bytes=0-9" });
  check("a range: 206 with the first ten bytes",
    [r.status, r.headers["content-range"], r.body.length, r.body.equals(photoBytes.subarray(0, 10))], [206, `bytes 0-9/${photoBytes.length}`, 10, true]);
  r = await get(photoUrl, { ...asA, Range: "bytes=999999999-" });
  check("a range past the end: 416", r.status, 416);
  r = await get("/files/not-an-id");
  check("/files/ with a malformed id: 404", r.status, 404);
  r = await get(`/files/${new mongoose.Types.ObjectId()}`);
  check("/files/ with an unknown id: 404", r.status, 404);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n--- permission ---");
  r = await get(photoUrl);
  check("a photo with no login: 401, no bytes", [r.status, r.headers["content-type"]?.startsWith("image/")], [401, false]);
  r = await get(photoUrl, asA);
  check("a photo, staff of its school: the photo, private cache, varies by login",
    [r.status, r.headers["content-type"], r.headers["cache-control"], r.headers.vary, r.body.equals(photoBytes)],
    [200, "image/jpeg", "private, max-age=3600", "Authorization", true]);
  r = await get(photoUrl, asB);
  check("a photo, staff of another school: 404, as if it did not exist", r.status, 404);
  r = await get(photoUrl, asSuper);
  check("a photo, Super Admin: the photo", r.status, 200);
  const photoId = photoDoc._id.toString();
  check("/files/:id — no login 401, other school 404, its school 200",
    [(await get(`/files/${photoId}`)).status, (await get(`/files/${photoId}`, asB)).status, (await get(`/files/${photoId}`, asA)).status], [401, 404, 200]);
  r = await get(`/uploads/${attachmentKey}`);
  check("a message attachment: no login 401", r.status, 401);
  const { signMediaPath } = require(path.join(SRC, "utils/mediaSignature"));
  r = await get(signMediaPath(attachmentKey));
  check("with its signed link, no login: served", [r.status, r.body.toString()], [200, "%PDF-1.4 attachment"]);
  r = await get(signMediaPath(photoKey).replace(/sig=\d+\./, "sig=9999999999."));
  check("a forged signature: 401", r.status, 401);

  const { resolveImageSrc } = require(path.join(SRC, "print/imageSource"));
  const cardLink = resolveImageSrc(photoUrl, { origin: `http://127.0.0.1:${port}` });
  r = await get(cardLink.replace(`http://127.0.0.1:${port}`, ""));
  check("a printed card's photo link is signed and opens with no login", [/\?sig=\d+\.[0-9a-f]{32}$/.test(cardLink), r.status], [true, 200]);
  check("a printed card's logo link stays plain", resolveImageSrc(logo.publicPath, { origin: "https://h" }), `https://h${logo.publicPath}`);

  r = await get(`/api/files/signed-link?url=${encodeURIComponent(photoUrl)}`, asA);
  const linkBody = JSON.parse(r.body.toString());
  const viaLink = await get(linkBody.url);
  check("signed-link: its school gets a one-hour link that works with no login", [r.status, linkBody.expiresInSeconds, viaLink.status], [200, 3600, 200]);
  check("signed-link: another school gets 404, no login gets 401",
    [(await get(`/api/files/signed-link?url=${encodeURIComponent(photoUrl)}`, asB)).status, (await get(`/api/files/signed-link?url=${encodeURIComponent(photoUrl)}`)).status], [404, 401]);

  await store.put("applications/birth-cert.pdf", Buffer.from("%PDF birth"), { schoolId: A });
  const appId = (await store.stat("applications/birth-cert.pdf")).id;
  check("an applicant's document: never from /uploads or /files, not even for its school",
    [(await get("/uploads/applications/birth-cert.pdf", asA)).status, (await get(`/files/${appId}`, asA)).status], [404, 404]);
  r = await get("/uploads/logos/6a4ccbfac10ad6faa189bd85-ad40837113a2.jpg");
  check("an old logo URL whose file was lost in a deploy: the placeholder, not a 404",
    [r.status, r.headers["content-type"], r.headers["x-upload-missing"]], [200, "image/png", "1"]);
  r = await get("/uploads/photos/68c0000000000000000000c1-000000000000.jpg");
  check("an old photo URL, gone: the placeholder, no login needed", [r.status, r.headers["x-upload-missing"]], [200, "1"]);
  r = await get("/uploads/content/document/gone.pdf");
  check("a missing document: 404", r.status, 404);

  // A file written before schools were recorded: a photo's school comes from its pupil.
  await store.put(`photos/${PUPIL_B}-aaaaaaaaaaaa.jpg`, photoBytes);
  check("an old photo with no school recorded: its pupil's school decides",
    [(await get(`/uploads/photos/${PUPIL_B}-aaaaaaaaaaaa.jpg`, asA)).status, (await get(`/uploads/photos/${PUPIL_B}-aaaaaaaaaaaa.jpg`, asB)).status], [404, 200]);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n--- delete-school ---");
  await store.put(`photos/${PUPIL_B}-bbbbbbbbbbbb.jpg`, photoBytes, { schoolId: B });
  await store.put("content/notes/kena-notes.pdf", Buffer.alloc(2048), { schoolId: B });
  const { run } = require("./delete-school");
  const aBefore = (await store.schoolFiles(A)).count;
  // A local store, as on a laptop: GridFS in the database is cleaned all the same.
  const laptop = createStore({ driver: "local", root: fs.mkdtempSync(path.join(require("os").tmpdir(), "gridfs-check-")) });
  const dry = await run({ school: B, store: laptop });
  check("dry run: counts the school's GridFS files and their size",
    [dry.plan.gridfs.files, dry.plan.gridfs.bytes, dry.result], [3, photoBytes.length * 2 + 2048, undefined]);
  check("dry run: writes nothing", (await store.schoolFiles(B)).count, 2);
  const done = await run({ school: B, apply: true, confirm: "Kena Academy", store: laptop });
  check("apply: the school's GridFS files are gone", [done.result.gridfsRemoved, (await store.schoolFiles(B)).count,
    await store.stat(`photos/${PUPIL_B}-aaaaaaaaaaaa.jpg`)], [3, 0, null]);
  check("apply: the other school's files stay", [(await store.schoolFiles(A)).count, !!(await store.stat(photoKey))], [aBefore, true]);
  check("apply: no orphan chunks left behind",
    await db.collection("uploads.chunks").countDocuments({ files_id: { $nin: (await files.find().project({ _id: 1 }).toArray()).map((f) => f._id) } }), 0);

  // ═════════════════════════════════════════════════════════════════════════
  console.log("\n--- usage ---");
  const { usage } = require("./uploads-usage");
  const u = await usage(db);
  const gva = u.perSchool.find((x) => x.schoolId === A);
  check("uploads:usage: per school, by name, files and bytes match GridFS",
    [gva?.name, gva?.files, gva?.bytes], ["Green Valley Academy", (await store.schoolFiles(A)).count, (await store.schoolFiles(A)).bytes]);
  check("uploads:usage: the limit is 512 MB", u.limitMb, 512);

  server.close();
  await mongoose.disconnect();
  await stopQuietly(mongo);
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("\nHarness error:", err); process.exit(1); });
