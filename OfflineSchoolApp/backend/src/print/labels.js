// backend/src/print/labels.js
"use strict";

/**
 * Wording for printed documents, in both school languages.
 *
 * The clients each have a full translation catalogue, so the obvious move is to
 * let them send the strings. It is the wrong one: the labels would then have to
 * match the template's expectations exactly, in two codebases, and a client one
 * version behind would print a sheet with blank column headings rather than an
 * error anybody could see.
 *
 * The template owns its own wording. It is thirty-odd strings, and they change
 * only when the template does.
 */

const LABELS = {
  en: {
    // ── Shared ──
    printedOn:      "Printed",
    teacher:        "Class teacher",
    headTeacher:    "Head teacher",
    registrar:      "Registrar",
    student:        "Student",
    class:          "Class",
    academicYear:   "Academic year",
    term:           "Term",
    admissionNo:    "Admission no.",
    gender:         "Gender",
    dateOfBirth:    "Date of birth",
    guardian:       "Guardian",
    phone:          "Phone",
    grade:          "Grade",
    average:        "Average",
    subject:        "Subject",
    status:         "Status",
    no:             "No.",

    // ── Class list ──
    classList:      "Class list",
    register:       "Attendance register",
    contacts:       "Contact sheet",
    total:          "Total",
    male:           "Boys",
    female:         "Girls",
    unspecified:    "Not recorded",
    emptyClass:     "No students in this class",

    // ── Transcript ──
    transcript:     "Academic transcript",
    position:       "Position",
    mark:           "Mark",
    outcome:        "Outcome",
    overallAverage: "Overall average",
    yearsOnRecord:  "Years on record",
    noResults:      "No published results for this year",
    emptyRecord:    "Nothing on record for this student yet",
    disclaimer:
      "This is a record of results published by the school. It is not a certificate.",

    // ── Receipt ──
    receipt:         "Fee receipt",
    receiptReversal: "Receipt — payment reversed",
    feePayment:      "School fees",
    reversalOf:      "Reversal of a fee payment",
    accountAfter:    "Account after this payment",
    charged:         "Total charged",
    waived:          "Less waivers",
    paidToDate:      "Paid to date",
    balance:         "Balance remaining",
    receivedBy:      "Received by",
    bursar:          "Bursar",
    receiptNo:       "Receipt no.",
    amount:          "Amount",
    description:     "Description",
    receiptNote:
      "Keep this receipt. It is the school's record that this payment was made.",

    // Payment methods. The stored values are codes ("mobile_money"); a receipt
    // a parent keeps should not show an underscore.
    methods: {
      cash: "Cash", mobile_money: "Mobile money", bank: "Bank transfer",
      cheque: "Cheque", waiver: "Waiver", other: "Other",
    },
  },

  fr: {
    printedOn:      "Imprimé le",
    teacher:        "Professeur principal",
    headTeacher:    "Directeur",
    registrar:      "Secrétaire",
    student:        "Élève",
    class:          "Classe",
    academicYear:   "Année scolaire",
    term:           "Trimestre",
    admissionNo:    "Matricule",
    gender:         "Sexe",
    dateOfBirth:    "Date de naissance",
    guardian:       "Tuteur",
    phone:          "Téléphone",
    grade:          "Note",
    average:        "Moyenne",
    subject:        "Matière",
    status:         "Statut",
    no:             "N°",

    classList:      "Liste de classe",
    register:       "Feuille de présence",
    contacts:       "Fiche de contacts",
    total:          "Total",
    male:           "Garçons",
    female:         "Filles",
    unspecified:    "Non renseigné",
    emptyClass:     "Aucun élève dans cette classe",

    transcript:     "Relevé de notes",
    position:       "Rang",
    mark:           "Note",
    outcome:        "Décision",
    overallAverage: "Moyenne générale",
    yearsOnRecord:  "Années enregistrées",
    noResults:      "Aucun résultat publié pour cette année",
    emptyRecord:    "Aucun élément enregistré pour cet élève",
    disclaimer:
      "Ceci est un relevé des résultats publiés par l'établissement. Ce n'est pas un diplôme.",

    receipt:         "Reçu de frais",
    receiptReversal: "Reçu — paiement annulé",
    feePayment:      "Frais de scolarité",
    reversalOf:      "Annulation d'un paiement",
    accountAfter:    "Situation après ce paiement",
    charged:         "Total facturé",
    waived:          "Moins les remises",
    paidToDate:      "Payé à ce jour",
    balance:         "Solde restant",
    receivedBy:      "Reçu par",
    bursar:          "Économe",
    receiptNo:       "N° de reçu",
    amount:          "Montant",
    description:     "Description",
    receiptNote:
      "Conservez ce reçu. Il atteste que ce paiement a bien été effectué.",

    methods: {
      cash: "Espèces", mobile_money: "Mobile money", bank: "Virement bancaire",
      cheque: "Chèque", waiver: "Remise", other: "Autre",
    },
  },
};

/** Falls back to English for anything not offered, never to a blank sheet. */
const labelsFor = (lang) => LABELS[String(lang || "").toLowerCase().slice(0, 2)] ?? LABELS.en;

/** Dates in the reader's language — the one place the locale genuinely matters. */
const formatPrintDate = (date, lang) => {
  try {
    return new Intl.DateTimeFormat(lang === "fr" ? "fr-CM" : "en-CM", {
      day: "numeric", month: "long", year: "numeric",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

module.exports = { LABELS, labelsFor, formatPrintDate };
