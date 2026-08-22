// backend/src/services/notification/channels.js
"use strict";

const nodemailer = require("nodemailer");

/**
 * How a notification physically leaves the building.
 *
 * Each adapter takes a rendered message and returns { ok, detail } or throws.
 * Nothing above this file knows which one runs — that is the whole point. A
 * school that pays for WhatsApp gets it switched on in its own settings and the
 * same queue, the same templates and the same retry logic deliver through a
 * different adapter.
 *
 * Adapters must not decide POLICY — whether to send, who to, how many times.
 * They transmit. Everything else belongs to the dispatcher, so a new channel
 * cannot quietly acquire its own rules about opt-in or retries.
 */

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────────────────────────────────────

let transporter = null;

/**
 * One transporter, reused.
 *
 * Built lazily rather than at module load: the config lives in environment
 * variables, and constructing it at import time makes every test and every
 * script that merely requires this file open an SMTP connection.
 */
const emailTransport = () => {
  if (transporter) return transporter;

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    const err = new Error("Email is not configured (GMAIL_USER / GMAIL_APP_PASSWORD)");
    err.code = "CHANNEL_NOT_CONFIGURED";
    throw err;
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });

  return transporter;
};

const emailChannel = {
  name: "email",

  /** Whether this channel could work at all, before we try to use it. */
  isConfigured: () =>
    Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),

  /** An address, loosely — enough to catch an empty or obviously wrong field. */
  accepts: (to) => typeof to === "string" && /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to),

  send: async ({ to, subject, text, html, fromName }) => {
    const tx   = emailTransport();
    const user = process.env.GMAIL_USER;

    const info = await tx.sendMail({
      // The school's name in the From, its address underneath. A parent should
      // see who it is from before deciding whether to open it.
      from: fromName ? `"${fromName}" <${user}>` : user,
      to, subject, text, html,
    });

    return { ok: true, detail: info.messageId ?? null };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP  (not enabled for any school yet)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deliberate placeholder.
 *
 * It exists so the seam is real and exercised rather than imagined: the
 * dispatcher already routes by channel, already records a skip reason, and
 * already surfaces "not configured" in the admin list. Turning WhatsApp on for
 * a school becomes filling in this send() and a settings flag, not restructuring
 * the queue.
 *
 * It intentionally does NOT half-implement the Cloud API. Untested code that
 * looks finished is worse than an honest stub — the first person to enable it
 * would trust it.
 */
const whatsappChannel = {
  name: "whatsapp",

  isConfigured: () =>
    Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_TOKEN),

  accepts: (to) => typeof to === "string" && /^\+?[0-9\s-]{8,}$/.test(to),

  send: async () => {
    const err = new Error(
      "WhatsApp is not integrated yet. Every school-initiated message needs a " +
      "Meta-approved template and is billed per message, so it is enabled per " +
      "school once that school has an account."
    );
    err.code = "CHANNEL_NOT_CONFIGURED";
    throw err;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LOG  (development, and the only channel that always works)
// ─────────────────────────────────────────────────────────────────────────────

const logChannel = {
  name: "log",
  isConfigured: () => true,
  accepts: () => true,
  send: async ({ to, subject, text }) => {
    console.log(`[notify:log] → ${to}\n  ${subject}\n  ${String(text).slice(0, 300)}`);
    return { ok: true, detail: "logged" };
  },
};

const CHANNELS = {
  email:    emailChannel,
  whatsapp: whatsappChannel,
  log:      logChannel,
};

const getChannel = (name) => CHANNELS[name] ?? null;

/** Which channels this deployment could actually deliver through right now. */
const availableChannels = () =>
  Object.values(CHANNELS)
    .filter((c) => c.isConfigured())
    .map((c) => c.name);

module.exports = { CHANNELS, getChannel, availableChannels };
