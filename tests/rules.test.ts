import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCue } from './helpers.ts';

const HOUR = 3600_000;
const MIN = 60_000;

function item(id: string, stage: 'todo' | 'active' | 'review' | 'blocked' | 'done', updatedAt: number) {
  return { id, title: `Ticket ${id}`, status: stage, stage, url: `https://tracker.example/${id}`, assignee: null, updatedAt };
}

test('item idle rule fires once, stays de-duplicated, and resolves when the item moves', () => {
  const { cue, clock, store } = makeCue({ rules: [{ id: 'stale-active', when: { stage: 'active', idleHours: 24 }, severity: 'warn' }] });
  const t0 = clock();
  store.syncItems('board', [item('A-1', 'active', t0 - 25 * HOUR), item('A-2', 'active', t0 - 2 * HOUR), item('A-3', 'todo', t0 - 99 * HOUR)]);

  let r = cue.evaluate();
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0]!.subjectId, 'board:A-1');
  assert.match(r.fired[0]!.title, /A-1 .* no update in active for 1d 1h/);
  assert.equal(r.fired[0]!.link, 'https://tracker.example/A-1');

  // Evaluating again changes nothing: one live signal per rule and subject.
  r = cue.evaluate();
  assert.equal(r.fired.length, 0);
  clock.advance(HOUR);
  r = cue.evaluate();
  assert.equal(r.fired.length, 0);
  assert.equal(store.listSignals({ status: 'live' }).length, 1);
  assert.match(store.listSignals({ status: 'live' })[0]!.title, /1d 2h/, 'title keeps the idle time current');

  // A-2 crosses the threshold later.
  clock.advance(22 * HOUR);
  r = cue.evaluate();
  assert.deepEqual(r.fired.map((s) => s.subjectId), ['board:A-2']);

  // A-1 gets an update: its signal resolves.
  store.syncItems('board', [item('A-1', 'review', clock()), item('A-2', 'active', t0 - 2 * HOUR), item('A-3', 'todo', t0 - 99 * HOUR)]);
  r = cue.evaluate();
  assert.deepEqual(r.resolved.map((s) => s.subjectId), ['board:A-1']);
  assert.equal(store.listSignals({ status: 'live' }).length, 1);

  const types = store.eventsSince(0).map((e) => e.type);
  assert.equal(types.filter((t) => t === 'signal.fired').length, 2);
  assert.equal(types.filter((t) => t === 'signal.resolved').length, 1);
});

test('a dismissed signal stays quiet while its condition holds, and can fire again after it clears', () => {
  const { cue, clock, store } = makeCue({ rules: [{ id: 'stale', when: { stage: 'blocked', idleMinutes: 60 } }] });
  store.syncItems('b', [item('X', 'blocked', clock() - 2 * HOUR)]);
  const [sig] = cue.evaluate().fired;
  cue.dismissSignal(sig!.id);
  clock.advance(HOUR);
  assert.equal(cue.evaluate().fired.length, 0, 'no re-fire while dismissed');
  assert.equal(cue.whatsNext().needs.length, 0, 'dismissed signals leave Needs you');

  store.syncItems('b', [item('X', 'blocked', clock())]);
  assert.equal(cue.evaluate().resolved.length, 1);
  clock.advance(2 * HOUR);
  assert.equal(cue.evaluate().fired.length, 1, 'fires again once the condition returns');
});

test('gone items do not keep signals alive', () => {
  const { cue, clock, store } = makeCue({ rules: [{ id: 'stale', when: { stage: 'active', idleHours: 1 } }] });
  store.syncItems('b', [item('G', 'active', clock() - 5 * HOUR)]);
  assert.equal(cue.evaluate().fired.length, 1);
  store.syncItems('b', []);
  assert.equal(cue.evaluate().resolved.length, 1);
});

test('session silent while holding a claim fires, and clears on a heartbeat or release', () => {
  const { cue, clock, store } = makeCue({
    resources: [{ id: 'tablet-1', kind: 'device' }],
    rules: [{ id: 'silent-claim', when: { session: 'holdsClaim', silentMinutes: 30 }, severity: 'urgent' }],
  });
  cue.claim('tablet-1', 'regression run', 240, { via: 'api', session: 'runner' });
  cue.reportProgress('started', undefined, { via: 'api', session: 'idle-one' }); // no claim: never fires
  clock.advance(31 * MIN);
  let r = cue.evaluate();
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0]!.severity, 'urgent');
  assert.match(r.fired[0]!.title, /runner has been silent for 31m while holding tablet-1/);

  cue.reportProgress('still going', undefined, { via: 'api', session: 'runner' });
  r = cue.evaluate();
  assert.equal(r.resolved.length, 1, 'a heartbeat clears it');

  clock.advance(45 * MIN);
  assert.equal(cue.evaluate().fired.length, 1);
  cue.release('tablet-1', { via: 'api', session: 'runner' });
  assert.equal(store.listSignals({ status: 'live' }).length, 0, 'release clears it');
});

test('ask age rule fires for old open asks, ignores snoozed ones, and resolves on answer', () => {
  const { cue, clock, store } = makeCue({ rules: [{ id: 'old-ask', when: { ask: 'open', ageHours: 2 }, severity: 'warn' }] });
  const a = cue.askHuman({ summary: 'Which account?' }, { via: 'api', session: 's1' });
  const b = cue.askHuman({ summary: 'Which build?' }, { via: 'api', session: 's2' });
  cue.snoozeAsk(b.id, 300);
  clock.advance(2 * HOUR + MIN);
  const r = cue.evaluate();
  assert.deepEqual(r.fired.map((s) => s.subjectId), [a.id]);
  cue.answerAsk(a.id, 'qa-buyer-2');
  assert.equal(store.listSignals({ status: 'live' }).length, 0);
});

test('signals for a removed rule resolve', () => {
  const { cue, clock, store } = makeCue({ rules: [{ id: 'old-ask', when: { ask: 'open', ageMinutes: 5 } }] });
  cue.askHuman({ summary: 'x' }, { via: 'api' });
  clock.advance(10 * MIN);
  cue.evaluate();
  assert.equal(store.listSignals({ status: 'live' }).length, 1);
  (cue.config as { rules: unknown[] }).rules = [];
  cue.evaluate();
  assert.equal(store.listSignals({ status: 'live' }).length, 0);
});
