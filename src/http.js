// -----------------------------------------------------------------------------
// One POST to a webhook, told apart in three outcomes, because a message is
// never sent twice:
//   - not_sent: the request failed before its body was handed to the network
//     (name not resolved, connection refused, certificate refused): nothing
//     reached Microsoft;
//   - no_answer: the body left, no status came back in time: it may have been
//     posted;
//   - answered: a status came back (the body read up to 16 KB, only for the
//     error code).
// Redirects are not followed. The URL never appears in a result.
// -----------------------------------------------------------------------------

import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { MAX_RESPONSE_BYTES } from './constants.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const USER_AGENT = `gladys-microsoft-teams/${pkg.version} (+https://github.com/LM1LC3N7/gladys-microsoft-teams)`;

/** A short code safe to log: the Node error code, or a generic word. */
export function codeOf(err) {
  const code = typeof err?.code === 'string' ? err.code : '';
  return /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'network_error';
}

/** The `error.code` of a Microsoft JSON error body, when it is a plain word. */
export function errorCodeOf(buffer) {
  try {
    const code = JSON.parse(buffer.toString('utf8'))?.error?.code;
    return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * POSTs `json` to `url` (a URL object). Resolves, never rejects:
 * { phase: 'not_sent' | 'no_answer', code } or
 * { phase: 'answered', status, headers, errorCode }.
 */
export function postJson(url, json, { timeoutMs, request = httpsRequest } = {}) {
  return new Promise((resolve) => {
    const body = Buffer.from(json, 'utf8');
    let written = false;
    let response;
    let done = false;
    let timer;
    let req;
    const finish = (result) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failed = (code) =>
      finish(written ? { phase: 'no_answer', code } : { phase: 'not_sent', code });
    try {
      req = request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': body.length,
            accept: 'application/json',
            'user-agent': USER_AGENT,
          },
        },
        (res) => {
          response = { status: res.statusCode, headers: res.headers };
          const chunks = [];
          let size = 0;
          const end = () =>
            finish({
              phase: 'answered',
              ...response,
              errorCode: errorCodeOf(Buffer.concat(chunks)),
            });
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size <= MAX_RESPONSE_BYTES) {
              chunks.push(chunk);
            } else {
              // Only the beginning matters: an oversized answer is cut.
              res.destroy();
              end();
            }
          });
          res.on('end', end);
          res.on('close', end);
          res.on('error', end);
        },
      );
    } catch (err) {
      finish({ phase: 'not_sent', code: codeOf(err) });
      return;
    }
    timer = setTimeout(() => {
      if (response) {
        finish({ phase: 'answered', ...response, errorCode: undefined });
      } else {
        failed('timeout');
      }
      req.destroy();
    }, timeoutMs);
    req.on('error', (err) => {
      if (response) {
        finish({ phase: 'answered', ...response, errorCode: undefined });
      } else {
        failed(codeOf(err));
      }
    });
    req.end(body, () => {
      written = true;
    });
  });
}
