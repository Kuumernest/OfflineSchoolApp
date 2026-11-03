// mobile/scripts/expo-crypto-node.js
"use strict";

/**
 * expo-crypto 57's JS surface (node_modules/expo-crypto/build/Crypto.d.ts),
 * backed by Node's crypto — what the check scripts load in place of the
 * native module, so the app's own code paths (security/passwordHash.js,
 * utils/idHelpers.js) run unchanged. Same names, same argument and return
 * shapes: digest → Promise<ArrayBuffer>, digestStringAsync → hex/base64
 * string, getRandomBytes(Async) → Uint8Array (0…1024 bytes), getRandomValues
 * fills in place, randomUUID → string. Not a check itself.
 *
 * `calls` counts native-equivalent calls, for checks that want to see them.
 */

const nodeCrypto = require("crypto");

const CryptoDigestAlgorithm = Object.freeze({
  SHA1: "SHA-1", SHA256: "SHA-256", SHA384: "SHA-384", SHA512: "SHA-512", MD2: "MD2", MD4: "MD4", MD5: "MD5",
});
const CryptoEncoding = Object.freeze({ HEX: "hex", BASE64: "base64" });
const NODE_ALG = { "SHA-1": "sha1", "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512", MD5: "md5" };

const calls = { digest: 0, random: 0 };

const alg = (a) => {
  const n = NODE_ALG[a];
  if (!n) throw new TypeError(`expo-crypto: Invalid algorithm provided: ${a}`);
  return n;
};
const byteCount = (n, name) => {
  if (typeof n !== "number" || Number.isNaN(n) || Math.floor(n) < 0 || Math.floor(n) > 1024) {
    throw new TypeError(`expo-crypto: ${name}(${n}) expected a valid number from range 0...1024`);
  }
  return Math.floor(n);
};
const toBuffer = (data) => {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError("expo-crypto: digest expects a BufferSource");
};

module.exports = {
  __esModule: true,
  CryptoDigestAlgorithm,
  CryptoEncoding,
  calls,
  getRandomBytes: (n) => { calls.random++; return new Uint8Array(nodeCrypto.randomBytes(byteCount(n, "getRandomBytes"))); },
  getRandomBytesAsync: async (n) => { calls.random++; return new Uint8Array(nodeCrypto.randomBytes(byteCount(n, "getRandomBytesAsync"))); },
  getRandomValues: (arr) => { calls.random++; nodeCrypto.randomFillSync(arr); return arr; },
  randomUUID: () => nodeCrypto.randomUUID(),
  digestStringAsync: async (a, data, options = { encoding: "hex" }) => {
    calls.digest++;
    if (typeof data !== "string") throw new TypeError("expo-crypto: Invalid data provided. Expected a string.");
    return nodeCrypto.createHash(alg(a)).update(data, "utf8").digest(options.encoding === "base64" ? "base64" : "hex");
  },
  digest: (a, data) => new Promise((resolve, reject) => {
    try {
      calls.digest++;
      const out = nodeCrypto.createHash(alg(a)).update(toBuffer(data)).digest();
      resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
    } catch (err) { reject(err); }
  }),
};
