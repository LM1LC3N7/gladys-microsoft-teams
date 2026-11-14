// The sending rules, on a test clock and a fake POST: cap, spacing, budget,
// pauses, refusals, never a second attempt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sender, retryAfterMs } from '../src/sender.js';
import { HOUR, MIN_GAP_MS, PAUSE, REFUSAL_MS } from '../src/constants.js';
import { settle, testClock } from './kit/index.mjs';
import { CHANNEL, PERSONAL, drive, fakePost } from './helpers.js';

const A = new URL(CHANNEL);
const B = new URL(PERSONAL);
const ok = { phase: 'answered', status: 202, headers: {} };

function make({ cap = 30 } = {}) {
  const clock = testClock();
  const fake = fakePost(clock);
  const saves = { count: 0 };
  const store = { scheduleSave: () => (saves.count += 1) };
  const sender = new Sender({
    store,
    post: fake.post,
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
  });
  sender.hourlyCap = cap;
  sender.load({ salt: '0'.repeat(32), sends: [], refused: [] });
  return { clock, fake, sender, saves };
}

const send = (ctx, url = A, opts = {}) =>
  drive(ctx.clock, ctx.sender.send(url, '{"type":"message"}', { budgetMs: 20_000, ...opts }));

test('a 2xx is accepted, one request, nothing else', async () => {
  const ctx = make();
  assert.deepEqual(await send(ctx), { result: 'accepted', status: 202 });
  assert.equal(ctx.fake.calls.length, 1);
  ctx.fake.answer = { ...ok, status: 200 };
  assert.equal((await send(ctx)).result, 'accepted');
});

test('the hourly cap: counted on what left, sliding hour, wait given', async () => {
  const ctx = make({ cap: 3 });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await send(ctx)).result, 'accepted');
  }
  const capped = await send(ctx, B);
  assert.equal(capped.result, 'not_sent');
  assert.equal(capped.reason, 'cap');
  assert.ok(capped.waitMs > HOUR - 5_000 && capped.waitMs <= HOUR, String(capped.waitMs));
  assert.equal(ctx.fake.calls.length, 3, 'the capped message never left');
  await ctx.clock.advance(capped.waitMs + 1);
  assert.equal((await send(ctx)).result, 'accepted');
  assert.equal((await send(ctx)).reason, 'cap', 'the other two are still in the hour');
});

test('a request that never left does not count; one that may have left counts', async () => {
  const ctx = make({ cap: 2 });
  ctx.fake.answer = { phase: 'not_sent', code: 'ECONNREFUSED' };
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(await send(ctx), { result: 'not_sent', reason: 'ECONNREFUSED' });
  }
  ctx.fake.answer = { phase: 'no_answer', code: 'timeout' };
  assert.deepEqual(await send(ctx), { result: 'unconfirmed', reason: 'timeout' });
  ctx.fake.answer = ok;
  assert.equal((await send(ctx)).result, 'accepted');
  assert.equal((await send(ctx)).reason, 'cap');
});

test('never a second attempt: no answer, 5xx, 429 each make exactly one request', async () => {
  for (const answer of [
    { phase: 'no_answer', code: 'ECONNRESET' },
    { phase: 'answered', status: 502, headers: {} },
    { phase: 'answered', status: 429, headers: {} },
  ]) {
    const ctx = make();
    ctx.fake.answer = answer;
    const outcome = await send(ctx);
    assert.notEqual(outcome.result, 'accepted');
    await ctx.clock.advance(7 * HOUR);
    assert.equal(ctx.fake.calls.length, 1, JSON.stringify(answer));
  }
});

test('two requests start 300 ms apart at least; concurrent messages all go', async () => {
  const ctx = make();
  const all = Promise.all([0, 1, 2, 3, 4].map(() => ctx.sender.send(A, '{}', { budgetMs: 3_500 })));
  // The first one starts at once: let it reach the POST before the clock moves.
  await new Promise((resolve) => setImmediate(resolve));
  const outcomes = await drive(ctx.clock, all, { step: 10 });
  assert.deepEqual(
    outcomes.map((o) => o.result),
    ['accepted', 'accepted', 'accepted', 'accepted', 'accepted'],
  );
  const starts = ctx.fake.calls.map((c) => c.at);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= MIN_GAP_MS - 1, `gap ${starts[i] - starts[i - 1]}`);
  }
});

test('the budget: no start without a second left; the request deadline is what is left', async () => {
  const ctx = make();
  const many = Promise.all(
    Array.from({ length: 12 }, () => ctx.sender.send(A, '{}', { budgetMs: 3_500 })),
  );
  const outcomes = await drive(ctx.clock, many, { step: 10 });
  const sent = outcomes.filter((o) => o.result === 'accepted').length;
  const busy = outcomes.filter((o) => o.reason === 'busy').length;
  assert.equal(sent + busy, 12);
  assert.ok(sent >= 8 && sent <= 9, `sent ${sent}`);
  for (const call of ctx.fake.calls) {
    assert.ok(call.timeoutMs >= 1_000 && call.timeoutMs <= 3_500, String(call.timeoutMs));
  }
  const big = await send(ctx, A, { budgetMs: 60_000 });
  assert.equal(big.result, 'accepted');
  assert.equal(ctx.fake.calls.at(-1).timeoutMs, 15_000, 'a request lasts 15 s at most');
});

test('429: Retry-After in seconds, as a date against Date, bounded 60 s to 6 h', async () => {
  assert.equal(retryAfterMs({ 'retry-after': '120' }), 120_000);
  assert.equal(
    retryAfterMs({
      'retry-after': 'Sat, 14 Nov 2026 10:05:00 GMT',
      date: 'Sat, 14 Nov 2026 10:00:00 GMT',
    }),
    300_000,
  );
  assert.equal(
    retryAfterMs({ 'retry-after': 'Sat, 14 Nov 2026 10:05:00 GMT' }),
    undefined,
    'no Date: unreadable',
  );
  assert.equal(retryAfterMs({ 'retry-after': '-5' }), undefined);
  assert.equal(retryAfterMs({}), undefined);
  for (const [header, expected] of [
    ['120', 120_000],
    ['1', PAUSE.min],
    ['999999', PAUSE.max],
  ]) {
    const ctx = make();
    ctx.fake.answer = { phase: 'answered', status: 429, headers: { 'retry-after': header } };
    const outcome = await send(ctx);
    assert.deepEqual(outcome, {
      result: 'rejected',
      reason: 'throttled',
      status: 429,
      pauseMs: expected,
    });
    ctx.fake.answer = ok;
    const paused = await send(ctx, B);
    assert.equal(paused.reason, 'paused', 'every webhook waits');
    await ctx.clock.advance(expected - 100);
    assert.equal((await send(ctx)).reason, 'paused');
    await ctx.clock.advance(200);
    assert.equal((await send(ctx)).result, 'accepted');
  }
});

test('429 without Retry-After and 5xx: the pause doubles, bounded, reset by a success', async () => {
  const ctx = make();
  const pauses = [];
  ctx.fake.answer = { phase: 'answered', status: 429, headers: {} };
  for (let i = 0; i < 8; i += 1) {
    const outcome = await send(ctx);
    pauses.push(outcome.pauseMs);
    await ctx.clock.advance(outcome.pauseMs + 1);
  }
  assert.deepEqual(pauses.slice(0, 3), [60_000, 120_000, 240_000]);
  assert.equal(Math.max(...pauses), PAUSE.throttleMax);
  ctx.fake.answer = ok;
  assert.equal((await send(ctx)).result, 'accepted');
  ctx.fake.answer = { phase: 'answered', status: 503, headers: {} };
  const server = [];
  for (let i = 0; i < 7; i += 1) {
    const outcome = await send(ctx);
    assert.equal(outcome.result, 'unconfirmed');
    assert.equal(outcome.reason, 'server_error');
    server.push(outcome.pauseMs);
    await ctx.clock.advance(outcome.pauseMs + 1);
  }
  assert.deepEqual(server.slice(0, 2), [60_000, 120_000], 'reset by the success');
  assert.equal(Math.max(...server), PAUSE.serverMax);
});

test('a pause that arrives while a message waits for its slot stops it', async () => {
  const ctx = make();
  ctx.fake.answer = { phase: 'answered', status: 429, headers: { 'retry-after': '600' } };
  const both = Promise.all([
    ctx.sender.send(A, '{}', { budgetMs: 20_000 }),
    ctx.sender.send(B, '{}', { budgetMs: 20_000 }),
  ]);
  const [first, second] = await drive(ctx.clock, both, { step: 10 });
  assert.equal(first.reason, 'throttled');
  assert.equal(second.reason, 'paused');
  assert.equal(ctx.fake.calls.length, 1);
});

test('401, 403, 404: the webhook is refused 24 h, the others still work', async () => {
  for (const status of [401, 403, 404]) {
    const ctx = make();
    ctx.fake.answer = { phase: 'answered', status, headers: {}, errorCode: 'WorkflowNotFound' };
    const outcome = await send(ctx);
    assert.deepEqual(outcome, {
      result: 'rejected',
      reason: 'refused',
      status,
      errorCode: 'WorkflowNotFound',
    });
    ctx.fake.answer = ok;
    assert.deepEqual(await send(ctx), { result: 'not_sent', reason: 'refused' });
    assert.equal(ctx.fake.calls.length, 1, 'never sent again by itself');
    assert.equal((await send(ctx, B)).result, 'accepted', 'another webhook is not touched');
    await ctx.clock.advance(REFUSAL_MS - 60_000);
    assert.equal((await send(ctx)).reason, 'refused');
    await ctx.clock.advance(61_000);
    assert.equal((await send(ctx)).result, 'accepted', 'tried again after 24 h');
  }
});

test('the test button may try a refused webhook; its success lifts the refusal', async () => {
  const ctx = make();
  ctx.fake.answer = { phase: 'answered', status: 404, headers: {} };
  await send(ctx);
  ctx.fake.answer = ok;
  assert.equal((await send(ctx, A, { bypassRefusal: true })).result, 'accepted');
  assert.equal((await send(ctx)).result, 'accepted');
  ctx.fake.answer = { phase: 'answered', status: 404, headers: {} };
  await send(ctx);
  ctx.fake.answer = { phase: 'answered', status: 404, headers: {} };
  assert.equal((await send(ctx, A, { bypassRefusal: true })).reason, 'refused');
  ctx.fake.answer = ok;
  assert.equal((await send(ctx)).reason, 'refused', 'a failed test lifts nothing');
});

test('other answers: redirect, 400, 413 are refusals of the message only', async () => {
  for (const [status, reason] of [
    [302, 'redirect'],
    [400, 'bad_request'],
    [413, 'bad_request'],
    [409, 'bad_request'],
  ]) {
    const ctx = make();
    ctx.fake.answer = { phase: 'answered', status, headers: {} };
    assert.equal((await send(ctx)).reason, reason);
    ctx.fake.answer = ok;
    assert.equal((await send(ctx)).result, 'accepted', `${status} does not block the webhook`);
  }
});

test('/data: what left is saved; stop releases the waiting messages', async () => {
  const ctx = make();
  await send(ctx);
  assert.ok(ctx.saves.count >= 1);
  const snapshot = ctx.sender.snapshot();
  assert.equal(snapshot.sends.length, 1);
  assert.equal(JSON.stringify(snapshot).includes('logic.azure'), false);
  const waiting = Promise.all([
    ctx.sender.send(A, '{}', { budgetMs: 20_000 }),
    ctx.sender.send(A, '{}', { budgetMs: 20_000 }),
  ]);
  await ctx.clock.advance(1);
  ctx.sender.stop();
  const outcomes = await waiting;
  assert.ok(outcomes.some((o) => o.reason === 'stopped'));
  assert.equal((await ctx.sender.send(A, '{}', { budgetMs: 20_000 })).reason, 'stopped');
});

test('a message without time left is refused at once and keeps no slot', async () => {
  const ctx = make();
  await send(ctx);
  let done = false;
  const short = ctx.sender.send(B, '{}', { budgetMs: 1_200 }).then((o) => {
    done = true;
    return o;
  });
  await settle();
  assert.equal(done, true, 'answered without waiting');
  assert.deepEqual(await short, { result: 'not_sent', reason: 'busy' });
  const before = ctx.clock.monotonic();
  await send(ctx, B);
  const waited = ctx.fake.calls.at(-1).at - before;
  assert.ok(waited <= MIN_GAP_MS + 60, `the busy message took no slot: ${waited}`);
});

test('a refused or paused webhook takes no slot from the others', async () => {
  const ctx = make();
  ctx.fake.answer = { phase: 'answered', status: 404, headers: {} };
  await send(ctx);
  ctx.fake.answer = ok;
  await ctx.clock.advance(1_000);
  assert.equal((await send(ctx)).reason, 'refused');
  const before = ctx.clock.monotonic();
  await new Promise((resolve) => setImmediate(resolve));
  const other = ctx.sender.send(B, '{}', { budgetMs: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.fake.calls.length, 2, 'started at once');
  assert.ok(ctx.fake.calls[1].at - before < 50);
  assert.equal((await drive(ctx.clock, other)).result, 'accepted');
});

test('timers that fire early never start a request before its slot', async () => {
  const clock = testClock();
  const fake = fakePost(clock);
  const early = {
    ...clock.timers,
    setTimeout: (fn, ms) => clock.timers.setTimeout(fn, Math.max(0, ms - 50)),
  };
  const sender = new Sender({
    post: fake.post,
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: early,
  });
  const all = Promise.all([0, 1, 2, 3].map(() => sender.send(A, '{}', { budgetMs: 5_000 })));
  await new Promise((resolve) => setImmediate(resolve));
  await drive(clock, all, { step: 5 });
  const starts = fake.calls.map((c) => c.at);
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] - starts[i - 1] >= MIN_GAP_MS - 1, `gap ${starts[i] - starts[i - 1]}`);
  }
});

test('a request that started late pushes the next one: 300 ms between real starts', async () => {
  const clock = testClock();
  const fake = fakePost(clock);
  let first = true;
  const late = {
    ...clock.timers,
    setTimeout: (fn, ms) => {
      const extra = first ? 200 : 0;
      first = false;
      return clock.timers.setTimeout(fn, ms + extra);
    },
  };
  const sender = new Sender({
    post: fake.post,
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: late,
  });
  const all = Promise.all([0, 1, 2].map(() => sender.send(A, '{}', { budgetMs: 5_000 })));
  await new Promise((resolve) => setImmediate(resolve));
  await drive(clock, all, { step: 5 });
  const starts = fake.calls.map((c) => c.at);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 499, `late start: ${starts[1] - starts[0]}`);
  assert.ok(
    starts[2] - starts[1] >= MIN_GAP_MS - 1,
    `gap after a late start: ${starts[2] - starts[1]}`,
  );
});
