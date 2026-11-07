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

const { RECEIPT_LABELS } = require("../../../shared/receiptHtml");

const LABELS = {
  en: {
    // ── Shared ──
    printedOn:      "Printed",
    teacher:        "Classmaster",
    headTeacher:    "Principal",
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
    // Words for the stored values, so the record reads "Female", "Approved",
    // "1st Term · Sequence 1" rather than female / approved / "Term 1" twice.
    termNames:     ["1st Term", "2nd Term", "3rd Term"],
    sequenceWord:  "Sequence",
    outOf20:       "/20",
    statusValues:  { pending: "Pending", approved: "Approved", rejected: "Rejected",
                     suspended: "Suspended", graduated: "Graduated" },
    outcomeValues: { promoted: "Promoted", repeated: "Repeated", graduated: "Graduated",
                     transferred: "Transferred", withdrawn: "Withdrawn" },

    // ── Receipt ──
    // shared/receiptHtml.js: the desktop and the phone print a provisional
    // receipt from the same template and wording when this server is out of
    // reach, so the words live beside the template.
    ...RECEIPT_LABELS.en,

    // ── Verification ──
    verifyTitle: "Verify this document",
    verifyHint:  "Scan the code, or enter",

    // ── ID card ──
    idCard:      "Student identity card",
    affixPhoto:  "Affix photo here",
    validUntil:  "Valid until",
    ifFound:     "If found, call",
    studentSignature: "Student's signature",
    emergencyContact: "Emergency contact",
    sexValues:   { male: "Male", female: "Female", other: "Other" },
    // A gender not given: the same phrase on every screen and document.
    sexUnspecified: "Not specified",
  },

  fr: {
    printedOn:      "Imprimé le",
    teacher:        "Professeur principal",
    headTeacher:    "Chef d'établissement",
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
    termNames:     ["1er trimestre", "2e trimestre", "3e trimestre"],
    sequenceWord:  "Séquence",
    outOf20:       "/20",
    statusValues:  { pending: "En attente", approved: "Admis(e)", rejected: "Refusé(e)",
                     suspended: "Suspendu(e)", graduated: "Diplômé(e)" },
    outcomeValues: { promoted: "Admis(e) en classe supérieure", repeated: "Redouble",
                     graduated: "Diplômé(e)", transferred: "Transféré(e)", withdrawn: "Retiré(e)" },

    ...RECEIPT_LABELS.fr,

    verifyTitle: "Vérifier ce document",
    verifyHint:  "Scannez le code, ou saisissez",

    idCard:      "Carte d'identité scolaire",
    affixPhoto:  "Coller la photo ici",
    validUntil:  "Valable jusqu'au",
    ifFound:     "En cas de perte, appeler",
    studentSignature: "Signature de l'élève",
    emergencyContact: "Contact d'urgence",
    sexValues:   { male: "Masculin", female: "Féminin", other: "Autre" },
    sexUnspecified: "Non précisé",
  },
};

/** Falls back to English for anything not offered, never to a blank sheet. */
const labelsFor = (lang) => LABELS[String(lang || "").toLowerCase().slice(0, 2)] ?? LABELS.en;

// Dates in the reader's language — shared, so a receipt printed on the desktop
// with no connection carries its date in the same words as the server's.
const { formatPrintDate } = require("../../../shared/printDocument");

module.exports = { LABELS, labelsFor, formatPrintDate };
