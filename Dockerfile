FROM node:20-bookworm

# Install system Chrome and required libraries
RUN apt-get update && apt-get install -y wget gnupg ca-certificates \
  && install -d -m 0755 /etc/apt/keyrings \
  && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
  && sh -c 'echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list' \
  && apt-get update && apt-get install -y \
    google-chrome-stable \
    fonts-liberation libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libxshmfence1 xdg-utils \
    curl \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for building)
RUN npm ci

# Copy source code and build
COPY src/ ./src/
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Environment variables
ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Run the application
CMD ["npm", "start"]
