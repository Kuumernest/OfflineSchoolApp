// backend/src/services/email.brevo.js
"use strict";

/**
 * Brevo's Transactional Email API, behind the interface the rest of this
 * backend already sends through.
 *
 * ── Why an adapter and not a new email service ────────────────────────────
 *
 * There are exactly two places in this backend that put an email on the wire:
 *
 *   services/email.service.js         welcome mail, admin-issued credentials
 *   services/notification/channels.js the queue — fee reminders, gate scans,
 *                                     absences, anything with a retry
 *
 * Both do the same two things: ask email.transport.js for a transport, then
 * call `.sendMail({ from, to, subject, html, text })`. That registry is where
 * the provider decision is made, and it is the only place it is made — a
 * previous commit exists purely because there were once two answers to "how
 * does this app send email" and they disagreed, so a school on SendGrid had
 * its fee reminders written to stdout and reported as sent.
 *
 * So Brevo becomes another entry in that registry rather than a service beside
 * it. What is unusual is only that Brevo's API is HTTP and every other entry is
 * SMTP, which nodemailer speaks. This file closes that gap: it exposes
 * `sendMail()` with nodemailer's argument shape and returns `{ messageId }`,
 * so neither send site changes and the queue keeps its retries, its backoff,
 * its skip semantics and its CHANNEL_NOT_CONFIGURED contract.
 *
 * The alternative — a parallel Brevo service called directly from controllers —
 * would have re-created the exact bug that registry was built to prevent.
 *
 * ── Templates ─────────────────────────────────────────────────────────────
 *
 * Brevo can render a template server-side from an id and a params object,
 * which is better than posting a kilobyte of HTML built in JavaScript. That is
 * supported here as an extra argument (`templateId`, `params`) and is opt-in:
 * the ids live in the environment and, until a school has created the
 * templates in Brevo, they are unset and the existing HTML is sent instead.
 * See templateId() below — an unset id is not an error, it is "not yet".
 *
 * ── What must never leave this file ───────────────────────────────────────
 *
 * The API key. It is read from the environment, held in a client, and never
 * logged, never returned, never put in an error message. describe() reports
 * its LENGTH and whether it contains whitespace, because those are what
 * actually go wrong with a pasted credential and neither reveals the value.
 */

const { BrevoClient } = require("@getbrevo/brevo");

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credentials as pasted, cleaned up.
 *
 * The same treatment email.transport.js gives every credential: a key copied
 * out of a browser can pick up a trailing newline, and Brevo answers 401,
 * which reads exactly like a wrong key.
 */
const cred = (v) => (typeof v === "string" ? v.replace(/\s+/g, "") : v);

const apiKey = (env = process.env) => cred(env.BREVO_API_KEY) || null;

/** The authenticated sender. Nothing is invented here — an unset value is null. */
const sender = (env = process.env) => ({
  email: (env.BREVO_SENDER_EMAIL || "").trim() || null,
  name:  (env.BREVO_SENDER_NAME  || "").trim() || null,
});

const replyTo = (env = process.env) => {
  const address = (env.BREVO_REPLY_TO || "").trim();
  return address ? { email: address } : null;
};

const isConfigured = (env = process.env) =>
  Boolean(apiKey(env) && sender(env).email);

/**
 * Everything that STOPS this account sending, in the order it matters.
 *
 * A list rather than a throw, so the startup log, the diagnostic script and a
 * failed send can all say the same thing. Mirrors email.transport.problems().
 *
 * ── Blocking only, and why that distinction is load-bearing ───────────────
 *
 * email.transport.transport() throws CHANNEL_NOT_CONFIGURED when this list is
 * non-empty. So anything returned here disables every email this school sends,
 * and only a fault with that consequence belongs in it.
 *
 * BREVO_SENDER_NAME used to be here, and it is exactly the wrong shape: a
 * missing display name is cosmetic — Brevo sends perfectly well from a bare
 * address — but its presence in this list meant an unset one turned off fee
 * reminders, gate scans and absence notices, while the error text said "mail
 * will still send". A school would have read that message in the log and had
 * no reason to connect it to the mail that never arrived. Advisory faults go
 * to advisories() below, which nothing gates on.
 */
const problems = (env = process.env) => {
  const out = [];
  if (!apiKey(env)) {
    out.push(
      "BREVO_API_KEY is not set. Create a v3 API key in Brevo under " +
      "SMTP & API → API keys and put it in the backend environment."
    );
  }
  if (!sender(env).email) {
    out.push(
      "BREVO_SENDER_EMAIL is not set. It must be an address on a sending " +
      "domain authenticated in Brevo — Brevo refuses anything else."
    );
  }
  return out;
};

/**
 * Faults worth reporting that do not stop a single email.
 *
 * Reported at startup and in describe(), gated on by nothing. Keeping these
 * apart from problems() is what stops a cosmetic omission from silently
 * becoming an outage — see the note above.
 */
const advisories = (env = process.env) => {
  const out = [];
  if (apiKey(env) && sender(env).email && !sender(env).name) {
    out.push(
      "BREVO_SENDER_NAME is not set. Mail still sends, but a parent sees a " +
      "bare address rather than the school's name in their inbox."
    );
  }
  return out;
};

/**
 * Template ids, from the environment, by purpose.
 *
 * Unset is a legitimate state and NOT an error: a school that has not built
 * the templates in Brevo yet sends the HTML this app already renders. Anything
 * non-numeric is treated as unset rather than passed on — Brevo requires a
 * number and would answer 400 for a stray string, which reads as a send
 * failure rather than a configuration one.
 *
 * ┌──────────────────────┬──────────────────────────────────────────────────┐
 * │ purpose              │ environment variable                             │
 * ├──────────────────────┼──────────────────────────────────────────────────┤
 * │ verify email         │ BREVO_TEMPLATE_VERIFY_EMAIL                      │
 * │ password reset       │ BREVO_TEMPLATE_PASSWORD_RESET                    │
 * │ welcome              │ BREVO_TEMPLATE_WELCOME                           │
 * │ fee receipt          │ BREVO_TEMPLATE_FEE_RECEIPT                       │
 * │ fee reminder         │ BREVO_TEMPLATE_FEE_REMINDER                      │
 * │ attendance           │ BREVO_TEMPLATE_ATTENDANCE                        │
 * │ result published     │ BREVO_TEMPLATE_RESULT_PUBLISHED                  │
 * └──────────────────────┴──────────────────────────────────────────────────┘
 */
const TEMPLATE_VARS = {
  verifyEmail:     "BREVO_TEMPLATE_VERIFY_EMAIL",
  passwordReset:   "BREVO_TEMPLATE_PASSWORD_RESET",
  welcome:         "BREVO_TEMPLATE_WELCOME",
  feeReceipt:      "BREVO_TEMPLATE_FEE_RECEIPT",
  feeReminder:     "BREVO_TEMPLATE_FEE_REMINDER",
  attendance:      "BREVO_TEMPLATE_ATTENDANCE",
  resultPublished: "BREVO_TEMPLATE_RESULT_PUBLISHED",
};

const templateId = (purpose, env = process.env) => {
  const raw = env[TEMPLATE_VARS[purpose]];
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// THE CLIENT
// ─────────────────────────────────────────────────────────────────────────────

// One client, built lazily and reused. Lazily because constructing it at
// import time would make every script that merely requires this file — every
// check suite in scripts/ — build a client it never uses.
let client = null;
let clientKey = null;

/*
 * An injected stub, and why it is a separate variable.
 *
 * It used to share `client`, guarded by comparing clientKey against the key in
 * the environment. That guard let a real client be built underneath a stub:
 * __setClient read process.env while sendMail was passed an explicit env
 * object, the two keys differed, and the cache was rebuilt — so the test suite
 * posted to api.brevo.com and got a 401 from the live API.
 *
 * A stub is not a cache entry. It is a decision to bypass the client entirely,
 * so it lives in its own variable and short-circuits before any key is read.
 */
let stub = null;

const brevo = (env = process.env) => {
  if (stub) return stub;

  const key = apiKey(env);
  if (!key) {
    const err = new Error(problems(env)[0]);
    err.code = "CHANNEL_NOT_CONFIGURED";
    throw err;
  }
  if (client && clientKey === key) return client;
  client    = new BrevoClient({ apiKey: key });
  clientKey = key;
  return client;
};

/** Drops the cached client. For a diagnostic that changes env between tries. */
const reset = () => { client = null; clientKey = null; stub = null; };

/**
 * Replace the client with a stub. Tests only.
 *
 * The alternative is a test that either posts to Brevo — which §19 forbids and
 * which would make the suite depend on the internet — or one that mocks the
 * module registry, which mocks the thing under test. This injects at the seam
 * the send path actually uses.
 */
const __setClient = (replacement) => { stub = replacement; };

// ─────────────────────────────────────────────────────────────────────────────
// SENDING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `"School Name" <sender@domain>` → { name, email }.
 *
 * Both existing send sites build that string, because nodemailer takes one.
 * Brevo wants the two halves separately, so it is taken apart here rather than
 * asking either caller to change.
 */
const parseFrom = (value, env = process.env) => {
  const fallback = sender(env);
  if (!value || typeof value !== "string") return fallback;

  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (m) {
    return {
      name:  (m[1] || "").trim() || fallback.name,
      email: m[2].trim() || fallback.email,
    };
  }
  // A bare address.
  const bare = value.trim();
  return bare.includes("@") ? { name: fallback.name, email: bare } : fallback;
};

/** One address, or several, in Brevo's `[{ email, name }]` shape. */
const recipients = (to) => {
  // Three shapes reach this, and the third was missed: a comma-separated
  // string (what nodemailer takes and what channels.js passes), an array, and
  // a SINGLE { email, name } object — which String()'d to "[object Object]"
  // and would have been sent to Brevo as an address.
  const list = Array.isArray(to)
    ? to
    : (to && typeof to === "object" ? [to] : String(to ?? "").split(","));
  return list
    .map((entry) => {
      if (entry && typeof entry === "object") {
        return entry.email ? { email: String(entry.email).trim(), ...(entry.name ? { name: entry.name } : {}) } : null;
      }
      const address = String(entry ?? "").trim();
      return address ? { email: address } : null;
    })
    .filter(Boolean);
};

/**
 * nodemailer's attachment shape → Brevo's.
 *
 * The receipt path already produces { filename, content } with a Buffer, so it
 * is base64-encoded here. A URL attachment is passed through untouched. An
 * attachment with neither is dropped rather than sent half-formed: Brevo
 * rejects the whole message for one bad entry, which would turn a cosmetic
 * problem into a lost receipt.
 */
const attachments = (list) =>
  (Array.isArray(list) ? list : [])
    .map((a) => {
      if (!a) return null;
      if (a.path && /^https?:\/\//i.test(String(a.path))) {
        return { url: String(a.path), name: a.filename || undefined };
      }
      if (a.url) return { url: String(a.url), name: a.filename || a.name || undefined };
      if (a.content === undefined || a.content === null) return null;
      const buf = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content));
      // Brevo requires a name whenever content is given.
      return { content: buf.toString("base64"), name: a.filename || a.name || "attachment" };
    })
    .filter(Boolean);

/**
 * Send one transactional email.
 *
 * Deliberately nodemailer-shaped — `{ from, to, subject, html, text }` — so
 * email.service.js and notification/channels.js send through Brevo without
 * either of them learning that they have. `templateId` and `params` are the
 * additions; when a templateId is given, Brevo renders it and htmlContent is
 * not sent, because Brevo ignores it in that case and sending both invites
 * confusion about which one arrived.
 *
 * Throws on failure, with the provider's message and no credential in it. The
 * callers already handle a throw: channels.js lets the dispatcher record the
 * attempt and retry on its own backoff, and email.service.js returns
 * { success: false }. Neither rolls anything back, which is the point — a fee
 * payment is recorded whether or not the receipt reaches an inbox.
 */
const sendMail = async ({
  from, to, subject, html, text, replyTo: replyToOverride,
  attachments: files, templateId: template, params, headers,
  cc, bcc,
} = {}, env = process.env) => {
  const list = recipients(to);
  if (!list.length) {
    const err = new Error("No recipient address");
    err.code = "NO_RECIPIENT";
    throw err;
  }

  // problems() is blocking-only now, so every entry here is fatal and no
  // filtering is needed — the display-name note moved to advisories().
  if (!isConfigured(env)) {
    const err = new Error(problems(env)[0] ?? "Brevo is not configured");
    err.code = "CHANNEL_NOT_CONFIGURED";
    throw err;
  }

  const payload = {
    sender: parseFrom(from, env),
    to:     list,
  };

  const reply = replyToOverride
    ? (typeof replyToOverride === "string" ? { email: replyToOverride } : replyToOverride)
    : replyTo(env);
  if (reply) payload.replyTo = reply;

  if (template) {
    payload.templateId = Number(template);
    if (params && Object.keys(params).length) payload.params = params;
    // Brevo applies the template's own subject unless overridden.
    if (subject) payload.subject = subject;
  } else {
    if (subject) payload.subject     = subject;
    if (html)    payload.htmlContent = html;
    if (text)    payload.textContent = text;
  }

  const ccList  = cc  ? recipients(cc)  : [];
  const bccList = bcc ? recipients(bcc) : [];
  if (ccList.length)  payload.cc  = ccList;
  if (bccList.length) payload.bcc = bccList;

  const attached = attachments(files);
  if (attached.length) payload.attachment = attached;
  if (headers && Object.keys(headers).length) payload.headers = headers;

  const res = await brevo(env).transactionalEmails.sendTransacEmail(payload);

  return {
    messageId: res?.messageId ?? res?.messageIds?.[0] ?? null,
    accepted:  list.map((r) => r.email),
    provider:  "brevo",
  };
};

/**
 * Is this key accepted, without sending anything?
 *
 * The SMTP providers answer this with nodemailer's verify(), which completes a
 * handshake and authenticates. scripts/mail-verify.js calls that method on
 * whatever transport the registry hands it, so this adapter has to have one or
 * the diagnostic dies with "transport.verify is not a function" on the only
 * provider this app actually uses.
 *
 * GET /v3/account is the HTTP equivalent: it authenticates, returns the
 * account the key belongs to, and sends no mail. The account's own email and
 * plan come back, which is worth more than a bare yes — the mistake this
 * diagnoses is usually a key from the WRONG Brevo account, and that is
 * invisible in a yes/no answer.
 */
const verify = async (env = process.env) => {
  const res = await brevo(env).account.getAccount();
  return {
    ok:      true,
    account: res?.email ?? null,
    company: res?.companyName ?? null,
    plan:    Array.isArray(res?.plan) ? res.plan[0]?.type ?? null : null,
  };
};

/**
 * A safe description for logs and the diagnostic — shape, never secrets.
 *
 * Same contract as email.transport.describe(), so the two read alike in a
 * startup log.
 */
const describe = (env = process.env) => {
  const shape = (v) =>
    v === undefined || v === null || v === ""
      ? "unset"
      : `${String(v).length} chars${/\s/.test(String(v)) ? ", contains whitespace" : ""}`;

  return {
    provider: "brevo-api",
    label:    "Brevo (Transactional API)",
    from:     sender(env).email,
    fromName: sender(env).name,
    replyTo:  replyTo(env)?.email ?? null,
    problems:   problems(env),
    advisories: advisories(env),
    vars: {
      // The key by shape only. Never the value, in any code path.
      BREVO_API_KEY:      shape(env.BREVO_API_KEY),
      BREVO_SENDER_EMAIL: shape(env.BREVO_SENDER_EMAIL),
      BREVO_SENDER_NAME:  shape(env.BREVO_SENDER_NAME),
      BREVO_REPLY_TO:     shape(env.BREVO_REPLY_TO),
    },
    templates: Object.fromEntries(
      Object.keys(TEMPLATE_VARS).map((k) => [k, templateId(k, env)])
    ),
  };
};

module.exports = {
  TEMPLATE_VARS,
  apiKey,          // returns the key for the client only; never logged
  sender,
  replyTo,
  isConfigured,
  problems,
  advisories,
  templateId,
  parseFrom,
  recipients,
  attachments,
  sendMail,
  verify,
  describe,
  reset,
  __setClient,
};
