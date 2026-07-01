#!/usr/bin/env bash
# Laxorq Automate launcher for macOS / Linux
cd "$(dirname "$0")"
echo "Starting Laxorq Automate on http://localhost:4000 ..."
( sleep 1; (command -v open >/dev/null && open http://localhost:4000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:4000) ) &
node server.js
