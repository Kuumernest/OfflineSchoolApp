// src/theme/colors.js
//
// The app's colours: one brand blue, neutral surfaces, and semantic colour
// only where it carries meaning. Screens use these names, never a hex.
//
// The web console defines the same values in web/src/index.css (@theme);
// Metro cannot reach that file, so change both together.
//
// Contrast, measured (WCAG; scripts/check-tile-contrast.js re-measures):
//   text 17.85 · textSecondary 7.58 · textSubtle 4.76 on white
//   white on primary 5.17 · contextText on contextBg 9.52
//   warning text 6.84 · danger text 7.60 · info text 8.01 · success text 6.81 on their tints
// textMuted (#94A3B8) is 2.56 on white: placeholders and decoration only,
// never text someone has to read.
//
// The app is light-only (app.json userInterfaceStyle), so there is no dark set.

export const COLORS = {
  primary:      "#2563EB",
  primaryHover: "#1D4ED8",
  primaryDark:  "#1E40AF",
  primaryLight: "#EFF6FF",

  text:          "#0F172A",
  textSecondary: "#475569",
  textSubtle:    "#64748B",
  textMuted:     "#94A3B8",
  onPrimary:     "#FFFFFF",
  onPrimaryBox:  "rgba(255,255,255,0.15)",  // the icon box on a primary action

  page:    "#F8FAFC",
  surface: "#FFFFFF",
  border:  "#E2E8F0",
  shadow:  "#0F172A",

  success: "#16A34A", successBg: "#F0FDF4",
  warning: "#D97706", warningBg: "#FFFBEB",
  danger:  "#DC2626", dangerBg:  "#FEF2F2",
  info:    "#2563EB", infoBg:    "#EFF6FF",

  // The school context bar at the top of a dashboard.
  contextBg:     "#EFF6FF",
  contextBorder: "#BFDBFE",
  contextIcon:   "#2563EB",
  contextText:   "#1E3A8A",
};

/**
 * The accents. Each kind of card takes one, the same as the web console
 * (web/src/config/dashboardTint.ts, tokens in web/src/index.css):
 *
 *   base   the 3px top edge of a tinted card
 *   wash   the card's light background
 *   solid  the icon square (with a white icon, COLORS.onPrimary)
 *   deep   the figure on the wash
 *
 * `icon` / `box` are the older pale pair (a coloured glyph on a pale box),
 * kept for a dot or a glyph on white; a tile's icon square is always `solid`.
 * Measured (scripts/check-tile-contrast.js): white on solid ≥ 5.02, deep on
 * wash ≥ 6.81, textSecondary on wash ≥ 6.78.
 */
export const ACCENT = {
  blue:   { base: "#2563EB", wash: "#EFF6FF", solid: "#2563EB", deep: "#1E40AF", icon: "#2563EB", box: "#EFF6FF" },
  violet: { base: "#7C3AED", wash: "#F5F3FF", solid: "#7C3AED", deep: "#5B21B6", icon: "#7C3AED", box: "#F5F3FF" },
  indigo: { base: "#4F46E5", wash: "#EEF2FF", solid: "#4F46E5", deep: "#3730A3", icon: "#4F46E5", box: "#EEF2FF" },
  slate:  { base: "#475569", wash: "#F1F5F9", solid: "#475569", deep: "#1E293B", icon: "#475569", box: "#F1F5F9" },
  teal:   { base: "#0D9488", wash: "#F0FDFA", solid: "#0F766E", deep: "#115E59", icon: "#0D9488", box: "#F0FDFA" },
  amber:  { base: "#D97706", wash: "#FFFBEB", solid: "#B45309", deep: "#92400E", icon: "#B45309", box: "#FFFBEB" },
  green:  { base: "#16A34A", wash: "#F0FDF4", solid: "#15803D", deep: "#166534", icon: "#15803D", box: "#F0FDF4" },
  sky:    { base: "#0284C7", wash: "#F0F9FF", solid: "#0369A1", deep: "#075985", icon: "#0369A1", box: "#F0F9FF" },
  red:    { base: "#DC2626", wash: "#FEF2F2", solid: "#B91C1C", deep: "#991B1B", icon: "#B91C1C", box: "#FEF2F2" },
};

/**
 * One accent per kind of thing, so Students is the same blue everywhere —
 * the same mapping as the web console's dashboards.
 */
export const TILE = {
  students:      ACCENT.blue,
  teachers:      ACCENT.violet,
  classes:       ACCENT.indigo,
  subjects:      ACCENT.slate,
  timetable:     ACCENT.teal,
  attendance:    ACCENT.green,
  exams:         ACCENT.amber,
  marks:         ACCENT.amber,
  homework:      ACCENT.indigo,
  quizzes:       ACCENT.indigo,
  content:       ACCENT.indigo,
  results:       ACCENT.slate,
  reports:       ACCENT.slate,
  intelligence:  ACCENT.violet,
  fees:          ACCENT.teal,
  finance:       ACCENT.teal,
  announcements: ACCENT.sky,
  messages:      ACCENT.sky,
  settings:      ACCENT.slate,
};

/** The border a tinted tile takes when its value means something. */
export const TONE_EDGE = {
  warning: ACCENT.amber.solid,
  error:   ACCENT.red.base,
  info:    ACCENT.blue.solid,
  success: ACCENT.green.solid,
};

/**
 * A card that means something: a light tint, never a solid fill. The number
 * and label take `text`, which is what keeps them readable on the tint.
 */
export const SEMANTIC = {
  warning: { bg: "#FFFBEB", box: "#FEF3C7", icon: "#D97706", text: "#92400E" },
  error:   { bg: "#FEF2F2", box: "#FEE2E2", icon: "#DC2626", text: "#991B1B" },
  info:    { bg: "#EFF6FF", box: "#DBEAFE", icon: "#2563EB", text: "#1E40AF" },
  success: { bg: "#F0FDF4", box: "#DCFCE7", icon: "#16A34A", text: "#166534" },
};

/**
 * The shape every card shares: a hairline border, a faint shadow. White here;
 * a tile (src/components/Tiles.js) puts its kind's wash and a 3px top edge on it.
 */
export const TILE_SHAPE = {
  borderRadius: 16,
  padding: 14,
  backgroundColor: COLORS.surface,
  borderWidth: 1,
  borderColor: COLORS.border,
  shadowColor: COLORS.shadow,
  shadowOpacity: 0.04,
  shadowRadius: 4,
  shadowOffset: { width: 0, height: 1 },
  elevation: 1,
};
