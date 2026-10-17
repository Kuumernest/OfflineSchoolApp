# ── Stage 1: Build the React web app ──────────────────────────────────────────
# Node 24, the version CI tests on (.github/workflows). Node 20 reached end of
# life in April 2026. Multi-arch: the same tag runs on Oracle's ARM64 (aarch64)
# VMs, and the backend has no native addons to build (bcryptjs is pure JS).
FROM node:24-alpine AS web-builder

WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
# The desktop/offline adapter imports ../../../../shared/requestPath.js, which
# from /app/web/src/lib/offline is /app/shared — outside web/.
COPY shared/requestPath.js /app/shared/requestPath.js
RUN npm run build

# ── Stage 2: Nginx with the web build ─────────────────────────────────────────
#
# Optional, single-host mode only. The production stack (docker-compose.yml)
# no longer builds it: the web console is served by Cloudflare Pages and nginx
# is API-only (docs/17). Kept so a school that wants the console on the same
# host can still `docker build --target web`.
#
# The `nginx` service in docker-compose.yml builds this target. nginx.conf
# roots `location /` at /app/public/web; without the build there, try_files
# fell through to /index.html, which matched `location /` again, and nginx
# answered every page with 500 (an internal redirection cycle). Baked into the
# image, not shared through a volume: Docker fills a named volume only when it
# is empty, so a volume would keep serving the first build after every deploy.
#
# Kept before the backend stage on purpose: a plain `docker build` builds the
# last stage, and that must stay the backend.
FROM nginx:alpine AS web
COPY --from=web-builder /app/web/dist /app/public/web

# ── Stage 3: Production backend ───────────────────────────────────────────────
FROM node:24-alpine AS production

WORKDIR /app

# Install only production dependencies
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev

# Copy backend source
COPY backend/src/ ./src/
COPY backend/middleware/ ./middleware/

# Runtime code outside backend/src, at the paths the source resolves to:
#   engine/              the report-template engine (src/routes/template.routes.js,
#                        src/services/reportHtml.service.js: ../../engine)
#   scripts/calibration/ the school-wide analysis and its worker
#                        (src/services/intelligence/*: path.join(…, "scripts", "calibration"))
#   /shared              logic shared with the desktop and web. Every require of
#                        it climbs one level above the backend root — from
#                        /app/src/db/models, ../../../../shared is /shared — so it
#                        sits beside /app, as shared/ sits beside backend/ in the
#                        repository.
COPY backend/engine/ ./engine/
COPY backend/scripts/calibration/ ./scripts/calibration/
COPY shared/ /shared/

# No web build in this image. It was copied to ./public/web "for the backend
# to serve", but nothing in the backend serves that path — and building the
# whole web app is the slowest step of an ARM64 build on the server.

# Create the upload directories the server bootstraps at startup.
#
# Under src/, not /app/uploads. server.js runs as `node src/server.js`, so
# its __dirname is /app/src and every uploads path in the codebase resolves
# from there — src/utils/photoStorage.js, src/utils/logoStorage.js,
# src/routes/messages.routes.js and the rest all build `../uploads` off a
# file inside src/. Creating /app/uploads made a directory the application
# never opens, and mounting the volume there meant every uploaded file was
# written to the container's own writable layer and lost on the next deploy.
#
# Named one by one: the image's /bin/sh (BusyBox ash) has no brace expansion,
# so `content/{syllabus,notes,…}` created a single directory with that literal
# name, and the server's own mkdir of content/syllabus then failed at boot.
RUN mkdir -p src/uploads/content/syllabus src/uploads/content/notes \
             src/uploads/content/video src/uploads/content/audio \
             src/uploads/content/document src/uploads/content/image \
             src/uploads/logos src/uploads/photos src/uploads/messages \
             src/uploads/applications

# Non-root user. It owns the upload tree, which it writes (and which a fresh
# named volume mounted there inherits): left to root, the server could not
# create a directory or save a file in it.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
 && chown -R appuser:appgroup src/uploads
USER appuser

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "src/server.js"]
