# syntax=docker/dockerfile:1
#
# One image that serves the API and the built UI on port 4000, with Chromium
# available for "Render JavaScript".
#
#   docker compose up -d --build        (see docker-compose.yml)
#
# The runtime stage is Microsoft's Playwright image, which ships Node.js,
# Chromium and every system library Chromium needs. Its tag MUST match the
# playwright version in backend/package-lock.json (currently 1.63.0); when
# you upgrade the npm package, bump the tag below too.

# ---- 1. Build the React frontend -------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 2. Runtime: Node.js + Chromium ----------------------------------------
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runtime
ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY backend/src ./src

# server.js serves ../../frontend/dist when it exists
COPY --from=frontend /build/dist /app/frontend/dist

# Chromium is happier as a regular user; "pwuser" comes with the image.
USER pwuser

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/config').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
