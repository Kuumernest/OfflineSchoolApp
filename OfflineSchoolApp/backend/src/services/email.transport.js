// backend/src/services/email.transport.js
"use strict";

const nodemailer = require("nodemailer");

/**
 * Where email physically goes, decided once.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * There were two answers to "how does this app send email", and they did not
 * agree:
 *
 *   email.service.js  — welcome emails and password resets. Understood
 *                       SendGrid, then Gmail, then a generic SMTP host.
 *   notification/channels.js — fee reminders, and everything else the queue
 *                       carries. Understood GMAIL ONLY, hard-coded
 *                       service:"gmail", and reported isConfigured() as false
 *                       for any other provider.
 *
 * So moving a school onto SendGrid used to half-work in the worst possible way:
 * staff would get their credentials, and every fee reminder would be quietly
 * routed to the LOG channel — because resolveChannel() asks
 * emailChannel.isConfigured(), that answered false, and the fallback chain ends
 * at a channel that always "succeeds" by printing to stdout. The bursar would
 * press Send, be told the reminders went, and they would be in a server log.
 *
 * That is the same shape of bug as the one fixed in the previous commit — a
 * layer reporting success for something that never left the building — reached
 * through a different door. One definition closes the door.
 *
 * ── Order of precedence ───────────────────────────────────────────────────
 *
 * A dedicated provider wins over Gmail, deliberately. Migrating off a personal
 * Gmail should be two lines ADDED to .env, not two lines added and two deleted
 * — a half-finished edit that leaves both sets present must land on the one the
 * school is moving to, not the one it is leaving.
 */

/** Credentials as pasted, cleaned up — see the note on cred() below. */
const cred = (v) => (typeof v === "string" ? v.replace(/\s+/g, "") : v);

/**
 * Whitespace is stripped from every credential, not just Gmail's.
 *
 * Google displays an app password as four spaced groups ("abcd efgh ijkl mnop")
 * so it arrives in .env with the spaces still in it, and Gmail answers
 * 535-5.7.8, which reads exactly like a wrong password. SendGrid keys and Brevo
 * SMTP keys are long enough that a copy out of a browser can pick up a trailing
 * newline just as easily. None of this rescues a genuinely wrong credential; it
 * removes a cause that is indistinguishable from one.
 */
const PROVIDERS = [
  {
    name:  "sendgrid",
    label: "SendGrid",
    detect: (e) => Boolean(e.SENDGRID_API_KEY),
    // The username is the literal string "apikey" for every SendGrid account.
    // That is not a placeholder to fill in — it is what SendGrid expects.
    build: (e) => ({
      host: "smtp.sendgrid.net", port: 587, secure: false,
      auth: { user: "apikey", pass: cred(e.SENDGRID_API_KEY) },
    }),
    // SendGrid refuses to send from an address that has not been verified in
    // the account, so there is no sensible default to fall back to.
    requiresFrom: true,
    vars: ["SENDGRID_API_KEY", "EMAIL_FROM"],
  },
  {
    name:  "brevo",
    label: "Brevo",
    detect: (e) => Boolean(e.BREVO_SMTP_USER && e.BREVO_SMTP_KEY),
    build: (e) => ({
      host: "smtp-relay.brevo.com", port: 587, secure: false,
      auth: {
        // Brevo's SMTP login, which is NOT the account's login email — the
        // panel shows it as something like 8a1b2c001@smtp-brevo.com.
        user: String(e.BREVO_SMTP_USER).trim(),
        pass: cred(e.BREVO_SMTP_KEY),
      },
    }),
    requiresFrom: true,
    vars: ["BREVO_SMTP_USER", "BREVO_SMTP_KEY", "EMAIL_FROM"],
  },
  {
    name:  "gmail",
    label: "Gmail",
    detect: (e) => Boolean(e.GMAIL_USER && e.GMAIL_APP_PASSWORD),
    build: (e) => ({
      // 465 + secure, which avoided TLS handshake failures on the networks
      // this has been run on.
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: {
        user: String(e.GMAIL_USER).trim(),
        pass: cred(e.GMAIL_APP_PASSWORD),
      },
      connectionTimeout: 10_000,
      greetingTimeout:   10_000,
      socketTimeout:     15_000,
    }),
    // Gmail will only send as the authenticated account, so the account IS the
    // from address and nothing extra is needed.
    requiresFrom: false,
    vars: ["GMAIL_USER", "GMAIL_APP_PASSWORD"],
  },
  {
    name:  "smtp",
    label: "SMTP",
    detect: (e) => Boolean(e.SMTP_HOST && e.SMTP_USER && e.SMTP_PASS),
    build: (e) => ({
      // No default host. There used to be one — smtp.mailtrap.io — which meant
      // a half-configured deployment silently tried to authenticate against a
      // third party's server and failed with a message about credentials
      // rather than about configuration.
      host:   String(e.SMTP_HOST).trim(),
      port:   Number.parseInt(e.SMTP_PORT, 10) || 587,
      secure: e.SMTP_SECURE === "true",
      auth: { user: String(e.SMTP_USER).trim(), pass: cred(e.SMTP_PASS) },
      connectionTimeout: 10_000,
      greetingTimeout:   10_000,
      socketTimeout:     15_000,
    }),
    requiresFrom: true,
    vars: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM"],
  },
];

/** Which provider this environment describes, or null for none. */
const provider = (env = process.env) =>
  PROVIDERS.find((p) => p.detect(env)) ?? null;

/** Is email configured at all? The one question both send paths now ask. */
const isConfigured = (env = process.env) => provider(env) !== null;

/**
 * The address mail is sent FROM.
 *
 * Returns null rather than a plausible-looking default. The old fallback chain
 * ended at "noreply@schoolapp.com", a domain this project does not own — which
 * SendGrid and Brevo reject outright, and which any receiving server is
 * entitled to treat as forged. A missing sender is a configuration mistake and
 * has to read as one.
 */
const fromAddress = (env = process.env) => {
  const explicit = (env.EMAIL_FROM || "").trim();
  if (explicit) return explicit;

  const p = provider(env);
  if (!p) return null;
  // Gmail sends as itself and cannot do otherwise.
  if (p.name === "gmail") return String(env.GMAIL_USER).trim();
  return null;
};

/**
 * Everything wrong with the current configuration, in the order it matters.
 *
 * Returned as a list rather than thrown so the startup log, the diagnostic
 * script and a send failure can all say the same thing.
 */
const problems = (env = process.env) => {
  const p = provider(env);
  if (!p) {
    return [
      "No email provider is configured. Set one of: SENDGRID_API_KEY, " +
      "BREVO_SMTP_USER + BREVO_SMTP_KEY, GMAIL_USER + GMAIL_APP_PASSWORD, " +
      "or SMTP_HOST + SMTP_USER + SMTP_PASS.",
    ];
  }

  const out = [];
  if (p.requiresFrom && !fromAddress(env)) {
    out.push(
      `${p.label} needs EMAIL_FROM set to an address verified in that account. ` +
      "It will not send from an unverified sender."
    );
  }
  return out;
};

// One transporter per provider shape, reused. Built lazily: constructing it at
// import time would make every script that merely requires this file open a
// connection.
let cached = null;
let cachedFor = null;

/**
 * The transport, or a thrown CHANNEL_NOT_CONFIGURED.
 *
 * The error code matters: notification/channels.js is expected to throw exactly
 * that so the dispatcher records a skip the admin list can display, rather than
 * a delivery failure that will be retried forever.
 */
const transport = (env = process.env) => {
  const p = provider(env);
  if (!p) {
    const err = new Error(problems(env)[0]);
    err.code = "CHANNEL_NOT_CONFIGURED";
    throw err;
  }

  const issues = problems(env);
  if (issues.length) {
    const err = new Error(issues.join(" "));
    err.code = "CHANNEL_NOT_CONFIGURED";
    throw err;
  }

  if (cached && cachedFor === p.name) return cached;

  cached    = nodemailer.createTransport(p.build(env));
  cachedFor = p.name;
  return cached;
};

/** Drops the cached transport. For a diagnostic that changes env between tries. */
const reset = () => { cached = null; cachedFor = null; };

/**
 * A safe description for logs and the diagnostic — shape, never secrets.
 *
 * Lengths and a whitespace flag, because those are what actually go wrong with
 * a pasted credential, and neither reveals the value.
 */
const describe = (env = process.env) => {
  const p = provider(env);
  const shape = (v) =>
    v === undefined || v === null || v === ""
      ? "unset"
      : `${String(v).length} chars${/\s/.test(String(v)) ? ", contains whitespace" : ""}`;

  return {
    provider: p?.name ?? null,
    label:    p?.label ?? "none",
    from:     fromAddress(env) ?? null,
    problems: problems(env),
    vars: Object.fromEntries(
      (p?.vars ?? ["SENDGRID_API_KEY", "BREVO_SMTP_USER", "GMAIL_USER", "SMTP_HOST"])
        .map((k) => [k, shape(env[k])])
    ),
  };
};

module.exports = {
  PROVIDERS,
  provider,
  isConfigured,
  fromAddress,
  problems,
  transport,
  reset,
  describe,
};
