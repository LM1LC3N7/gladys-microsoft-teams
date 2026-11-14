// -----------------------------------------------------------------------------
// The message posted to the Workflows webhook: an Adaptive Card in a
// "message" envelope, the format of the Microsoft documentation and of the
// "Send webhook alerts to a channel / chat" templates. Text fields of a card
// take basic Markdown (bold, italic, lists, links); Gladys writes Markdown, so
// only the headings, unknown to cards, become bold lines.
// MAX_PAYLOAD_BYTES (27 KB) is the bound the tests hold the body to.
// -----------------------------------------------------------------------------

import { MAX_TEXT_CHARS, MAX_TITLE_CHARS } from './constants.js';

const ELLIPSIS = '…';

/** Drops the control characters (tabs and line feeds kept), CRLF -> LF. */
export function cleanText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return (
    value
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
      // A lone surrogate is not UTF-8: U+FFFD instead.
      .toWellFormed()
      .trim()
  );
}

/** Cuts to `max` characters (code points, never half an emoji), "…" at the end. */
export function cut(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}${ELLIPSIS}`;
}

/** Markdown headings ("# Title") are not rendered by cards: bold lines. */
export function toCardMarkdown(text) {
  return text.replace(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm, '**$1**');
}

const envelope = (body) => ({
  type: 'message',
  attachments: [
    {
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.2',
        body,
      },
    },
  ],
});

function render(text, title, urgent) {
  const body = [];
  if (title) {
    body.push({
      type: 'TextBlock',
      text: title,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
      ...(urgent ? { color: 'Attention' } : {}),
    });
  }
  body.push({ type: 'TextBlock', text, wrap: true });
  return JSON.stringify(envelope(body));
}

/**
 * Builds the JSON body. Throws { code: 'empty' } on a text left empty after
 * cleaning. The text is cut to 4096 characters and the title to 200: at
 * most 4 bytes each once in JSON (control characters are dropped, lone
 * surrogates replaced), about 17 KB, under the 28 KB Teams accepts
 * (test/card.test.js checks the worst case against MAX_PAYLOAD_BYTES).
 */
export function buildCard({ text, title, urgent = false }) {
  const cleaned = toCardMarkdown(cleanText(text));
  if (!cleaned) {
    const err = new Error('empty text');
    err.code = 'empty';
    throw err;
  }
  const head = cut(cleanText(title).replace(/\s+/g, ' '), MAX_TITLE_CHARS);
  const body = cut(cleaned, MAX_TEXT_CHARS);
  return { json: render(body, head, urgent), cut: body !== cleaned };
}
