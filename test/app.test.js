// The integration on the SDK fake Gladys: messages to users, the scene action,
// the test button, the configuration read in `connected`, the status, and no
// secret anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Sender } from '../src/sender.js';
import { join } from 'node:path';
import { ACTIONS, SCENE_ACTIONS, STORE } from '../src/constants.js';
import { settle } from './kit/index.mjs';
import { CHANNEL, PERSONAL, PERSONAL_SIG, SIG, drive, setup } from './helpers.js';

const ok = { phase: 'answered', status: 202, headers: {} };
const textOf = (call) => call.body.attachments[0].content.body.at(-1).text;

test('a Gladys message goes to the personal webhook of the user, as a card', async (t) => {
  const { gladys, fake, clock } = await setup(t);
  const ack = await drive(
    clock,
    gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'Bonjour **Louis**', file: null }),
  );
  assert.deepEqual(ack, { success: true });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, new URL(PERSONAL).href);
  assert.equal(textOf(fake.calls[0]), 'Bonjour **Louis**');
  assert.ok(fake.calls[0].timeoutMs <= 3_500, 'answered before the 5 s of Gladys');
});

test('a message with an image: the text is posted, the image is not', async (t) => {
  const { gladys, fake, clock } = await setup(t);
  const ack = await drive(
    clock,
    gladys.fake.sendMessage(
      { webhook_url: PERSONAL },
      { text: 'Camera', file: 'image/jpg;base64,AAAA' },
    ),
  );
  assert.equal(ack.success, true);
  assert.equal(JSON.stringify(fake.calls[0].body).includes('base64'), false);
});

test('a message that fails says why, without the URL; nothing sent twice', async (t) => {
  const { gladys, fake, clock, logger } = await setup(t);
  const bad = await gladys.fake.sendMessage(
    { webhook_url: 'https://example.com/x?sig=1' },
    { text: 'x' },
  );
  assert.equal(bad.success, false);
  assert.match(bad.error, /not the URL of a Workflows webhook/);
  const retired = await gladys.fake.sendMessage(
    { webhook_url: 'https://contoso.webhook.office.com/webhookb2/a/IncomingWebhook/b/c' },
    { text: 'x' },
  );
  assert.match(retired.error, /retired by Microsoft/);
  const empty = await gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: '  ' });
  assert.match(empty.error, /Empty message/);
  fake.answer = { phase: 'no_answer', code: 'timeout' };
  const unconfirmed = await drive(
    clock,
    gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'x' }),
  );
  assert.equal(unconfirmed.success, false);
  assert.match(unconfirmed.error, /without an answer from Microsoft.*Not sent again/);
  fake.answer = { phase: 'answered', status: 404, headers: {} };
  const refused = await drive(
    clock,
    gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'x' }),
  );
  assert.match(refused.error, /HTTP 404/);
  fake.answer = ok;
  const blocked = await drive(
    clock,
    gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'x' }),
  );
  assert.match(blocked.error, /Nothing sent: this webhook was refused/);
  assert.equal(fake.calls.length, 2);
  for (const text of [
    bad.error,
    retired.error,
    unconfirmed.error,
    refused.error,
    blocked.error,
    ...logger.lines,
  ]) {
    assert.equal(text.includes(PERSONAL_SIG), false);
    assert.equal(text.includes('powerplatform'), false);
  }
});

test('the scene action posts to the channel: title, urgent, outputs', async (t) => {
  const { gladys, fake, clock } = await setup(t);
  const ack = await drive(
    clock,
    gladys.fake.sceneAction(SCENE_ACTIONS.POST, {
      text: 'Water leak',
      title: 'Kitchen',
      importance: 'urgent',
    }),
  );
  assert.deepEqual(ack, { success: true, data: { outputs: { status: 'accepted' } } });
  const body = fake.calls[0].body.attachments[0].content.body;
  assert.equal(fake.calls[0].url, new URL(CHANNEL).href);
  assert.equal(body[0].text, 'Kitchen');
  assert.equal(body[0].color, 'Attention');
  assert.equal(body[1].text, 'Water leak');
  fake.answer = { phase: 'no_answer', code: 'ECONNRESET' };
  const unsure = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  assert.deepEqual(unsure, { success: true, data: { outputs: { status: 'unconfirmed' } } });
  fake.answer = { phase: 'answered', status: 503, headers: {} };
  const server = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  assert.deepEqual(server.data.outputs, { status: 'unconfirmed' });
  fake.answer = ok;
  const paused = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }), {
    max: 10,
  });
  assert.equal(paused.success, false);
  assert.match(
    paused.error,
    /Nothing sent: Microsoft asked to slow down or failed for this webhook; it is used again in/,
  );
  assert.equal(fake.calls.length, 3);
});

test('a scene of five messages at once: all five posted', async (t) => {
  const { gladys, fake, clock } = await setup(t);
  fake.delayMs = 800;
  const acks = await drive(
    clock,
    Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: `message ${n}` }),
      ),
    ),
    { step: 20 },
  );
  assert.deepEqual(
    acks.map((a) => a.data?.outputs?.status),
    ['accepted', 'accepted', 'accepted', 'accepted', 'accepted'],
  );
  assert.equal(fake.calls.length, 5);
});

test('the scene action without a usable channel: nothing sent, the reason', async (t) => {
  for (const [config, pattern] of [
    [{}, /no webhook URL/],
    [{ channel_webhook_url: CHANNEL.replace(/&sig=.*$/, '') }, /Anyone/],
  ]) {
    const { gladys, fake } = await setup(t, { config });
    const ack = await gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' });
    assert.equal(ack.success, false);
    assert.match(ack.error, pattern);
    assert.equal(fake.calls.length, 0);
  }
});

test('the hourly cap applies to everything, the test button included', async (t) => {
  const { gladys, fake, clock } = await setup(t, {
    config: { channel_webhook_url: CHANNEL, max_messages_per_hour: 2 },
  });
  await drive(clock, gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: '1' }));
  await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: '2' }));
  const third = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: '3' }));
  assert.match(third.error, /hourly cap of 2 messages reached/);
  const test3 = await drive(clock, gladys.fake.action(ACTIONS.TEST));
  assert.match(test3.data.message.en, /hourly cap of 2/);
  assert.match(test3.data.message.fr, /plafond de 2 messages/);
  assert.equal(fake.calls.length, 2);
});

test('the test button: bilingual card and answer; it lifts a refusal by succeeding', async (t) => {
  const { gladys, fake, clock } = await setup(t);
  fake.answer = { phase: 'answered', status: 403, headers: {} };
  await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the channel webhook/);
  const blocked = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  assert.match(blocked.error, /Nothing sent/);
  fake.answer = ok;
  const ack = await drive(clock, gladys.fake.action(ACTIONS.TEST));
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /accepted by Microsoft Workflows/);
  assert.match(ack.data.message.fr, /accepté par Microsoft Workflows/);
  assert.match(
    textOf(fake.calls.at(-1)),
    /Test message from Gladys[\s\S]*Message de test de Gladys/,
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const after = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  assert.equal(after.data.outputs.status, 'accepted');
});

test('the test button without configuration or with a bad URL sends nothing', async (t) => {
  const { gladys, fake } = await setup(t, { config: { channel_webhook_url: 'http://x' } });
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.match(ack.data.message.en, /not a valid https/);
  assert.match(ack.data.message.fr, /n’est pas une adresse https/);
  assert.equal(fake.calls.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  const early = await setup(t, { connect: false });
  const before = await early.app.testChannel();
  assert.match(before.en, /not read from Gladys yet/);
  await assert.rejects(early.app.postToChannel({ text: 'x' }), /not read from Gladys yet/);
});

test('status: ready, then the new configuration; written only when it changes', async (t) => {
  const { gladys, app } = await setup(t, { config: {} });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /personal webhooks only/);
  await gladys.fake.configUpdated({ channel_webhook_url: CHANNEL, max_messages_per_hour: 12 });
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /channel webhook set; at most 12 messages per hour/,
  );
  const count = gladys.fake.connectionStatuses.length;
  await app.refreshStatus();
  assert.equal(gladys.fake.connectionStatuses.length, count);
});

test('getConfig() failing in `connected`: retried without end, then started', async (t) => {
  const { gladys, app, clock } = await setup(t, { config: {} });
  gladys.fake.config = { channel_webhook_url: CHANNEL };
  let failures = 2;
  const original = gladys.getConfig.bind(gladys);
  t.mock.method(gladys, 'getConfig', async () => {
    if (failures > 0) {
      failures -= 1;
      throw Object.assign(new Error('boom'), { status: 503 });
    }
    return original();
  });
  // A reconnection: the SDK fires `connected` again.
  const loop = app.connected();
  await settle();
  assert.equal(gladys.getConfig.mock.callCount(), 1);
  assert.equal(app.channel.ok, false, 'the old configuration until read');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /Configuration not read/);
  await clock.advance(4_000);
  assert.equal(gladys.getConfig.mock.callCount(), 1, 'spaced, not a storm');
  await clock.advance(1_100);
  assert.equal(gladys.getConfig.mock.callCount(), 2);
  await clock.advance(9_000);
  assert.equal(gladys.getConfig.mock.callCount(), 2, 'the second wait is longer');
  await clock.advance(1_100);
  await loop;
  assert.equal(gladys.getConfig.mock.callCount(), 3);
  assert.equal(app.channel.ok, true);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await clock.advance(600_000);
  assert.equal(gladys.getConfig.mock.callCount(), 3, 'no more reads once started');
});

test('a configuration saved during the retries wins; stop ends them', async (t) => {
  const { gladys, app, clock } = await setup(t, { config: {} });
  t.mock.method(gladys, 'getConfig', async () => {
    throw new Error('down');
  });
  const loop = app.connected();
  await settle();
  await gladys.fake.configUpdated({ channel_webhook_url: CHANNEL });
  await loop;
  await clock.advance(120_000);
  assert.equal(gladys.getConfig.mock.callCount(), 1, 'the loop ended');
  assert.equal(app.channel.ok, true);
  app.connected();
  await settle();
  await app.stop();
  await clock.advance(120_000);
  assert.equal(gladys.getConfig.mock.callCount(), 2, 'stop ends the retries');
  assert.equal(clock.pending, 0, 'no timer left after stop');
});

test('a personal webhook in 5xx or 429 never holds the channel', async (t) => {
  const { gladys, fake, clock } = await setup(t);
  fake.answer = (call) =>
    call.url === new URL(PERSONAL).href
      ? { phase: 'answered', status: 502, headers: {} }
      : { phase: 'answered', status: 202, headers: {} };
  for (let round = 0; round < 4; round += 1) {
    await drive(clock, gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'alert' }));
    const ack = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'alert' }));
    assert.equal(ack.data?.outputs?.status, 'accepted', `round ${round}`);
    await clock.advance(30_000);
  }
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /1 personal webhook\(s\) paused/);
});

test('a refused personal webhook: shown in the status, lifted by the test button', async (t) => {
  const { gladys, fake, clock } = await setup(t);
  fake.answer = { phase: 'answered', status: 404, headers: {} };
  await drive(clock, gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'x' }));
  fake.answer = ok;
  const blocked = await drive(
    clock,
    gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'x' }),
  );
  assert.match(blocked.error, /Nothing sent: this webhook was refused/);
  assert.match(blocked.error, /new URL in "My account", or after a click on "Send a test message"/);
  assert.doesNotMatch(blocked.error, /successful test/);
  await settle();
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /1 personal webhook\(s\) refused by Microsoft/,
  );
  assert.match(gladys.fake.connectionStatus.message.fr, /1 webhook\(s\) personnel\(s\) refusé/);
  const test = await drive(clock, gladys.fake.action(ACTIONS.TEST));
  assert.match(test.data.message.en, /accepted by Microsoft Workflows.*1 refused personal webhook/);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.en, /refused/);
  const calls = fake.calls.length;
  const again = await drive(
    clock,
    gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'x' }),
  );
  assert.equal(again.success, true, 'tried again after the click');
  assert.equal(fake.calls.length, calls + 1);
});

test('a test that fails keeps the channel refused', async (t) => {
  const { gladys, fake, clock } = await setup(t);
  fake.answer = { phase: 'answered', status: 403, headers: {} };
  await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  fake.answer = { phase: 'no_answer', code: 'timeout' };
  const test = await drive(clock, gladys.fake.action(ACTIONS.TEST));
  assert.match(test.data.message.en, /without an answer/);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  fake.answer = ok;
  const after = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  assert.match(after.error, /Nothing sent: this webhook was refused/);
});

test('a new personal URL is tried even when the old one is refused', async (t) => {
  const { gladys, fake, clock } = await setup(t, {
    config: { channel_webhook_url: CHANNEL, max_messages_per_hour: 200 },
  });
  fake.answer = { phase: 'answered', status: 401, headers: {} };
  await drive(clock, gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'x' }));
  fake.answer = ok;
  const other = PERSONAL.replace('fedc3210', 'fedc3211');
  for (let i = 0; i < 40; i += 1) {
    const url = other.replace(PERSONAL_SIG, `${PERSONAL_SIG}${i}`);
    const ack = await drive(clock, gladys.fake.sendMessage({ webhook_url: url }, { text: 'x' }));
    assert.equal(ack.success, true, `URL ${i}: never blocked by the fingerprint of another`);
  }
});

test('a channel URL changed during the run is tried at once', async (t) => {
  const { gladys, fake, clock } = await setup(t);
  fake.answer = { phase: 'answered', status: 403, headers: {} };
  await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  assert.equal(gladys.fake.connectionStatus.connected, false);
  fake.answer = ok;
  await gladys.fake.configUpdated({ channel_webhook_url: CHANNEL.replace(SIG, `${SIG}new`) });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const ack = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  assert.equal(ack.data.outputs.status, 'accepted');
});

/** A /data written before the start, with marks on the fingerprints of `urls`. */
async function dataWithMarks(t, marks) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-teams-'));
  const salt = '9'.repeat(32);
  const fp = new Sender();
  fp.salt = salt;
  const at = Date.UTC(2026, 0, 1) - 60_000; // the test clock starts on 2026-01-01
  const state = {
    salt,
    sends: [],
    marks: marks.map((url) => ({ fp: fp.fingerprint(new URL(url)), refused: at })),
  };
  await writeFile(join(dir, STORE.file), JSON.stringify(state));
  return {
    dir,
    // Registered after setup(): runs once the app is stopped.
    cleanup: () => t.after(() => rm(dir, { recursive: true, force: true })),
  };
}

test('a channel URL configured during the run never takes a mark of /data', async (t) => {
  const NEW = CHANNEL.replace(SIG, `${SIG}new`);
  const data = await dataWithMarks(t, [NEW]);
  const { gladys, fake, clock } = await setup(t, { dataDir: data.dir });
  data.cleanup();
  await gladys.fake.configUpdated({ channel_webhook_url: NEW });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const ack = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  assert.equal(ack.data?.outputs?.status, 'accepted', 'tried at once');
  assert.equal(fake.calls.length, 1);
});

test('the channel of the first configuration takes its mark back after a restart', async (t) => {
  const data = await dataWithMarks(t, [CHANNEL]);
  const { gladys, fake, clock } = await setup(t, { dataDir: data.dir });
  data.cleanup();
  const ack = await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' }));
  assert.match(ack.error, /Nothing sent: this webhook was refused/);
  assert.equal(fake.calls.length, 0);
});

test('a click lifts the refusals still in /data, before their first use', async (t) => {
  const data = await dataWithMarks(t, [PERSONAL]);
  const { gladys, fake, clock } = await setup(t, { dataDir: data.dir, config: {} });
  data.cleanup();
  const test = await drive(clock, gladys.fake.action(ACTIONS.TEST));
  assert.match(test.data.message.en, /1 refused personal webhook/);
  const ack = await drive(clock, gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'x' }));
  assert.equal(ack.success, true, 'tried after the click');
  assert.equal(fake.calls.length, 1);
});

test('the secrets are nowhere: logs, statuses, /data, answers', async (t) => {
  const { gladys, fake, clock, logger, dir, app } = await setup(t);
  const outcomes = [];
  for (const answer of [
    ok,
    { phase: 'answered', status: 401, headers: {}, errorCode: 'DirectApiAuthorizationRequired' },
    { phase: 'answered', status: 429, headers: {} },
  ]) {
    fake.answer = answer;
    outcomes.push(
      await drive(clock, gladys.fake.sendMessage({ webhook_url: PERSONAL }, { text: 'x' })),
    );
    outcomes.push(await drive(clock, gladys.fake.sceneAction(SCENE_ACTIONS.POST, { text: 'x' })));
    outcomes.push(await drive(clock, gladys.fake.action(ACTIONS.TEST)));
  }
  await clock.advance(STORE.saveDelayMs + 10);
  await app.store.stop();
  const files = await readdir(dir);
  const data = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('\n');
  const everything = [
    JSON.stringify(outcomes),
    JSON.stringify(gladys.fake.connectionStatuses),
    logger.lines.join('\n'),
    data,
  ].join('\n');
  for (const secret of [
    SIG,
    PERSONAL_SIG,
    'logic.azure',
    'powerplatform',
    '0123abcd',
    'fedc3210',
  ]) {
    assert.equal(everything.includes(secret), false, secret);
  }
  assert.ok(data.length > 10);
});
