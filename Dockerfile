# ── Stage 1: Build dashboard UI ──────────────────────────────────────────────
FROM node:20-alpine AS dashboard-builder

WORKDIR /app/dashboard-ui
COPY dashboard-ui/package*.json ./
RUN npm ci
COPY dashboard-ui/ ./
# Output goes to /app/dist/dashboard (vite outDir is ../dist/dashboard)
RUN npm run build

# ── Stage 2: Build backend ────────────────────────────────────────────────────
FROM node:20-alpine AS backend-builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ── Stage 3: Production image ─────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Production deps only
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Backend compiled output
COPY --from=backend-builder /app/dist ./dist

# Dashboard static files (built by dashboard-builder into dist/dashboard)
COPY --from=dashboard-builder /app/dist/dashboard ./dist/dashboard

# Logs dir + non-root user
RUN mkdir -p /app/logs && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3001

CMD ["node", "dist/index.js"]
