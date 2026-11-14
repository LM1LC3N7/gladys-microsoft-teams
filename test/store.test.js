// /data: read once, unreadable is not empty, never overwritten before a read,
// re-read on its own timer, no URL in it, restarts keep cap, pause, refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, sanitizeState } from '../src/store.js';
import { Sender } from '../src/sender.js';
import { HOUR, STORE } from '../src/constants.js';
import { settle, testClock } from './kit/index.mjs';
import {
  CHANNEL,
  PERSONAL,
  SIG,
  drive,
  fakePost,
  memoryLogger,
  tempDir,
  until,
} from './helpers.js';

const A = new URL(CHANNEL);

function make(dir, { clock = testClock(), fs, answer } = {}) {
  const logger = memoryLogger();
  const store = new Store({ dir, timers: clock.timers, logger, fs });
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

test('restart: the cap, the pause and the refusal are kept', async (t) => {
  const dir = await tempDir(t);
  const first = make(dir);
  first.sender.hourlyCap = 2;
  first.store.start();
  await until(() => first.store.loaded);
  await send(first);
  await send(first);
  first.fake.answer = { phase: 'answered', status: 404, headers: {} };
  first.sender.hourlyCap = 10;
  await send(first, new URL(PERSONAL));
  first.fake.answer = { phase: 'answered', status: 429, headers: { 'retry-after': '900' } };
  await send(first);
  await first.store.stop();

  const clock = testClock({ start: first.clock.now() + 60_000 });
  const second = make(dir, { clock });
  second.sender.hourlyCap = 2;
  second.store.start();
  await until(() => second.store.loaded);
  const paused = await send(second);
  assert.equal(paused.reason, 'paused');
  assert.ok(paused.waitMs > 700_000 && paused.waitMs <= 840_000, String(paused.waitMs));
  await clock.advance(paused.waitMs + 1);
  assert.equal((await send(second)).reason, 'cap', 'the sends of before the restart count');
  second.sender.hourlyCap = 30;
  assert.equal((await send(second, new URL(PERSONAL))).reason, 'refused');
  assert.equal((await send(second)).result, 'accepted');
  assert.equal(second.fake.calls.length, 1);
});

test('dates in the future and malformed fields are dropped', () => {
  const clean = sanitizeState({
    salt: 'nothex',
    sends: [1, 'x', null, Infinity],
    pause: { until: 'soon', step: 1 },
    refused: [{ fp: 'zz', at: 1 }, { fp: 'ab', at: 2 }, null],
  });
  assert.deepEqual(clean, {
    salt: undefined,
    sends: [1],
    pause: undefined,
    refused: [{ fp: 'ab', at: 2 }],
  });
  assert.deepEqual(sanitizeState('[]').sends, []);
  const clock = testClock();
  const sender = new Sender({
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
  });
  const wall = clock.now();
  sender.load({
    salt: 'a'.repeat(32),
    sends: [wall + 600_000, wall - 10_000, wall - HOUR - 1],
    pause: { until: wall + 100 * HOUR, step: 0 },
    refused: [],
  });
  assert.equal(sender.sends.length, 1, 'only the date of the last hour, not the future one');
  assert.ok(sender.pausedFor(clock.monotonic()) <= 6 * HOUR, 'a pause is never longer than 6 h');
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
  assert.equal(state.refused.length, 1);
  assert.match(state.refused[0].fp, /^[0-9a-f]{2}$/);
});

test('a write that fails is said once and tried again', async (t) => {
  const dir = await tempDir(t);
  let fail = true;
  const ctx = make(dir, {
    fs: {
      writeFile: async (...args) => {
        if (fail) {
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
  await send(ctx);
  await ctx.clock.advance(STORE.saveDelayMs + 10);
  await settle();
  assert.equal(ctx.logger.lines.filter((l) => l.includes('not written')).length, 1);
  fail = false;
  await ctx.store.stop();
  assert.equal((await stateOf(dir)).sends.length, 2, 'written at the clean stop');
});
