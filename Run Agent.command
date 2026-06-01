#!/bin/zsh
set -e

cd "$(dirname "$0")"

TASK=$(/usr/bin/osascript <<'APPLESCRIPT'
try
  set dialogResult to display dialog "Paste the agent command you want Runcap to run." default answer "codex \"Inspect this project and improve one small thing. Run npm run check. Stop if blocked.\"" buttons {"Cancel", "Run"} default button "Run"
  text returned of dialogResult
on error
  return ""
end try
APPLESCRIPT
)

if [ -z "${TASK}" ]; then
  echo "No command provided. Nothing to run."
  exit 0
fi

LABEL="manual-agent-$(date +%Y%m%d-%H%M%S)"

echo "Running mission: ${LABEL}"
echo "Command: ${TASK}"
echo ""

node ./bin/runcap.mjs run --label "${LABEL}" -- zsh -lc "${TASK}"

echo ""
node ./bin/runcap.mjs report

PORT="${AIM_DASHBOARD_PORT:-8791}"
URL="http://127.0.0.1:${PORT}"

if ! lsof -ti tcp:"${PORT}" >/dev/null 2>&1; then
  node ./bin/runcap.mjs dashboard --port "${PORT}" &
  sleep 1
fi

open "${URL}"
echo ""
echo "Mission complete. Dashboard opened: ${URL}"
