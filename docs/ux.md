# JobAgent Telegram style

Every screen is built from `app/src/kit.ts`. Use its helpers (`heading`, `note`, `quote`, `kv`, `bar`, `nav`, `pairs`, `money`, `ago`) rather than hand-written markup.

## Text

- **Heading:** `heading(emoji, title)` is one bold line with **one** emoji. A line carries at most one emoji, at its start.
- **Status:** each status has exactly one emoji and one phrase, in `STATUS` (`jobs.ts`). Cards and lists use those, never their own.
- **Length:** at most about 12 lines before the first button on a screen. Longer content goes in an expandable `quote(…, true)` or behind a button. Every page fits in 4096 characters (`fits()` in `ui.test.ts`).
- **Tone:** plain words a non-technical person understands. Say "Needs you", "Applied", "Ready for your review", "I couldn't download the posting". Never show codes, file names, commands or raw JSON.
- **Side notes** go in `note()` (italics), one per block.
- **Third-party and user text** always goes through `esc()`.
- **Private answers** (work authorization, salary, EEO…) are shown only inside `<tg-spoiler>`.

## Buttons

- The **primary action comes first**, on its own row, styled `success` (go ahead) or `primary` (look at this). There is at most one styled primary per screen.
- Back and Home always come last: `nav(back)`.
- Destructive actions use `style: 'danger'` and one confirm step ("🗑 Yes, delete it" / "Keep it").
- `callback_data` is at most 64 bytes. Use `code(id)` from `jobs.ts` for job ids.

## Messages

- Progress is a **live card** that is edited in place and never makes a sound. Only things that need the user are loud: a review, a kit, a question, a problem.
- One message per event. When a prompt is answered, edit it into its result instead of sending a new message.
- Typed text has **one listener**: the screen the user opened last (`pending` in `app.ts`). A message the app sends on its own never starts listening (the emailed verification code is the one exception). Questions are answered only through ❓ Open Questions.
- Pictures (a resume preview, the filled form) go before the card as a silent album. Files go behind a `📎 Files` button.

## Skipped and filtered out

- **After ⏭ Skip** the review card becomes "Skipped" with one row of reasons (Pay, Location, Kind of work, Company, Level, Other). Answering is optional: the usual buttons stay below.
- **🔎 Filtered out** (`filteredPage`): what auto-search skipped before a full read, grouped by reason with counts, then the 10 newest, each with "👀 Look at it anyway", which reads it like a link the user sent.

## Home

Home's first button is `nextAction()` (`pages.ts`): finish setup → review → apply yourself → answer questions → fix stuck jobs → search now or turn on Auto-search.

## Looking at the screens

`bun run dev/preview.ts` renders every main screen from fixture state into `app/dev/out/preview.html` with Telegram-like styling. `uv run --project agent python app/dev/shot.py` screenshots it at phone width (`app/dev/out/preview.png`). Review it after changing any wording or layout.
