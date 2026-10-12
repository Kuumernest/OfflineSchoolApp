# ── Stage 1: Build the React web app ──────────────────────────────────────────
FROM node:20-alpine AS web-builder

WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
# The desktop/offline adapter imports ../../../../shared/requestPath.js, which
# from /app/web/src/lib/offline is /app/shared — outside web/.
COPY shared/requestPath.js /app/shared/requestPath.js
RUN npm run build

# ── Stage 2: Production backend ───────────────────────────────────────────────
FROM node:20-alpine AS production

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

# Copy built web assets into a path the backend can serve
COPY --from=web-builder /app/web/dist ./public/web

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
