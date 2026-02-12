FROM oven/bun:1 AS base
WORKDIR /app

# Install Chromium dependencies for Puppeteer (whatsapp-web.js)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --trust

# Copy source
COPY . .

# Build Tailwind CSS
RUN bunx @tailwindcss/cli -i tailwind.css -o styles.css

# Data directory for SQLite and WhatsApp auth
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["bun", "run", "index.ts"]
