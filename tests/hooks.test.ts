import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCue, postJson } from './helpers.ts';
import { ingestClaudeHook } from '../src/ingest/hooks.ts';
import { HOOK_EVENTS, hooksSnippet, mergeHooks, writeHooks } from '../src/ingest/install.ts';
import { startServer } from '../src/server/index.ts';
import { CueError } from '../src/cue.ts';

const SID = '3fa2c1d0-7b1e-4e55-9a0c-2f1d8c9b4a11';
const common = { session_id: SID, transcript_path: '/home/me/.claude/projects/x/3fa2.jsonl', cwd: '/home/me/code/shop-app' };

test('SessionStart creates the session, labelled by folder and short id', () => {
  const { cue, store } = makeCue();
  const r = ingestClaudeHook(cue, { ...common, hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(r.sessionId, SID);
  const s = store.getSession(SID)!;
  assert.equal(s.label, 'shop-app · 3fa2c1');
  assert.equal(s.source, 'claude-code');
  assert.equal(s.cwd, '/home/me/code/shop-app');
  assert.equal(s.transcriptPath, common.transcript_path);
  assert.equal(s.state, 'working');
  assert.equal(store.eventsSince(0).filter((e) => e.type === 'session.started').length, 1);
});

test('Notification becomes an ask (permission prompts are approvals), without duplicates', () => {
  const { cue, store } = makeCue();
  const r1 = ingestClaudeHook(cue, { ...common, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  const ask = store.getAsk(r1.askId!)!;
  assert.equal(ask.kind, 'approve');
  assert.equal(ask.origin, 'hook');
  assert.equal(ask.sessionId, SID);
  assert.equal(store.getSession(SID)!.state, 'waiting');

  const r2 = ingestClaudeHook(cue, { ...common, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  assert.equal(r2.askId, r1.askId, 'same message, same open ask');

  const r3 = ingestClaudeHook(cue, { ...common, hook_event_name: 'Notification', message: 'Claude is waiting for your input' });
  assert.equal(store.getAsk(r3.askId!)!.kind, 'answer');
  assert.equal(store.listAsks({ status: 'open' }).length, 2);
  const entry = cue.whatsNext().needs.find((e) => e.id === r1.askId)!;
  assert.deepEqual(entry.actions, ['done', 'dismiss', 'snooze'], 'hook asks are answered in the terminal');
});

test('Stop closes the asks the session raised and marks it idle', () => {
  const { cue, store } = makeCue();
  ingestClaudeHook(cue, { ...common, hook_event_name: 'Notification', message: 'Claude is waiting for your input' });
  const r = ingestClaudeHook(cue, { ...common, hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(r.closedAsks, 1);
  assert.equal(store.listAsks({ status: 'open' }).length, 0);
  assert.equal(store.listAsks({ status: 'answered' })[0]!.answer, '(handled in the terminal)');
  assert.equal(store.getSession(SID)!.state, 'idle');
});

test('SessionEnd ends the session and releases its claims', () => {
  const { cue, store } = makeCue({ resources: [{ id: 'tablet-1' }] });
  ingestClaudeHook(cue, { ...common, hook_event_name: 'SessionStart' });
  assert.equal(cue.claim('tablet-1', 'run', 60, { via: 'mcp', session: SID }).ok, true);
  const r = ingestClaudeHook(cue, { ...common, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  assert.deepEqual(r.released, ['tablet-1']);
  assert.equal(store.liveClaim('tablet-1'), null);
  assert.equal(store.getSession(SID)!.state, 'ended');
  assert.match(store.eventsSince(0).at(-1)!.summary, /ended \(prompt_input_exit\); released tablet-1/);
});

test('other hook events count as a heartbeat; bad payloads are refused', () => {
  const { cue, clock, store } = makeCue();
  ingestClaudeHook(cue, { ...common, hook_event_name: 'SessionStart' });
  clock.advance(10 * 60_000);
  const r = ingestClaudeHook(cue, { ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.equal(r.ignored, true);
  assert.equal(store.getSession(SID)!.lastSeen, clock());
  assert.throws(() => ingestClaudeHook(cue, { hook_event_name: 'Stop' }), CueError);
  assert.throws(() => ingestClaudeHook(cue, [1, 2]), /JSON object/);
  assert.throws(() => ingestClaudeHook(cue, { session_id: SID }), /hook_event_name/);
});

test('POST /api/hooks/claude accepts what the curl hook sends', async (t) => {
  const { cue } = makeCue();
  const srv = await startServer(cue, { port: 0 });
  t.after(() => srv.close());
  const host = { Host: `127.0.0.1:${srv.port}` };
  const res = await postJson(srv.port, '/api/hooks/claude', { ...common, hook_event_name: 'Notification', message: 'Claude needs your permission to use Edit' }, host);
  assert.equal(res.status, 200);
  assert.ok(res.json().askId);
  const bad = await postJson(srv.port, '/api/hooks/claude', { hook_event_name: 'Stop' }, host);
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /session_id/);
});

test('hooks install: the snippet covers the four events and only prints', () => {
  const snippet = hooksSnippet(4520);
  assert.deepEqual(Object.keys(snippet.hooks), [...HOOK_EVENTS]);
  const cmd = snippet.hooks.Notification![0]!.hooks[0]!.command!;
  assert.match(cmd, /http:\/\/127\.0\.0\.1:4520\/api\/hooks\/claude/);
  assert.match(cmd, /\|\| true$/, 'a stopped Cue never blocks Claude Code');
});

test('hooks install: merging keeps existing settings and hooks, and is idempotent', () => {
  const existing = {
    model: 'some-model',
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] },
  };
  const first = mergeHooks(existing, 4520);
  assert.deepEqual(first.added, [...HOOK_EVENTS]);
  const s = first.settings as typeof existing & { hooks: Record<string, { hooks: { command: string }[] }[]> };
  assert.equal(s.model, 'some-model');
  assert.deepEqual(s.permissions, existing.permissions);
  assert.equal(s.hooks.Stop!.length, 2, 'the user Stop hook stays');
  assert.equal(s.hooks.Stop![0]!.hooks[0]!.command, 'say done');
  assert.ok(s.hooks.PreToolUse);
  assert.equal(existing.hooks.Stop.length, 1, 'input not mutated');

  const again = mergeHooks(first.settings, 4520);
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.unchanged, [...HOOK_EVENTS]);
  const moved = mergeHooks(first.settings, 4600);
  assert.deepEqual(moved.updated, [...HOOK_EVENTS]);
  assert.throws(() => mergeHooks([], 4520), /JSON object/);
});

test('hooks install --write: writes only the given file, with a backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-hooks-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ theme: 'dark' }));
  const r = writeHooks(file, 4520);
  assert.deepEqual(r.added, [...HOOK_EVENTS]);
  assert.equal(r.backup, `${file}.cuedesk-backup`);
  assert.deepEqual(JSON.parse(readFileSync(r.backup!, 'utf8')), { theme: 'dark' });
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.theme, 'dark');
  assert.equal(Object.keys(written.hooks).length, 4);
  const second = writeHooks(file, 4520);
  assert.equal(second.backup, null, 'no change, no rewrite');

  const fresh = join(dir, 'repo', '.claude', 'settings.json');
  assert.deepEqual(writeHooks(fresh, 4520).added, [...HOOK_EVENTS], 'creates a missing .claude folder');
  assert.equal(existsSync(`${fresh}.cuedesk-backup`), false, 'nothing to back up');
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  assert.throws(() => writeHooks(join(dir, 'broken.json'), 4520), /not valid JSON/);
});
