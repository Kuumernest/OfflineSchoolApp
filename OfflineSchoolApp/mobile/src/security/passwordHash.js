// src/security/passwordHash.js
"use strict";

/**
 * The offline sign-in's password hash: PBKDF2-HMAC-SHA256 (RFC 8018 §5.2,
 * HMAC per RFC 2104), a random 16-byte salt, a self-describing stored value.
 *
 *   pbkdf2-sha256$<iterations>$<salt, base64>$<derived key, base64>
 *
 * ── Why this replaced what was here ───────────────────────────────────────
 *
 * auth.store.js hashed with `CryptoJS.PBKDF2`, but crypto-js was never a
 * dependency of this app (not in package.json or the lockfile in any commit),
 * so the require failed and the fallback ran on every phone:
 * `return password + salt`. The "hash" in the offline cache was the password
 * in clear text with a few characters appended. Those values still verify
 * here (verifyPassword's `legacy` result) so offline sign-in keeps working;
 * the next ONLINE sign-in replaces them (auth.store.js, docs/14).
 *
 * ── Where the work runs, and why ──────────────────────────────────────────
 *
 * expo-crypto 57 (the installed package's own types are the authority) offers
 * digest / digestStringAsync (one SHA-x digest per call), getRandomBytes(Async),
 * getRandomValues, randomUUID and AES-GCM. It has no KDF and no HMAC, so
 * PBKDF2 is built here, two ways that give identical bytes:
 *
 *   pbkdf2Sha256        the loop in plain JS, the two HMAC pad states computed
 *                       once (two SHA-256 compressions per iteration);
 *   pbkdf2Sha256Native  every SHA-256 by expo-crypto's `digest` — two native
 *                       calls per iteration, each a JSI→JNI crossing on
 *                       Android plus a Promise, each re-hashing a pad block.
 *
 * Which is faster depends on the engine and the device (an interpreted JS
 * loop against per-call bridge cost), so pickBackend times both once per
 * launch and uses the faster. expo-crypto also supplies what must come from
 * the platform: the salt (getRandomBytesAsync — the native CSPRNG, never the
 * Math.random dev fallback getRandomBytes has). selfTest checks both backends
 * against known answers, and the JS SHA-256 against expo-crypto's digest,
 * before anything is hashed; the check scripts prove both against Node's
 * crypto.pbkdf2Sync and the RFC 7914 §11 vectors.
 *
 * ── The iteration count ───────────────────────────────────────────────────
 *
 * ITERATIONS is a cost, paid at every sign-in, on the phone's JS thread.
 * Measured in Node 10,000 iterations take ~15 ms with V8's JIT and ~720 ms
 * with it off (`--jitless`, the closest stand-in for Hermes, which
 * interprets); the native-digest backend took ~160 ms jitless. A mid-range
 * Android core is perhaps 1.5–3× slower than the machine measured, which puts
 * a sign-in's hash at roughly 0.3–1.5 s — estimated; measure on a device
 * (docs/14). The loop yields every 1,000 iterations so the screen keeps
 * drawing. The count is stored in every value, so it
 * can be raised later without invalidating anything already stored.
 * This is far below OWASP's 600,000 for server-side PBKDF2-SHA256: the
 * attacker here needs the phone's app-private database first, and the
 * offline cache is a convenience the server never trusts (every request is
 * still authenticated online). It is a large step from clear text; it is not
 * a server-grade password store.
 */

import * as Crypto from "expo-crypto";

export const SCHEME     = "pbkdf2-sha256";
export const ITERATIONS = 10000;
export const SALT_BYTES = 16;
export const KEY_BYTES  = 32;

// ── SHA-256 (FIPS 180-4) ──────────────────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** One compression of `w[0..15]` (big-endian words) into `st`. `w` is scratch (64 words). */
const compress = (st, w) => {
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15], b = w[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
  st[4] = (st[4] + e) | 0; st[5] = (st[5] + f) | 0; st[6] = (st[6] + g) | 0; st[7] = (st[7] + h) | 0;
};

/** SHA-256 of `bytes` continuing from `state` after `prefixLen` bytes already compressed. */
const sha256From = (state, prefixLen, bytes) => {
  const st = Int32Array.from(state);
  const w  = new Int32Array(64);
  const total = prefixLen + bytes.length;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bits = total * 8;
  const end = padded.length;
  padded[end - 5] = Math.floor(bits / 2 ** 32) & 0xff;   // lengths below 2^40 bits
  padded[end - 4] = (bits >>> 24) & 0xff;
  padded[end - 3] = (bits >>> 16) & 0xff;
  padded[end - 2] = (bits >>> 8) & 0xff;
  padded[end - 1] = bits & 0xff;
  for (let off = 0; off < end; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3];
    }
    compress(st, w);
  }
  return st;
};

const wordsToBytes = (st) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = st[i] >>> 24; out[i * 4 + 1] = st[i] >>> 16; out[i * 4 + 2] = st[i] >>> 8; out[i * 4 + 3] = st[i];
  }
  return out;
};

/** SHA-256 of a byte array. */
export const sha256 = (bytes) => wordsToBytes(sha256From(IV, 0, bytes));

// ── HMAC-SHA256 (RFC 2104) and PBKDF2 (RFC 8018 §5.2) ─────────────────────

/** The two pad states for `key`, each one compression past the IV. */
const hmacStates = (key) => {
  const k = key.length > 64 ? sha256(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  const w = new Int32Array(64);
  const state = (pad) => {
    const st = Int32Array.from(IV);
    for (let i = 0; i < 16; i++) {
      const j = i * 4;
      w[i] = ((block[j] ^ pad) << 24) | ((block[j + 1] ^ pad) << 16) | ((block[j + 2] ^ pad) << 8) | (block[j + 3] ^ pad);
    }
    compress(st, w);
    return st;
  };
  return { inner: state(0x36), outer: state(0x5c) };
};

export const hmacSha256 = (key, msg) => {
  const { inner, outer } = hmacStates(key);
  return wordsToBytes(sha256From(outer, 64, wordsToBytes(sha256From(inner, 64, msg))));
};

/**
 * One 32-byte-message HMAC step from precomputed pad states, words in/out.
 * A 32-byte message after the 64-byte pad block is one padded block: the
 * message (8 words), 0x80, zeros, the length 768 bits.
 */
const hmacWords = (inner, outer, msg, out, w, st) => {
  for (let i = 0; i < 8; i++) w[i] = msg[i];
  w[8] = 0x80000000; for (let i = 9; i < 15; i++) w[i] = 0; w[15] = 768;
  st.set(inner); compress(st, w);
  for (let i = 0; i < 8; i++) w[i] = st[i];
  w[8] = 0x80000000; for (let i = 9; i < 15; i++) w[i] = 0; w[15] = 768;
  st.set(outer); compress(st, w);
  out.set(st);
};

/** Yield to the event loop so a spinner keeps turning during a long derive. */
const yieldNow = () => new Promise((r) => setTimeout(r, 0));

const checkArgs = (iterations, dkLen) => {
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("pbkdf2: bad iteration count");
  if (!Number.isInteger(dkLen) || dkLen < 1 || dkLen > 1024) throw new Error("pbkdf2: bad key length");
};

/** salt || INT_32_BE(block) — U1's message (RFC 8018 §5.2). */
const firstMessage = (salt, b) => {
  const m = new Uint8Array(salt.length + 4);
  m.set(salt);
  m[salt.length] = b >>> 24; m[salt.length + 1] = b >>> 16; m[salt.length + 2] = b >>> 8; m[salt.length + 3] = b;
  return m;
};

/**
 * PBKDF2-HMAC-SHA256 with the loop in plain JS. `password` and `salt` are
 * byte arrays.
 * @returns {Promise<Uint8Array>}
 */
export const pbkdf2Sha256 = async (password, salt, iterations, dkLen = KEY_BYTES, { yieldEvery = 1000 } = {}) => {
  checkArgs(iterations, dkLen);
  const { inner, outer } = hmacStates(password);
  const blocks = Math.ceil(dkLen / 32);
  const out = new Uint8Array(blocks * 32);
  const w = new Int32Array(64), st = new Int32Array(8), u = new Int32Array(8), t = new Int32Array(8);
  for (let b = 1; b <= blocks; b++) {
    u.set(sha256From(outer, 64, wordsToBytes(sha256From(inner, 64, firstMessage(salt, b)))));
    t.set(u);
    for (let i = 1; i < iterations; i++) {
      hmacWords(inner, outer, u, u, w, st);
      for (let j = 0; j < 8; j++) t[j] ^= u[j];
      if (yieldEvery && i % yieldEvery === 0) await yieldNow();
    }
    out.set(wordsToBytes(t), (b - 1) * 32);
  }
  return out.slice(0, dkLen);
};

/**
 * The same PBKDF2-HMAC-SHA256, each SHA-256 done by expo-crypto's native
 * `digest` (two calls per iteration: H(K⊕ipad ‖ U), H(K⊕opad ‖ inner)).
 * Same bytes out as pbkdf2Sha256; which is faster depends on the phone
 * (see pickBackend).
 */
export const pbkdf2Sha256Native = async (password, salt, iterations, dkLen = KEY_BYTES, { yieldEvery = 1000 } = {}) => {
  checkArgs(iterations, dkLen);
  const H = async (bytes) => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));
  const key = password.length > 64 ? await H(password) : password;
  const ipad = new Uint8Array(64), opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { ipad[i] = (key[i] ?? 0) ^ 0x36; opad[i] = (key[i] ?? 0) ^ 0x5c; }
  const hmac = async (msg) => {
    const a = new Uint8Array(64 + msg.length); a.set(ipad); a.set(msg, 64);
    const inner = await H(a);
    const b = new Uint8Array(96); b.set(opad); b.set(inner, 64);
    return H(b);
  };
  const blocks = Math.ceil(dkLen / 32);
  const out = new Uint8Array(blocks * 32);
  for (let b = 1; b <= blocks; b++) {
    let u = await hmac(firstMessage(salt, b));
    const t = Uint8Array.from(u);
    for (let i = 1; i < iterations; i++) {
      u = await hmac(u);
      for (let j = 0; j < 32; j++) t[j] ^= u[j];
      if (yieldEvery && i % yieldEvery === 0) await yieldNow();
    }
    out.set(t, (b - 1) * 32);
  }
  return out.slice(0, dkLen);
};

const hasNativeDigest = () => typeof Crypto.digest === "function" && !!Crypto.CryptoDigestAlgorithm?.SHA256;

let _backend = null;
/**
 * Which of the two runs PBKDF2 faster on THIS phone, decided once per launch
 * by timing a short run of each (~2×64 iterations).
 *
 * Measured in Node with the JIT off: the JS loop ~72 µs/iteration, Node's
 * native hash per call ~16 µs. On Android each native call is a JSI→JNI
 * crossing plus a Promise, whose cost varies by device and engine build — so
 * the phone measures rather than this file guessing. Both produce identical
 * bytes (checked in selfTest), so the choice never affects stored values.
 */
export const pickBackend = () => {
  if (!_backend) {
    _backend = (async () => {
      if (!hasNativeDigest()) return pbkdf2Sha256;
      const pw = utf8("calibrate"), salt = new Uint8Array(16);
      const time = async (fn) => {
        await fn(pw, salt, 8, 32, { yieldEvery: 0 });          // warm-up
        const t0 = Date.now();
        await fn(pw, salt, 64, 32, { yieldEvery: 0 });
        return Date.now() - t0;
      };
      try {
        const js = await time(pbkdf2Sha256);
        const native = await time(pbkdf2Sha256Native);
        return native < js ? pbkdf2Sha256Native : pbkdf2Sha256;
      } catch {
        return pbkdf2Sha256;
      }
    })();
  }
  return _backend;
};

/** For the checks: forget the calibration (and the self-test). */
export const __resetForTests = () => { _backend = null; _selfTest = null; };

/** PBKDF2 with whichever backend this phone runs faster. */
const derive = async (password, salt, iterations) => (await pickBackend())(password, salt, iterations, KEY_BYTES);

// ── Encoding ──────────────────────────────────────────────────────────────

/** UTF-8 bytes of a JS string (lone surrogates as U+FFFD, as TextEncoder does). */
export const utf8 = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export const toBase64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=")
      + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return s;
};
export const fromBase64 = (s) => {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4) return null;
  const out = [];
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12)
      | ((s[i + 2] === "=" ? 0 : B64.indexOf(s[i + 2])) << 6) | (s[i + 3] === "=" ? 0 : B64.indexOf(s[i + 3]));
    out.push((n >> 16) & 255);
    if (s[i + 2] !== "=") out.push((n >> 8) & 255);
    if (s[i + 3] !== "=") out.push(n & 255);
  }
  return Uint8Array.from(out);
};

/** Equal byte strings, in time that depends only on their lengths. */
export const timingSafeEqual = (a, b) => {
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

// ── Self-test against the platform ────────────────────────────────────────

let _selfTest = null;
/**
 * Both backends against known answers, once per launch: SHA-256("abc") (FIPS
 * 180-4) and PBKDF2-HMAC-SHA256("password", "salt", 2, 32), and the JS SHA-256
 * against expo-crypto's native digest. A mismatch (a broken build, an engine
 * bug) refuses to hash rather than store something nothing could verify.
 */
export const selfTest = () => {
  if (!_selfTest) {
    _selfTest = (async () => {
      const input = utf8("abc");
      const mine = toBase64(sha256(input));
      if (mine !== "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=") throw new Error("passwordHash: SHA-256 known answer failed");
      const KAT = "rk0Mla9rRtMtCt/5KPBt0CowP47zwlHf1uLYWpVHTEM=";
      if (toBase64(await pbkdf2Sha256(utf8("password"), utf8("salt"), 2, 32)) !== KAT) {
        throw new Error("passwordHash: PBKDF2 known answer failed");
      }
      if (hasNativeDigest()) {
        const native = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, input));
        if (toBase64(native) !== mine) throw new Error("passwordHash: SHA-256 differs from expo-crypto");
        if (toBase64(await pbkdf2Sha256Native(utf8("password"), utf8("salt"), 2, 32)) !== KAT) {
          throw new Error("passwordHash: native PBKDF2 known answer failed");
        }
      }
      return true;
    })();
    _selfTest.catch(() => { _selfTest = null; });
  }
  return _selfTest;
};

// ── The stored value ──────────────────────────────────────────────────────

/** Parse a stored value; null when it is not this scheme (a legacy value). */
export const parseStored = (stored) => {
  if (typeof stored !== "string" || !stored.startsWith(`${SCHEME}$`)) return null;
  const parts = stored.split("$");
  if (parts.length !== 4) return null;
  const iterations = Number(parts[1]);
  const salt = fromBase64(parts[2]);
  const key  = fromBase64(parts[3]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) return null;
  if (!salt || salt.length < 8 || !key || key.length !== KEY_BYTES) return null;
  return { iterations, salt, key };
};

export const isCurrentFormat = (stored) => parseStored(stored) !== null;

/**
 * Hash `password` for storage.
 * @returns {Promise<{ salt: string, hash: string }>}  `hash` is the whole
 *   self-describing value; `salt` repeats its salt for the column that has
 *   always held one (readers that only check the column is set keep working).
 */
export const hashPassword = async (password, { iterations = ITERATIONS } = {}) => {
  if (typeof password !== "string" || !password) throw new Error("passwordHash: empty password");
  await selfTest();
  const salt = await Crypto.getRandomBytesAsync(SALT_BYTES);
  const key  = await derive(utf8(password), salt, iterations);
  const saltB64 = toBase64(salt);
  return { salt: saltB64, hash: `${SCHEME}$${iterations}$${saltB64}$${toBase64(key)}` };
};

/**
 * Does `password` match what is stored?
 *
 * @param {string} password
 * @param {string} storedSalt  the salt column (used only by legacy values)
 * @param {string} storedHash  the hash column
 * @returns {Promise<{ ok: boolean, legacy: boolean }>}  `legacy` marks a value
 *   in the old clear-text form, to be replaced at the next online sign-in.
 */
export const verifyPassword = async (password, storedSalt, storedHash) => {
  if (typeof password !== "string" || !password || typeof storedHash !== "string" || !storedHash) {
    return { ok: false, legacy: false };
  }
  const parsed = parseStored(storedHash);
  if (parsed) {
    await selfTest();
    const key = await derive(utf8(password), parsed.salt, parsed.iterations);
    return { ok: timingSafeEqual(key, parsed.key), legacy: false };
  }
  // The old form: `password + salt`, verbatim (see the header). crypto-js was
  // never installed, so no build ever stored a real CryptoJS PBKDF2 value.
  if (typeof storedSalt !== "string" || !storedSalt) return { ok: false, legacy: true };
  return { ok: timingSafeEqual(utf8(password + storedSalt), utf8(storedHash)), legacy: true };
};

export default {
  SCHEME, ITERATIONS, hashPassword, verifyPassword, isCurrentFormat, parseStored,
  pbkdf2Sha256, pbkdf2Sha256Native, pickBackend, sha256, hmacSha256, timingSafeEqual, selfTest,
};
