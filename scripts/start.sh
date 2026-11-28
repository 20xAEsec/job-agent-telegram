#!/usr/bin/env bash
# Starts JobAgent. Keep this window open; closing it turns JobAgent off. --practice forces practice mode on.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
check="$(uv run --quiet --project agent jobagent setup-check || true)"
if ! echo "$check" | grep -q '"ok": true, "checks"'; then
  echo "JobAgent cannot start yet:"
  echo "$check" | uv run --quiet --no-project python -c "import json,sys; [print('  X  '+c['name']+': '+c['detail']) for c in json.load(sys.stdin)['checks'] if not c['ok'] and c['required']]"
  echo; echo "Run the setup to fix it:  bash scripts/setup.sh"; exit 1
fi
[ "${1:-}" = "--practice" ] && export JOBAGENT_DRY_RUN=1
# Exit code 75 means the user tapped "Update and restart": pull, refresh the dependencies, start again.
# If the pull fails, the old version starts and the app tells the user (it compares versions with data/update.json).
while true; do
  code=0; bun run app/src/main.ts || code=$?
  [ "$code" -eq 75 ] || exit "$code"
  echo "Updating JobAgent..."
  if git pull --ff-only; then (cd app && bun install --silent >/dev/null) && uv sync --project agent --quiet || echo "The update did not finish."; fi
done
