# gladys-microsoft-teams

[Gladys Assistant](https://gladysassistant.com) external integration: Gladys messages and alerts posted in
a Microsoft Teams channel or chat through a **Workflows webhook**. Send only: nothing is read from Teams.

Unofficial, not affiliated with Microsoft. **Never tested with a real Teams account**: it follows the
Microsoft documentation ("Create an Incoming Webhook" with Workflows; the Office 365 connectors were
retired in May 2026).

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## How it works

- Manifest `type: "communication"`, `messaging.receive: false`: each Gladys user pastes a personal
  webhook in **My account** (`contact_schema`); Gladys hands it to `onSendMessage` with every message
  addressed to that user (scene "Send a message", system messages).
- The configuration holds an optional **channel webhook**, used by the scene action
  `post_to_channel` (text, title, urgent; output `status`: `accepted` or `unconfirmed`) and by the
  `test_channel` button.
- Each message is an Adaptive Card in a `message` envelope, cut at 4096 characters, under the 28 KB of
  Teams. Images of messages are not posted.
- `src/sender.js` holds the rules: hourly cap on everything (30 by default, 1 to 200), 300 ms between
  two requests, no retry of a request that may have left, pause after 429 (Retry-After, 60 s to 6 h) or
  5xx (60 s doubling to 30 min), a webhook answered 401/403/404 not used for 24 h (the test button lifts
  it for the channel). Decisions on the monotonic clock.
- `src/http.js` tells apart "not sent" (failed before the body left), "no answer" (it left) and an
  answer; redirects are not followed; the answer is read up to 16 KB.
- `/data/state.json` (`src/store.js`): dates of the last hour, the pause, a random salt and 8-bit
  fingerprints of refused webhooks. Never a URL. Unreadable: read again every 10 s, never overwritten before a read succeeds.
- Webhook URLs are secrets: checked (https, `*.logic.azure.com|us`, `*.api.powerplatform.com|us`, a
  `/workflows/…/triggers/` path, a `sig`), never logged, never in the status nor `/data`.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
node scripts/mutants.mjs                        # mutants of the guards (dev VM: memcap, setsid)
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never reach Microsoft: `test/http.test.js` runs the real HTTPS client against loopback servers
(`test/kit/`, copied from gladys-testkit); the other tests use a fake POST, a test clock and the SDK's
fake Gladys.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the version in `package.json` and the
manifest, rolls `CHANGELOG.md`, tags, builds the multi-arch image to GHCR and publishes the GitHub
Release.

## License

Apache-2.0 (`LICENSE`). No third-party code; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also
shipped in the Docker image).
