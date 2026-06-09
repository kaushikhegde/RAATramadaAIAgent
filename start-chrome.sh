#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Start Chrome with Remote Debugging for RAA Travel Chatbot
# ─────────────────────────────────────────────────────────────
# Run this BEFORE 'docker compose up'
# Chrome MUST be fully closed first (quit Chrome completely)
# ─────────────────────────────────────────────────────────────

PORT="${1:-9222}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="${PROFILE_DIR:-${SCRIPT_DIR}/.jetstar-profile-cdp}"

# Detect OS and set Chrome path
if [[ "$OSTYPE" == "darwin"* ]]; then
    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    CHROME="$(which google-chrome || which google-chrome-stable || which chromium-browser || which chromium)"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe"
fi

if [ ! -f "$CHROME" ] && [ -z "$(which "$CHROME" 2>/dev/null)" ]; then
    echo "ERROR: Could not find Chrome at: $CHROME"
    echo "Please install Google Chrome or set the path manually."
    exit 1
fi

# Check if Chrome is already running with debugging
if curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "Chrome is already running with remote debugging on port ${PORT}!"
    curl -s "http://127.0.0.1:${PORT}/json/version" | python3 -m json.tool 2>/dev/null || \
    curl -s "http://127.0.0.1:${PORT}/json/version"
    echo ""
    echo "Ready! Now run: docker compose up"
    exit 0
fi

mkdir -p "$PROFILE_DIR"

echo "Starting Chrome with remote debugging on port ${PORT}..."
echo "Chrome path:   $CHROME"
echo "Profile dir:   $PROFILE_DIR"
if [ -d "$PROFILE_DIR/Default" ]; then
    echo "Profile state: reusing existing (cookies should be warm)"
else
    echo "Profile state: NEW — first run; warm up by manually browsing jetstar.com"
fi
echo ""

"$CHROME" \
    --remote-debugging-port=${PORT} \
    --no-first-run \
    --no-default-browser-check \
    --user-data-dir="$PROFILE_DIR" \
    &

# Wait for Chrome to start
echo "Waiting for Chrome to be ready..."
for i in $(seq 1 15); do
    if curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
        echo ""
        echo "============================================"
        echo "  Chrome is ready on port ${PORT}!"
        echo "  Now run: docker compose up"
        echo "============================================"
        exit 0
    fi
    sleep 1
done

echo "ERROR: Chrome did not start with remote debugging."
echo "Make sure Chrome is fully closed (Cmd+Q on Mac) before running this script."
exit 1
