// OfflineSchoolApp/shared/officialHeader.js
"use strict";

/**
 * The official header a Cameroonian report card carries.
 *
 * Three columns: the ministry and the delegations in English down the left, the
 * school's own identity in the middle, the same ministry and delegations in
 * French down the right, and the period underneath. Both languages appear at
 * once on every card — that is the format, not a translation setting. Only the
 * title under the rule follows the reader's language.
 *
 * ── Why this is shared ────────────────────────────────────────────────────
 *
 * Two renderers print this header: the built-in layout, and whatever template
 * a school has saved. They took their school branding from the same place
 * already and still managed to disagree about gender and date of birth for as
 * long as both existed, because each read a different field. The wording of a
 * ministry is worth less room for that: a card whose English column says
 * "Ministry of Secondary Education" and whose French column says "Éducation de
 * Base" is not a document a school can send home.
 *
 * ── What is derived and what is stored ────────────────────────────────────
 *
 * The country and its motto are fixed — this is the Cameroonian format and
 * "Peace — Work — Fatherland" is not configurable. The ministry follows from
 * the school's own type: a primary school sits under Basic Education, a
 * secondary or technical one under Secondary Education. The delegations are
 * stored on the school, because they are an administrative placement nothing
 * can infer — two schools on the same street can sit under different divisional
 * delegations — and fall back to the postal region and city, which is a better
 * guess than a line of dots.
 */

/** Ministry a school's type reports to. */
const MINISTRIES = {
  primary:    "basic",
  // Cameroon's own types (C9). The older values below stay for schools that
  // saved one before these existed.
  college_general:   "secondary",
  college_technical: "secondary",
  lycee_general:     "secondary",
  lycee_technical:   "secondary",
  jhs:        "secondary",
  shs:        "secondary",
  combined:   "secondary",
  vocational: "secondary",
  university: "higher",
  other:      "secondary",
};

/**
 * A blank type is not an unknown one: School defaults schoolType to "primary",
 * so a school that has never opened the settings screen is a primary school and
 * belongs under Basic Education. A type that is set but not in the table is a
 * genuine unknown, and secondary is the safer guess for it.
 */
const ministryFor = (schoolType) => {
  const t = String(schoolType || "").trim().toLowerCase();
  if (!t) return MINISTRIES.primary;
  return MINISTRIES[t] || "secondary";
};

const OFFICIAL = {
  en: {
    country: "Republic of Cameroon",
    peace:   "Peace — Work — Fatherland",
    ministry: {
      basic:     "Ministry of Basic Education",
      secondary: "Ministry of Secondary Education",
      higher:    "Ministry of Higher Education",
    },
    regional:   "Regional Delegation of",
    divisional: "Divisional Delegation of",
    types: {
      primary:    "Primary Education",
      college_general:   "General Secondary Education",
      college_technical: "Technical Secondary Education",
      lycee_general:     "General Secondary Education",
      lycee_technical:   "Technical Secondary Education",
      jhs:        "General Secondary Education",
      shs:        "General Secondary Education",
      combined:   "General and Technical Secondary Education",
      vocational: "Technical and Vocational Education",
      university: "Higher Education",
      other:      null,
    },
    progressRecord: "Progress Record",
  },

  fr: {
    country: "République du Cameroun",
    peace:   "Paix — Travail — Patrie",
    ministry: {
      basic:     "Ministère de l'Éducation de Base",
      secondary: "Ministère des Enseignements Secondaires",
      higher:    "Ministère de l'Enseignement Supérieur",
    },
    regional:   "Délégation Régionale de",
    divisional: "Délégation Départementale de",
    types: {
      primary:    "Enseignement Primaire",
      college_general:   "Enseignement Secondaire Général",
      college_technical: "Enseignement Secondaire Technique",
      lycee_general:     "Enseignement Secondaire Général",
      lycee_technical:   "Enseignement Secondaire Technique",
      jhs:        "Enseignement Secondaire Général",
      shs:        "Enseignement Secondaire Général",
      combined:   "Enseignement Secondaire Général et Technique",
      vocational: "Enseignement Technique et Professionnel",
      university: "Enseignement Supérieur",
      other:      null,
    },
    progressRecord: "Relevé de Notes",
  },
};

/**
 * Cameroon's ten regions, in each column's language (A9, decided 2026-10-27).
 *
 * The French column printed the region as the school typed it — "Délégation
 * Régionale de NORTH WEST". The stored name is matched whatever its case,
 * accents, hyphens or abbreviation ("NW", "Far North", "Extrême-Nord") and
 * printed in the column's own language, the French with its article: "du
 * Nord-Ouest", "de l'Adamaoua". A region not in the table prints as typed.
 */
const REGIONS = [
  { en: "Adamawa",    fr: "Adamaoua",     frOf: "de l'Adamaoua",    aka: ["adamawa", "adamaoua"] },
  { en: "Centre",     fr: "Centre",       frOf: "du Centre",        aka: ["centre", "center"] },
  { en: "East",       fr: "Est",          frOf: "de l'Est",         aka: ["east", "est"] },
  { en: "Far North",  fr: "Extrême-Nord", frOf: "de l'Extrême-Nord", aka: ["far north", "extreme north", "extreme nord", "fn"] },
  { en: "Littoral",   fr: "Littoral",     frOf: "du Littoral",      aka: ["littoral"] },
  { en: "North",      fr: "Nord",         frOf: "du Nord",          aka: ["north", "nord"] },
  { en: "North West", fr: "Nord-Ouest",   frOf: "du Nord-Ouest",    aka: ["north west", "northwest", "nord ouest", "nw"] },
  { en: "West",       fr: "Ouest",        frOf: "de l'Ouest",       aka: ["west", "ouest"] },
  { en: "South",      fr: "Sud",          frOf: "du Sud",           aka: ["south", "sud"] },
  { en: "South West", fr: "Sud-Ouest",    frOf: "du Sud-Ouest",     aka: ["south west", "southwest", "sud ouest", "sw"] },
];

const regionKey = (name) => String(name ?? "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim()
  .replace(/^(the )?region (of |de l'|de la |du |de )?|^(the )|\s+region$/g, "").trim();

/** The region in the table for a stored name, or null. */
const regionOf = (name) => {
  const k = regionKey(name);
  return k ? REGIONS.find((r) => r.aka.includes(k)) ?? null : null;
};

/** The separator a real card prints between the blocks of a margin column. */
const SEPARATOR = "**********************";

/**
 * One margin column, resolved.
 *
 * A delegation with nothing to name is left out rather than printed as a label
 * with nothing after it: a document going home to a family should not have a
 * blank on it where a place name belongs.
 *
 * @param {"en"|"fr"} lang
 * @param {object} school
 * @returns {{country, peace, ministry, regional: string|null,
 *            divisional: string|null, schoolType: string|null}}
 */
/** "Regional Delegation of North West" / "Délégation Régionale du Nord-Ouest". */
const regionalLine = (lang, region) => {
  const known = regionOf(region);
  if (lang === "fr") {
    return known ? `Délégation Régionale ${known.frOf}` : `${OFFICIAL.fr.regional} ${region}`;
  }
  return `${OFFICIAL.en.regional} ${known ? known.en : region}`;
};

const headerColumn = (lang, school = {}) => {
  const l = lang === "fr" ? "fr" : "en";
  const o = OFFICIAL[l];

  const region   = (school.region   || school.state || "").trim();
  const division = (school.division || school.city  || "").trim();
  const type     = String(school.schoolType || "").toLowerCase();

  return {
    country:    o.country,
    peace:      o.peace,
    ministry:   o.ministry[ministryFor(type)],
    regional:   region   ? regionalLine(l, region)        : null,
    divisional: division ? `${o.divisional} ${division}` : null,
    schoolType: o.types[type] ?? null,
  };
};

/**
 * Both columns at once, which is how the header is always printed.
 *
 * @returns {{ en: object, fr: object, separator: string }}
 */
const officialHeader = (school = {}) => ({
  en:        headerColumn("en", school),
  fr:        headerColumn("fr", school),
  separator: SEPARATOR,
});

/**
 * The line under the rule: the period this card is for, then what it is.
 *
 * "First Sequence Progress Record", not "Sequence 1" and not "ACADEMIC REPORT
 * CARD" — the period is the whole reason a family can tell one card from the
 * next, and it was being printed as a bare number.
 *
 * @param {string|null} period  from shared/reportCard.js periodName()
 * @param {"en"|"fr"}   [lang]
 */
const reportTitle = (period, lang = "en") => {
  const o = OFFICIAL[lang === "fr" ? "fr" : "en"];
  // Coerced, not assumed: `term` on a payload has been a number as often as a
  // string, and a card is not worth losing over the difference.
  const p = String(period ?? "").trim();
  if (!p) return o.progressRecord;
  return lang === "fr"
    // "Relevé de Notes — Première Séquence" reads correctly where the English
    // order does not translate.
    ? `${o.progressRecord} — ${p}`
    : `${p} ${o.progressRecord}`;
};

module.exports = {
  officialHeader, headerColumn, reportTitle, ministryFor, regionOf,
  OFFICIAL, MINISTRIES, SEPARATOR, REGIONS,
};
