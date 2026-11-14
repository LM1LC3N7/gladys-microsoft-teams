# TODO

## Decisions

- **Version 0.1.0** set by hand (package.json, lock, manifest, `docker_image`), before the first release.
- **SDK `^0.16.0`**, the latest on npm on 2026-11-14.
- **Send only** (`type: "communication"`, `messaging.receive: false`): no bot, no reading of Teams
  (Azure Bot left out of v1). Per-user webhook in `contact_schema`, channel webhook in the configuration.
- **Workflows webhooks only**: the Office 365 connectors are retired (May 2026); their URLs
  (`*.webhook.office.com`, `outlook.office.com`) are refused with an explanation. Accepted hosts:
  `*.logic.azure.com`, `*.logic.azure.us`, `*.api.powerplatform.com`, `*.api.powerplatform.us`, port 443,
  a `/workflows/…/triggers/` path and a `sig` parameter (a trigger limited to signed-in users cannot be
  called by Gladys). Another Microsoft cloud (China) would need its host added.
- **Nothing sent without a scene action, a Gladys message or the test button.** System messages of Gladys
  reach Teams only if the administrator lets them go to Teams or to all channels (core setting).
- **No retry at all**: a request that may have left is never sent again (no duplicates). "not sent" only
  when it failed before its body was handed to the network.
- **Hourly cap**: 30 by default, 1 to 200, on all messages together, counted on requests that left
  (reserved before waiting so concurrent messages cannot pass it together), kept in `/data`.
- **Spacing 300 ms** between two starts (Microsoft: more than four requests a second are throttled).
- **Budgets**: Gladys messages 3.5 s (the core waits 5 s for the ack), scene action and test 20 s
  (declared 30 s), one request 15 s at most, none started with less than 1 s left.
- **Pauses**: 429 with Retry-After (seconds, or date against the `Date` header), 60 s to 6 h; without it
  60 s doubling to 1 h; 5xx 60 s doubling to 30 min; reset by a success. Global (all webhooks): a
  per-webhook pause would need a fingerprint per URL.
- **Refusals**: 401/403/404 block that webhook 24 h (in memory by a key never written, in `/data` by an
  8-bit salted fingerprint); lifted by a successful test (channel only), a new URL, or the 24 h. A 1/256
  collision can block another URL until one of these. 400/409/413 and redirects refuse the message only.
- **Scene action outputs**: `accepted`; `unconfirmed` (no answer, or 5xx) resolves without failing so the
  scene can gate on it; nothing posted throws with the reason.
- **Images** (`message.file`) not posted: 28 KB limit of Teams messages; data URIs in cards untested.
- **Markdown**: passed to the card as is (cards render basic Markdown), headings turned into bold lines.
- **Category** `notifications`; no `countries` (world wide); no `keywords`.

## Not verified

- Never tested with a real Teams account or Workflows webhook: the answers (202, error codes of a turned
  off or deleted workflow, 429 headers) follow the documentation.
- The rendering of the card in Teams (title colour, Markdown subset).

## Later

- Azure Bot (receiving, replies) if users ask for it.
- `keywords` for the store: teams, microsoft, workflows, power automate, webhook, notification.
