import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cue } from '../src/cue.ts';
import { Store } from '../src/store/index.ts';
import { ingestClaudeHook } from '../src/ingest/hooks.ts';
import { parseArgs } from '../src/cli.ts';
import type { PostLike } from '../src/notify/index.ts';
import { fakeClock, testConfig } from './helpers.ts';

const TOPIC = 'cue-k3v9q2m7xa';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { topic: string; title: string; message: string; priority: number; tags: string[] };
}

function setup(
  notify: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  opts: { fail?: boolean; failFirst?: number; status?: number; env?: Record<string, string> } = {},
) {
  const clock = fakeClock();
  const sent: Sent[] = [];
  const logs: string[] = [];
  let calls = 0;
  const post: PostLike = async (url, init) => {
    calls++;
    if (opts.fail || calls <= (opts.failFirst ?? 0)) throw new Error('getaddrinfo ENOTFOUND ntfy.sh');
    if (opts.status) return { ok: false, status: opts.status };
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const config = testConfig({
    notify,
    // An ask left open for an hour becomes an urgent signal: an easy way to fire one.
    rules: [{ id: 'old-ask', when: { ask: 'open', ageMinutes: 60 }, severity: 'urgent' }],
    ...extra,
  });
  const cue = new Cue({ config, store: new Store(':memory:', clock), sources: [], post, env: opts.env ?? {}, log: (m) => logs.push(m), alertRetryDelayMs: 0 });
  return { cue, clock, sent, logs, calls: () => calls };
}

test('an urgent signal sends one alert with its title, at top priority', async () => {
  const { cue, clock, sent } = setup({ ntfy: { topic: TOPIC } });
  cue.askHuman({ summary: 'Which test account should the signup tests use?' }, { via: 'api' });
  await cue.notifier!.idle();
  assert.equal(sent.length, 0, 'asks are not sent unless "asks" is on');

  clock.advance(61 * 60_000);
  cue.evaluate();
  cue.evaluate(); // the same signal does not alert twice
  await cue.notifier!.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'https://ntfy.sh/');
  assert.equal(sent[0]!.body.topic, TOPIC);
  assert.equal(sent[0]!.body.priority, 5);
  assert.equal(sent[0]!.body.title, 'Cue · test: urgent');
  assert.match(sent[0]!.body.message, /Which test account/);
  assert.equal(sent[0]!.headers.Authorization, undefined);
});

test('signals below urgent never alert', async () => {
  const { cue, clock, sent } = setup({ ntfy: { topic: TOPIC } }, { rules: [{ id: 'old-ask', when: { ask: 'open', ageMinutes: 60 }, severity: 'warn' }] });
  cue.askHuman({ summary: 'Anything' }, { via: 'api' });
  clock.advance(61 * 60_000);
  assert.equal(cue.evaluate().fired.length, 1);
  await cue.notifier!.idle();
  assert.equal(sent.length, 0);
});

test('with "asks" on, a new ask alerts, from an agent or from a Claude Code prompt', async () => {
  const { cue, sent } = setup({ ntfy: { topic: TOPIC }, on: ['urgent', 'asks'] });
  cue.askHuman({ summary: 'Delete 14 leftover test orders?', kind: 'approve', askedBy: 'checkout-tests' }, { via: 'mcp' });
  ingestClaudeHook(cue, { hook_event_name: 'PreToolUse', session_id: 's-1', cwd: '/w/shop', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  ingestClaudeHook(cue, { hook_event_name: 'Notification', session_id: 's-1', cwd: '/w/shop', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  await cue.notifier!.idle();
  assert.deepEqual(
    sent.map((s) => [s.body.title, s.body.message, s.body.priority]),
    [
      ['checkout-tests needs you', 'Delete 14 leftover test orders?', 4],
      ['shop · s-1 needs you', 'Claude wants to run: npm test', 4],
    ],
  );
});

test('quiet hours hold asks but not urgent signals', async () => {
  const clock = fakeClock();
  const hour = new Date(clock()).getHours();
  const pad = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  const { cue, clock: c, sent } = setup({ ntfy: { topic: TOPIC }, on: ['urgent', 'asks'] }, { quietHours: { start: pad(hour), end: pad(hour + 3) } });
  cue.askHuman({ summary: 'Can this wait?' }, { via: 'api' });
  await cue.notifier!.idle();
  assert.equal(sent.length, 0, 'the ask waits for the morning');
  c.advance(61 * 60_000);
  cue.evaluate();
  await cue.notifier!.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.priority, 5);
});

test('details: false never sends titles or commands', async () => {
  const { cue, clock, sent } = setup({ ntfy: { topic: TOPIC }, on: ['urgent', 'asks'], details: false });
  cue.askHuman({ summary: 'Use the secret staging token sk-123?' }, { via: 'api' });
  clock.advance(61 * 60_000);
  cue.evaluate();
  await cue.notifier!.idle();
  assert.equal(sent.length, 2);
  for (const s of sent) {
    assert.doesNotMatch(JSON.stringify(s.body), /staging|sk-123/);
  }
});

test('a protected topic gets its token from the environment, and a self-hosted server works', async () => {
  const { cue, sent } = setup(
    { ntfy: { server: 'https://ntfy.example.org/', topic: 'qa', tokenEnv: 'NTFY_TOKEN' }, on: ['asks'] },
    {},
    { env: { NTFY_TOKEN: 'tk_abc' } },
  );
  cue.askHuman({ summary: 'x' }, { via: 'api' });
  await cue.notifier!.idle();
  assert.equal(sent[0]!.url, 'https://ntfy.example.org/');
  assert.equal(sent[0]!.headers.Authorization, 'Bearer tk_abc');
});

test('a failed send is retried, then logged, and never breaks Cue', async () => {
  const { cue, sent, logs, calls } = setup({ ntfy: { topic: TOPIC }, on: ['asks'] }, {}, { fail: true });
  assert.doesNotThrow(() => cue.askHuman({ summary: 'x' }, { via: 'api' }));
  await cue.notifier!.idle();
  assert.equal(sent.length, 0);
  assert.equal(calls(), 3);
  assert.match(logs.join('\n'), /alert not sent: getaddrinfo ENOTFOUND/);
});

test('a dropped request is retried and the alert still arrives', async () => {
  const { cue, sent, logs } = setup({ ntfy: { topic: TOPIC }, on: ['asks'] }, {}, { failFirst: 1 });
  cue.askHuman({ summary: 'x' }, { via: 'api' });
  await cue.notifier!.idle();
  assert.equal(sent.length, 1);
  assert.deepEqual(logs, []);
});

test('a refused send (bad token) is not retried', async () => {
  const { cue, logs, calls } = setup({ ntfy: { topic: TOPIC }, on: ['asks'] }, {}, { status: 403 });
  cue.askHuman({ summary: 'x' }, { via: 'api' });
  await cue.notifier!.idle();
  assert.equal(calls(), 1);
  assert.match(logs.join('\n'), /HTTP 403 \(check the topic token\)/);
});

test('a burst sends at most 6 alerts a minute, then one "more are waiting"', async () => {
  const { cue, clock, sent } = setup({ ntfy: { topic: TOPIC }, on: ['asks'] });
  for (let i = 0; i < 10; i++) cue.askHuman({ summary: `ask ${i}` }, { via: 'api' });
  await cue.notifier!.idle();
  assert.equal(sent.length, 7);
  assert.match(sent[6]!.body.message, /More alerts are waiting/);
  clock.advance(61_000);
  cue.askHuman({ summary: 'after the minute' }, { via: 'api' });
  await cue.notifier!.idle();
  assert.equal(sent.at(-1)!.body.message, 'after the minute');
});

test('notify config is checked: topic, server, values, and secrets kept out', () => {
  const problems = (notify: unknown) => {
    try {
      testConfig({ notify });
      return '';
    } catch (err) {
      return (err as Error).message;
    }
  };
  assert.equal(problems({ ntfy: { topic: TOPIC } }), '');
  assert.match(problems({ ntfy: {} }), /notify\.ntfy\.topic: required/);
  assert.match(problems({ on: ['urgent'] }), /notify\.ntfy: required/);
  assert.match(problems({ ntfy: { topic: 'alerts' } }), /at least 12 random characters/);
  assert.equal(problems({ ntfy: { server: 'http://192.168.1.5:8080', topic: 'alerts' } }), '', 'short topics are fine on your own server');
  assert.match(problems({ ntfy: { topic: 'my alerts here!' } }), /letters, digits/);
  assert.match(problems({ ntfy: { server: 'ntfy.sh', topic: TOPIC } }), /expected a URL/);
  assert.match(problems({ ntfy: { topic: TOPIC }, on: ['everything'] }), /unknown value everything/);
  assert.match(problems({ ntfy: { topic: TOPIC }, details: 'no' }), /expected true or false/);
  assert.match(problems({ ntfy: { topic: TOPIC, tokenEnv: 'sk-live-123' } }), /looks like a secret/);
  assert.match(problems({ ntfy: { topic: TOPIC }, colour: 'red' }), /unknown key/);
  assert.deepEqual(testConfig({ notify: { ntfy: { topic: TOPIC } } }).notify, {
    ntfy: { server: 'https://ntfy.sh', topic: TOPIC, tokenEnv: null },
    on: ['urgent'],
    details: true,
  });
});

test('no notify section, no notifier, nothing sent', () => {
  const cue = new Cue({ config: testConfig(), store: new Store(':memory:', fakeClock()), sources: [] });
  assert.equal(cue.notifier, null);
});

test('"cuedesk notify test" parses', () => {
  assert.equal(parseArgs(['notify', 'test', '--config', 'x.yaml']).command, 'notify-test');
  assert.throws(() => parseArgs(['notify', 'now']), /cuedesk notify test/);
});
