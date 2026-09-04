// Lint rules that exist because these two bug classes have actually shipped in
// this app, and both stay invisible to the checks we already run: the parse
// check and `tsc --noEmit` are perfectly happy with either one, and the crash
// only shows up on a device.
//
//   rules-of-hooks — a hook called from a plain helper rather than from a
//   component. getGreeting() called useTranslation() and was then passed to
//   useState as a lazy initialiser, which took down the admin dashboard; the
//   same shape existed in 16 other screens. When the helper is async and runs
//   from a handler (openLocalFile, fetchPeriods, loadResultsFromAPI) React's
//   dispatcher is null and it throws on the first call, not on a re-render.
//
//   no-undef — an identifier used but never imported. ScrollView in
//   teacher/attendance/mark.js and getDB in admin/subjects/add.js were both
//   plain ReferenceErrors on screens that looked fine in review.
//
// exhaustive-deps stays a warning, not an error: a missing dependency here
// usually means a stale string after a language switch rather than a crash,
// and warnings do not fail `npm run check`.

import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "node_modules/**",
      ".expo/**",
      "android/**",
      "ios/**",
      "dist/**",
      "web-build/**",
    ],
  },
  {
    files: ["**/*.js", "**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        // React Native injects this one; it is not in either preset.
        __DEV__: "readonly",
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-undef": "error",
    },
  },
];
