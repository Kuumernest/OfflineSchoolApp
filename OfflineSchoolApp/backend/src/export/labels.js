// backend/src/export/labels.js
"use strict";

/**
 * Column headings for spreadsheet exports, in both school languages.
 *
 * Held here rather than sent by the clients, for the same reason the printed
 * documents hold theirs: a client one version behind would produce a file with
 * blank column headings instead of a visible error, and a spreadsheet with no
 * headings is worse than no spreadsheet.
 */

const LABELS = {
  en: {
    // sheet / file names
    students: "Students", arrears: "Fee arrears", payments: "Fee payments",
    expenses: "Expenses", payroll: "Payroll", classHistory: "Class history",

    // columns
    no: "No.", name: "Name", admissionNo: "Admission no.", class: "Class",
    gender: "Gender", dateOfBirth: "Date of birth", phone: "Phone",
    guardian: "Guardian", guardianPhone: "Guardian phone",
    status: "Status", enrolledOn: "Enrolled on",
    charged: "Charged", waived: "Waived", paid: "Paid", balance: "Balance",
    receiptNo: "Receipt no.", date: "Date", academicYear: "Academic year",
    amount: "Amount", method: "Method", reference: "Reference", type: "Type",
    payment: "Payment", reversal: "Reversal",
    category: "Category", description: "Description", vendor: "Paid to",
    voided: "Voided", voidReason: "Void reason", yes: "Yes",
    approvalStatus: "Approval", awaitingApproval: "Awaiting approval",
    rejected: "Rejected",
    payslipNo: "Payslip no.", month: "Month", staff: "Staff member", role: "Role",
    basePay: "Base pay", allowances: "Allowances", deductions: "Deductions",
    gross: "Gross", net: "Net", paidOn: "Paid on", runStatus: "Run status",
    outcome: "Outcome",
  },

  fr: {
    students: "Élèves", arrears: "Frais impayés", payments: "Paiements",
    expenses: "Dépenses", payroll: "Paie", classHistory: "Historique des classes",

    no: "N°", name: "Nom", admissionNo: "Matricule", class: "Classe",
    gender: "Sexe", dateOfBirth: "Date de naissance", phone: "Téléphone",
    guardian: "Tuteur", guardianPhone: "Téléphone du tuteur",
    status: "Statut", enrolledOn: "Inscrit le",
    charged: "Facturé", waived: "Remise", paid: "Payé", balance: "Solde",
    receiptNo: "N° de reçu", date: "Date", academicYear: "Année scolaire",
    amount: "Montant", method: "Mode", reference: "Référence", type: "Type",
    payment: "Paiement", reversal: "Annulation",
    category: "Catégorie", description: "Description", vendor: "Bénéficiaire",
    voided: "Annulée", voidReason: "Motif d'annulation", yes: "Oui",
    approvalStatus: "Validation", awaitingApproval: "En attente de validation",
    rejected: "Refusée",
    payslipNo: "N° de bulletin", month: "Mois", staff: "Personnel", role: "Rôle",
    basePay: "Salaire de base", allowances: "Indemnités", deductions: "Retenues",
    gross: "Brut", net: "Net", paidOn: "Payé le", runStatus: "État de la paie",
    outcome: "Décision",
  },
};

/** Falls back to English rather than to a sheet of blank headings. */
const labelsFor = (lang) =>
  LABELS[String(lang || "").toLowerCase().slice(0, 2)] ?? LABELS.en;

module.exports = { LABELS, labelsFor };
