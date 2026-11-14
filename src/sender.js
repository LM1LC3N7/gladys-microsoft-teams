// -----------------------------------------------------------------------------
// Every message goes through here, whatever its target (the channel of the
// configuration or the personal webhook of a Gladys user). The rules:
//   - an hourly cap, counted on every request that left (sliding hour);
//   - two requests start at least 300 ms apart (Microsoft throttles beyond
//     four a second), and none starts when its caller's budget is too short;
//   - per webhook: a pause after a 429 (Retry-After, 60 s to 6 h) or a 5xx
//     (60 s doubling to 30 min); a refusal (401, 403, 404) that keeps it
//     unused for 24 h, unless the test button lifts it or the URL changes.
//     One webhook in trouble never holds the others;
//   - never a second attempt of a request that may have been posted: there
//     is no retry at all.
// Decisions read the monotonic clock once; the wall clock only dates /data.
//
// The state of a webhook lives in memory under a key never written anywhere
// (exact, one URL each). /data keeps it under an 8-bit salted fingerprint,
// taken back by a webhook the first time it is used after a restart only: a
// URL configured during this run, or already used in it, never inherits the
// marks of another one.
// -----------------------------------------------------------------------------

import { createHmac, randomBytes } from 'node:crypto';
import { postJson } from './http.js';
import {
  HOUR,
  HOURLY_CAP,
  MAX_MARKS,
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
    /** False until the configuration gave the cap: the one kept in /data is used. */
    this.capFromConfig = false;
    /** { mono, wall } of each request that left, or is about to. */
    this.sends = [];
    this.lastStart = -Infinity;
    /** When the last request really started (lastStart is its reserved slot). */
    this.lastActual = -Infinity;
    /** Never written anywhere: keys the webhooks in memory and the log refs. */
    this.runtimeKey = randomBytes(32);
    /** runtime id -> state of one webhook (see target()). */
    this.targets = new Map();
    /** Marks read from /data not taken back by a webhook yet: { fp, refused?, pause? }. */
    this.marks = [];
    this.salt = undefined;
    this.stopped = false;
    this.sleeps = new Set();
    if (store) {
      store.onLoad = (state) => this.load(state);
      store.snapshot = () => this.snapshot();
    }
  }

  setCap(cap) {
    this.hourlyCap = cap;
    this.capFromConfig = true;
    this.save();
  }

  // --- /data ------------------------------------------------------------------

  load(state) {
    const now = this.monotonic();
    const wall = this.wallNow();
    this.salt = state.salt;
    if (!this.capFromConfig && state.cap !== undefined) {
      this.hourlyCap = state.cap;
    }
    // Dates in the future are invalid (clock set back, file from elsewhere).
    for (const at of state.sends) {
      const age = wall - at;
      if (age >= 0 && age < HOUR) {
        this.sends.push({ mono: now - age, wall: at });
      }
    }
    this.sends.sort((a, b) => a.mono - b.mono);
    this.marks = state.marks.filter((m) => this.markAlive(m, wall));
    // Webhooks used before the read take their marks back now.
    for (const target of this.targets.values()) {
      this.adopt(target, now, wall);
    }
    this.save();
  }

  markAlive(mark, wall) {
    const refused =
      mark.refused !== undefined && wall - mark.refused >= 0 && wall - mark.refused < REFUSAL_MS;
    const paused = mark.pause !== undefined && mark.pause.until > wall;
    return refused || paused;
  }

  snapshot() {
    const now = this.monotonic();
    const wall = this.wallNow();
    const marks = [...this.marks.filter((m) => this.markAlive(m, wall))];
    for (const target of this.targets.values()) {
      if (!target.fp) {
        continue;
      }
      const mark = { fp: target.fp };
      if (this.isRefused(target, now)) {
        mark.refused = target.refusedWall;
      }
      if (this.pausedFor(target, now) > 0) {
        mark.pause = { until: target.pauseWall, step: target.step };
      }
      if (mark.refused !== undefined || mark.pause) {
        marks.push(mark);
      }
    }
    return {
      salt: this.salt,
      cap: this.hourlyCap,
      sends: this.sends.map((s) => s.wall).filter((at) => wall - at < HOUR),
      marks: marks.slice(-MAX_MARKS),
    };
  }

  save() {
    this.store?.scheduleSave();
  }

  // --- Webhooks -----------------------------------------------------------------

  /** 8-bit salted fingerprint, the only trace of a webhook in /data. */
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

  /**
   * The state of one webhook, created at its first use in this run. `fresh`:
   * a URL just configured, which takes back no mark from /data.
   */
  target(url, { fresh = false } = {}) {
    const id = this.runtimeId(url);
    let target = this.targets.get(id);
    if (!target) {
      target = {
        id,
        url,
        fp: undefined,
        adopted: fresh,
        pauseUntil: -Infinity,
        pauseWall: 0,
        step: 0,
        refusedAt: undefined,
        refusedWall: 0,
      };
      this.targets.set(id, target);
      this.adopt(target, this.monotonic(), this.wallNow());
    }
    return target;
  }

  /** A URL configured during this run: never inherits a mark of /data. */
  markFresh(url) {
    this.target(url, { fresh: true });
  }

  /** First use after a restart: takes the marks of its fingerprint back. */
  adopt(target, now, wall) {
    if (!this.salt) {
      return;
    }
    target.fp ??= this.fingerprint(target.url);
    if (target.adopted) {
      return;
    }
    target.adopted = true;
    const mine = this.marks.filter((m) => m.fp === target.fp);
    this.marks = this.marks.filter((m) => m.fp !== target.fp);
    for (const mark of mine) {
      const age = mark.refused === undefined ? -1 : wall - mark.refused;
      if (age >= 0 && age < REFUSAL_MS) {
        target.refusedAt = now - age;
        target.refusedWall = mark.refused;
      }
      if (mark.pause) {
        const left = Math.min(mark.pause.until - wall, PAUSE.max);
        if (left > 0 && now + left > target.pauseUntil) {
          target.pauseUntil = now + left;
          target.pauseWall = wall + left;
        }
        target.step = Math.max(target.step, mark.pause.step);
      }
    }
  }

  isRefused(target, now) {
    return target.refusedAt !== undefined && now - target.refusedAt < REFUSAL_MS;
  }

  markRefused(target, now) {
    target.refusedAt = now;
    target.refusedWall = this.wallNow();
    this.save();
  }

  clearRefusal(target) {
    if (target.refusedAt !== undefined) {
      target.refusedAt = undefined;
      this.save();
    }
  }

  /**
   * A click on the test button: every webhook but `except` (the channel,
   * lifted by its own successful test) may be tried again, once.
   */
  liftRefusals(except) {
    const keep = except ? this.target(except).id : undefined;
    let lifted = 0;
    for (const target of this.targets.values()) {
      if (target.id !== keep && target.refusedAt !== undefined) {
        target.refusedAt = undefined;
        lifted += 1;
      }
    }
    const before = this.marks.filter((m) => m.refused !== undefined).length;
    this.marks = this.marks.filter((m) => m.pause).map((m) => ({ fp: m.fp, pause: m.pause }));
    lifted += before;
    if (lifted > 0) {
      this.save();
    }
    return lifted;
  }

  pausedFor(target, now) {
    return now < target.pauseUntil ? target.pauseUntil - now : 0;
  }

  pause(target, ms, now) {
    const length = clampPause(ms);
    if (now + length > target.pauseUntil) {
      target.pauseUntil = now + length;
      target.pauseWall = this.wallNow() + length;
    }
    this.save();
    return length;
  }

  /** For the status: the channel, and how many personal webhooks are held. */
  summary(channel) {
    const now = this.monotonic();
    const channelId = channel ? this.target(channel).id : undefined;
    const result = { channelPausedMs: 0, channelRefused: false, refused: 0, paused: 0 };
    for (const target of this.targets.values()) {
      if (target.id === channelId) {
        result.channelPausedMs = this.pausedFor(target, now);
        result.channelRefused = this.isRefused(target, now);
      } else {
        result.refused += this.isRefused(target, now) ? 1 : 0;
        result.paused += this.pausedFor(target, now) > 0 ? 1 : 0;
      }
    }
    return result;
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
    const target = this.target(url);
    const now = this.monotonic();
    const deadline = now + budgetMs;
    if (this.stopped) {
      return { result: 'not_sent', reason: 'stopped' };
    }
    if (!bypassRefusal && this.isRefused(target, now)) {
      return { result: 'not_sent', reason: 'refused' };
    }
    const paused = this.pausedFor(target, now);
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
    // A 429, a 5xx or a refusal of this webhook may have come while waiting.
    if (!bypassRefusal && this.isRefused(target, at)) {
      unreserve();
      return { result: 'not_sent', reason: 'refused' };
    }
    const pausedNow = this.pausedFor(target, at);
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
      target.step = 0;
      this.clearRefusal(target);
      return { result: 'accepted', status };
    }
    if (status === 429) {
      const asked = retryAfterMs(answer.headers);
      if (asked === undefined) {
        target.step = nextStep(target.step, PAUSE.throttleMax);
      }
      const pauseMs = this.pause(target, asked ?? target.step, done);
      return { result: 'rejected', reason: 'throttled', status, pauseMs };
    }
    if (status >= 500) {
      target.step = nextStep(target.step, PAUSE.serverMax);
      const pauseMs = this.pause(target, target.step, done);
      return { result: 'unconfirmed', reason: 'server_error', status, pauseMs };
    }
    if (status === 401 || status === 403 || status === 404) {
      this.markRefused(target, done);
      return { result: 'rejected', reason: 'refused', status, errorCode: answer.errorCode };
    }
    if (status >= 300 && status < 400) {
      return { result: 'rejected', reason: 'redirect', status };
    }
    return { result: 'rejected', reason: 'bad_request', status, errorCode: answer.errorCode };
  }
}
