// src/theme/colors.js
//
// The app's warm, earthy palette and the one colour each kind of tile wears.
// Screens pick a tile by what it shows — TILE.students, TILE.fees — and never
// by hex, so Students is the same teal on every dashboard and every list.
//
// The web console keeps the same hues as its --color-sec-* tokens
// (web/src/index.css); Metro cannot reach that file, so change both together.
//
// Contrast of each tile's text on its fill, measured (WCAG, 4.5:1 for body
// text; scripts/check-tile-contrast.js re-measures every pair):
//   cream on teal 4.98 · plum 7.47 · slate 6.85 · terracottaDeep 4.85 · oliveDeep 4.91
//   ink   on mustard 7.18 · burntOrange 4.97
// Terracotta (4.35) and olive (3.75) miss 4.5 with white as given, so their
// tiles fill with the nearest deeper shade of the same hue. The brand values
// stay below for accents, borders and anything that carries no text.
//
// The app is light-only (app.json userInterfaceStyle), so there is no dark set.

export const PALETTE = {
  tileTerracotta:     "#C8553D",
  tileTerracottaDeep: "#BB4C35",
  tileMustard:        "#E0A526",
  tileTeal:           "#1F7A74",
  tilePlum:           "#7B3F61",
  tileOlive:          "#6B8E4E",
  tileOliveDeep:      "#5A7741",
  tileBurntOrange:    "#D9772B",
  tileSlateBlue:      "#3D5A80",

  pageCream: "#FAF6EF",
  inkWarm:   "#2B2118",
  cream:     "#FFFBF5",
  // Warm-tinted shadow: a brown, not black, so a lifted tile reads as lit
  // paper rather than a grey smudge.
  shadowWarm: "#6B3E1F",
};

const light = (bg) => ({ bg, fg: PALETTE.cream });
const dark  = (bg) => ({ bg, fg: PALETTE.inkWarm });

const TEAL        = light(PALETTE.tileTeal);
const TERRACOTTA  = light(PALETTE.tileTerracottaDeep);
const BURNT       = dark(PALETTE.tileBurntOrange);
const PLUM        = light(PALETTE.tilePlum);
const OLIVE       = light(PALETTE.tileOliveDeep);
const MUSTARD     = dark(PALETTE.tileMustard);
const SLATE       = light(PALETTE.tileSlateBlue);

/**
 * One colour per kind of thing. Grouped by meaning so the palette stays
 * small: people are teal, set work is terracotta, exams burnt orange,
 * outcomes plum, time olive, money mustard, and slate is kept for
 * communication alone.
 */
export const TILE = {
  // People and groups
  students:      TEAL,
  teachers:      TEAL,
  classes:       TEAL,
  // Work that is set
  homework:      TERRACOTTA,
  quizzes:       TERRACOTTA,
  content:       TERRACOTTA,
  subjects:      TERRACOTTA,
  // Exams and marks
  exams:         BURNT,
  marks:         BURNT,
  // Outcomes
  results:       PLUM,
  reports:       PLUM,
  intelligence:  PLUM,
  // Time
  attendance:    OLIVE,
  timetable:     OLIVE,
  // Money
  fees:          MUSTARD,
  finance:       MUSTARD,
  // Communication
  announcements: SLATE,
  messages:      SLATE,
  // The machinery: settings, sign-out. Warm ink, quiet on purpose (14.6:1).
  settings:      light(PALETTE.inkWarm),
};

/** The shape every tile shares, so they match from screen to screen. */
export const TILE_SHAPE = {
  borderRadius: 18,
  padding: 14,
  shadowColor: PALETTE.shadowWarm,
  shadowOpacity: 0.14,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 4 },
  elevation: 3,
};
