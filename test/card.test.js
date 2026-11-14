import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCard, cleanText, cut, toCardMarkdown } from '../src/card.js';
import { MAX_PAYLOAD_BYTES, MAX_TEXT_CHARS, MAX_TITLE_CHARS } from '../src/constants.js';

const blocks = (json) => JSON.parse(json).attachments[0].content.body;

test('the envelope is the one of the Microsoft documentation', () => {
  const { json, cut: wasCut } = buildCard({ text: 'Door **open**' });
  const payload = JSON.parse(json);
  assert.equal(payload.type, 'message');
  assert.equal(payload.attachments.length, 1);
  const [attachment] = payload.attachments;
  assert.equal(attachment.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(attachment.content.type, 'AdaptiveCard');
  assert.equal(attachment.content.version, '1.2');
  assert.deepEqual(attachment.content.body, [
    { type: 'TextBlock', text: 'Door **open**', wrap: true },
  ]);
  assert.equal(wasCut, false);
});

test('title, urgent colour, headings and control characters', () => {
  const body = blocks(
    buildCard({
      text: '# Alarm\r\nGarage\u0007 open\u001b\n\tand lit',
      title: 'Home\nalert',
      urgent: true,
    }).json,
  );
  assert.deepEqual(body[0], {
    type: 'TextBlock',
    text: 'Home alert',
    weight: 'Bolder',
    size: 'Medium',
    wrap: true,
    color: 'Attention',
  });
  assert.equal(body[1].text, '**Alarm**\nGarage open\n\tand lit');
  assert.equal(blocks(buildCard({ text: 'x', title: 'T' }).json)[0].color, undefined);
  assert.equal(toCardMarkdown('## Two ##\nno#heading'), '**Two**\nno#heading');
  assert.equal(cleanText(42), '');
});

test('an empty text is refused', () => {
  for (const text of ['', '   ', '\u0000\u0001', undefined, null]) {
    assert.throws(() => buildCard({ text }), { code: 'empty' });
  }
});

test('texts are cut to 4096 characters, titles to 200, never half an emoji', () => {
  const long = buildCard({ text: 'a'.repeat(5000), title: 't'.repeat(500) });
  const body = blocks(long.json);
  assert.equal(long.cut, true);
  assert.equal(Array.from(body[1].text).length, MAX_TEXT_CHARS);
  assert.ok(body[1].text.endsWith('…'));
  assert.equal(Array.from(body[0].text).length, MAX_TITLE_CHARS);
  assert.equal(cut('😀😀😀', 2), '😀…');
  assert.equal(cut('ab', 2), 'ab');
});

test('the body always stays under the 28 KB of Teams, even in the worst characters', () => {
  for (const unit of ['😀', '"', '\\', 'é', '\ud800', '\u2028a', '<']) {
    const { json } = buildCard({ text: unit.repeat(5000), title: unit.repeat(300), urgent: true });
    assert.ok(Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES, `${unit}: ${Buffer.byteLength(json)}`);
    assert.equal(JSON.parse(json).attachments.length, 1);
  }
  const lone = blocks(buildCard({ text: 'a\ud800b' }).json)[0].text;
  assert.equal(lone, 'a\ufffdb');
});
