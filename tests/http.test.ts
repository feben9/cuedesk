import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCue, postJson, rawRequest } from './helpers.ts';
import { startServer, type RunningServer } from '../src/server/index.ts';

async function serve(t: { after(fn: () => unknown): void }): Promise<RunningServer> {
  const { cue } = makeCue({ resources: [{ id: 'tablet-1' }] });
  const srv = await startServer(cue, { port: 0 });
  t.after(() => srv.close());
  return srv;
}

test('rejects a foreign Host header (DNS rebinding)', async (t) => {
  const srv = await serve(t);
  for (const host of ['evil.example', `evil.example:${srv.port}`, '127.0.0.1:1', `192.168.1.5:${srv.port}`]) {
    const res = await rawRequest(srv.port, { path: '/api/whats_next', headers: { Host: host } });
    assert.equal(res.status, 403, host);
    assert.match(res.json().error, /is not this Cue/);
  }
  const mcp = await rawRequest(srv.port, { method: 'POST', path: '/mcp', headers: { Host: 'evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(mcp.status, 403, 'the MCP endpoint is guarded too');
});

test('rejects a foreign Origin, including other localhost ports and "null"', async (t) => {
  const srv = await serve(t);
  const host = `127.0.0.1:${srv.port}`;
  for (const origin of ['https://evil.example', 'http://localhost:3000', 'null', `https://127.0.0.1:${srv.port}`]) {
    const res = await postJson(srv.port, '/api/ask_human', { summary: 'hi', session: 'x' }, { Host: host, Origin: origin });
    assert.equal(res.status, 403, origin);
    assert.match(res.json().error, /Origin .* is not allowed/);
  }
  const cross = await rawRequest(srv.port, { path: '/api/state', headers: { Host: host, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 403);
});

test('accepts local requests: no Origin (scripts, curl) or Cue\'s own origin', async (t) => {
  const srv = await serve(t);
  const variants: Record<string, string>[] = [
    { Host: `127.0.0.1:${srv.port}` },
    { Host: `localhost:${srv.port}` },
    { Host: `127.0.0.1:${srv.port}`, Origin: `http://127.0.0.1:${srv.port}` },
    { Host: `localhost:${srv.port}`, Origin: `http://localhost:${srv.port}` },
  ];
  for (const headers of variants) {
    const res = await rawRequest(srv.port, { path: '/api/whats_next', headers });
    assert.equal(res.status, 200, JSON.stringify(headers));
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'no CORS headers, ever');
  }
});

test('the server listens on 127.0.0.1 only', async (t) => {
  const srv = await serve(t);
  const addr = srv.server.address();
  assert.ok(addr && typeof addr === 'object');
  assert.equal(addr.address, '127.0.0.1');
});

test('POST bodies must be JSON; preflights are refused', async (t) => {
  const srv = await serve(t);
  const host = `127.0.0.1:${srv.port}`;
  const form = await rawRequest(srv.port, {
    method: 'POST',
    path: '/api/ask_human',
    headers: { Host: host, 'Content-Type': 'text/plain' },
    body: '{"summary":"x"}',
  });
  assert.equal(form.status, 415);
  const bad = await rawRequest(srv.port, { method: 'POST', path: '/api/ask_human', headers: { Host: host, 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  const pre = await rawRequest(srv.port, { method: 'OPTIONS', path: '/api/ask_human', headers: { Host: host } });
  assert.equal(pre.status, 405);
});

test('serves the UI with a strict content security policy', async (t) => {
  const srv = await serve(t);
  const host = { Host: `127.0.0.1:${srv.port}` };
  const page = await rawRequest(srv.port, { path: '/', headers: host });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'] as string, /text\/html/);
  assert.match(page.headers['content-security-policy'] as string, /default-src 'none'/);
  assert.match(page.body, /<title>Cue<\/title>/);
  assert.equal((await rawRequest(srv.port, { path: '/app.js', headers: host })).status, 200);
  assert.equal((await rawRequest(srv.port, { path: '/app.css', headers: host })).status, 200);
  assert.equal((await rawRequest(srv.port, { path: '/../package.json', headers: host })).status, 404);
  assert.equal((await rawRequest(srv.port, { path: '/%2e%2e/package.json', headers: host })).status, 404);
});

test('API: an ask round trip, tool aliases, and helpful errors', async (t) => {
  const srv = await serve(t);
  const host = { Host: `127.0.0.1:${srv.port}` };
  const created = await postJson(srv.port, '/api/asks', { summary: 'Which build?', session: 'lane-a', kind: 'answer' }, host);
  assert.equal(created.status, 201);
  const askId = created.json().askId;
  const answered = await postJson(srv.port, `/api/asks/${askId}/answer`, { answer: 'the newest one' }, host);
  assert.equal(answered.status, 200);
  const got = await postJson(srv.port, '/api/get_answer', { askId }, host);
  assert.equal(got.json().answer, 'the newest one');
  const again = await postJson(srv.port, `/api/asks/${askId}/dismiss`, {}, host);
  assert.equal(again.status, 409);

  const sessions = await rawRequest(srv.port, { path: '/api/sessions', headers: host });
  assert.equal(sessions.json().sessions[0].label, 'lane-a');
  const since = await rawRequest(srv.port, { path: '/api/since?ts=1h', headers: host });
  assert.match(since.json().headline, /1 ask/);

  const getWrite = await rawRequest(srv.port, { path: '/api/claim_resource?resourceId=tablet-1', headers: host });
  assert.equal(getWrite.status, 405);
  const invalid = await postJson(srv.port, '/api/claim_resource', { resourceId: 'tablet-1', session: 'a' }, host);
  assert.equal(invalid.status, 400);
  assert.match(invalid.json().error, /reason: required; minutes: required/);
  const claimed = await postJson(srv.port, '/api/claim_resource', { resourceId: 'tablet-1', reason: 'run', minutes: 5 }, { ...host, 'X-Cue-Session': 'lane-a' });
  assert.equal(claimed.status, 200);
  const refused = await postJson(srv.port, '/api/claim_resource', { resourceId: 'tablet-1', reason: 'run', minutes: 5, session: 'lane-b' }, host);
  assert.equal(refused.status, 409);
  assert.match(refused.json().message, /held by lane-a/);
  const released = await postJson(srv.port, '/api/resources/tablet-1/release', {}, host);
  assert.equal(released.status, 200);
  const missing = await rawRequest(srv.port, { path: '/api/nope', headers: host });
  assert.equal(missing.status, 404);
});
