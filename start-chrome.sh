#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Start Chrome with Remote Debugging for the RAA Travel Chatbot
# ─────────────────────────────────────────────────────────────
# This opens a DEDICATED Chrome window (its own profile) on port 9222.
# The chatbot (npm run chat) drives THIS window — not your normal Chrome.
#
# IMPORTANT: after it opens, LOG INTO TRAMADA *IN THIS WINDOW*.
# Your everyday Chrome does NOT share this login. Keep this window open.
# ─────────────────────────────────────────────────────────────

PORT="${1:-9222}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="${PROFILE_DIR:-${SCRIPT_DIR}/.jetstar-profile-cdp}"

# Tramada login page to open automatically so you log into the RIGHT window.
# Override by exporting TRAMADA_URL (must match the one in your .env).
TRAMADA_URL="${TRAMADA_URL:-https://asp.tramada.com.au/ttms/raatravelsandbox}"
TRAMADA_LOGIN="${TRAMADA_URL%/}/login.htm"

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

# Already running with debugging? Just point the user at it.
if curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "Chrome is already running with remote debugging on port ${PORT}."
    echo ""
    echo ">> Make sure you're LOGGED INTO TRAMADA in that window:"
    echo "   ${TRAMADA_LOGIN}"
    echo ">> Then run:  npm run chat"
    exit 0
fi

mkdir -p "$PROFILE_DIR"

echo "Starting a dedicated Chrome (port ${PORT}) with profile:"
echo "  $PROFILE_DIR"
if [ -d "$PROFILE_DIR/Default" ]; then
    echo "  (reusing profile — if you logged into Tramada here before, it's still warm)"
else
    echo "  (NEW profile — you'll need to log into Tramada in the window that opens)"
fi
echo ""

# Launch a separate Chrome instance (own profile) and open Tramada login in it,
# so it's obvious which window to sign into.
"$CHROME" \
    --remote-debugging-port=${PORT} \
    --no-first-run \
    --no-default-browser-check \
    --user-data-dir="$PROFILE_DIR" \
    "$TRAMADA_LOGIN" \
    >/dev/null 2>&1 &

echo "Waiting for Chrome to be ready..."
for i in $(seq 1 15); do
    if curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
        echo ""
        echo "============================================================"
        echo "  Chrome is ready on port ${PORT}."
        echo ""
        echo "  1) In the Chrome window that just opened, LOG INTO TRAMADA"
        echo "     (${TRAMADA_LOGIN})"
        echo "  2) Keep that window open."
        echo "  3) In another terminal, run:  npm run chat"
        echo "============================================================"
        exit 0
    fi
    sleep 1
done

echo "ERROR: Chrome did not start with remote debugging on port ${PORT}."
echo "If your normal Chrome was open, this still launches a SEPARATE window"
echo "with its own profile — look for a new Chrome window showing the Tramada"
echo "login page. If nothing opened, fully quit Chrome (Cmd+Q) and retry."
exit 1
