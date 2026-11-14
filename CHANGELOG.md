# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Microsoft Teams as a send-only Gladys channel (type `communication`,
  `receive: false`), through Workflows webhooks (Office 365 connectors were
  retired by Microsoft in May 2026; their URLs are refused with an
  explanation).
- "My account": each Gladys user's personal webhook, where the messages
  Gladys addresses to them are posted (scene "Send a message", system
  messages), as an Adaptive Card.
- Scene action "Post in the Teams channel" (text, optional title, urgent
  red title) to the channel webhook of the configuration, with the output
  `status` (`accepted` or `unconfirmed`); and a "Send a test message"
  button.
- Webhook URLs checked before use (https, Workflows hosts, a signature);
  kept only in the Gladys database, never in the logs, the status nor
  `/data`.
- Hourly cap on all messages (30 by default, 1 to 200), requests at least
  300 ms apart, no second attempt of a message that may have been posted.
- Per webhook: HTTP 429 (Retry-After) and 5xx pause it, 60 s to 6 h; a
  refusal by Microsoft (401, 403, 404) keeps it unused for 24 h, a new URL
  is always tried and the test button lifts it; one webhook in trouble
  never holds the others. Cap, pauses and refusals kept in `/data` across
  restarts; the status counts the personal webhooks refused or paused.
- Webhook hosts of every cloud listed by Microsoft for the HTTP trigger of
  Power Automate: public, US Government (GCC, GCC High, DoD) and China.
- Messages cut at 4096 characters, cards under the 28 KB of Teams; images
  of messages not posted.
- `LICENSE` and `THIRD_PARTY_NOTICES.md` shipped in the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-microsoft-teams/commits/main
