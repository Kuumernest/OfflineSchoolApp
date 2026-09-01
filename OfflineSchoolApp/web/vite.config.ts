// web/vite.config.ts
/// <reference types="node" />
import { defineConfig } from "vite";
import react            from "@vitejs/plugin-react";
import tailwindcss      from "@tailwindcss/vite";
import path             from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // Prevents duplicate React instances when dependencies use CJS require()
    // while the app uses ESM imports — the classic "invalid hook call" cause.
    dedupe: ["react", "react-dom"],
  },

  server: {
    port: 3000,
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