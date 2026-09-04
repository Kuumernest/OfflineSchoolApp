// backend/src/utils/tempPassword.js
"use strict";

/**
 * Temporary first-password generator.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The word + digits + symbol recipe was written out twice — once in
 * students.routes.js and once in admin.routes.js — and both copies picked the
 * word, the digits and the symbol with Math.random(). Math.random() is not a
 * cryptographic generator: its state can be recovered from a handful of
 * observed outputs, so a password minted with it is guessable in principle by
 * anybody who can see a few of the others (welcome emails, log lines).
 *
 * crypto.randomInt() is the CSPRNG the platform ships for exactly this job.
 * The output format is unchanged — Word1234! — so nothing that displays,
 * emails or types one of these passwords can tell the difference.
 */

const crypto = require("crypto");

const WORDS = [
  "Apple", "Mango", "Cedar", "Delta", "Eagle", "Flame",
  "Grace", "Haven", "Ivory", "Jewel", "Karma", "Lemon",
  "Maple", "Noble", "Ocean", "Pearl", "Queen", "River",
  "Stone", "Tiger", "Unity", "Vivid", "Witty", "Xenon",
  "Yield", "Zesty",
];

const SYMBOLS = ["!", "@", "#", "$"];

const generateTempPassword = () => {
  const word   = WORDS[crypto.randomInt(WORDS.length)];
  const digits = String(1000 + crypto.randomInt(9000));
  const symbol = SYMBOLS[crypto.randomInt(SYMBOLS.length)];
  return `${word}${digits}${symbol}`;
};

module.exports = { generateTempPassword };
