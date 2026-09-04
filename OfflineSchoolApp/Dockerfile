# ── Stage 1: Build the React web app ──────────────────────────────────────────
FROM node:20-alpine AS web-builder

WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
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
RUN mkdir -p src/uploads/content/{syllabus,notes,video,audio,document,image} \
             src/uploads/logos src/uploads/photos src/uploads/messages \
             src/uploads/applications

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "src/server.js"]
