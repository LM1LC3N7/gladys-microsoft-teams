// -----------------------------------------------------------------------------
// /data/state.json: what must survive a restart so that the hourly cap, a
// pause asked by Microsoft and a refused webhook are not forgotten by a crash
// loop. No URL, no text, no identity: dates, the last hourly cap, a random
// salt and 8-bit fingerprints of the webhooks refused or paused.
//
// An unreadable file is not an empty one: it is read again every 10 s, one
// read at a time, and never overwritten before a read succeeded. Nothing on
// the path of a message waits for /data.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HOURLY_CAP, MAX_MARKS, PAUSE, STORE } from './constants.js';

const defaultTimers = { setTimeout, clearTimeout };

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** Keeps the well-formed fields of a parsed file; anything else is dropped. */
export function sanitizeState(raw) {
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const salt =
    typeof state.salt === 'string' && /^[0-9a-f]{32}$/.test(state.salt) ? state.salt : undefined;
  const sends = Array.isArray(state.sends) ? state.sends.filter(finite).slice(-1000) : [];
  const cap =
    Number.isInteger(state.cap) && state.cap >= HOURLY_CAP.min && state.cap <= HOURLY_CAP.max
      ? state.cap
      : undefined;
  const marks = [];
  for (const m of Array.isArray(state.marks) ? state.marks.slice(-MAX_MARKS) : []) {
    if (!m || typeof m.fp !== 'string' || !/^[0-9a-f]{2}$/.test(m.fp)) {
      continue;
    }
    const mark = { fp: m.fp };
    if (finite(m.refused)) {
      mark.refused = m.refused;
    }
    if (m.pause && finite(m.pause.until) && finite(m.pause.step)) {
      mark.pause = { until: m.pause.until, step: Math.min(Math.max(m.pause.step, 0), PAUSE.max) };
    }
    if (mark.refused !== undefined || mark.pause) {
      marks.push(mark);
    }
  }
  return { salt, cap, sends, marks };
}

export class Store {
  constructor({ dir = '/data', timers = defaultTimers, logger, fs } = {}) {
    this.file = join(dir, STORE.file);
    this.dir = dir;
    this.timers = timers;
    this.logger = logger;
    this.fs = { mkdir, readFile, rename, writeFile, ...fs };
    this.loaded = false;
    this.reading = false;
    this.readTimer = undefined;
    this.saveTimer = undefined;
    this.writing = undefined;
    this.dirty = false;
    this.stopped = false;
    this.warnedRead = false;
    this.warnedWrite = false;
    /** Set by the owner: called once with the state read, returns nothing. */
    this.onLoad = () => {};
    /** Set by the owner: the state to write. */
    this.snapshot = () => ({});
  }

  start() {
    this.stopped = false;
    this.read();
  }

  /** One read at a time; on failure another one 10 s later, until it works. */
  async read() {
    if (this.reading || this.loaded || this.stopped) {
      return;
    }
    this.reading = true;
    let state;
    try {
      const text = await this.fs.readFile(this.file, 'utf8');
      state = sanitizeState(JSON.parse(text));
    } catch (err) {
      if (err?.code === 'ENOENT') {
        state = sanitizeState({});
      } else if (!this.warnedRead) {
        this.warnedRead = true;
        this.logger?.warn(
          `/data/${STORE.file} unreadable (${err?.code ?? 'invalid JSON'}): kept as is, read again every ${STORE.retryMs / 1000} s`,
        );
      }
    } finally {
      this.reading = false;
    }
    if (this.stopped) {
      return;
    }
    if (!state) {
      this.timers.clearTimeout(this.readTimer);
      this.readTimer = this.timers.setTimeout(() => this.read(), STORE.retryMs);
      return;
    }
    if (!state.salt) {
      state.salt = randomBytes(16).toString('hex');
      this.dirty = true;
    }
    this.loaded = true;
    if (this.warnedRead) {
      this.logger?.info(`/data/${STORE.file} read again`);
    }
    this.onLoad(state);
    if (this.dirty) {
      this.scheduleSave();
    }
  }

  /** Groups the writes of the next second in one. */
  scheduleSave() {
    this.dirty = true;
    if (!this.loaded || this.saveTimer || this.stopped) {
      return;
    }
    this.saveTimer = this.timers.setTimeout(() => {
      this.saveTimer = undefined;
      this.flush().catch(() => {});
    }, STORE.saveDelayMs);
  }

  /** Writes now (one write at a time, atomic rename); never before a read. */
  async flush() {
    if (!this.loaded) {
      return;
    }
    while (this.writing) {
      await this.writing;
    }
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    const text = `${JSON.stringify(this.snapshot())}\n`;
    const tmp = `${this.file}.tmp`;
    this.writing = (async () => {
      try {
        await this.fs.mkdir(this.dir, { recursive: true });
        await this.fs.writeFile(tmp, text, { mode: 0o600 });
        await this.fs.rename(tmp, this.file);
        if (this.warnedWrite) {
          this.warnedWrite = false;
          this.logger?.info(`/data/${STORE.file} written again`);
        }
      } catch (err) {
        this.dirty = true;
        if (!this.warnedWrite) {
          this.warnedWrite = true;
          this.logger?.warn(`/data/${STORE.file} not written (${err?.code ?? 'error'})`);
        }
      }
    })();
    try {
      await this.writing;
    } finally {
      this.writing = undefined;
    }
  }

  /** Clean stop: timers cleared, last state written. */
  async stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.readTimer);
    this.timers.clearTimeout(this.saveTimer);
    this.readTimer = undefined;
    this.saveTimer = undefined;
    // A write in flight may fail and leave the state dirty: wait for it first.
    while (this.writing) {
      await this.writing;
    }
    if (this.dirty) {
      await this.flush();
    }
  }
}
