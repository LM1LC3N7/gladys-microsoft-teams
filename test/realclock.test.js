// The periods on the real clock (sped up): the re-read of an unreadable /data
// every 10 s, and two requests 300 ms apart at least. Everything is stopped
// in t.after, so a failure never leaves a timer behind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Sender } from '../src/sender.js';
import { MIN_GAP_MS, STORE } from '../src/constants.js';
import { measurePeriod, realClock, spyOn } from './kit/index.mjs';
import { CHANNEL, memoryLogger, tempDir } from './helpers.js';

test('unreadable /data is read again every 10 s, never faster', async (t) => {
  const clock = realClock({ speed: 20 });
  const dir = await tempDir(t);
  const store = new Store({
    dir,
    timers: clock.timers,
    logger: memoryLogger(),
    fs: {
      readFile: async () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
    },
  });
  const spy = spyOn(store, 'read', clock);
  t.after(async () => {
    await store.stop();
    clock.close();
  });
  store.start();
  const gaps = await measurePeriod(spy, {
    count: 4,
    period: STORE.retryMs,
    max: STORE.retryMs * 3,
    timeoutMs: 20_000,
  });
  assert.equal(gaps.length, 3);
  assert.equal(store.loaded, false);
});

test('requests start 300 ms apart at least on the real clock', async (t) => {
  const clock = realClock({ speed: 10 });
  const starts = [];
  const sender = new Sender({
    post: async () => {
      starts.push(clock.monotonic());
      return { phase: 'answered', status: 202, headers: {} };
    },
    monotonic: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
  });
  t.after(() => {
    sender.stop();
    clock.close();
  });
  const url = new URL(CHANNEL);
  const outcomes = await Promise.all(
    Array.from({ length: 6 }, () => sender.send(url, '{}', { budgetMs: 20_000 })),
  );
  assert.ok(outcomes.every((o) => o.result === 'accepted'));
  for (let i = 1; i < starts.length; i += 1) {
    const gap = starts[i] - starts[i - 1];
    assert.ok(gap >= MIN_GAP_MS * 0.95 && gap <= MIN_GAP_MS * 10, `gap ${gap}`);
  }
});
