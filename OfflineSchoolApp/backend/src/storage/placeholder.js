// backend/src/storage/placeholder.js
"use strict";

/**
 * The image served in place of a logo or photo whose file is gone, so a
 * screen shows a quiet grey picture rather than a broken-image icon.
 *
 * A PNG, not an SVG: React Native's <Image> and the PDF renderers do not draw
 * SVG. Drawn here once, at first use — a grey square with a simple landscape
 * glyph — so there is no binary file to keep in the repository.
 */

const zlib = require("zlib");

const SIZE = 160;
const BG   = [229, 231, 235];   // #E5E7EB
const FG   = [156, 163, 175];   // #9CA3AF

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td  = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** Is pixel (x, y) part of the glyph: a sun and two hills. */
const ink = (x, y) => {
  const sun = (x - 108) ** 2 + (y - 52) ** 2 <= 14 ** 2;
  const hill1 = y >= 118 - 0.9 * (40 - Math.abs(x - 62)) && y <= 118 && Math.abs(x - 62) <= 40;
  const hill2 = y >= 118 - 0.8 * (30 - Math.abs(x - 106)) && y <= 118 && Math.abs(x - 106) <= 30;
  return sun || hill1 || hill2;
};

let png = null;

/** The placeholder PNG's bytes. */
const placeholderPng = () => {
  if (png) return png;
  const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 3 + 1);
    raw[row] = 0;                                   // filter: none
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = ink(x, y) ? FG : BG;
      raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGB
  png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
};

/**
 * Answer a request with the placeholder. 200, so every client draws it, and
 * not cached, so the real image shows as soon as it is uploaded again.
 */
const sendPlaceholder = (res) => {
  res.set({
    "Content-Type":                 "image/png",
    "Cache-Control":                "no-store",
    "X-Upload-Missing":             "1",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin":  "*",
  });
  return res.status(200).send(placeholderPng());
};

module.exports = { placeholderPng, sendPlaceholder };
