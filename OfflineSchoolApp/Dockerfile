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

# Create upload directories the server bootstraps at startup
RUN mkdir -p uploads/content/{syllabus,notes,video,audio,document,image} \
             uploads/logos uploads/photos uploads/messages

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "src/server.js"]
