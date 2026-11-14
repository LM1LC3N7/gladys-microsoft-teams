// -----------------------------------------------------------------------------
// Every message goes through here, whatever its target (the channel of the
// configuration or the personal webhook of a Gladys user). The rules:
//   - an hourly cap, counted on every request that left (sliding hour);
//   - two requests start at least 300 ms apart (Microsoft throttles beyond
//     four a second), and none starts when its caller's budget is too short;
//   - a pause after a 429 (Retry-After, 60 s to 6 h) or a 5xx (60 s doubling
//     to 30 min), kept in /data;
//   - a webhook refused by Microsoft (401, 403, 404) is not used again for
//     24 h unless the test button succeeds with it or the URL changes;
//   - never a second attempt of a request that may have been posted: there
//     is no retry at all.
// Decisions read the monotonic clock once; the wall clock only dates /data.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { postJson } from './http.js';
import {
  HOUR,
  HOURLY_CAP,
  MAX_REFUSALS,
  MIN_GAP_MS,
  MIN_REQUEST_MS,
  PAUSE,
  REFUSAL_MS,
  REQUEST_TIMEOUT_MS,
} from './constants.js';

const defaultTimers = { setTimeout, clearTimeout };

/**
 * Retry-After in ms: seconds, or an HTTP date read against the Date header of
 * the same answer (never against the local clock). Unreadable: undefined.
 */
export function retryAfterMs(headers = {}) {
  const value = String(headers['retry-after'] ?? '').trim();
  if (/^\d{1,9}$/.test(value)) {
    return Number(value) * 1000;
  }
  const at = Date.parse(value);
  const date = Date.parse(String(headers.date ?? ''));
  if (value && Number.isFinite(at) && Number.isFinite(date)) {
    return Math.max(0, at - date);
  }
  return undefined;
}

const clampPause = (ms) => Math.min(PAUSE.max, Math.max(PAUSE.min, ms));
const nextStep = (step, max) => (step >= PAUSE.min ? Math.min(step * 2, max) : PAUSE.min);

export class Sender {
  constructor({
    store,
    post = postJson,
    monotonic = () => performance.now(),
    wallNow = Date.now,
    timers = defaultTimers,
  } = {}) {
    this.store = store;
    this.post = post;
    this.monotonic = monotonic;
    this.wallNow = wallNow;
    this.timers = timers;
    this.hourlyCap = HOURLY_CAP.default;
    /** { mono, wall } of each request that left, or is about to. */
    this.sends = [];
    this.pauseUntil = -Infinity;
    this.pauseWallUntil = 0;
    this.pauseStep = 0;
    this.lastStart = -Infinity;
    /** When the last request really started (lastStart is its reserved slot). */
    this.lastActual = -Infinity;
    /** Never written anywhere: keys the in-memory refusals and the log refs. */
    this.runtimeKey = randomBytes(32);
    this.refusedRuntime = new Map();
    this.refusedStored = [];
    /** Refusals seen before /data was read: fingerprinted once the salt is known. */
    this.pendingFingerprints = [];
    this.salt = undefined;
    this.stopped = false;
    this.sleeps = new Set();
    if (store) {
      store.onLoad = (state) => this.load(state);
      store.snapshot = () => this.snapshot();
    }
  }

  // --- /data ------------------------------------------------------------------

  load(state) {
    const now = this.monotonic();
    const wall = this.wallNow();
    this.salt = state.salt;
    // Dates in the future are invalid (clock set back, file from elsewhere).
    for (const at of state.sends) {
      const age = wall - at;
      if (age >= 0 && age < HOUR) {
        this.sends.push({ mono: now - age, wall: at });
      }
    }
    this.sends.sort((a, b) => a.mono - b.mono);
    if (state.pause) {
      const left = Math.min(state.pause.until - wall, PAUSE.max);
      if (left > 0) {
        this.pauseUntil = Math.max(this.pauseUntil, now + left);
        this.pauseWallUntil = Math.max(this.pauseWallUntil, wall + left);
      }
      this.pauseStep = Math.max(this.pauseStep, state.pause.step);
    }
    const merged = state.refused.filter((r) => wall - r.at >= 0 && wall - r.at < REFUSAL_MS);
    this.refusedStored = [...merged, ...this.refusedStored].slice(-MAX_REFUSALS);
    // Refusals seen before the read: their fingerprint can now be written.
    for (const pending of this.pendingFingerprints) {
      this.refusedStored.push({ fp: this.fingerprint(pending.url), at: pending.at });
    }
    this.pendingFingerprints = [];
    this.refusedStored = this.refusedStored.slice(-MAX_REFUSALS);
  }

  snapshot() {
    const wall = this.wallNow();
    return {
      salt: this.salt,
      sends: this.sends.map((s) => s.wall).filter((at) => wall - at < HOUR),
      pause:
        this.pauseWallUntil > wall
          ? { until: this.pauseWallUntil, step: this.pauseStep }
          : undefined,
      refused: this.refusedStored.filter((r) => wall - r.at < REFUSAL_MS),
    };
  }

  save() {
    this.store?.scheduleSave();
  }

  // --- Identities ---------------------------------------------------------------

  /** 8-bit salted fingerprint, the only trace of a refused URL in /data. */
  fingerprint(url) {
    return createHmac('sha256', this.salt).update(url.href).digest('hex').slice(0, 2);
  }

  runtimeId(url) {
    return createHmac('sha256', this.runtimeKey).update(url.href).digest('hex');
  }

  /** A short reference for the logs, different at every start, not the URL. */
  ref(url) {
    return this.runtimeId(url).slice(0, 4);
  }

  isRefused(url, now) {
    const seen = this.refusedRuntime.get(this.runtimeId(url));
    if (seen !== undefined && now - seen < REFUSAL_MS) {
      return true;
    }
    if (!this.salt) {
      return false;
    }
    const wall = this.wallNow();
    const fp = this.fingerprint(url);
    return this.refusedStored.some(
      (r) => r.fp === fp && wall - r.at >= 0 && wall - r.at < REFUSAL_MS,
    );
  }

  markRefused(url, now) {
    this.refusedRuntime.set(this.runtimeId(url), now);
    const at = this.wallNow();
    if (this.salt) {
      const fp = this.fingerprint(url);
      this.refusedStored = [...this.refusedStored.filter((r) => r.fp !== fp), { fp, at }].slice(
        -MAX_REFUSALS,
      );
      this.save();
    } else {
      this.pendingFingerprints.push({ url, at });
      this.save();
    }
  }

  clearRefusal(url) {
    const had = this.refusedRuntime.delete(this.runtimeId(url));
    if (this.salt) {
      const fp = this.fingerprint(url);
      const before = this.refusedStored.length;
      this.refusedStored = this.refusedStored.filter((r) => r.fp !== fp);
      if (had || before !== this.refusedStored.length) {
        this.save();
      }
    }
    this.pendingFingerprints = this.pendingFingerprints.filter((p) => p.url.href !== url.href);
  }

  // --- Pauses -------------------------------------------------------------------

  pausedFor(now) {
    return now < this.pauseUntil ? this.pauseUntil - now : 0;
  }

  pause(ms, now) {
    const length = clampPause(ms);
    if (now + length > this.pauseUntil) {
      this.pauseUntil = now + length;
      this.pauseWallUntil = this.wallNow() + length;
    }
    this.save();
    return length;
  }

  // --- Cap ----------------------------------------------------------------------

  /** Requests counted in the last hour at `now`, oldest first. */
  window(now) {
    this.sends = this.sends.filter((s) => now - s.mono < HOUR);
    return this.sends;
  }

  sleep(ms) {
    return new Promise((resolve) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      const entry = { resolve };
      entry.handle = this.timers.setTimeout(() => {
        this.sleeps.delete(entry);
        resolve();
      }, ms);
      this.sleeps.add(entry);
    });
  }

  stop() {
    this.stopped = true;
    for (const entry of this.sleeps) {
      this.timers.clearTimeout(entry.handle);
      entry.resolve();
    }
    this.sleeps.clear();
  }

  // --- Sending ------------------------------------------------------------------

  /**
   * Sends `json` to `url` within `budgetMs`. Resolves, never rejects:
   *   { result: 'accepted' }
   *   { result: 'not_sent', reason: refused|paused|cap|busy|stopped|<network code>, waitMs? }
   *   { result: 'rejected', reason: refused|throttled|redirect|bad_request, status, pauseMs? }
   *   { result: 'unconfirmed', reason: server_error|<network code>, status?, pauseMs? }
   * `bypassRefusal`: the test button may try a refused webhook again.
   */
  async send(url, json, { budgetMs, bypassRefusal = false }) {
    const now = this.monotonic();
    const deadline = now + budgetMs;
    if (this.stopped) {
      return { result: 'not_sent', reason: 'stopped' };
    }
    if (!bypassRefusal && this.isRefused(url, now)) {
      return { result: 'not_sent', reason: 'refused' };
    }
    const paused = this.pausedFor(now);
    if (paused > 0) {
      return { result: 'not_sent', reason: 'paused', waitMs: paused };
    }
    const recent = this.window(now);
    if (recent.length >= this.hourlyCap) {
      return { result: 'not_sent', reason: 'cap', waitMs: recent[0].mono + HOUR - now };
    }
    const start = Math.max(now, this.lastStart + MIN_GAP_MS);
    if (start + MIN_REQUEST_MS > deadline) {
      return { result: 'not_sent', reason: 'busy' };
    }
    // The slot and the cap entry are reserved before waiting, so concurrent
    // messages never pass the cap together.
    this.lastStart = start;
    const entry = { mono: start, wall: this.wallNow() + (start - now) };
    this.sends.push(entry);
    const unreserve = () => {
      this.sends = this.sends.filter((s) => s !== entry);
    };
    // A timer may fire early, a previous request may have started late:
    // never start before the slot nor less than 300 ms after the last start.
    let at = now;
    for (;;) {
      const due = Math.max(start, this.lastActual + MIN_GAP_MS);
      if (at >= due || this.stopped) {
        break;
      }
      await this.sleep(due - at);
      at = this.monotonic();
    }
    if (this.stopped) {
      unreserve();
      return { result: 'not_sent', reason: 'stopped' };
    }
    // A 429, a 5xx or a refusal may have come while waiting.
    if (!bypassRefusal && this.isRefused(url, at)) {
      unreserve();
      return { result: 'not_sent', reason: 'refused' };
    }
    const pausedNow = this.pausedFor(at);
    if (pausedNow > 0) {
      unreserve();
      return { result: 'not_sent', reason: 'paused', waitMs: pausedNow };
    }
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, deadline - at);
    if (timeoutMs < MIN_REQUEST_MS) {
      unreserve();
      return { result: 'not_sent', reason: 'busy' };
    }
    this.lastActual = at;
    const answer = await this.post(url, json, { timeoutMs });
    const done = this.monotonic();
    if (answer.phase === 'not_sent') {
      unreserve();
      return { result: 'not_sent', reason: answer.code };
    }
    this.save();
    if (answer.phase !== 'answered') {
      return { result: 'unconfirmed', reason: answer.code };
    }
    const { status } = answer;
    if (status >= 200 && status < 300) {
      this.pauseStep = 0;
      this.clearRefusal(url);
      return { result: 'accepted', status };
    }
    if (status === 429) {
      const asked = retryAfterMs(answer.headers);
      if (asked === undefined) {
        this.pauseStep = nextStep(this.pauseStep, PAUSE.throttleMax);
      }
      const pauseMs = this.pause(asked ?? this.pauseStep, done);
      return { result: 'rejected', reason: 'throttled', status, pauseMs };
    }
    if (status >= 500) {
      this.pauseStep = nextStep(this.pauseStep, PAUSE.serverMax);
      const pauseMs = this.pause(this.pauseStep, done);
      return { result: 'unconfirmed', reason: 'server_error', status, pauseMs };
    }
    if (status === 401 || status === 403 || status === 404) {
      this.markRefused(url, done);
      return { result: 'rejected', reason: 'refused', status, errorCode: answer.errorCode };
    }
    if (status >= 300 && status < 400) {
      return { result: 'rejected', reason: 'redirect', status };
    }
    return { result: 'rejected', reason: 'bad_request', status, errorCode: answer.errorCode };
  }
}
