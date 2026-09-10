# 20 — Email (Brevo Transactional Email)

Every email this system sends leaves through **Brevo's Transactional Email
API**. This document is the whole of it: what sends mail, what to put in the
environment, how to check it before trusting it, and what the failures look
like.

Two things to know before anything else.

**Email is a side effect, never a dependency.** A school with no mail provider
at all takes a register, records a fee payment and publishes results exactly as
one with a working provider does. Every notification is still *recorded* and
still appears in the parent portal; only *delivery* is missing, and the stored
row carries a `skipReason` that says so. This is deliberate and is asserted by
the test suite — an email failure must never invalidate the attendance,
payment or result operation underneath it. See
[13-financial-workflows.md](13-financial-workflows.md).

**The API key is a backend secret and has no client-side equivalent.** No
`EXPO_PUBLIC_`, `VITE_` or `REACT_APP_` variable carries it, and none may: those
are compiled into bundles that anyone who installs the app can unpack. Nothing
in `web/`, `mobile/` or `desktop/` references Brevo at all.

---

## 1. What actually sends email

Two code paths, one provider decision. Both call
`mail.transport().sendMail(...)`, and `services/email.transport.js` is the only
place that decides what that transport is.

| Path | File | What it sends |
|---|---|---|
| Direct | `services/email.service.js` | Staff and student credentials — a teacher or admin's welcome mail, an admin-issued password reset, an admissions approval or rejection. Sent inline, on the request. |
| Queue | `services/notification/channels.js` | Fee reminders and receipts, gate arrivals and departures, absences, published results. Enqueued, retried with backoff, and recorded whether or not delivery succeeds. |

That split is load-bearing. A previous version of this system had **two**
provider decisions that disagreed — `email.service.js` understood one set of
providers and the queue understood another — so a school could receive staff
credentials while every fee reminder was written to stdout and reported to the
bursar as sent. `scripts/check-email-transport.js` exists to keep those two
answers identical and asserts agreement directly.

### There is no self-service password reset, and no email verification

Worth stating plainly, because both are usual in a system like this and neither
exists here:

- **No "forgot password" flow.** The `reset-password` routes are
  *administrator-initiated*: a head teacher resets a teacher's or a student's
  password and the new one is mailed out. There is no public endpoint a user
  can hit with their own address, and therefore no reset token.
- **No email verification.** Accounts are created *by* an administrator, who
  types the address. Nobody self-registers, so there is nothing to verify.
  `BREVO_TEMPLATE_VERIFY_EMAIL` exists in the environment and is deliberately
  unreachable — see §4.

One consequence is worth flagging rather than hiding: an admin-issued reset
mails a **temporary password in the message body**. That is pre-existing
behaviour, unchanged by the move to Brevo, and it means the temporary password
passes through — and is retained in — the provider's message log, exactly as it
previously passed through Gmail or SendGrid. It is also why the parent portal's
notification list is an explicit *allowlist* of kinds rather than a blocklist:
`Notification.body` can contain one.

---

## 2. Required environment variables

Backend only, in `backend/.env`. `backend/.env.example` carries the same list
with placeholders and no values.

| Variable | Required | What it is |
|---|---|---|
| `BREVO_API_KEY` | **yes** | The v3 API key, beginning `xkeysib-`. Not the SMTP key. |
| `BREVO_SENDER_EMAIL` | **yes** | The From address. Must be on a domain authenticated in the Brevo account — `no-reply@offlineschool.vgrp.org`. |
| `BREVO_SENDER_NAME` | no | The display name a parent sees. Mail sends without it; they just see a bare address. |
| `BREVO_REPLY_TO` | no | Where a reply goes — `support@vgrp.org`. Without it, replies go to a `no-reply@` nobody reads. |
| `BREVO_TEMPLATE_*` | no | Seven optional template ids. See §4. |
| `EMAIL_FROM` | no | Legacy. Overrides `BREVO_SENDER_EMAIL` if set. Kept so an existing deployment keeps working; leave it empty in new ones. |

**Required means required to send, not required to boot.** The server starts
without any of them, prints one line saying email is unavailable, and runs.
`config/env.js` never treats a missing mail variable as fatal.

### Missing `BREVO_SENDER_NAME` is not an outage

This distinction was a real bug and is now enforced by a test. `transport()`
throws `CHANNEL_NOT_CONFIGURED` for anything in `problems()`, so anything in
that list disables *all* email. `BREVO_SENDER_NAME` used to be in it — meaning
a school that had not set a display name sent nothing at all, while the log
line said "mail will still send". Blocking faults now live in `problems()` and
cosmetic ones in `advisories()`, and nothing gates on the second.

### The two fallback routes

Both exist for networks and setups the API does not suit. Neither is a second
email system; the API wins whenever `BREVO_API_KEY` is present.

| Route | Variables | When |
|---|---|---|
| Brevo over SMTP | `BREVO_SMTP_USER`, `BREVO_SMTP_KEY` | Same Brevo account, port 587 instead of 443 — for a network that permits one and not the other. `BREVO_SMTP_USER` is the SMTP login from the panel (like `8a1b2c001@smtp-brevo.com`), **not** the account's login email, and `BREVO_SMTP_KEY` is the SMTP key, **not** the API key. Needs `EMAIL_FROM`. |
| Any SMTP host | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | A self-hosted relay, or a local mail catcher in development. Needs `EMAIL_FROM`. |

### Gmail and SendGrid are gone

`GMAIL_USER`, `GMAIL_APP_PASSWORD` and `SENDGRID_API_KEY` are **read by
nothing**. Both providers were removed from the registry rather than left in
place, because a stale key in a deployed environment would otherwise resolve to
a provider nobody intends to use — silently, since the registry takes the first
match and reports success either way. An environment holding one is treated as
*unconfigured*, which is asserted by the test suite in both directions. The
startup log warns if either is still present. Delete them.

---

## 3. Creating the API key

In the Brevo panel:

1. **SMTP & API → API keys → Generate a new key.** Name it for the deployment
   ("offlineschool production"), not for a person.
2. Copy it immediately — it is shown **once**. It begins `xkeysib-` and runs to
   roughly 60–80 characters.
3. Paste it into `backend/.env` as `BREVO_API_KEY=` with nothing else on the
   line. No quotes, no trailing spaces.

The sending domain is a separate, one-time job done **in Brevo and in DNS, not
in this application**: **Senders, Domains & Dedicated IPs → Domains**, add
`offlineschool.vgrp.org`, and publish the SPF and DKIM records it gives you.
Brevo refuses to send from an unauthenticated domain, and a receiving server is
entitled to treat an unverified sender as forged. Until those records resolve,
a correct key and a correct sender still will not deliver.

---

## 4. Templates

Optional, and unset is a fully working state. With no id, the app sends the HTML
it renders itself — the same mail as before. Set an id and Brevo renders its own
template from the params instead, which keeps the wording out of this
repository and lets a head teacher change it without a deploy.

Create one in **Campaigns → Templates**; the id is the number in its URL. Ids
are per-account, so an id copied from another account will send the wrong email
or none.

| Variable | Purpose | Reached by |
|---|---|---|
| `BREVO_TEMPLATE_WELCOME` | `welcome` | `teacherWelcome`, `adminWelcome` |
| `BREVO_TEMPLATE_PASSWORD_RESET` | `passwordReset` | `passwordResetByAdmin`, `studentPasswordReset` |
| `BREVO_TEMPLATE_FEE_RECEIPT` | `feeReceipt` | queue kind `fee.payment` |
| `BREVO_TEMPLATE_FEE_REMINDER` | `feeReminder` | queue kind `fee.reminder` |
| `BREVO_TEMPLATE_ATTENDANCE` | `attendance` | queue kinds `attendance.absent`, `gate.arrival`, `gate.departure` |
| `BREVO_TEMPLATE_RESULT_PUBLISHED` | `resultPublished` | queue kind `result.published` |
| `BREVO_TEMPLATE_VERIFY_EMAIL` | `verifyEmail` | **nothing — see §1** |

Two templates always send this app's own HTML and have no variable:
`studentApproved` and `studentRejected`. They are admissions decisions, and
there is no purpose in the set that describes them.

Three details that matter:

- **An id only takes effect on the API route.** nodemailer ignores a
  `templateId`, so a school on either SMTP fallback that assigns ids would get
  the old wording with no error at all. `email.transport.templateFor()` returns
  `null` for any non-API provider precisely so that cannot happen, and the test
  suite asserts it.
- **A non-numeric or zero id is treated as unset**, not passed on. Brevo needs
  a number and would answer 400, which reads as a send failure rather than the
  configuration mistake it is.
- **The params are the same data the HTML carried**, including the temporary
  password on a reset. That is not a new exposure — the body contained it
  before — but it does land in Brevo's message log either way.

`npm run mail:verify` prints which ids are assigned and which are not, because
an absent id looks exactly like a wrong one from the outside.

---

## 5. Testing it

### `npm run mail:verify` — the one to run after editing `.env`

```bash
cd backend
npm run mail:verify
```

Reports the provider, the sender, the reply-to, the shape of every credential,
any advisories, and which templates are assigned — then **authenticates without
sending anything** (`GET /v3/account` on the API route, an SMTP handshake on the
others). It prints the Brevo account the key belongs to, which is the one thing
a bare "accepted" would hide: a valid key for the *wrong account* is a common
mistake and looks identical to a correct one.

It never prints a credential. It reports length, whether the value contains
whitespace, and an 8-character hash — enough to answer "did my edit land?"
without anybody reading a secret aloud.

To send a real message:

```bash
node scripts/mail-verify.js you@example.com
```

Check the spam folder as well as the inbox. Landing in spam is a
*deliverability* problem, not a configuration one, and it is the next thing to
fix — bulk fee reminders from a domain whose SPF and DKIM do not resolve are
treated harshly.

### `GET /api/admin/email/config`

Requires `settings.view`. Answers "is this thing configured, and as whom"
without sending anything, in the same shape as the startup log. It asserts on
the way out that the response does not contain the API key, so a future edit to
`describe()` cannot turn it into a credential leak.

### `POST /api/admin/email/test`

Requires `settings.manage`, **refused outright when `NODE_ENV=production`**, and
sends only to the caller's own address taken from the verified token. A body
naming anybody else is refused rather than ignored — so nobody can believe they
tested delivery to a parent. The subject and body are fixed in code; nothing
from the request reaches the message.

### The automated suites

```bash
npm run check:mail     # provider selection, agreement, template reachability
npm run check:brevo    # the adapter: payload shape, refusals, secret hygiene
```

Both are pure — no database, no network, no sockets. `check:brevo` stubs the
client, so it never posts to `api.brevo.com`. Neither proves a message was
delivered, and neither claims to; only an actual send to an address you can
read does that.

---

## 6. Troubleshooting

| Symptom | What it usually is |
|---|---|
| `⚠️ Brevo email service is not configured` at startup | `BREVO_API_KEY` or `BREVO_SENDER_EMAIL` is missing. Everything else works; nothing is delivered. |
| 401, or "Key not found" | One answer for four causes: the key was regenerated (which does not keep the old one working), it belongs to a different Brevo account, it was pasted short, or it is an SMTP key (`xsmtpsib-`) in `BREVO_API_KEY`, which needs a v3 key (`xkeysib-`). Compare the shape `mail:verify` prints. |
| Authenticates, then the send fails | Almost always the sender: `BREVO_SENDER_EMAIL` is not on a domain authenticated in that account. |
| Mail sends, but from a bare address | `BREVO_SENDER_NAME` is unset. Cosmetic; `mail:verify` prints it as a note. |
| A template id is set and the wording never changes | The active provider is not `brevo-api`. An id has no effect on either SMTP route. `mail:verify` names the provider on its first line. |
| Delivered but in spam | SPF/DKIM for the sending domain. A DNS job, not a code one. |
| Reminders "sent" but nobody received them | Check the notification row's `skipReason`. With no provider, the queue falls back to the log channel, which always succeeds. That fallback is why `check:mail` asserts both send paths agree about configuration. |
| 535 on either SMTP route | A revoked or mistyped key, a key from another account, or — for the relay — the account's login email used as `BREVO_SMTP_USER` instead of the SMTP login. |

---

## 7. Rotating the key

The key is used on every send and cached per-key inside the adapter, so
rotation is an environment edit and a restart. Nothing in the database or in any
client holds it.

1. Generate a **new** key in Brevo. Do not delete the old one yet.
2. Replace `BREVO_API_KEY` in `backend/.env`.
3. Restart the backend.
4. `npm run mail:verify` — confirm it is accepted **and that the account it
   names is the right one**.
5. Delete the old key in Brevo.

Rotate immediately, in that order, if a key ever reaches a log, a screenshot, a
support thread or a commit. Step 5 is what actually revokes it; steps 1–4 only
stop *this* deployment from using it.

## 8. Deploying it safely

- `.env` is gitignored and must never be committed. `backend/.env.example`
  carries variable **names** and placeholder values only.
- Set the key through the host's secret store (environment variables, a secrets
  manager) rather than by copying a `.env` between machines.
- Never paste a key into an issue, a chat, or a screenshot. `describe()`,
  `problems()`, the startup log, the admin endpoint and `mail:verify` are all
  written so the value cannot appear in any of them, and `check:brevo` asserts
  the key is absent from every one — including the text and the stack of a
  thrown error.
- Production and development should use **different keys**, so revoking one
  does not take the other down.
- `POST /api/admin/email/test` refuses to run in production by design. To check
  production, send a real notification to a test account and read Brevo's own
  transactional log.

---

## See also

- [14-security.md](14-security.md) — secret handling across the whole system
- [13-financial-workflows.md](13-financial-workflows.md) — fee reminders and
  why a delivery failure never rolls back a payment
- [18-operations-troubleshooting.md](18-operations-troubleshooting.md) — the
  notification queue, its retries and its skip reasons
- [19-known-limitations.md](19-known-limitations.md)
