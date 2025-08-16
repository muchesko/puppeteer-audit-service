FROM node:20-bookworm

# Install required libraries for Chromium (bundled with Puppeteer)
RUN apt-get update && apt-get install -y \
    # Core libraries for Chromium
    libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libxshmfence1 \
    # Additional X11 and graphics libraries
    libxss1 libgconf-2-4 libxtst6 libxss1 \
    # Font support
    fonts-liberation fonts-dejavu-core \
    # Utilities
    ca-certificates curl \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (Puppeteer will download bundled Chromium)
RUN npm ci

# Copy source code and build
COPY src/ ./src/
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Environment variables
ENV NODE_ENV=production
# Don't set PUPPETEER_EXECUTABLE_PATH - use bundled Chromium
# ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false (default)

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Run the application
CMD ["npm", "start"]
