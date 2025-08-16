# ---------- base ----------
FROM node:20-bookworm-slim AS base
WORKDIR /app

# ---------- deps (with dev deps for build) ----------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# ---------- build ----------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime (Chrome + prod deps only) ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Add Google Chrome repo first, then install Chrome + headless deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates curl \
  && install -m 0755 -d /etc/apt/keyrings \
  && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
      google-chrome-stable \
      fonts-liberation fonts-freefont-ttf \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcairo-gobject2 \
      libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 \
      libnss3 libnspr4 libpango-1.0-0 libx11-6 libx11-xcb1 libxcomposite1 \
      libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxrender1 \
      libxshmfence1 libxi6 libxss1 libxtst6 libpci3 xdg-utils \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_OPTIONS=--max-old-space-size=512
ENV NODE_ENV=production

# Prod deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Built files from build stage
COPY --from=build /app/dist ./dist

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]