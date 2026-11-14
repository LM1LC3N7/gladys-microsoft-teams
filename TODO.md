# TODO

## Decisions

- **Version 0.1.0** set by hand (package.json, lock, manifest, `docker_image`), before the first release.
- **SDK `^0.16.0`**, the latest on npm on 2026-11-14.
- **Send only** (`type: "communication"`, `messaging.receive: false`): no bot, no reading of Teams
  (Azure Bot left out of v1). Per-user webhook in `contact_schema`, channel webhook in the configuration.
- **Workflows webhooks only**: the Office 365 connectors are retired (May 2026); their URLs
  (`*.webhook.office.com`, `outlook.office.com`, `outlook.office365.com`) are refused with an explanation.
  Accepted hosts: those of the Power Automate page "IP address configuration" for the HTTP trigger:
  `*.api.powerplatform.com`, `*.logic.azure.com` (public), `*.api.gov.powerplatform.microsoft.us`,
  `*.logic.azure.us` (GCC), `*.api.high.powerplatform.microsoft.us` (GCC High), `*.api.appsplatform.us`
  (DoD), `*.api.powerplatform.partner.microsoftonline.cn`, `*.logic.azure.cn` (China); port 443, a
  `/workflows/…/triggers/` path and a `sig` parameter (a trigger limited to signed-in users cannot be
  called by Gladys).
- **Nothing sent without a scene action, a Gladys message or the test button.** System messages of Gladys
  reach Teams only if the administrator lets them go to Teams or to all channels (core setting).
- **No retry at all**: a request that may have left is never sent again (no duplicates). "not sent" only
  when it failed before its body was handed to the network.
- **Hourly cap**: 30 by default, 1 to 200, on all messages together, counted on requests that left
  (reserved before waiting so concurrent messages cannot pass it together), kept in `/data`.
- **Spacing 300 ms** between two starts (Microsoft: more than four requests a second are throttled).
- **Budgets**: Gladys messages 3.5 s (the core waits 5 s for the ack), scene action and test 20 s
  (declared 30 s), one request 15 s at most, none started with less than 1 s left.
- **Pauses, per webhook** (review r1 I1): 429 with Retry-After (seconds, or date against the `Date`
  header), 60 s to 6 h; without it 60 s doubling to 1 h; 5xx 60 s doubling to 30 min; reset by a success.
  One webhook in trouble never holds the channel nor the other users. The cap and the 300 ms spacing stay
  global.
- **Refusals, per webhook**: 401/403/404 keep that webhook unused 24 h. Lifted by: a new URL (always
  tried), a successful test (channel), a click on the test button (personal webhooks, tried again once by
  their next message), the 24 h. The status counts the personal webhooks refused or paused (no name kept);
  the user sees the reason in the scene log.
- **Webhook state**: in memory under a key never written (exact, per URL); in `/data` under an 8-bit
  salted fingerprint, taken back only at the first use of a webhook after a restart. A URL configured
  during the run never takes a mark; after a restart, a never-refused URL can take another's mark with
  a 1/256 chance per mark (documented).
- **Cap before the configuration**: the last cap read is kept in `/data` and used until Gladys gives the
  configuration.
- **`/data` unreadable at start**: messages are not held; until the read succeeds the cap counts only the
  messages since the start and the earlier pauses and refusals are unknown (Teams webhooks are free;
  documented). The file is never overwritten before it is read.
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
