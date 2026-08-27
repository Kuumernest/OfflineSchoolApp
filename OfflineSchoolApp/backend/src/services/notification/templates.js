// backend/src/services/notification/templates.js
"use strict";

/**
 * What each kind of notification actually says, in both school languages.
 *
 * Held here rather than composed at the call site so the wording is reviewable
 * in one place and a resend reproduces the same message. Each returns plain
 * text as well as HTML: some mail clients strip HTML, and the plain part is
 * also what an SMS or WhatsApp adapter would send, so a template written once
 * serves every channel.
 *
 * Deliberately short. These are read on a phone, usually in a hurry, and a
 * parent who has to scroll to find the number has been failed by the message.
 */

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const money = (value, lang) => {
  const n = Number(value ?? 0);
  try {
    return new Intl.NumberFormat(lang === "fr" ? "fr-CM" : "en-CM", {
      style: "currency", currency: "XAF",
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${Math.round(n)} XAF`;
  }
};

const time = (value, lang) => {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(lang === "fr" ? "fr-CM" : "en-CM", {
      hour: "2-digit", minute: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
};

/** Wraps a body in the minimal shell mail clients render consistently. */
const shell = (schoolName, bodyHtml, footer) => `
<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#14181f;line-height:1.5">
  <p style="margin:0 0 14px;font-weight:700;font-size:16px">${esc(schoolName)}</p>
  ${bodyHtml}
  <p style="margin:18px 0 0;font-size:12px;color:#55607a">${esc(footer)}</p>
</div>`;

const FOOTER = {
  en: "This is an automatic message from your school. Please do not reply to it.",
  fr: "Ceci est un message automatique de votre établissement. Merci de ne pas y répondre.",
};

const TEMPLATES = {
  "fee.payment": (d, lang) => {
    const en = lang !== "fr";
    const subject = en
      ? `Payment received — ${d.receiptNo ?? ""}`
      : `Paiement reçu — ${d.receiptNo ?? ""}`;

    const lines = en
      ? [
          `A payment of <b>${money(d.amount, lang)}</b> has been received for <b>${esc(d.studentName)}</b>.`,
          `Receipt number: <b>${esc(d.receiptNo ?? "—")}</b>`,
          d.balance > 0
            ? `Balance remaining: <b>${money(d.balance, lang)}</b>`
            : `The fees for this year are now settled.`,
        ]
      : [
          `Un paiement de <b>${money(d.amount, lang)}</b> a été reçu pour <b>${esc(d.studentName)}</b>.`,
          `Numéro de reçu : <b>${esc(d.receiptNo ?? "—")}</b>`,
          d.balance > 0
            ? `Solde restant : <b>${money(d.balance, lang)}</b>`
            : `Les frais de cette année sont soldés.`,
        ];

    return {
      subject,
      text: lines.map((l) => l.replace(/<[^>]+>/g, "")).join("\n"),
      html: shell(d.schoolName, lines.map((l) => `<p style="margin:0 0 8px">${l}</p>`).join(""), FOOTER[en ? "en" : "fr"]),
    };
  },

  /**
   * The outstanding balance, and the date it was due.
   *
   * The date is the point of this message. "You owe 40,000" invites a reply
   * asking by when; "40,000 was due on 15 September" does not, and a parent who
   * has genuinely paid can say so against a specific bill. It comes from the
   * due date entered on the fee structure, carried onto the charge and passed
   * in by feeReminders.service.
   *
   * Three wordings rather than one, because the difference matters to the
   * person reading it: a bill not yet due is a notice, a bill due today is a
   * nudge, and a bill three weeks late is a different conversation. Sending the
   * overdue wording to somebody whose fees are not due yet is the fastest way
   * to have a school stop using reminders.
   */
  "fee.reminder": (d, lang) => {
    const en = lang !== "fr";

    // Formatted here rather than in the service: the service does not know the
    // family's language, and this is the only place that does.
    const due = d.dueDate
      ? new Date(d.dueDate).toLocaleDateString(en ? "en-GB" : "fr-FR", {
          day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
        })
      : null;

    const days = Number(d.daysOverdue) || 0;
    const late = Boolean(d.isOverdue);

    const opening = en
      ? `<b>${esc(d.studentName)}</b> has an outstanding fee balance of <b>${money(d.balance, lang)}</b>.`
      : `<b>${esc(d.studentName)}</b> a un solde de frais impayés de <b>${money(d.balance, lang)}</b>.`;

    // No due date at all: the plain balance notice, which is what this template
    // said before it learned about deadlines.
    const middle = !due
      ? null
      : late
        ? en
          ? `This was due on <b>${due}</b>${days > 0 ? ` — ${days} day${days === 1 ? "" : "s"} ago` : ""}.`
          : `Le règlement était attendu le <b>${due}</b>${days > 0 ? ` — il y a ${days} jour${days === 1 ? "" : "s"}` : ""}.`
        : en
          ? `It is due on <b>${due}</b>.`
          : `Le règlement est attendu le <b>${due}</b>.`;

    // Three closings, not two. "…by that date" with no date above it is
    // nonsense, and that is exactly what an undated charge produced until
    // rendering all four cases showed it.
    const closing = !due
      ? (en
          ? "Please settle it at the school office."
          : "Merci de le régler au secrétariat.")
      : late
        ? (en
            ? "Please settle it at the school office as soon as you are able."
            : "Merci de le régler au secrétariat dès que possible.")
        : (en
            ? "Please settle it at the school office by that date."
            : "Merci de le régler au secrétariat avant cette date.");

    // A family on an agreed schedule is told which schedule is meant. Without
    // this the message reads as a demand for the whole balance, which is the
    // opposite of what the arrangement said and exactly the confusion that
    // makes a parent stop opening these.
    const arrangement = !d.onPlan
      ? null
      : Number(d.planBehindBy) > 0
        ? (en
            ? `Under the payment arrangement agreed with the school, <b>${money(d.planBehindBy, lang)}</b> of this should have been paid by now.`
            : `Selon l'échéancier convenu avec l'établissement, <b>${money(d.planBehindBy, lang)}</b> de cette somme devait déjà être réglée.`)
        : (en
            ? `This is the next instalment of the arrangement agreed with the school.`
            : `Il s'agit de la prochaine échéance de l'échéancier convenu avec l'établissement.`);

    const lines = [opening, middle, arrangement, closing].filter(Boolean);

    const subject = en
      ? (late ? "Overdue school fees" : "School fees due")
      : (late ? "Frais de scolarité en retard" : "Frais de scolarité à régler");

    return {
      subject,
      text: lines.map((l) => l.replace(/<[^>]+>/g, "")).join("\n"),
      html: shell(d.schoolName, lines.map((l) => `<p style="margin:0 0 8px">${l}</p>`).join(""), FOOTER[en ? "en" : "fr"]),
    };
  },

  "result.published": (d, lang) => {
    const en = lang !== "fr";
    const lines = en
      ? [
          `Results for <b>${esc(d.studentName)}</b> have been published.`,
          `${esc(d.term ?? "")} ${esc(d.academicYear ?? "")}`,
          // Deliberately no marks in the message. Email is not private enough
          // for a child's results, and the portal already authenticates.
          `Sign in to the parent portal to see them.`,
        ]
      : [
          `Les résultats de <b>${esc(d.studentName)}</b> ont été publiés.`,
          `${esc(d.term ?? "")} ${esc(d.academicYear ?? "")}`,
          `Connectez-vous à l'espace parents pour les consulter.`,
        ];
    return {
      subject: en ? "Results published" : "Résultats publiés",
      text: lines.map((l) => l.replace(/<[^>]+>/g, "")).join("\n"),
      html: shell(d.schoolName, lines.map((l) => `<p style="margin:0 0 8px">${l}</p>`).join(""), FOOTER[en ? "en" : "fr"]),
    };
  },

  "gate.arrival": (d, lang) => {
    const en = lang !== "fr";
    const line = en
      ? `<b>${esc(d.studentName)}</b> arrived at school at <b>${time(d.at, lang)}</b>.`
      : `<b>${esc(d.studentName)}</b> est arrivé(e) à l'école à <b>${time(d.at, lang)}</b>.`;
    return {
      subject: en ? "Arrived at school" : "Arrivée à l'école",
      text: line.replace(/<[^>]+>/g, ""),
      html: shell(d.schoolName, `<p style="margin:0">${line}</p>`, FOOTER[en ? "en" : "fr"]),
    };
  },

  "gate.departure": (d, lang) => {
    const en = lang !== "fr";
    const line = en
      ? `<b>${esc(d.studentName)}</b> left school at <b>${time(d.at, lang)}</b>.`
      : `<b>${esc(d.studentName)}</b> a quitté l'école à <b>${time(d.at, lang)}</b>.`;
    return {
      subject: en ? "Left school" : "Départ de l'école",
      text: line.replace(/<[^>]+>/g, ""),
      html: shell(d.schoolName, `<p style="margin:0">${line}</p>`, FOOTER[en ? "en" : "fr"]),
    };
  },

  "attendance.absent": (d, lang) => {
    const en = lang !== "fr";
    const line = en
      ? `<b>${esc(d.studentName)}</b> was not recorded at school today.`
      : `<b>${esc(d.studentName)}</b> n'a pas été enregistré(e) à l'école aujourd'hui.`;
    return {
      subject: en ? "Absent from school" : "Absence à l'école",
      text: line.replace(/<[^>]+>/g, ""),
      html: shell(d.schoolName, `<p style="margin:0">${line}</p>`, FOOTER[en ? "en" : "fr"]),
    };
  },

  announcement: (d, lang) => {
    const en = lang !== "fr";
    return {
      subject: d.title ?? (en ? "School announcement" : "Annonce de l'établissement"),
      text: `${d.title ?? ""}\n\n${d.body ?? ""}`.trim(),
      html: shell(
        d.schoolName,
        `<p style="margin:0 0 8px;font-weight:700">${esc(d.title ?? "")}</p>` +
        `<p style="margin:0;white-space:pre-line">${esc(d.body ?? "")}</p>`,
        FOOTER[en ? "en" : "fr"]
      ),
    };
  },

  test: (d, lang) => {
    const en = lang !== "fr";
    const line = en
      ? "This is a test message. If you are reading it, notifications are working."
      : "Ceci est un message de test. Si vous le lisez, les notifications fonctionnent.";
    return {
      subject: en ? "Test notification" : "Notification de test",
      text: line,
      html: shell(d.schoolName, `<p style="margin:0">${line}</p>`, FOOTER[en ? "en" : "fr"]),
    };
  },
};

/**
 * Render one notification.
 *
 * Throws on an unknown kind rather than sending something blank — a message
 * with an empty body reaching a parent is worse than one that never left.
 */
const render = (kind, data = {}, lang = "en") => {
  const fn = TEMPLATES[kind];
  if (!fn) throw new Error(`No template for notification kind "${kind}"`);
  return fn(data, lang);
};

module.exports = { render, TEMPLATES };
