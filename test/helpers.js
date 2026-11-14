// Shared pieces of the tests: webhook URLs, a fake POST, a logger keeping its
// lines, an app wired to the SDK fake Gladys on a test clock and a private
// /data directory removed after the test.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TeamsApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { testClock, settle } from './kit/index.mjs';

export const SIG = 'S3cr3tS1gnatureValue0123456789abcdefXYZ';
export const CHANNEL = `https://prod-12.westeurope.logic.azure.com:443/workflows/0123abcd/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${SIG}`;
export const PERSONAL_SIG = 'PersonalSecretSig9876543210zyxwvu';
export const PERSONAL = `https://default0123.ab.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/fedc3210/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${PERSONAL_SIG}`;

export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => a?.message ?? String(a)).join(' ')}`);
  return {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}

/**
 * A fake postJson: records { url, json, timeoutMs, at } and answers with
 * `next` (an object or a function of the call), 202 by default. `delayMs`
 * on the clock before answering.
 */
export function fakePost(clock, { answer = { phase: 'answered', status: 202, headers: {} } } = {}) {
  const fake = {
    calls: [],
    answer,
    delayMs: 0,
    post: async (url, json, { timeoutMs }) => {
      const call = {
        url: url.href,
        json,
        body: JSON.parse(json),
        timeoutMs,
        at: clock.monotonic(),
      };
      fake.calls.push(call);
      if (fake.delayMs > 0) {
        await new Promise((resolve) => clock.timers.setTimeout(resolve, fake.delayMs));
      }
      return typeof fake.answer === 'function' ? fake.answer(call) : fake.answer;
    },
  };
  return fake;
}

export async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-teams-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** An app on the fake Gladys, a test clock and a private /data. */
export async function setup(
  t,
  { config = { channel_webhook_url: CHANNEL }, dataDir, connect = true } = {},
) {
  const clock = testClock();
  const logger = memoryLogger();
  const fake = fakePost(clock);
  const gladys = createFakeGladys({ config });
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'gladys-teams-')));
  const app = new TeamsApp({
    gladys,
    logger,
    timers: clock.timers,
    monotonic: clock.monotonic,
    wallNow: clock.now,
    post: fake.post,
    dataDir: dir,
  });
  registerHandlers(gladys, app, logger);
  app.init();
  // /data read for real (an empty directory): wait for it, bounded.
  await until(() => app.store.loaded, { what: '/data read' });
  // Stopped before its /data is removed (the last write happens at stop).
  t.after(async () => {
    await app.stop();
    if (!dataDir) {
      await rm(dir, { recursive: true, force: true });
    }
  });
  if (connect) {
    await gladys.connect();
    await settle();
  }
  return { clock, logger, fake, gladys, app, dir };
}

/** Advances the clock while `promise` is pending, by `step` ms, at most `max`. */
export async function drive(clock, promise, { step = 50, max = 60_000 } = {}) {
  let done = false;
  const result = promise.finally(() => {
    done = true;
  });
  for (let spent = 0; !done && spent < max; spent += step) {
    await clock.advance(step);
  }
  return result;
}

/** Waits (real time, bounded) until `predicate()` is true; throws otherwise. */
export async function until(predicate, { timeoutMs = 5_000, what = 'condition' } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
