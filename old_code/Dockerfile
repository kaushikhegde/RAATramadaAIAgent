# ─────────────────────────────────────────────────────────────
# RAA Travel Booking Chatbot — Dockerfile
# Node.js + Real Google Chrome + noVNC for live browser viewing
# Uses real Chrome (not Chromium) for proper TLS fingerprint
# that passes Akamai bot detection
# ─────────────────────────────────────────────────────────────
FROM --platform=linux/amd64 node:20-slim

# Avoid interactive prompts during package install
ENV DEBIAN_FRONTEND=noninteractive

# ─── Install Real Google Chrome + Virtual Display + VNC + noVNC ──
# Step 1: Install dependencies and download real Chrome .deb
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
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
    # Virtual display (Xvfb) so Chrome runs with a real GUI
    xvfb \
    # Window manager (keeps browser window tidy)
    fluxbox \
    # VNC server — streams the virtual display
    x11vnc \
    # noVNC — browser-based VNC client (no install on your machine)
    novnc \
    websockify \
    # Utilities
    procps \
    && rm -rf /var/lib/apt/lists/*

# Step 2: Install real Google Chrome (not Chromium!)
# This gives us the authentic Chrome TLS fingerprint that passes Akamai
# Must apt-get update again so apt-get -f install can find missing deps
RUN wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update \
    && (dpkg -i /tmp/chrome.deb || true) \
    && apt-get install -f -y --no-install-recommends \
    && rm /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/* \
    && google-chrome-stable --version

# ─── App setup ───────────────────────────────────────────────
WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy application code
COPY server.js automator.js tramada-automator.js geminiAgent.js geminiPrompt.js ./
COPY public/ ./public/

# ─── Screenshot output directory ─────────────────────────────
RUN mkdir -p /app/completed
VOLUME /app/completed

# ─── Environment defaults ────────────────────────────────────
ENV PORT=3000
ENV NODE_ENV=production
ENV CHROME_PATH=/usr/bin/google-chrome-stable
ENV DISPLAY=:99
ENV RESOLUTION=1280x900x24
# Tell puppeteer-core to use our real Chrome (don't download its own)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# ─── Expose ports ────────────────────────────────────────────
# 3000 = Web UI + WebSocket (chatbot)
# 6080 = noVNC web viewer (browser view)
EXPOSE 3000 6080

# ─── Health check ────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:3000/ || exit 1

# ─── Start script ────────────────────────────────────────────
COPY <<'STARTEOF' /app/start.sh
#!/bin/bash
set -e

CDP_MODE="${CDP_MODE:-internal}"
CDP_HOST="${CDP_HOST:-host.docker.internal}"
CDP_PORT="${CDP_PORT:-9222}"

if [ "$CDP_MODE" = "internal" ]; then
  # ═══════════════════════════════════════════════════
  #  INTERNAL MODE: Real Google Chrome inside container
  #  puppeteer-extra launches Chrome with stealth patches
  #  noVNC provides live browser viewing
  # ═══════════════════════════════════════════════════
  echo "Mode: INTERNAL (Real Google Chrome + Stealth + noVNC)"

  # Show Chrome version
  CHROME_VER=$(/usr/bin/google-chrome-stable --version 2>/dev/null || echo "unknown")
  echo "Chrome: ${CHROME_VER}"

  echo "[1/4] Starting Xvfb virtual display (${RESOLUTION})..."
  Xvfb ${DISPLAY} -screen 0 ${RESOLUTION} -ac +extension GLX +render -noreset &
  sleep 1

  echo "[2/4] Starting Fluxbox window manager..."
  fluxbox -display ${DISPLAY} &>/dev/null &
  sleep 1

  echo "[3/4] Starting VNC server..."
  x11vnc -display ${DISPLAY} -nopw -listen 0.0.0.0 -rfbport 5900 -shared -forever -noxdamage &>/dev/null &
  sleep 1

  echo "[4/4] Starting noVNC on port 6080..."
  websockify --web /usr/share/novnc 6080 localhost:5900 &>/dev/null &

  # Chrome is launched by puppeteer-extra when automation starts.
  # This ensures stealth + rebrowser patches are active from the start.

  echo ""
  echo "============================================"
  echo "  RAA Travel Booking Chatbot"
  echo "  Mode:           Internal Real Chrome"
  echo "  Chrome:         ${CHROME_VER}"
  echo "  Anti-detect:    puppeteer-extra + stealth"
  echo "                  + rebrowser-patches"
  echo "  Chatbot UI:     http://localhost:${PORT}"
  echo "  Browser viewer: http://localhost:6080/vnc.html"
  echo "  NOTE: Solve CAPTCHAs in the browser viewer!"
  echo "============================================"

else
  # ═══════════════════════════════════════════════════
  #  EXTERNAL MODE: Connect to Chrome on host machine
  # ═══════════════════════════════════════════════════
  echo "Mode: EXTERNAL (connecting to host Chrome on port ${CDP_PORT})"

  CHROME_READY=false
  FOUND_HOST=""

  echo "Searching for Chrome with remote debugging..."
  for HOST_TRY in "${CDP_HOST}" "host.docker.internal" "172.17.0.1" "host-gateway"; do
      echo "  Trying ${HOST_TRY}:${CDP_PORT}..."
      if wget -q -T 3 --spider "http://${HOST_TRY}:${CDP_PORT}/json/version" 2>/dev/null; then
          echo "  Found Chrome at ${HOST_TRY}:${CDP_PORT}!"
          CHROME_READY=true
          FOUND_HOST="${HOST_TRY}"
          export CDP_HOST="${FOUND_HOST}"
          break
      fi
  done

  if [ "$CHROME_READY" = false ]; then
      echo ""
      echo "  Chrome not found yet. Waiting 20 seconds..."
      for i in $(seq 1 10); do
          if wget -q -T 3 --spider "http://${CDP_HOST}:${CDP_PORT}/json/version" 2>/dev/null; then
              echo "  Found Chrome at ${CDP_HOST}:${CDP_PORT}!"
              CHROME_READY=true
              FOUND_HOST="${CDP_HOST}"
              break
          fi
          sleep 2
      done
  fi

  if [ "$CHROME_READY" = false ]; then
      echo ""
      echo "============================================"
      echo "  WARNING: Cannot reach Chrome on host!"
      echo "  Switch to internal mode (recommended):"
      echo "    CDP_MODE=internal docker compose up"
      echo "============================================"
      echo ""
      echo "Starting server anyway (will retry on booking)..."
  fi

  echo ""
  echo "============================================"
  echo "  RAA Travel Booking Chatbot"
  echo "  Mode:           External Chrome"
  echo "  Chrome:         ${CDP_HOST}:${CDP_PORT}"
  echo "  Chatbot UI:     http://localhost:${PORT}"
  echo "============================================"

fi

echo ""
exec node server.js
STARTEOF
RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
