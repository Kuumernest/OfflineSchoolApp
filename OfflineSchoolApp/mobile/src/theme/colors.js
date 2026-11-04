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

/** Icon accents for normal cards: colour on the icon box, nowhere else. */
export const ACCENT = {
  blue:   { icon: "#2563EB", box: "#EFF6FF" },
  indigo: { icon: "#4F46E5", box: "#EEF2FF" },
  violet: { icon: "#7C3AED", box: "#F5F3FF" },
  slate:  { icon: "#475569", box: "#F1F5F9" },
  teal:   { icon: "#0D9488", box: "#F0FDFA" },
};

/**
 * One accent per kind of thing, so Students is the same blue box everywhere.
 * Matches the web console's mapping.
 */
export const TILE = {
  students:      ACCENT.blue,
  teachers:      ACCENT.indigo,
  classes:       ACCENT.violet,
  subjects:      ACCENT.slate,
  timetable:     ACCENT.teal,
  attendance:    ACCENT.teal,
  exams:         ACCENT.blue,
  marks:         ACCENT.blue,
  homework:      ACCENT.indigo,
  quizzes:       ACCENT.indigo,
  content:       ACCENT.indigo,
  results:       ACCENT.violet,
  reports:       ACCENT.violet,
  intelligence:  ACCENT.violet,
  fees:          ACCENT.teal,
  finance:       ACCENT.teal,
  announcements: ACCENT.blue,
  messages:      ACCENT.blue,
  settings:      ACCENT.slate,
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

/** The shape every card shares: white, a hairline border, a faint shadow. */
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
