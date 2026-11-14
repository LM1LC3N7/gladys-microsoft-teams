// /data: read once, unreadable is not empty, never overwritten before a read,
// re-read on its own timer, no URL in it, restarts keep cap, pause, refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sanitizeState } from '../src/store.js';
import { Sender } from '../src/sender.js';
import { HOUR, STORE } from '../src/constants.js';
import { settle, testClock } from './kit/index.mjs';
import {
  CHANNEL,
  PERSONAL,
  PERSONAL_SIG,
  SIG,
  drive,
  fakePost,
  memoryLogger,
  until,
} from './helpers.js';

const A = new URL(CHANNEL);

/** Stores of the running test: stopped before their directory is removed. */
const live = new Set();
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-teams-'));
  t.after(async () => {
    for (const store of live) {
      await store.stop();
    }
    live.clear();
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function make(dir, { clock = testClock(), fs, answer } = {}) {
  const logger = memoryLogger();
  const store = new Store({ dir, timers: clock.timers, logger, fs });
  live.add(store);
  const fake = fakePost(clock, answer ? { answer } : undefined);
  const sender = new Sender({
    store,
    post: fake.post,
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
  });
  return { clock, store, sender, fake, logger };
}

const send = (ctx, url = A) => drive(ctx.clock, ctx.sender.send(url, '{}', { budgetMs: 20_000 }));
const stateOf = async (dir) => JSON.parse(await readFile(join(dir, STORE.file), 'utf8'));

test('no file: a salt is created and written, no URL ever', async (t) => {
  const dir = await tempDir(t);
  const ctx = make(dir);
  ctx.store.start();
  await until(() => ctx.store.loaded);
  await send(ctx);
  await ctx.clock.advance(STORE.saveDelayMs + 10);
  await until(() => !ctx.store.writing && !ctx.store.dirty && !ctx.store.saveTimer, {
    what: 'the write',
  });
  const state = await stateOf(dir);
  assert.match(state.salt, /^[0-9a-f]{32}$/);
  assert.equal(state.sends.length, 1);
  const text = await readFile(join(dir, STORE.file), 'utf8');
  assert.equal(text.includes(SIG), false);
  assert.equal(text.includes('logic.azure'), false);
});

test('restart: the cap, the pauses and the refusals are kept, webhook by webhook', async (t) => {
  const dir = await tempDir(t);
  const P = new URL(PERSONAL);
  const first = make(dir);
  first.store.start();
  await until(() => first.store.loaded);
  first.sender.setCap(4);
  await send(first);
  await send(first);
  first.fake.answer = { phase: 'answered', status: 404, headers: {} };
  await send(first, P);
  first.fake.answer = { phase: 'answered', status: 429, headers: { 'retry-after': '900' } };
  await send(first);
  await first.store.stop();
  const text = await readFile(join(dir, STORE.file), 'utf8');
  assert.equal(text.includes(SIG) || text.includes('logic.azure'), false);

  const clock = testClock({ start: first.clock.now() + 60_000 });
  const second = make(dir, { clock });
  second.store.start();
  await until(() => second.store.loaded);
  assert.equal(second.sender.hourlyCap, 4, 'the last cap read, before the configuration');
  const paused = await send(second);
  assert.equal(paused.reason, 'paused');
  assert.ok(paused.waitMs > 700_000 && paused.waitMs <= 840_000, String(paused.waitMs));
  assert.equal((await send(second, P)).reason, 'refused');
  await clock.advance(paused.waitMs + 1);
  assert.equal((await send(second)).reason, 'cap', 'the sends of before the restart count');
  second.sender.setCap(30);
  assert.equal((await send(second)).result, 'accepted');
  assert.equal(second.fake.calls.length, 1);
});

test('a URL configured during the run never takes the marks of /data', async (t) => {
  const dir = await tempDir(t);
  const salt = 'c'.repeat(32);
  const ctx0 = make(dir);
  ctx0.sender.salt = salt;
  const fp = ctx0.sender.fingerprint(new URL(CHANNEL));
  const wall = ctx0.clock.now();
  await writeFile(
    join(dir, STORE.file),
    JSON.stringify({ salt, sends: [], marks: [{ fp, refused: wall - 1000 }] }),
  );
  const ctx = make(dir, { clock: ctx0.clock });
  ctx.store.start();
  await until(() => ctx.store.loaded);
  ctx.sender.markFresh(new URL(CHANNEL));
  assert.equal((await send(ctx)).result, 'accepted', 'a new URL is always tried');
  const again = make(dir, { clock: ctx0.clock });
  again.store.start();
  await until(() => again.store.loaded);
  assert.equal(
    (await send(again)).reason,
    'refused',
    'first use after a restart: the mark applies',
  );
});

test('the 8-bit fingerprint cannot single out a webhook', () => {
  const sender = new Sender();
  sender.salt = 'd'.repeat(32);
  const stored = sender.fingerprint(new URL(CHANNEL));
  // An attacker who reads /data and the salt, and tries signatures: one
  // candidate in 256 matches, so the right one is lost among the others.
  let matches = 0;
  for (let i = 0; i < 4096; i += 1) {
    const guess = new URL(CHANNEL.replace(SIG, `guess${i}`));
    matches += sender.fingerprint(guess) === stored ? 1 : 0;
  }
  assert.ok(matches >= 4 && matches <= 40, `matches ${matches}`);
  assert.match(stored, /^[0-9a-f]{2}$/);
});

test('dates in the future and malformed fields are dropped', () => {
  const clean = sanitizeState({
    salt: 'nothex',
    cap: 999,
    sends: [1, 'x', null, Infinity],
    marks: [
      { fp: 'zz', refused: 1 },
      { fp: 'ab', refused: 2 },
      { fp: 'cd', pause: { until: 'soon', step: 1 } },
      { fp: 'ef', pause: { until: 5, step: 1 } },
      null,
    ],
  });
  assert.deepEqual(clean, {
    salt: undefined,
    cap: undefined,
    sends: [1],
    marks: [
      { fp: 'ab', refused: 2 },
      { fp: 'ef', pause: { until: 5, step: 1 } },
    ],
  });
  assert.equal(sanitizeState({ cap: 12 }).cap, 12);
  assert.deepEqual(sanitizeState('[]').sends, []);
  const clock = testClock();
  const sender = new Sender({
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
  });
  const wall = clock.now();
  sender.salt = 'a'.repeat(32);
  const fp = sender.fingerprint(new URL(CHANNEL));
  sender.load({
    salt: 'a'.repeat(32),
    sends: [wall + 600_000, wall - 10_000, wall - HOUR - 1],
    marks: [{ fp, pause: { until: wall + 100 * HOUR, step: 0 }, refused: wall + 5_000 }],
  });
  assert.equal(sender.sends.length, 1, 'only the date of the last hour, not the future one');
  const target = sender.target(new URL(CHANNEL));
  assert.ok(sender.pausedFor(target, clock.monotonic()) <= 6 * HOUR, 'never longer than 6 h');
  assert.equal(
    sender.isRefused(target, clock.monotonic()),
    false,
    'a refusal in the future is invalid',
  );
});

test('unreadable /data: kept as is, read again every 10 s, one read at a time', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, STORE.file), '{"salt":"', 'utf8');
  let reads = 0;
  let broken = true;
  const ctx = make(dir, {
    fs: {
      readFile: async (...args) => {
        reads += 1;
        if (broken) {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        }
        return readFile(...args);
      },
    },
  });
  ctx.store.start();
  await settle();
  assert.equal(ctx.store.loaded, false);
  await send(ctx);
  await ctx.clock.advance(STORE.saveDelayMs + 10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await until(() => !ctx.store.writing && !ctx.store.saveTimer, { what: 'no write' });
  assert.equal(await readFile(join(dir, STORE.file), 'utf8'), '{"salt":"', 'not overwritten');
  const before = reads;
  ctx.store.read();
  ctx.store.read();
  await settle();
  assert.ok(reads - before <= 2);
  reads = 0;
  await ctx.clock.advance(STORE.retryMs * 3 + 10);
  assert.ok(reads >= 2 && reads <= 4, `reads ${reads}`);
  assert.equal(ctx.logger.lines.filter((l) => l.includes('unreadable')).length, 1, 'said once');
  broken = false;
  const seen = reads;
  await ctx.clock.advance(STORE.retryMs + 10);
  await until(() => reads > seen && !ctx.store.reading);
  assert.equal(ctx.store.loaded, false, 'invalid JSON is still unreadable');
  await writeFile(join(dir, STORE.file), '{"sends":[]}', 'utf8');
  await ctx.clock.advance(STORE.retryMs + 10);
  await until(() => ctx.store.loaded);
  await ctx.clock.advance(STORE.saveDelayMs + 10);
  await until(() => !ctx.store.writing && !ctx.store.dirty && !ctx.store.saveTimer, {
    what: 'the write',
  });
  const state = await stateOf(dir);
  assert.equal(state.sends.length, 1, 'the send made meanwhile is written after the read');
});

test('a refusal seen before /data was read is written once it is', async (t) => {
  const dir = await tempDir(t);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const ctx = make(dir, {
    answer: { phase: 'answered', status: 401, headers: {} },
    fs: {
      readFile: async () => (
        await gate,
        Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' }))
      ),
    },
  });
  ctx.store.start();
  await send(ctx);
  assert.equal((await send(ctx)).reason, 'refused', 'refused in memory');
  release();
  await until(() => ctx.store.loaded);
  await ctx.clock.advance(STORE.saveDelayMs + 10);
  await until(() => !ctx.store.writing && !ctx.store.dirty && !ctx.store.saveTimer, {
    what: 'the write',
  });
  const state = await stateOf(dir);
  assert.equal(state.marks.length, 1);
  assert.match(state.marks[0].fp, /^[0-9a-f]{2}$/);
  assert.ok(state.marks[0].refused > 0);
});

test('a write that fails is said once and tried again, even when it fails during stop', async (t) => {
  const dir = await tempDir(t);
  let fail = true;
  let release;
  let gate = Promise.resolve();
  const ctx = make(dir, {
    fs: {
      writeFile: async (...args) => {
        if (fail) {
          await gate;
          throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
        }
        return writeFile(...args);
      },
    },
  });
  ctx.store.start();
  await until(() => ctx.store.loaded);
  await send(ctx);
  await ctx.clock.advance(STORE.saveDelayMs + 10);
  await until(() => !ctx.store.writing);
  assert.equal(ctx.logger.lines.filter((l) => l.includes('not written')).length, 1);
  // The second write is in flight, and fails, when the integration stops.
  gate = new Promise((resolve) => (release = resolve));
  await send(ctx);
  await ctx.clock.advance(STORE.saveDelayMs + 10);
  await until(() => ctx.store.writing, { what: 'the write in flight' });
  const stopping = ctx.store.stop();
  fail = false;
  release();
  await stopping;
  assert.equal(ctx.logger.lines.filter((l) => l.includes('not written')).length, 1, 'said once');
  assert.equal((await stateOf(dir)).sends.length, 2, 'written at the clean stop');
});

test('a mark taken back leaves /data: after a success, the next restart holds nothing', async () => {
  const clock = testClock();
  const sender = new Sender({
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
  });
  const P = new URL(PERSONAL);
  sender.salt = 'e'.repeat(32);
  const fp = sender.fingerprint(P);
  sender.load({ salt: 'e'.repeat(32), sends: [], marks: [{ fp, refused: clock.now() - 1_000 }] });
  const target = sender.target(P);
  assert.equal(sender.isRefused(target, clock.monotonic()), true, 'taken back');
  assert.equal(sender.marks.length, 0, 'no longer a loose mark');
  sender.clearRefusal(target);
  assert.deepEqual(sender.snapshot().marks, [], 'nothing comes back to /data after the success');
  const twin = { ...target, id: 'other', adopted: false, refusedAt: undefined };
  sender.adopt(twin, clock.monotonic(), clock.now());
  assert.equal(twin.refusedAt, undefined, 'a second link of the same fingerprint takes nothing');
});

test('the cap of the configuration wins over the one of /data read later', () => {
  const clock = testClock();
  const sender = new Sender({
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
  });
  sender.setCap(12);
  sender.load({ salt: 'f'.repeat(32), cap: 4, sends: [], marks: [] });
  assert.equal(sender.hourlyCap, 12);
  const other = new Sender({
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
  });
  other.load({ salt: 'f'.repeat(32), cap: 4, sends: [], marks: [] });
  assert.equal(other.hourlyCap, 4, 'before the configuration, the cap of /data');
});

test('/data keeps 64 marks at most', () => {
  const clock = testClock();
  const sender = new Sender({
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
  });
  sender.load({ salt: '1'.repeat(32), sends: [], marks: [] });
  for (let i = 0; i < 70; i += 1) {
    const target = sender.target(new URL(PERSONAL.replace(PERSONAL_SIG, `${PERSONAL_SIG}${i}`)));
    sender.markRefused(target, clock.monotonic());
  }
  const { marks } = sender.snapshot();
  assert.equal(marks.length, 64);
  assert.ok(marks.every((m) => /^[0-9a-f]{2}$/.test(m.fp) && m.refused > 0));
});
