#!/usr/bin/env bash
# Starts JobAgent. Keep this window open; closing it turns JobAgent off. --practice forces practice mode on.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
check="$(uv run --quiet --project agent jobagent setup-check || true)"
if ! echo "$check" | grep -q '"ok": true, "checks"'; then
  echo "JobAgent cannot start yet:"
  echo "$check" | uv run --quiet --no-project python -c "import json,sys; [print('  X  '+c['name']+': '+c['detail']) for c in json.load(sys.stdin)['checks'] if not c['ok'] and c['required']]"
  echo; echo "Run the setup to fix it:  scripts/setup.sh"; exit 1
fi
[ "${1:-}" = "--practice" ] && export JOBAGENT_DRY_RUN=1
exec bun run app/src/main.ts
