import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeCue } from './helpers.ts';
import { startServer } from '../src/server/index.ts';

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content: { type: string; text?: string }[] };

async function connect(url: string, name: string) {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const call = async (tool: string, args: Record<string, unknown> = {}) => (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  return { client, call };
}

async function setup(t: { after(fn: () => unknown): void }) {
  // The real clock: the MCP SDK and the HTTP server run in real time here.
  const { cue } = makeCue(
    {
      resources: [{ id: 'tablet-1', kind: 'device' }],
      rules: [{ id: 'old-ask', when: { ask: 'open', ageMinutes: 30 } }],
    },
    { clock: Object.assign(() => Date.now(), { advance() {}, set() {} }) },
  );
  const srv = await startServer(cue, { port: 0 });
  const a = await connect(srv.url, 'agent-a');
  const b = await connect(srv.url, 'agent-b');
  t.after(async () => {
    await a.client.close();
    await b.client.close();
    await srv.close();
  });
  return { cue, srv, a, b };
}

test('lists the nine tools with JSON Schema inputs', async (t) => {
  const { a } = await setup(t);
  const { tools } = await a.client.listTools();
  assert.deepEqual(
    tools.map((x) => x.name).sort(),
    ['ask_human', 'claim_resource', 'get_answer', 'list_sessions', 'list_signals', 'release_resource', 'report_progress', 'since', 'whats_next'],
  );
  const ask = tools.find((x) => x.name === 'ask_human')!;
  assert.deepEqual(ask.inputSchema.required, ['summary']);
  assert.equal(tools.find((x) => x.name === 'whats_next')!.annotations?.readOnlyHint, true);
  const instructions = a.client.getInstructions();
  assert.match(instructions ?? '', /ask_human/);
});

test('ask_human → the human answers → get_answer returns it', async (t) => {
  const { cue, a } = await setup(t);
  const asked = await a.call('ask_human', { summary: 'Sandbox or mock gateway?', details: 'Refund tests', kind: 'answer', dueMinutes: 30, session: 'lane-a' });
  assert.equal(asked.isError, false);
  const askId = asked.structuredContent!.askId as string;
  assert.match(askId, /^ask_[0-9a-f]{10}$/);
  assert.equal(asked.structuredContent!.status, 'open');
  assert.match(asked.content[0]!.text!, /Call get_answer/);

  const pending = await a.call('get_answer', { askId });
  assert.equal(pending.structuredContent!.status, 'open');

  const next = await a.call('whats_next');
  assert.equal(next.structuredContent!.needs[0].id, askId);
  assert.equal(next.structuredContent!.needs[0].sessionLabel, 'lane-a');

  cue.answerAsk(askId, 'Use the sandbox');
  const done = await a.call('get_answer', { askId });
  assert.equal(done.structuredContent!.status, 'answered');
  assert.equal(done.structuredContent!.answer, 'Use the sandbox');
});

test('ask_human can wait for the answer', async (t) => {
  const { cue, a } = await setup(t);
  setTimeout(() => {
    const open = cue.store.listAsks({ status: 'open' });
    cue.answerAsk(open[0]!.id, 'approved');
  }, 600);
  const started = Date.now();
  const r = await a.call('ask_human', { summary: 'Delete 14 test orders?', kind: 'approve', waitSeconds: 10, session: 'lane-a' });
  assert.equal(r.structuredContent!.status, 'answered');
  assert.equal(r.structuredContent!.answer, 'approved');
  assert.ok(Date.now() - started < 5000);
});

test('claims across two MCP clients: the refusal names the holder', async (t) => {
  const { a, b, cue } = await setup(t);
  const got = await a.call('claim_resource', { resourceId: 'tablet-1', reason: 'smoke run', minutes: 30, session: 'android-lane' });
  assert.equal(got.isError, false);
  assert.equal(got.structuredContent!.heldBy, 'android-lane');

  // Client B names no session: its MCP connection identifies it.
  const refused = await b.call('claim_resource', { resourceId: 'tablet-1', reason: 'video tests', minutes: 30 });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text!, /^Refused: tablet-1 is held by android-lane for "smoke run"/);
  assert.equal(refused.structuredContent!.holder.label, 'android-lane');

  const notYours = await b.call('release_resource', { resourceId: 'tablet-1' });
  assert.equal(notYours.isError, true);
  assert.match(notYours.structuredContent!.message, /Only the holder can release it/);

  const released = await a.call('release_resource', { resourceId: 'tablet-1', session: 'android-lane' });
  assert.equal(released.isError, false);
  const now = await b.call('claim_resource', { resourceId: 'tablet-1', reason: 'video tests', minutes: 30 });
  assert.equal(now.isError, false);
  assert.match(now.structuredContent!.heldBy, /^mcp-[0-9a-f]{8}$/);
  const sessions = cue.listSessions();
  assert.ok(sessions.some((s) => s.label.startsWith('agent-b · ')), 'labelled with the client name');
});

test('report_progress, list_sessions, list_signals and since', async (t) => {
  const { a } = await setup(t);
  const p = await a.call('report_progress', { summary: 'Checkout suite: 14/40 passed', item: 'APP-12', session: 'checkout-tests' });
  assert.equal(p.isError, false);
  const sessions = (await a.call('list_sessions')).structuredContent!.sessions as { label: string; activity: string }[];
  const s = sessions.find((x) => x.label === 'checkout-tests')!;
  assert.equal(s.activity, 'Checkout suite: 14/40 passed');
  const signals = await a.call('list_signals', { status: 'all' });
  assert.deepEqual(signals.structuredContent!.signals, []);
  const since = await a.call('since', { timestamp: '1h' });
  assert.match(since.structuredContent!.highlights.join('\n'), /checkout-tests: 1 update, last "APP-12: Checkout suite: 14\/40 passed"/);
  const iso = await a.call('since', { timestamp: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(iso.isError, false);
});

test('inputs are validated with readable errors', async (t) => {
  const { a } = await setup(t);
  const missing = await a.call('ask_human', {});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0]!.text!, /invalid input: summary: required/);
  const wrong = await a.call('claim_resource', { resourceId: 'tablet-1', reason: 'x', minutes: 0, session: 's', extra: true });
  assert.match(wrong.content[0]!.text!, /minutes: must be at least 1; extra: unknown field/);
  const kind = await a.call('ask_human', { summary: 'x', kind: 'maybe' });
  assert.match(kind.content[0]!.text!, /kind: must be one of answer, approve, action/);
  const unknown = await a.call('claim_resource', { resourceId: 'tablet-9', reason: 'x', minutes: 5, session: 's' });
  assert.match(unknown.content[0]!.text!, /unknown resource "tablet-9"\. Known resources: tablet-1/);
  const badTs = await a.call('since', { timestamp: 'last tuesday' });
  assert.match(badTs.content[0]!.text!, /not an ISO date/);
  const noAsk = await a.call('get_answer', { askId: 'ask_0000000000' });
  assert.match(noAsk.content[0]!.text!, /no ask with id/);
  const noTool = await a.call('make_coffee');
  assert.equal(noTool.isError, true);
});
