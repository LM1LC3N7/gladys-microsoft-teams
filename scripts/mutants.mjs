// -----------------------------------------------------------------------------
// Mutants of the guards of gladys-microsoft-teams. Each one breaks one guard;
// the whole suite must fail, never hang. Run one at a time in a private copy
// of the repository (never the working tree), under a RAM cap and a deadline
// that kills the whole process group:
//
//   node scripts/mutants.mjs [names...]
//   MUTANTS_REPO=<another clone> node scripts/mutants.mjs   (default: this repository)
//
// The unmodified suite runs first in the copy: red, the run stops ("baseline
// FAILED", exit 1) and no mutant is judged.
//
// Needs `memcap`, `setsid` and `timeout` (the dev VM). Not in the image.
// -----------------------------------------------------------------------------

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(
  process.env.MUTANTS_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..'),
);
const only = process.argv.slice(2);

const S = 'src/sender.js';
const H = 'src/http.js';
const C = 'src/config.js';
const K = 'src/card.js';
const A = 'src/app.js';
const D = 'src/store.js';

/** [name, [file, from, to], ...]: each `from` must occur exactly once. */
const MUTANTS = [
  // Hourly cap.
  [
    'cap-off-by-one',
    [S, 'if (recent.length >= this.hourlyCap) {', 'if (recent.length > this.hourlyCap) {'],
  ],
  ['cap-ignored', [S, 'if (recent.length >= this.hourlyCap) {', 'if (false) {']],
  ['cap-half-hour', [S, 'now - s.mono < HOUR)', 'now - s.mono < HOUR / 2)']],
  [
    'cap-counts-not-sent',
    [
      S,
      "      unreserve();\n      return { result: 'not_sent', reason: answer.code };",
      "      return { result: 'not_sent', reason: answer.code };",
    ],
  ],
  ['load-future-dates', [S, 'if (age >= 0 && age < HOUR) {', 'if (age < HOUR) {']],
  // Spacing and budget.
  ['no-spacing', [S, 'this.lastStart + MIN_GAP_MS', 'this.lastStart']],
  ['no-budget-check', [S, 'if (start + MIN_REQUEST_MS > deadline) {', 'if (false) {']],
  [
    'early-start',
    [S, 'const due = Math.max(start, this.lastActual + MIN_GAP_MS);', 'const due = start - 100;'],
  ],
  [
    'late-start-ignored',
    [S, 'const due = Math.max(start, this.lastActual + MIN_GAP_MS);', 'const due = start;'],
  ],
  // Pauses.
  [
    'pause-ignored',
    [
      S,
      'const paused = this.pausedFor(now);\n    if (paused > 0) {',
      'const paused = this.pausedFor(now);\n    if (false) {',
    ],
  ],
  ['pause-not-rechecked', [S, 'if (pausedNow > 0) {', 'if (false) {']],
  ['pause-no-min', [S, 'Math.min(PAUSE.max, Math.max(PAUSE.min, ms))', 'Math.min(PAUSE.max, ms)']],
  ['pause-no-max', [S, 'Math.min(PAUSE.max, Math.max(PAUSE.min, ms))', 'Math.max(PAUSE.min, ms)']],
  ['no-5xx-pause', [S, 'const pauseMs = this.pause(this.pauseStep, done);', 'const pauseMs = 0;']],
  [
    'retry-after-local-clock',
    [
      S,
      'if (value && Number.isFinite(at) && Number.isFinite(date)) {',
      'if (value && Number.isFinite(at)) {',
    ],
  ],
  [
    'loaded-pause-unbounded',
    [S, 'Math.min(state.pause.until - wall, PAUSE.max)', 'state.pause.until - wall'],
  ],
  [
    'step-not-reset',
    [S, 'this.pauseStep = 0;\n      this.clearRefusal(url);', 'this.clearRefusal(url);'],
  ],
  // Refusals.
  ['refusal-ignored', [S, 'if (!bypassRefusal && this.isRefused(url, now)) {', 'if (false) {']],
  [
    'refusal-404-forgotten',
    [S, 'status === 401 || status === 403 || status === 404', 'status === 401 || status === 403'],
  ],
  [
    'refusal-never-expires',
    [S, 'if (seen !== undefined && now - seen < REFUSAL_MS) {', 'if (seen !== undefined) {'],
  ],
  [
    'refusal-not-lifted',
    [
      S,
      "this.clearRefusal(url);\n      return { result: 'accepted'",
      "return { result: 'accepted'",
    ],
  ],
  ['test-no-bypass', [A, 'bypassRefusal: true,', 'bypassRefusal: false,']],
  // HTTP outcomes.
  ['sent-seen-as-not-sent', [H, 'written = true;', 'written = false;']],
  ['response-unbounded', [H, 'if (size <= MAX_RESPONSE_BYTES) {', 'if (true) {']],
  ['request-deadline-x10', [H, '}, timeoutMs);', '}, timeoutMs * 10);']],
  // URL checks.
  ['no-signature-check', [C, "if (!url.searchParams.get('sig')) {", 'if (false) {']],
  [
    'host-substring',
    [C, 'host.endsWith(suffix) && host.length > suffix.length', 'host.includes(suffix.slice(1))'],
  ],
  ['retired-accepted', [C, 'if (endsWithHost(host, RETIRED_HOST_SUFFIXES)) {', 'if (false) {']],
  ['any-port', [C, "if (url.port !== '' && url.port !== '443') {", 'if (false) {']],
  // Card.
  ['text-not-cut', [K, 'const body = cut(cleaned, MAX_TEXT_CHARS);', 'const body = cleaned;']],
  [
    'controls-kept',
    [K, "      .replace(/[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]/g, '')\n", ''],
  ],
  // App.
  [
    'message-budget-too-long',
    [A, '{ budgetMs: MESSAGE_BUDGET_MS }', '{ budgetMs: ACTION_BUDGET_MS }'],
  ],
  [
    'unconfirmed-as-failure',
    [
      A,
      "return { status: 'unconfirmed' };",
      'throw failure(describe(outcome, this.sender.hourlyCap));',
    ],
  ],
  ['config-retry-not-spaced', [A, 'delay = Math.min(delay * 2, CONFIG_RETRY.max);', '']],
  // /data.
  [
    'overwrite-before-read',
    [D, '!this.loaded || this.saveTimer || this.stopped', 'this.saveTimer || this.stopped'],
    [
      D,
      '    if (!this.loaded) {\n      return;\n    }\n    while (this.writing) {',
      '    while (this.writing) {',
    ],
  ],
  ['unreadable-as-empty', [D, "if (err?.code === 'ENOENT') {", 'if (true) {']],
  [
    'no-reread-timer',
    [D, 'this.readTimer = this.timers.setTimeout(() => this.read(), STORE.retryMs);', ''],
  ],
  [
    'stop-skips-failed-write',
    [
      D,
      '    // A write in flight may fail and leave the state dirty: wait for it first.\n    while (this.writing) {\n      await this.writing;\n    }\n',
      '',
    ],
  ],
];

function apply(file, from, to) {
  const text = readFileSync(file, 'utf8');
  const count = text.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${count} occurrences of ${JSON.stringify(from.slice(0, 60))}`);
  }
  writeFileSync(
    file,
    text.replace(from, () => to),
  );
}

/** The whole suite in `cwd`, its process group killed at the deadline. */
function suite(cwd) {
  const started = Date.now();
  const run = spawnSync(
    'setsid',
    ['memcap', '-m', '3G', 'timeout', '-k', '5', '300', 'node', '--test', '--test-timeout=60000'],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const out = `${run.stdout}${run.stderr}`;
  return {
    status: run.status,
    failed: /ℹ fail (\d+)/.exec(out)?.[1],
    hung: run.status === 124 || run.status === 137,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

// A private copy (node_modules copied, never linked), removed at the end.
// Only `.git` itself is left out (`.github` holds the release script a test imports).
const git = join(repo, '.git');
const work = mkdtempSync(join(tmpdir(), 'teams-mutants-'));
let survivors = 0;
try {
  const copy = join(work, 'repo');
  cpSync(repo, copy, {
    recursive: true,
    filter: (src) => src !== git && !src.startsWith(`${git}${sep}`),
  });
  const base = suite(copy);
  console.log(`baseline: exit ${base.status}, fail ${base.failed}, ${base.seconds} s`);
  if (base.status !== 0 || base.failed !== '0') {
    console.log('baseline FAILED: the unmodified suite is red, no mutant judged');
    survivors = Infinity;
  }
  for (const [name, ...edits] of survivors === 0 ? MUTANTS : []) {
    if (only.length > 0 && !only.includes(name)) {
      continue;
    }
    const originals = new Map();
    let line;
    try {
      for (const [file, from, to] of edits) {
        const path = join(copy, file);
        if (!originals.has(path)) {
          originals.set(path, readFileSync(path, 'utf8'));
        }
        apply(path, from, to);
      }
      const run = suite(copy);
      const killed = !run.hung && run.failed !== undefined && run.failed !== '0';
      if (!killed) {
        survivors += 1;
      }
      const verdict = run.hung ? `HUNG(${run.status})` : killed ? 'KILLED' : 'SURVIVED';
      line = `${name}: ${verdict} (fail ${run.failed}, ${run.seconds} s)`;
    } catch (err) {
      survivors += 1;
      line = `${name}: ERROR ${err.message}`;
    } finally {
      for (const [path, original] of originals) {
        writeFileSync(path, original);
      }
    }
    console.log(line);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exitCode = survivors > 0 ? 1 : 0;
