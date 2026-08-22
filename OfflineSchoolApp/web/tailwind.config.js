/**
 * Tailwind v4 takes its design tokens from the `@theme` block in
 * src/index.css, not from this file. It is kept only because editors and the
 * `tailwindcss` language server look for it to enable class completion.
 *
 * Do not add colors or fonts here — they will be silently ignored at build
 * time. src/index.css is the single source of truth.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
};
