import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCue } from './helpers.ts';
import { UnknownResourceError } from '../src/store/index.ts';

const MIN = 60_000;
const resources = [
  { id: 'tablet-1', kind: 'device', label: 'Tablet 1' },
  { id: 'staging-config', kind: 'config' },
];

test('a second session is refused, and the refusal names the holder', () => {
  const { cue } = makeCue({ resources });
  const a = cue.claim('tablet-1', 'smoke run', 30, { via: 'api', session: 'android-lane' });
  assert.equal(a.ok, true);
  const b = cue.claim('tablet-1', 'video tests', 30, { via: 'api', session: 'ios-lane' });
  assert.equal(b.ok, false);
  if (!b.ok) {
    assert.equal(b.holder.sessionId, 'android-lane');
    assert.match(b.message, /^Refused: tablet-1 is held by android-lane for "smoke run"/);
  }
  const refused = cue.store.eventsSince(0).filter((e) => e.type === 'claim.refused');
  assert.equal(refused.length, 1);
});

test('the holder can renew; only the holder can release', () => {
  const { cue, clock } = makeCue({ resources });
  cue.claim('tablet-1', 'run', 10, { via: 'api', session: 'a' });
  clock.advance(8 * MIN);
  const renewed = cue.claim('tablet-1', 'run, part 2', 20, { via: 'api', session: 'a' });
  assert.equal(renewed.ok && renewed.renewed, true);
  assert.equal(renewed.ok && renewed.claim.expiresAt, clock() + 20 * MIN);

  const wrong = cue.release('tablet-1', { via: 'api', session: 'b' });
  assert.equal(wrong.ok, false);
  assert.match(!wrong.ok ? wrong.message : '', /held by a .*Only the holder can release it/);

  assert.equal(cue.release('tablet-1', { via: 'api', session: 'a' }).ok, true);
  assert.equal(cue.store.liveClaim('tablet-1'), null);
  assert.equal(cue.release('tablet-1', { via: 'api', session: 'a' }).ok, false, 'nothing left to release');
});

test('claims expire, and then another session can claim', () => {
  const { cue, clock, store } = makeCue({ resources });
  cue.claim('staging-config', 'flag change', 15, { via: 'api', session: 'a' });
  clock.advance(14 * MIN);
  assert.equal(cue.claim('staging-config', 'x', 5, { via: 'api', session: 'b' }).ok, false);
  clock.advance(2 * MIN);
  const b = cue.claim('staging-config', 'x', 5, { via: 'api', session: 'b' });
  assert.equal(b.ok, true);
  const expired = store.eventsSince(0).filter((e) => e.type === 'claim.expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0]!.ts, Date.parse('2026-10-20T09:15:00Z'), 'logged at the expiry time');
});

test('the human can release any claim from the UI', () => {
  const { cue } = makeCue({ resources });
  cue.claim('tablet-1', 'run', 60, { via: 'api', session: 'a' });
  const r = cue.release('tablet-1', { via: 'ui' });
  assert.equal(r.ok, true);
  const ev = cue.store.eventsSince(0).find((e) => e.type === 'claim.released')!;
  assert.match(ev.summary, /you released tablet-1 \(held by a\)/);
});

test('unknown resources are refused with the list of known ones', () => {
  const { cue } = makeCue({ resources });
  assert.throws(() => cue.claim('tablet-9', 'run', 5, { via: 'api', session: 'a' }), (err: unknown) => {
    assert.ok(err instanceof UnknownResourceError);
    assert.match(err.message, /unknown resource "tablet-9"\. Known resources: staging-config, tablet-1/);
    return true;
  });
});

test('a claim needs a named session', () => {
  const { cue } = makeCue({ resources });
  assert.throws(() => cue.claim('tablet-1', 'run', 5, { via: 'api' }), /name the session/);
});
