# Dashboard and phone access: how it is protected

The dashboard (`app/src/dashboard.ts`, `app/web/dashboard.html`) is the desktop front end. It does what the Telegram
screens do: overview and live activity, the review queue, every job, question forms, profile, saved answers, all
settings, practice mode, companies, job site logins, phone access, insights and health. Telegram stays the on-the-go
option; the onboarding wizard and the chat with Claude stay there.

How actions reach the app (`dashCall` in `app/src/app.ts`):

- **Buttons** that mirror a Telegram button send its callback code to `POST /api/do {op:"tap"}`. Only codes matching
  `TAPS` in `dashboard.ts` are accepted, and they run through the same `route()` the chat uses. Pairing, onboarding,
  version and anything that would send a file into the chat are not on the list.
- **Typed input** (a job link, a setting, a contact field, an achievement, a saved answer, a form, a code, a change
  request, a resume upload) has its own `op`, which uses the same helpers as the chat and validates the same way.
- **Approve** still goes through `POST /api/job/<id>/approve` with the `plan_hash` of the review the page showed, then
  `review.approve`, so practice mode and the plan check apply unchanged.
- **Reads** are `GET /api/state`, `GET /api/view/<live|settings|profile|forms|logins>` and `GET /api/job/<id>`.
  `/api/do` refuses `view:` and `export` ops so a write path can never be used to read.

## What it never does

- It never sends private answers to the page. Answers marked sensitive are replaced with `null` on the server, in
  reviews, forms and saved answers alike. The page can replace a private answer but never read it.
- It never loads anything from outside. The 3D background uses three.js served by JobAgent itself from
  `app/node_modules/three` (a fixed list of 9 files), and the CSP is `default-src 'self'`.
- It never serves job files other than the known screenshots and the files listed in that job's review or
  apply-yourself kit.
- It cannot pair, finish setup or change who is paired. Going live (`P:yes`) needs a confirm on the page, as in Telegram.
- It never listens on the network. The server binds `127.0.0.1` only.

## On the computer (always on)

- **The link:** `http://127.0.0.1:<port>/?k=<secret>`. The secret is 32 random bytes stored in `data/dashboard.json`.
- **The cookie:** opening the link sets an `HttpOnly; SameSite=Strict` cookie. Every API call needs that cookie.
- **The host header:** it must be `127.0.0.1` or `localhost`, which defeats DNS rebinding. A POST must come from the same origin and be JSON, which blocks cross-site form posts.
- **Who can get in:** anyone who has the link and uses that computer. Treat the link like a password.

## On the phone (off by default)

Telegram Mini Apps must be served over public HTTPS, so phone access needs a tunnel the user starts themselves.

- **`scripts\phone.ps1` (Windows):** runs `scripts/phone.ts`, which uses an installed `cloudflared`, or downloads the
  latest official one to `data/bin/` and keeps it only if its Windows signature is valid and Cloudflare's. It tunnels
  only to a port that answers like the dashboard, turns phone access on with the address once the tunnel connects, and
  turns it off when the tunnel ends (if the window is killed outright, the dead address stays until the next run).
- **Your own tunnel,** such as `cloudflared tunnel --url http://127.0.0.1:4777` or Tailscale Funnel: paste its https
  address in Telegram (Home → 🖥 Dashboard → 📱 Set up phone access).

While phone access is off, requests that arrive with any other host are refused, so a tunnel that is left running does
nothing on its own.

### How requests through the tunnel are checked

1. **The local secret is refused.** A request through the tunnel can never use the `?k=` link or the cookie.
2. **The page has to sign in.** The page itself contains no data. It reads the signed launch data that Telegram puts in the URL fragment (`tgWebAppData`) and posts it to `/api/tg-auth`.
3. **The server checks the signature.** The HMAC is checked as Telegram documents it (key `HMAC_SHA256("WebAppData", bot_token)`). `auth_date` must be within 24 hours, and the Telegram user id must equal `paired_user_id`.
4. **A session token is issued.** It is 32 random bytes, valid for 12 hours, kept in memory only (a restart signs every phone out), and sent in an `x-session` header. Cookies aren't used, so it also works inside Telegram Web's iframe.
5. **Framing is limited.** `frame-ancestors` allows only `https://web.telegram.org`, and the POST origin must be the tunnel origin.

### Risks the user accepts by turning phone access on

- **The tunnel provider sees the traffic.** Cloudflare or Tailscale can read it, because their edge terminates TLS. That includes job titles, scores, resume edits and non-private answers, but never private answers.
- **Quick-tunnel addresses can be found.** Anyone who guesses the address reaches the page, but without valid Telegram-signed data for the paired account they cannot get any data back.
- **A stolen Telegram session is enough.** Someone with the user's Telegram session could open the Mini App. They could also tap Approve in the chat itself, so this adds no new power.
- **Turning it off:** use 🚫 Turn off phone access, or stop the tunnel.
