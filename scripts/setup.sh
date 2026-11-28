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
mac() { [ "$(uname)" = Darwin ]; }
# Opens a Telegram chat: in the Telegram app on macOS when it is installed, else in the browser (not for pairing links).
open_tg() {
  if mac && open "tg://resolve?domain=$1${2:+&start=$2}" 2>/dev/null; then return 0; fi
  [ -n "${2:-}" ] && return 1
  if mac; then open "https://t.me/$1"; elif command -v xdg-open >/dev/null; then xdg-open "https://t.me/$1" >/dev/null 2>&1; fi || true
}
clip() { pbpaste 2>/dev/null || wl-paste 2>/dev/null || xclip -o -selection clipboard 2>/dev/null || true; }
find_token() { grep -oE '[0-9]{5,}:[A-Za-z0-9_-]{30,}' | head -1 || true; }
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
opened=''
while [ -z "$bot" ]; do
  [ -n "$opened" ] || { opened=1; open_tg BotFather; }
  printf '\n  JobAgent talks to you through your own private Telegram bot. To make one (1 minute):\n'
  printf '    1. In Telegram, open a chat with @BotFather  (https://t.me/BotFather, I just opened it) and tap START\n'
  printf '    2. Send  /newbot , pick any name, then a username ending in "bot" (if it is taken, add some digits)\n'
  printf '    3. BotFather replies with a token like  123456789:AAH...  Click it to copy it.\n'
  printf '  Telegram only on your phone? Open https://web.telegram.org on this computer to copy the token there.\n\n'
  read -r -p '  Paste the token here, or just press Enter once you copied it: ' typed
  [ -n "$typed" ] || typed="$(clip)"
  token="$(printf '%s' "$typed" | find_token)"
  [ -n "$token" ] || { warn "I could not find a bot token there. It looks like 123456789:AAH... (copy it from BotFather's message)."; continue; }
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
  open_tg "$bot" "$(echo "$pair" | json 'd["pairing_code"]')" && echo '  I also opened it in Telegram on this computer: tap START there.' || true
elif echo "$pair" | grep -q already_paired; then ok 'Already connected to your Telegram'
else fail "Could not make a pairing link: $pair"; fi

printf '\n  \033[32mSetup is done. In Telegram I ask for your resume first: have it ready as a PDF or Word file.\033[0m\n'
printf '  JobAgent starts now; keep its window open while you use it.\n  Next time, start it with:  bash scripts/start.sh\n\n'
exec bash scripts/start.sh
