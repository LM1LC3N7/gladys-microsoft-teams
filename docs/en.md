# Microsoft Teams for Gladys

Unofficial integration, not affiliated with Microsoft. **Never tested with a real Teams account**: it
follows the Microsoft documentation ("Create an Incoming Webhook", Workflows webhooks). Feedback welcome on
the Gladys forum.

Gladys posts its messages and alerts in a Teams channel or chat. **Send only**: the integration reads
nothing from Teams, a message written in Teams never reaches Gladys.

## What you need

A **Workflows webhook** (Power Automate). The old Office 365 connectors ("Incoming Webhook" connector,
`webhook.office.com` addresses) were retired by Microsoft in May 2026; such an address is refused with an
explanation.

1. In Teams, open the channel (or the chat), then **...** > **Workflows**.
2. Pick a template like **Send webhook alerts to a channel** (or **Send webhook alerts to a chat**),
   choose where to post, save.
3. Copy the webhook link (it starts with `https://` and ends in `logic.azure.com` or
   `api.powerplatform.com` for its host).
4. In the trigger of the workflow, **Who can trigger the flow?** must be **Anyone**: Gladys does not sign
   in to Microsoft. A link without its `sig=` signature is refused with this explanation.

The link is a **secret**: anyone who has it can post where it points. It is kept by Gladys in its
database, never shown again, sent only to Microsoft. The integration never writes it in its logs, its
status, nor in `/data`.

## Two places for a webhook

- **Configuration > Channel webhook URL** (optional): the channel where your scenes post with the action
  **Post in the Teams channel**, and where the **Send a test message** button posts.
- **My account > My Teams webhook URL** (each Gladys user): the chat or channel where Gladys posts the
  messages **addressed to you**: the scene action **Send a message** (when it targets Microsoft Teams or
  all channels) and the system messages (Gladys upgraded, backup failed, low battery…) when the
  administrator lets them go to Teams or to all channels (Gladys settings).

## What is posted

An Adaptive Card with the text. Basic Markdown is rendered by Teams (bold, italic, lists, links);
headings become bold lines. Texts are cut at 4096 characters. Images (scene "Send a camera image") are
not posted: Teams webhooks take 28 KB per message at most; the text of such a message is posted.

The scene action **Post in the Teams channel** has a text, an optional title and an importance (**Urgent**
shows the title in red). Its output `status` is:

- `accepted`: Microsoft Workflows accepted the message;
- `unconfirmed`: the message left but Microsoft did not answer in time, or answered with an error
  (5xx); it may or may not be posted.

When nothing was posted (cap reached, pause, refused webhook, network down…), the action fails with the
reason in the scene log, and the scene goes on.

"Accepted" means accepted by Workflows: the workflow then runs on Microsoft's side. If it fails there
(owner who left, channel deleted), Teams shows nothing; see the run history of the workflow in Power
Automate.

## Limits and safety

- **Messages per hour** (configuration, 30 by default, 1 to 200): all the messages of the integration
  together (channel, personal webhooks, test button), counted over the last hour, kept across restarts.
  Beyond it a message is not sent and the reason gives the wait.
- **No second attempt**: a message is sent once. If Microsoft does not answer, it is not sent again (it
  may have been posted: no duplicates).
- Two requests start **300 ms apart at least** (Microsoft throttles beyond four a second).
- **429** (Microsoft asks to slow down): every message waits for the `Retry-After` delay, between 60 s
  and 6 h (60 s, then doubling up to 1 h when Microsoft gives no delay). **5xx**: 60 s, doubling up to
  30 min, back to 60 s after a success. The pause is kept across restarts and shown in the status.
- **401, 403, 404** (workflow deleted, turned off, wrong link): the webhook is refused and not used again
  for **24 h**, or until its link changes; for the channel webhook, a successful test button lifts it at once. The other webhooks are not
  affected.
- A message of Gladys must be answered within 5 s: the integration gives up at 3.5 s. If it is still
  waiting for Microsoft then, the message counts as "sent, without confirmation".

## Status

The Configuration screen shows **Ready** (with or without a channel webhook, and the hourly cap), a
**pause** asked by Microsoft and its end, a **refused** channel webhook, or a link that is not usable,
with the reason.

## What stays on your Gladys

`/data/state.json`: the dates of the messages of the last hour, the end of a pause, a random value and a
2-character fingerprint of each webhook refused in the last 24 h. No link, no text, no name. The messages
themselves go through Microsoft's servers (Power Automate, Teams).

## Questions

- **Can Gladys read Teams messages?** No, this integration only sends.
- **Several channels?** One channel webhook per Gladys for the scene action; each user can point their
  own webhook at any chat or channel.
