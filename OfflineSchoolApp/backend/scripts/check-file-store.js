// backend/scripts/check-file-store.js
"use strict";

/**
 * Uploads survive a deploy: they go to the file store (src/storage/fileStore.js),
 * a bucket in production, and the URLs records already hold keep working.
 * Against a FAKE bucket — an in-memory S3 client — so no network, no account.
 *
 *   keys        a key cannot leave uploads/; stored URLs of every shape map to one
 *   config      STORAGE_BUCKET picks the bucket; no secret in code or in the store
 *   driver      put / stat / read / list (paged) / remove against the bucket;
 *               the SDK's real presigner signs a URL offline, secret not in it
 *   writers     a logo, a photo and a multer upload land in the bucket, not on
 *               disk; the same logo twice is one object; deleting removes it
 *   serving     /uploads/… redirects to a signed URL (to the public URL for a
 *               logo); Green Valley's lost logo URL works once the file is in
 *               the bucket and shows a placeholder until then; a missing
 *               document is a 404; applicant documents stay closed; a message
 *               attachment still needs its signature; traversal is refused
 *   print       a logo embeds after warmImages; a missing one prints nothing
 *   delete (D2) deleting a school removes its files from the bucket — the
 *               logo, an old replaced logo, a pupil's photo — and keeps
 *               another school's
 *
 *   node scripts/check-file-store.js
 */

const fs       = require("fs");
const os       = require("os");
const path     = require("path");
const http     = require("http");
const express  = require("express");
const mongoose = require("mongoose");
const { stopQuietly } = require("./stopQuietly");

const SRC = path.join(__dirname, "..", "src");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`); }
};

/** An S3 client that keeps objects in a Map — what the bucket would do. */
function fakeBucket() {
  const objects = new Map();             // key → { body: Buffer, contentType }
  const calls = [];
  const notFound = () => Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
  const toBuffer = async (body) => {
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === "string") return Buffer.from(body);
    const chunks = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  };
  return {
    objects, calls,
    async send(cmd) {
      const name = cmd.constructor.name, i = cmd.input;
      calls.push([name, i.Key ?? i.Prefix]);
      if (i.Bucket !== "school-files") throw new Error(`wrong bucket ${i.Bucket}`);
      switch (name) {
        case "PutObjectCommand":
          objects.set(i.Key, { body: await toBuffer(i.Body), contentType: i.ContentType });
          return {};
        case "HeadObjectCommand": {
          const o = objects.get(i.Key);
          if (!o) throw notFound();
          return { ContentLength: o.body.length, ContentType: o.contentType };
        }
        case "GetObjectCommand": {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
          return { Body: { transformToByteArray: async () => new Uint8Array(o.body) } };
        }
        case "DeleteObjectCommand":
          objects.delete(i.Key);
          return {};
        case "ListObjectsV2Command": {
          // Two a page, so the driver has to follow the continuation token.
          const all = [...objects.keys()].filter((k) => k.startsWith(i.Prefix)).sort();
          const from = Number(i.ContinuationToken || 0);
          const page = all.slice(from, from + 2);
          return { Contents: page.map((Key) => ({ Key })), IsTruncated: from + 2 < all.length, NextContinuationToken: String(from + 2) };
        }
        default: throw new Error(`unexpected ${name}`);
      }
    },
  };
}

const request = (port, urlPath, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: urlPath, headers }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on("error", reject);
});

(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-only-secret";
  const fileStore = require(path.join(SRC, "storage/fileStore"));
  const { cleanKey, keyFromUrl, keyOfLocalPath, createStore, configFromEnv, setStore, UPLOADS_ROOT } = fileStore;

  console.log("\n--- keys ---");
  check("traversal and absolute keys are refused", ["../x", "logos/../../x", "/etc/passwd", "logos//x", ""].map(cleanKey), [null, null, "etc/passwd", null, null]);
  check("every stored URL shape names one key", [
    keyFromUrl("/uploads/logos/6a4ccbfac10ad6faa189bd85-ad40837113a2.jpg"),
    keyFromUrl("https://api.example.test/uploads/content/document/1700-notes.pdf"),
    keyFromUrl("uploads/photos/s1-abc.png?v=2"),
    keyFromUrl("/uploads/messages/a%20b.pdf"),
    keyFromUrl("/uploads/../secrets"),
    keyFromUrl("https://youtube.com/watch?v=x"),
  ], ["logos/6a4ccbfac10ad6faa189bd85-ad40837113a2.jpg", "content/document/1700-notes.pdf", "photos/s1-abc.png", "messages/a b.pdf", null, null]);
  check("a local path maps to its key, and nothing outside uploads/ does",
    [keyOfLocalPath(path.join(UPLOADS_ROOT, "messages", "x.pdf")), keyOfLocalPath("/tmp/x.pdf")], ["messages/x.pdf", null]);

  console.log("\n--- configuration ---");
  check("no bucket configured: the local disk", configFromEnv({}).driver, "local");
  const env = { STORAGE_BUCKET: "school-files", STORAGE_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
    STORAGE_ACCESS_KEY_ID: "AKIDEXAMPLE", STORAGE_SECRET_ACCESS_KEY: "secret-that-must-not-leak" };
  const cfg = configFromEnv(env);
  check("STORAGE_BUCKET set: the bucket, region auto for R2", [cfg.driver, cfg.region, cfg.signedSeconds], ["s3", "auto", 3600]);
  const realS3 = createStore(cfg);
  const signed = await realS3.url("photos/s1-abc.jpg");
  check("the SDK signs a URL offline: right host, bucket, key, expiry, signature", [
    signed.startsWith("https://acc.r2.cloudflarestorage.com/school-files/photos/s1-abc.jpg?"),
    /X-Amz-Expires=3600/.test(signed), /X-Amz-Signature=[0-9a-f]{64}/.test(signed)], [true, true, true]);
  check("the secret is in neither the URL nor anything the store exposes",
    [signed.includes("secret-that-must-not-leak"), JSON.stringify(Object.keys(realS3)).includes("secret")], [false, false]);
  const srcFiles = ["storage/fileStore.js", "storage/serveUploads.js", "storage/placeholder.js"].map((f) => fs.readFileSync(path.join(SRC, f), "utf8")).join("\n");
  check("no credential is written in the code", /(AKIA|AKID)[A-Z0-9]{8,}|secretAccessKey:\s*["']/.test(srcFiles), false);

  // ── The fake bucket, as the app's store ────────────────────────────────────
  const bucket = fakeBucket();
  const store = createStore({ driver: "s3", bucket: "school-files", client: bucket,
    publicUrl: "https://files.example.test", presign: async (key, s) => `https://signed.example.test/${key}?expires=${s}` });
  setStore(store);

  console.log("\n--- the driver ---");
  await store.put("content/document/a.pdf", Buffer.from("%PDF-1.4 a"));
  check("put, stat, read", [await store.stat("content/document/a.pdf"), (await store.read("content/document/a.pdf")).toString()],
    [{ size: 10, contentType: "application/pdf" }, "%PDF-1.4 a"]);
  check("a missing file is null, not an error", [await store.stat("logos/none.png"), await store.read("logos/none.png")], [null, null]);
  for (const n of [1, 2, 3, 4, 5]) await store.put(`photos/kid-${n}.jpg`, Buffer.from("x"));
  check("list follows the pages", (await store.list("photos/kid-")).length, 5);
  check("a logo's URL is the public one; anything else is signed", [await store.url("logos/s-1.png"), await store.url("photos/kid-1.jpg")],
    ["https://files.example.test/logos/s-1.png", "https://signed.example.test/photos/kid-1.jpg?expires=3600"]);
  await store.remove("content/document/a.pdf");
  check("remove", await store.stat("content/document/a.pdf"), null);

  console.log("\n--- the writers ---");
  const logoStorage  = require(path.join(SRC, "utils/logoStorage"));
  const photoStorage = require(path.join(SRC, "utils/photoStorage"));
  const PNG = require(path.join(SRC, "storage/placeholder")).placeholderPng();   // a real PNG to upload
  const before = fs.existsSync(logoStorage.LOGO_DIR) ? fs.readdirSync(logoStorage.LOGO_DIR).length : 0;
  const logo = await logoStorage.saveLogoFromBase64("schoolA", PNG.toString("base64"));
  const logoKey = keyFromUrl(logo.publicPath);
  check("a logo goes to the bucket, as an image, under the URL shape records already use",
    [/^\/uploads\/logos\/schoolA-[0-9a-f]{12}\.png$/.test(logo.publicPath), bucket.objects.get(logoKey)?.contentType, bucket.objects.get(logoKey)?.body.equals(PNG)],
    [true, "image/png", true]);
  check("and not to the server's disk", fs.existsSync(logoStorage.LOGO_DIR) ? fs.readdirSync(logoStorage.LOGO_DIR).length : 0, before);
  const puts = bucket.calls.filter(([n]) => n === "PutObjectCommand").length;
  await logoStorage.saveLogoFromBase64("schoolA", PNG.toString("base64"));
  check("the same logo again is not uploaded twice", bucket.calls.filter(([n]) => n === "PutObjectCommand").length, puts);
  check("a logo that is not an image is refused before anything is stored",
    await logoStorage.saveLogoFromBase64("schoolA", Buffer.from("not an image at all, just text").toString("base64")).then(() => "stored", (e) => e.message), "Logo is not a JPEG, PNG, GIF or WebP image");
  const photo = await photoStorage.savePhotoFromBase64("stu1", PNG.toString("base64"));
  check("a photo goes to the bucket", !!bucket.objects.get(keyFromUrl(photo.publicPath)), true);
  check("deleting a photo removes the object", [await photoStorage.deletePhotoFile(photo.publicPath), bucket.objects.has(keyFromUrl(photo.publicPath))], [true, false]);
  check("a value that is not one of ours deletes nothing", [await photoStorage.deletePhotoFile("/uploads/logos/" + path.basename(logo.publicPath)), bucket.objects.has(logoKey)], [false, true]);

  const tmpUpload = path.join(UPLOADS_ROOT, "messages", `check-file-store-${process.pid}.pdf`);
  fs.mkdirSync(path.dirname(tmpUpload), { recursive: true });
  fs.writeFileSync(tmpUpload, "%PDF-1.4 attachment");
  const adopted = await store.adoptLocal(tmpUpload, { contentType: "application/pdf" });
  check("a multer upload is moved into the bucket and off the disk",
    [adopted, bucket.objects.get(adopted)?.body.toString(), fs.existsSync(tmpUpload)], [`messages/${path.basename(tmpUpload)}`, "%PDF-1.4 attachment", false]);

  console.log("\n--- serving /uploads/… ---");
  const app = express();
  app.use("/uploads/applications", require(path.join(SRC, "utils/applicationDocuments")).blockPublicApplicationsPath);
  app.get("/uploads/{*path}", require(path.join(SRC, "storage/serveUploads")).serveUploads({ uploadsRoot: UPLOADS_ROOT, mediaMime: { ".mp4": "video/mp4" } }));
  app.use((_req, res) => res.status(404).json({ error: "not here" }));
  const server = app.listen(0);
  const port = server.address().port;

  const GV = "/uploads/logos/6a4ccbfac10ad6faa189bd85-ad40837113a2.jpg";
  let r = await request(port, GV);
  check("Green Valley's lost logo: a placeholder picture, not a broken image",
    [r.status, r.headers["content-type"], r.headers["x-upload-missing"], r.body.slice(1, 4).toString(), r.headers["cache-control"]], [200, "image/png", "1", "PNG", "no-store"]);
  await store.put(keyFromUrl(GV), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]));
  r = await request(port, GV);
  check("the same URL, once the file is in the bucket: sent to the bucket's public URL", [r.status, r.headers.location],
    [302, "https://files.example.test/logos/6a4ccbfac10ad6faa189bd85-ad40837113a2.jpg"]);
  r = await request(port, "/uploads/photos/kid-1.jpg");
  check("a photo: a signed URL, kept briefly and privately", [r.status, r.headers.location, r.headers["cache-control"]],
    [302, "https://signed.example.test/photos/kid-1.jpg?expires=3600", "private, max-age=300"]);
  r = await request(port, "/uploads/photos/gone.png");
  check("a missing photo: the placeholder too", [r.status, r.headers["x-upload-missing"]], [200, "1"]);
  r = await request(port, "/uploads/content/document/gone.pdf");
  check("a missing document: 404, no placeholder", [r.status, r.headers["x-upload-missing"]], [404, undefined]);
  await store.put("applications/birth.pdf", Buffer.from("%PDF"));
  r = await request(port, "/uploads/applications/birth.pdf");
  check("an applicant's document is never served from /uploads", [r.status, r.headers.location], [404, undefined]);
  r = await request(port, "/uploads/%2e%2e/%2e%2e/package.json");
  check("a path out of uploads/ is refused", r.status, 403);
  process.env.REQUIRE_MEDIA_SIGNATURE = "1";
  r = await request(port, `/uploads/${adopted}`);
  check("a message attachment without its signature: refused, bucket not consulted", [r.status, r.headers.location], [401, undefined]);
  const { signMediaPath } = require(path.join(SRC, "utils/mediaSignature"));
  r = await request(port, signMediaPath(adopted));
  check("with its signature: a signed bucket URL", [r.status, r.headers.location], [302, `https://signed.example.test/${adopted}?expires=3600`]);
  delete process.env.REQUIRE_MEDIA_SIGNATURE;

  // The local driver keeps today's behaviour, and the placeholder.
  setStore(createStore({ driver: "local" }));
  r = await request(port, "/uploads/logos/check-file-store-missing.png");
  check("local disk: a missing logo is the placeholder as well", [r.status, r.headers["x-upload-missing"]], [200, "1"]);
  setStore(store);
  server.close();

  console.log("\n--- print ---");
  const { resolveImageSrc } = require(path.join(SRC, "print/imageSource"));
  check("before the logo is loaded it is linked, not embedded",
    resolveImageSrc(logo.publicPath, { origin: "https://api.example.test", embed: true }), `https://api.example.test${logo.publicPath}`);
  await store.warmImages([logo.publicPath, "/uploads/photos/gone.png"]);
  check("after warmImages it is embedded", resolveImageSrc(logo.publicPath, { origin: "https://api.example.test", embed: true }), `data:image/png;base64,${PNG.toString("base64")}`);
  check("a photo known to be missing prints the empty box, not a broken image",
    resolveImageSrc("/uploads/photos/gone.png", { origin: "https://api.example.test", embed: true }), null);

  console.log("\n--- deleting a school (D2) removes its files from the bucket ---");
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180000 } });
  await mongoose.connect(mongo.getUri());
  const db = mongoose.connection.db;
  const A = new mongoose.Types.ObjectId(), B = new mongoose.Types.ObjectId();
  const aLogo = await logoStorage.saveLogoFromBase64(String(A), PNG.toString("base64"));
  await store.put(`logos/${A}-0123456789ab.jpg`, Buffer.from("an old logo no record names"));
  const bLogo = await logoStorage.saveLogoFromBase64(String(B), Buffer.concat([PNG, Buffer.from([0])]).toString("base64"));
  await store.put("photos/pupilA-111111111111.png", PNG);
  await store.put("content/document/shared.pdf", Buffer.from("%PDF shared"));
  await db.collection("schools").insertMany([{ _id: A, name: "School A", logo: aLogo.publicPath }, { _id: B, name: "School B", logo: bLogo.publicPath }]);
  await db.collection("students").insertMany([
    { _id: "pupilA", schoolId: String(A), photoUrl: "/uploads/photos/pupilA-111111111111.png", documents: [{ url: "/uploads/content/document/shared.pdf" }] },
    { _id: "pupilB", schoolId: String(B), documents: [{ url: "https://api.example.test/uploads/content/document/shared.pdf" }] },
  ]);
  const { run } = require("./delete-school");
  const dry = await run({ school: String(A) });
  check("the dry run lists the logo, the old logo and the photo — not the shared file",
    dry.plan.files, [`uploads/logos/${A}-0123456789ab.jpg`, `uploads${aLogo.publicPath.slice("/uploads".length)}`, "uploads/photos/pupilA-111111111111.png"].sort());
  const { result } = await run({ school: String(A), apply: true, confirm: "School A" });
  check("apply removes them from the bucket",
    [result.filesRemoved, bucket.objects.has(keyFromUrl(aLogo.publicPath)), bucket.objects.has(`logos/${A}-0123456789ab.jpg`), bucket.objects.has("photos/pupilA-111111111111.png")],
    [3, false, false, false]);
  check("and keeps the other school's logo and the file it still uses",
    [bucket.objects.has(keyFromUrl(bLogo.publicPath)), bucket.objects.has("content/document/shared.pdf")], [true, true]);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  await stopQuietly(mongo);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error("check failed:", err); process.exit(1); });
