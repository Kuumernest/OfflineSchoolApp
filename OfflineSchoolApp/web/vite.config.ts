// web/vite.config.ts
/// <reference types="node" />
import { defineConfig } from "vite";
import react            from "@vitejs/plugin-react";
import tailwindcss      from "@tailwindcss/vite";
import path             from "path";
import os               from "os";
import crypto           from "crypto";

/*
 * ── Where the dependency cache lives ──────────────────────────────────────
 *
 * Not in the project. This tree sits under a synced OneDrive folder, where
 * every file read goes through the sync filter: listing lucide-react's icon
 * directory — 4,044 single-icon modules — takes 3.3 seconds, and reading those
 * files costs about 16ms each. The dev server's dependency optimizer walks and
 * rewrites thousands of such files, so `vite` printed "bundling
 * dependencies..." and never came back; five minutes was not enough.
 *
 * The optimizer's output is a few hundred files it writes and then re-reads on
 * every start. Putting them on the local disk takes them out of the sync path
 * entirely, so the second and later starts do not pay for them at all.
 *
 * Keyed by the project path so two checkouts cannot share one cache.
 *
 * import.meta.dirname, not __dirname: Vite's native config loader warns that
 * the CommonJS global is unsupported and is due to stop working when that
 * loader becomes the default.
 */
const projectDir = import.meta.dirname;

const cacheDir = path.join(
  os.tmpdir(),
  "vite-" + crypto.createHash("sha1").update(projectDir).digest("hex").slice(0, 12)
);

export default defineConfig({
  cacheDir,
  plugins: [
    react(),
    tailwindcss(),
  ],

  resolve: {
    alias: {
      "@": path.resolve(projectDir, "./src"),
    },
    // Prevents duplicate React instances when dependencies use CJS require()
    // while the app uses ESM imports — the classic "invalid hook call" cause.
    dedupe: ["react", "react-dom"],
  },

  /*
   * ── Pre-bundling, declared rather than discovered ─────────────────────
   *
   * `include` names the dependencies up front so the optimizer does not have
   * to crawl the source graph to find them, and so it never stops mid-session
   * to bundle one it met late — the pause that looks like a hang after the
   * page has already loaded.
   *
   * lucide-react is the expensive one and the reason this list exists: it
   * publishes one ES module per icon, so a browser importing it unbundled asks
   * for thousands of files. It must be pre-bundled, not excluded.
   */
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react-router-dom",
      "@tanstack/react-query",
      "axios",
      "lucide-react",
      "react-i18next",
      "i18next",
      "zod",
      "react-hook-form",
      "@hookform/resolvers/zod",
      "zustand",
    ],
  },

  server: {
    port: 3000,
    /*
     * The watcher has no business in node_modules. On a synced filesystem each
     * watched path is another handle the sync filter sits behind, and the
     * dependency cache now lives outside the project anyway.
     */
    watch: {
      ignored: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    },
    proxy: {
      "/api": {
        target:       "http://localhost:5000",
        changeOrigin: true,
      },
      // School logos are stored as files and served from the API server's
      // root, not from under /api. Without this the dashboard banner and the
      // settings preview request /uploads/... from Vite itself and get its
      // index.html back, so the image fails to decode.
      "/uploads": {
        target:       "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir:    "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (id.includes("node_modules/react")) return "react";
          if (id.includes("node_modules/react-router-dom")) return "router";
          if (id.includes("node_modules/@tanstack/react-query")) return "query";
          if (id.includes("node_modules/axios")) return "axios";
        },
      },
    },
  },
});