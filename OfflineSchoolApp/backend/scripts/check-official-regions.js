// backend/scripts/check-official-regions.js
"use strict";

/**
 * The report header's region, in each column's language (A9, decided
 * 2026-10-27): all ten of Cameroon's regions, whatever the school typed.
 *
 *   node scripts/check-official-regions.js
 */

const { headerColumn, REGIONS } = require("../../shared/officialHeader");

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}:\n       got      ${a}\n       expected ${e}`); }
};
const fr = (region) => headerColumn("fr", { region }).regional;
const en = (region) => headerColumn("en", { region }).regional;

check("the reported card: NORTH WEST → Nord-Ouest", fr("NORTH WEST"), "Délégation Régionale du Nord-Ouest");
check("all ten regions, French names",
  REGIONS.map((r) => r.fr),
  ["Adamaoua", "Centre", "Est", "Extrême-Nord", "Littoral", "Nord", "Nord-Ouest", "Ouest", "Sud", "Sud-Ouest"]);
check("each region's English name reads back to itself in French",
  REGIONS.map((r) => fr(r.en.toUpperCase())),
  ["Délégation Régionale de l'Adamaoua", "Délégation Régionale du Centre", "Délégation Régionale de l'Est",
   "Délégation Régionale de l'Extrême-Nord", "Délégation Régionale du Littoral", "Délégation Régionale du Nord",
   "Délégation Régionale du Nord-Ouest", "Délégation Régionale de l'Ouest", "Délégation Régionale du Sud",
   "Délégation Régionale du Sud-Ouest"]);
check("a French spelling prints in English on the English column",
  [en("Extrême-Nord"), en("sud-ouest"), en("Région de l'Ouest")],
  ["Regional Delegation of Far North", "Regional Delegation of South West", "Regional Delegation of West"]);
check("abbreviations: NW, SW", [fr("NW"), fr("sw")], ["Délégation Régionale du Nord-Ouest", "Délégation Régionale du Sud-Ouest"]);
check("a name not in the table prints as typed", fr("Kribi"), "Délégation Régionale de Kribi");
check("no region: no line", fr(""), null);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
