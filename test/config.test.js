import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseWebhookUrl, toInteger } from '../src/config.js';
import { HOURLY_CAP } from '../src/constants.js';
import { CHANNEL, PERSONAL } from './helpers.js';

test('the two forms of Workflows webhook URL are accepted, fragment dropped', () => {
  for (const url of [CHANNEL, PERSONAL, ` ${CHANNEL}\n`]) {
    const parsed = parseWebhookUrl(url);
    assert.equal(parsed.ok, true, url);
  }
  assert.equal(parseWebhookUrl(`${CHANNEL}#x`).url.hash, '');
  assert.equal(
    parseWebhookUrl(CHANNEL.replace('logic.azure.com', 'logic.azure.us')).ok,
    true,
    'US government cloud',
  );
});

test('every other URL is refused with its reason', () => {
  const cases = [
    [undefined, 'empty'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['not a url', 'invalid'],
    [CHANNEL.replace('https:', 'http:'), 'invalid'],
    [CHANNEL.replace('https://', 'https://user:pw@'), 'invalid'],
    [CHANNEL.replace('&sp=', '\r\n&sp='), 'invalid'],
    [CHANNEL.replace('&sp=', '&\u0000sp='), 'invalid'],
    [`${CHANNEL}${'a'.repeat(2100)}`, 'invalid'],
    ['https://contoso.webhook.office.com/webhookb2/abc/IncomingWebhook/def/ghi', 'retired'],
    ['https://outlook.office.com/webhook/abc/IncomingWebhook/def', 'retired'],
    [
      CHANNEL.replace('prod-12.westeurope.logic.azure.com', 'logic.azure.com.evil.example'),
      'not_workflows',
    ],
    [
      CHANNEL.replace('prod-12.westeurope.logic.azure.com', 'evil-logic.azure.com'),
      'not_workflows',
    ],
    [CHANNEL.replace(':443', ':8443'), 'not_workflows'],
    [CHANNEL.replace('/workflows/', '/flows/'), 'not_workflows'],
    [CHANNEL.replace('/triggers/', '/runs/'), 'not_workflows'],
    [CHANNEL.replace(/&sig=.*$/, ''), 'no_signature'],
    [CHANNEL.replace(/sig=.*$/, 'sig='), 'no_signature'],
  ];
  for (const [value, reason] of cases) {
    assert.deepEqual(parseWebhookUrl(value), { ok: false, reason }, String(value).slice(0, 80));
  }
});

test('the hourly cap is a bounded integer, its default otherwise', () => {
  assert.equal(normalizeConfig().hourlyCap, HOURLY_CAP.default);
  assert.equal(normalizeConfig({ max_messages_per_hour: 5 }).hourlyCap, 5);
  assert.equal(normalizeConfig({ max_messages_per_hour: '12' }).hourlyCap, 12);
  assert.equal(normalizeConfig({ max_messages_per_hour: 0 }).hourlyCap, HOURLY_CAP.min);
  assert.equal(normalizeConfig({ max_messages_per_hour: 100000 }).hourlyCap, HOURLY_CAP.max);
  for (const bad of ['', ' ', '1.5', 2.5, null, 'abc', -3, '-3', NaN]) {
    const cap = normalizeConfig({ max_messages_per_hour: bad }).hourlyCap;
    assert.ok(cap >= HOURLY_CAP.min && cap <= HOURLY_CAP.max, String(bad));
    assert.ok(Number.isInteger(cap));
  }
  assert.equal(toInteger(''), undefined);
  assert.equal(toInteger('1.5'), undefined);
  assert.equal(toInteger(null), undefined);
  assert.equal(normalizeConfig({ max_messages_per_hour: '' }).hourlyCap, HOURLY_CAP.default);
  assert.equal(normalizeConfig({ channel_webhook_url: 42 }).channelWebhook, '');
});
