import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cue } from '../src/cue.ts';
import { DemoBoard, demoConfig, runDemo, seedDemo } from '../src/demo/index.ts';
import { buildBrief } from '../src/brief/index.ts';

test('demo mode shows every feature right away', async () => {
  const board = new DemoBoard(() => Date.now());
  const cue = new Cue({ config: demoConfig(0), sources: [board] });
  seedDemo(cue);
  await cue.syncAll();
  cue.evaluate();

  const sessions = cue.listSessions();
  assert.deepEqual(sessions.map((s) => s.label).sort(), ['api-review', 'checkout-tests', 'device-runner']);
  const resources = cue.listResources();
  assert.equal(resources.length, 2);
  assert.equal(resources.find((r) => r.id === 'pixel-7')!.holder!.label, 'device-runner');
  assert.equal(resources.find((r) => r.id === 'staging-env')!.holder, null);

  const wn = cue.whatsNext();
  assert.equal(wn.needs[0]!.tags![0], 'dev', 'qa-lead preset: dev questions first');
  const silent = wn.needs.find((e) => e.type === 'signal' && e.ruleId === 'silent-claim');
  assert.ok(silent, 'the silent session holding a claim is flagged');
  assert.equal(silent!.severity, 'urgent');
  assert.ok(wn.needs.some((e) => e.tier === 'claimBlocking'), 'an ask blocks a session that holds a claim');
  assert.ok(wn.needs.some((e) => e.kind === 'approve'), 'an approval card');

  const stale = cue.board().filter((i) => i.stale).map((i) => i.id).sort();
  assert.deepEqual(stale, ['DEMO-101', 'DEMO-103', 'DEMO-105', 'DEMO-107']);

  const brief = buildBrief(cue.store, Date.now() - 8 * 3600_000);
  assert.ok(brief.highlights.length >= 5);

  // Timers: heartbeats, new asks and board moves keep coming.
  const before = cue.store.eventsSince(0).length;
  const stop = runDemo(cue, board, { speed: 500 });
  await new Promise((r) => setTimeout(r, 400));
  stop();
  await cue.syncAll();
  assert.ok(cue.store.eventsSince(0).length > before + 5);
  assert.ok(cue.store.eventsSince(0).some((e) => e.type === 'item.moved' && e.summary.startsWith('DEMO-102')));
  await cue.stop();
  cue.store.close();
});
