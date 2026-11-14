# Third-party notices

This integration contains no code taken from another project.

## Sources it follows

- **Microsoft Teams documentation**, "Create an Incoming Webhook" (Workflows webhooks, Adaptive Card
  payload, 28 KB message limit, four requests per second) and "Send messages in Teams using incoming
  webhooks": read to write the requests, nothing copied. Microsoft, Teams and Power Automate are
  trademarks of Microsoft Corporation; this integration is not affiliated with Microsoft.
- **Adaptive Cards** schema (`http://adaptivecards.io/schemas/adaptive-card.json`): only named in the
  posted cards.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), the Gladys Assistant SDK, installed by npm in the
  image with its own license file.

## Test helpers

- `test/kit/` is a copy of parts of `gladys-testkit` (Apache-2.0, same author as this repository): fake
  HTTPS servers, test clocks. Used by the tests only, not in the image.
