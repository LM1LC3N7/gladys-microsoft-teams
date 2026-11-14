// postJson on real local HTTPS servers (the kit): what left, what came back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { USER_AGENT, codeOf, errorCodeOf, postJson } from '../src/http.js';
import { MAX_RESPONSE_BYTES } from '../src/constants.js';
import { blackhole, certs, httpsServer, refusePort, reply } from './kit/index.mjs';
import { CHANNEL, SIG } from './helpers.js';

const URL_ = new URL(CHANNEL);
const ROUTE = `POST ${URL_.pathname}`;

/** https.request aimed at the local server, trusting `ca` only. */
const via =
  (port, ca = certs.device.cert) =>
  (url, options, callback) =>
    request(
      {
        ...options,
        host: '127.0.0.1',
        port,
        path: `${url.pathname}${url.search}`,
        ca,
        servername: 'device',
        checkServerIdentity: () => undefined,
        signal: AbortSignal.timeout(10_000),
      },
      callback,
    );

async function server(t, routes) {
  const srv = await httpsServer({ routes });
  t.after(() => srv.close());
  return srv;
}

test('a 202 is answered; the request carries the card, JSON headers and the User-Agent', async (t) => {
  const srv = await server(t, { [ROUTE]: reply(202, '') });
  const answer = await postJson(URL_, '{"type":"message"}', {
    timeoutMs: 5000,
    request: via(srv.port),
  });
  assert.equal(answer.phase, 'answered');
  assert.equal(answer.status, 202);
  const [req] = srv.requests;
  assert.equal(req.json.type, 'message');
  assert.equal(req.query.sig, SIG);
  assert.match(req.headers['content-type'], /^application\/json/);
  assert.equal(req.headers.accept, 'application/json');
  assert.equal(req.headers['user-agent'], USER_AGENT);
  assert.match(
    USER_AGENT,
    /^gladys-microsoft-teams\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\//,
  );
});

test('nothing left: refused port, unknown certificate, TLS never answered', async (t) => {
  const port = await refusePort();
  assert.deepEqual(await postJson(URL_, '{}', { timeoutMs: 3000, request: via(port) }), {
    phase: 'not_sent',
    code: 'ECONNREFUSED',
  });
  const srv = await server(t, { [ROUTE]: reply(202, '') });
  const impostor = await postJson(URL_, '{}', {
    timeoutMs: 3000,
    request: via(srv.port, certs.impostor.cert),
  });
  assert.equal(impostor.phase, 'not_sent');
  assert.equal(srv.requests.length, 0, 'no request reached the server');
  const hole = await blackhole();
  t.after(() => hole.close());
  assert.deepEqual(await postJson(URL_, '{}', { timeoutMs: 500, request: via(hole.port) }), {
    phase: 'not_sent',
    code: 'timeout',
  });
});

test('left without an answer: silence until the deadline, connection dropped', async (t) => {
  const srv = await server(t, { [ROUTE]: 'silent' });
  const started = performance.now();
  assert.deepEqual(await postJson(URL_, '{}', { timeoutMs: 600, request: via(srv.port) }), {
    phase: 'no_answer',
    code: 'timeout',
  });
  const spent = performance.now() - started;
  assert.ok(spent >= 550 && spent < 5000, `deadline kept: ${spent} ms`);
  srv.routes[ROUTE] = 'drop';
  const dropped = await postJson(URL_, '{}', { timeoutMs: 3000, request: via(srv.port) });
  assert.equal(dropped.phase, 'no_answer');
});

test('error answers: status, Microsoft error code, no redirect followed', async (t) => {
  const srv = await server(t, {
    [ROUTE]: reply(401, { error: { code: 'DirectApiAuthorizationRequired', message: 'x' } }),
    'POST /other': reply(302, '', { location: 'https://example.com/' }),
  });
  const refused = await postJson(URL_, '{}', { timeoutMs: 3000, request: via(srv.port) });
  assert.equal(refused.status, 401);
  assert.equal(refused.errorCode, 'DirectApiAuthorizationRequired');
  const moved = await postJson(new URL('https://a.logic.azure.com/other'), '{}', {
    timeoutMs: 3000,
    request: via(srv.port),
  });
  assert.equal(moved.status, 302);
  assert.equal(srv.requests.length, 2, 'the redirection is not followed');
  assert.equal(errorCodeOf(Buffer.from('{"error":{"code":"bad code with spaces"}}')), undefined);
  assert.equal(errorCodeOf(Buffer.from('not json')), undefined);
  assert.equal(codeOf(new Error('https://x/?sig=secret')), 'network_error');
  assert.equal(codeOf({ code: 'ECONNRESET' }), 'ECONNRESET');
});

test('an oversized answer is cut, not read whole', async (t) => {
  const srv = await httpsServer({
    routes: { [ROUTE]: reply(500, { error: { code: 'X' } }) },
    bigBody: 4 * 1024 * 1024,
  });
  t.after(() => srv.close());
  const started = performance.now();
  const answer = await postJson(URL_, '{}', { timeoutMs: 5000, request: via(srv.port) });
  assert.equal(answer.phase, 'answered');
  assert.equal(answer.status, 500);
  assert.equal(answer.errorCode, undefined, 'the start is blanks, the code is past the cut');
  assert.ok(performance.now() - started < 5000);
  assert.ok(MAX_RESPONSE_BYTES < 4 * 1024 * 1024);
});

test('a request function that throws is "not sent"', async () => {
  const answer = await postJson(URL_, '{}', {
    timeoutMs: 1000,
    request: () => {
      throw Object.assign(new Error('bad'), { code: 'ERR_INVALID_ARG_TYPE' });
    },
  });
  assert.deepEqual(answer, { phase: 'not_sent', code: 'ERR_INVALID_ARG_TYPE' });
});
