# Dashboard and phone access: how it is protected

The dashboard (`app/src/dashboard.ts`, `app/web/dashboard.html`) shows the pipeline, score breakdowns, resume changes,
insights and screenshots, and can **approve** or **skip** an application. Approving from the dashboard calls the same
`review.approve` as the Telegram button, so the `plan_hash` check and practice mode apply unchanged. The dashboard also
checks that the review the page showed is still the current one.

## What it never does

- It never sends private answers to the page. Answers marked sensitive are replaced with `null` on the server.
- It never loads anything from outside. The page has no CDN scripts, and its CSP is `default-src 'self'`.
- It never serves files other than the three known screenshots of a job.
- It never listens on the network. The server binds `127.0.0.1` only.

## On the computer (always on)

- **The link:** `http://127.0.0.1:<port>/?k=<secret>`. The secret is 32 random bytes stored in `data/dashboard.json`.
- **The cookie:** opening the link sets an `HttpOnly; SameSite=Strict` cookie. Every API call needs that cookie.
- **The host header:** it must be `127.0.0.1` or `localhost`, which defeats DNS rebinding. A POST must come from the same origin and be JSON, which blocks cross-site form posts.
- **Who can get in:** anyone who has the link and uses that computer. Treat the link like a password.

## On the phone (off by default)

Telegram Mini Apps must be served over public HTTPS, so phone access needs a tunnel the user starts themselves, such as
`cloudflared tunnel --url http://127.0.0.1:4777` or Tailscale Funnel. To turn it on, the user pastes the tunnel's https
address in Telegram (Home → 🖥 Dashboard → 📱 Set up phone access). Until then, requests that arrive with any other host
are refused, so a tunnel that is left running does nothing on its own.

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
