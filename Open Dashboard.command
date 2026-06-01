#!/bin/zsh
set -e

cd "$(dirname "$0")"

PORT="${AIM_DASHBOARD_PORT:-8791}"
URL="http://127.0.0.1:${PORT}"

if lsof -ti tcp:"${PORT}" >/dev/null 2>&1; then
  echo "Runcap dashboard is already running."
  echo "Opening ${URL}"
  open "${URL}"
  exit 0
fi

echo "Starting Runcap dashboard on ${URL}"
node ./bin/runcap.mjs dashboard --port "${PORT}" &
DASHBOARD_PID=$!

sleep 1
open "${URL}"

echo ""
echo "Dashboard is running."
echo "Close this Terminal window or press Ctrl+C to stop it."
wait "${DASHBOARD_PID}"
