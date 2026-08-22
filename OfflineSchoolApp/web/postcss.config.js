// web/postcss.config.js
//
// Tailwind is applied by @tailwindcss/vite (see vite.config.ts), not by
// PostCSS. This file previously also registered the v3 `tailwindcss` PostCSS
// plugin, which in v4 is a hard error ("it has moved to @tailwindcss/postcss")
// and would have run Tailwind twice even if it loaded.
//
// autoprefixer stays: it is harmless and covers the handful of hand-written
// rules in index.css that sit outside Tailwind's own prefixing.
export default {
  plugins: {
    autoprefixer: {},
  },
};
