#!/usr/bin/env bash
# JobAgent setup for macOS and Linux. Safe to run again at any time: it skips what is already done.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

step() { printf '\n\033[36m[%s/5] %s\033[0m\n' "$1" "$2"; }
ok() { printf '  \033[32mOK\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mX\033[0m   %s\n\nFix that, then run this setup again.\n' "$1"; exit 1; }
yes_no() { read -r -p "  $1 [Y/n] " a; [ -z "$a" ] || [[ "$a" =~ ^[Yy] ]]; }
json() { uv run --quiet --no-project python -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

printf '\n  JobAgent setup\n  Finds jobs, tailors your resume and prepares applications. Nothing is sent without you.\n'

step 1 'Checking your computer'
if ! command -v uv >/dev/null; then
  yes_no 'uv (runs the Python helper) is missing. Install it now?' || fail 'uv is needed.'
  curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"
fi
ok 'uv'
if ! command -v bun >/dev/null; then
  yes_no 'Bun (runs the app) is missing. Install it now?' || fail 'Bun is needed.'
  curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"
fi
ok 'Bun'
if ! command -v claude >/dev/null; then
  warn 'Claude Code is missing. JobAgent uses it (with your own Claude subscription) to do the thinking.'
  yes_no 'Install Claude Code now?' && curl -fsSL https://claude.ai/install.sh | bash && export PATH="$HOME/.local/bin:$PATH"
  command -v claude >/dev/null || fail 'Install Claude Code from https://claude.com/claude-code, then run setup again.'
fi
ok 'Claude Code'
if [ "$(claude auth status 2>/dev/null | json 'd.get("loggedIn")' 2>/dev/null || echo True)" = "False" ]; then
  warn 'Claude Code is not logged in. A browser window opens: log in with your Claude (Pro or Max) account.'
  claude auth login
fi
ok 'Claude account'

step 2 'Installing JobAgent (a few minutes the first time)'
(cd app && bun install --silent >/dev/null); ok 'App'
uv sync --project agent --quiet; ok 'Python helper'
echo '  ... downloading the browser used to fill in forms (about 150 MB, first time only)'
uv run --quiet --project agent playwright install chromium >/dev/null; ok 'Form-filling browser'
mkdir -p data

step 3 'Your Telegram bot'
bot=''
getme() { uv run --quiet --no-project python -I -c "import json,sys,urllib.request as u;print(json.load(u.urlopen('https://api.telegram.org/bot'+sys.argv[1]+'/getMe'))['result']['username'])" "$1" 2>/dev/null; }
if [ -f data/.env ]; then
  token="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' data/.env | tr -d '[:space:]')"
  if bot="$(getme "$token")"; then ok "Bot @$bot"; else warn 'The saved bot token no longer works. Let'"'"'s set a new one.'; rm -f data/.env; bot=''; fi
fi
while [ -z "$bot" ]; do
  printf '\n  JobAgent talks to you through your own private Telegram bot. To make one (1 minute):\n'
  printf '    1. In Telegram, open a chat with @BotFather  (https://t.me/BotFather)\n'
  printf '    2. Send  /newbot , pick any name, then a username ending in "bot"\n'
  printf '    3. BotFather replies with a token like  123456789:AAH...  Copy it.\n\n'
  read -r -p '  Paste the token here: ' token; token="$(echo "$token" | tr -d '[:space:]')"
  [ -n "$token" ] || continue
  if bot="$(getme "$token")"; then printf 'TELEGRAM_BOT_TOKEN=%s\n' "$token" > data/.env; chmod 600 data/.env; ok "Bot @$bot saved"
  else bot=''; warn 'Telegram did not accept that token. Copy the whole line BotFather sent, and try again.'; fi
done

step 4 'Checking everything'
check="$(uv run --quiet --project agent jobagent setup-check || true)"
echo "$check" | json '"\n".join(("  OK  " if c["ok"] else "  !   ")+c["name"]+("" if c["ok"] else ": "+c["detail"]) for c in d["checks"])'
[ "$(echo "$check" | json 'd["ok"]')" = "True" ] || fail 'Something required is missing (see above).'

step 5 'Connect your phone'
pair="$(uv run --quiet --project agent jobagent pair --new --bot "$bot" || true)"
if [ "$(echo "$pair" | json 'd["ok"]')" = "True" ]; then
  printf '\n  Scan this with your phone camera, or open the link in Telegram, then tap START:\n\n'
  echo "$pair" | json 'd["qr"]'
  echo "  $(echo "$pair" | json 'd["link"]')"
  echo "  (works once, for 15 minutes)"
elif echo "$pair" | grep -q already_paired; then ok 'Already connected to your Telegram'
else fail "Could not make a pairing link: $pair"; fi

printf '\n  \033[32mSetup is done. JobAgent starts now; keep its window open while you use it.\033[0m\n  Next time, start it with:  scripts/start.sh\n\n'
exec "$(dirname "$0")/start.sh"
