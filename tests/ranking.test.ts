import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCue } from './helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

function setup(raw: Record<string, unknown> = {}) {
  const ctx = makeCue({
    resources: [{ id: 'tablet-1' }],
    rules: [
      { id: 'silent-claim', when: { session: 'holdsClaim', silentMinutes: 30 }, severity: 'urgent' },
      { id: 'stale', when: { stage: 'active', idleHours: 24 }, severity: 'warn' },
    ],
    ...raw,
  });
  const { cue, clock, store } = ctx;
  // Oldest first: a plain ask, a dev-tagged ask, an ask with a due time, an ask from a claim holder.
  const plain = cue.askHuman({ summary: 'plain question' }, { via: 'api', session: 'writer' });
  clock.advance(5 * MIN);
  const dev = cue.askHuman({ summary: 'dev question', tags: ['dev'], askedBy: 'Sam (dev)' }, { via: 'api' });
  clock.advance(5 * MIN);
  const due = cue.askHuman({ summary: 'due soon', dueMinutes: 10 }, { via: 'api', session: 'reviewer' });
  clock.advance(5 * MIN);
  cue.claim('tablet-1', 'run', 240, { via: 'api', session: 'runner' });
  const blocking = cue.askHuman({ summary: 'tap allow', kind: 'action' }, { via: 'api', session: 'runner' });
  store.syncItems('board', [{ id: 'B-1', title: 'stale ticket', status: 'In Progress', stage: 'active', url: null, assignee: null, updatedAt: clock() - 30 * HOUR }]);
  return { ...ctx, plain, dev, due, blocking };
}

test('default order: urgent and overdue first, then claim-blocking asks, then the rest by age', () => {
  const { cue, clock } = setup();
  clock.advance(31 * MIN); // "due soon" is overdue; runner is silent while holding tablet-1
  cue.evaluate();
  const wn = cue.whatsNext();
  const order = wn.needs.map((e) => (e.type === 'ask' ? e.title : `signal:${e.ruleId}`));
  assert.deepEqual(order, ['due soon', 'signal:silent-claim', 'tap allow', 'plain question', 'dev question', 'signal:stale']);
  assert.equal(wn.needs[0]!.tier, 'urgent');
  assert.equal(wn.needs[0]!.overdue, true);
  assert.match(wn.needs[0]!.why, /overdue by/);
  assert.equal(wn.needs[2]!.tier, 'claimBlocking');
  assert.match(wn.needs[2]!.why, /runner is waiting and holds tablet-1/);
  // Without "dev" in the ranking tags, the dev ask is ordered by age like the rest.
  assert.equal(wn.needs[4]!.tier, 'rest');
  assert.equal(wn.counts.urgent, 2);
  assert.ok(wn.priorities[0]!.startsWith('1. Answer reviewer: due soon'));
});

test('the qa-lead preset puts dev questions first', () => {
  const { cue, clock } = setup({ preset: 'qa-lead' });
  clock.advance(31 * MIN);
  cue.evaluate();
  const first = cue.whatsNext().needs[0]!;
  assert.equal(first.title, 'dev question');
  assert.equal(first.tier, 'tagged');
});

test('snoozed entries leave the list until the snooze ends', () => {
  const { cue, clock, plain } = setup();
  cue.snoozeAsk(plain.id, 60);
  let wn = cue.whatsNext();
  assert.equal(wn.needs.some((e) => e.id === plain.id), false);
  assert.equal(wn.counts.snoozed, 1);
  clock.advance(61 * MIN);
  wn = cue.whatsNext();
  assert.equal(wn.needs.some((e) => e.id === plain.id), true);
});

test('a rule signal about an ask is folded into the ask card', () => {
  const { cue, clock } = makeCue({ rules: [{ id: 'old-ask', when: { ask: 'open', ageMinutes: 30 }, severity: 'urgent' }] });
  const a = cue.askHuman({ summary: 'still waiting' }, { via: 'api' });
  clock.advance(31 * MIN);
  cue.evaluate();
  const wn = cue.whatsNext();
  assert.equal(wn.needs.length, 1);
  assert.equal(wn.needs[0]!.id, a.id);
  assert.equal(wn.needs[0]!.flags!.length, 1);
  assert.equal(wn.needs[0]!.severity, 'urgent');
  assert.equal(wn.needs[0]!.tier, 'urgent');
});

test('quiet hours hold non-urgent signals but keep asks and urgent ones', () => {
  // 09:00Z start; quiet hours computed in local time, so cover the whole day.
  const { cue, clock } = setup({ quietHours: { start: '00:00', end: '23:59' } });
  clock.advance(31 * MIN);
  cue.evaluate();
  const wn = cue.whatsNext();
  assert.equal(wn.quietHours, true);
  assert.ok(wn.needs.every((e) => e.type === 'ask' || e.severity === 'urgent'));
  assert.deepEqual(wn.held.map((e) => e.ruleId), ['stale']);
});
