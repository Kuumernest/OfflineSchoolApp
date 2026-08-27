// backend/src/services/notification/channels.js
"use strict";

const mail = require("../email.transport");

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

const emailChannel = {
  name: "email",

  /**
   * Whether this channel could work at all, before we try to use it.
   *
   * This used to ask specifically about GMAIL_USER and GMAIL_APP_PASSWORD, and
   * that made it a trap. resolveChannel() consults exactly this answer, and its
   * fallback chain ends at the log channel — which always "succeeds". So a
   * school configured on SendGrid got welcome emails (email.service.js knew
   * about SendGrid) while every fee reminder was written to stdout and reported
   * as sent. The provider question has one answer now, in email.transport.js.
   */
  isConfigured: () => mail.isConfigured(),

  /** An address, loosely — enough to catch an empty or obviously wrong field. */
  accepts: (to) => typeof to === "string" && /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(to),

  send: async ({ to, subject, text, html, fromName }) => {
    // Throws CHANNEL_NOT_CONFIGURED, which the dispatcher records as a skip
    // rather than a delivery failure to retry forever.
    const tx   = mail.transport();
    const from = mail.fromAddress();

    const info = await tx.sendMail({
      // The school's name in the From, the verified sender underneath. A parent
      // should see who it is from before deciding whether to open it.
      from: fromName ? `"${fromName}" <${from}>` : from,
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
