# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human contributors.

## What this is

A Gladys Assistant **external integration** (Node.js 22+, ESM, no build step) in its own sandboxed Docker
container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js), its only
runtime dependency. A send-only Microsoft Teams channel through Workflows webhooks.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
npm run lint && npm run format:check
node scripts/mutants.mjs [names...]       # mutants of the guards, in a private copy
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js            SDK wiring only (src/handlers.js registers the handlers)
src/app.js          TeamsApp: configuration, status, messages, scene action, test button
src/sender.js       every request: hourly cap, spacing, budget, pauses, refusals, no retry
src/http.js         one HTTPS POST: not_sent / no_answer / answered
src/card.js         the Adaptive Card, text cleaning and cuts
src/config.js       configuration and webhook URL checks
src/store.js        /data/state.json (no URL ever)
src/i18n.js         user texts (en, fr)
test/kit/           parts of gladys-testkit (loopback HTTPS servers, clocks)
scripts/cover.mjs   cover.png; scripts/mutants.mjs: mutation run
```

## Rules

- **Webhook URLs are secrets**: never in a log, a status, an error, `/data`. Logs name a webhook by
  `Sender.ref()` (changes at every start).
- **Never a second attempt** of a request that may have left. Only `not_sent` (failed before the body
  left) is "nothing sent".
- **No send without a scene action, a Gladys message or the test button**; nothing is received.
- Decisions read the monotonic clock once (`monotonic()`); the wall clock only dates `/data`.
- `/data` unreadable is not empty: never overwritten before a read succeeded; nothing waits for it.
- **Keys are forever**: `channel_webhook_url`, `max_messages_per_hour`, `webhook_url` (contact),
  `test_channel`, `post_to_channel` and its fields and output.
- **Versions**: 0.1.0 by hand before the first release, then the Release workflow only.
- **Changelog**: every user-visible change under `## [Unreleased]`.
- **User-facing text** in English and French: manifest, `src/i18n.js`, `docs/en.md` / `docs/fr.md`.
  A secret is described as kept by Gladys in its database, never shown again, sent only to Microsoft.
- Comments explain why, in English. Tests never reach Microsoft.
