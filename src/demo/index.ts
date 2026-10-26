import { buildConfig, type CueConfig } from '../config/index.ts';
import type { Cue } from '../cue.ts';
import type { Source, SourceItem } from '../sources/types.ts';
import { DAY, HOUR, MINUTE } from '../util/time.ts';

// Everything here is fictional: a made-up web shop, made-up people, made-up tickets.

export const DEMO_SESSIONS = {
  checkout: 'checkout-tests',
  api: 'api-review',
  device: 'device-runner',
} as const;

export function demoConfig(port: number): CueConfig {
  return buildConfig({
    project: 'demo-shop',
    preset: 'qa-lead',
    port,
    db: ':memory:',
    resources: [
      { id: 'pixel-7', kind: 'device', label: 'Pixel 7 test phone' },
      { id: 'staging-env', kind: 'environment', label: 'Staging environment' },
    ],
  });
}

interface DemoTicket {
  id: string;
  title: string;
  status: string;
  stage: SourceItem['stage'];
  ago: number;
  assignee: string | null;
}

/** A fake tracker. Some tickets are going stale; a timer moves others along. */
export class DemoBoard implements Source {
  readonly name = 'demo-board';
  readonly type = 'demo';
  private items: SourceItem[];
  private step = 0;
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
    const t = now();
    const tickets: DemoTicket[] = [
      { id: 'DEMO-101', title: 'Checkout: coupon field accepts expired codes', status: 'In Progress', stage: 'active', ago: 3 * DAY + 2 * HOUR, assignee: 'Mia' },
      { id: 'DEMO-102', title: 'Search results flicker on slow networks', status: 'In Progress', stage: 'active', ago: 2 * HOUR, assignee: 'Leo' },
      { id: 'DEMO-103', title: 'Refund email shows the wrong currency', status: 'Ready for test', stage: 'review', ago: 2 * DAY + 4 * HOUR, assignee: null },
      { id: 'DEMO-104', title: 'Add dark mode to the settings page', status: 'To Do', stage: 'todo', ago: 5 * DAY, assignee: null },
      { id: 'DEMO-105', title: 'Login rate limit returns 500 instead of 429', status: 'Blocked', stage: 'blocked', ago: 30 * HOUR, assignee: 'Ana' },
      { id: 'DEMO-106', title: 'Order history pagination', status: 'Done', stage: 'done', ago: DAY, assignee: 'Leo' },
      { id: 'DEMO-107', title: 'Profile photo upload fails over 5 MB', status: 'In Testing', stage: 'active', ago: 26 * HOUR, assignee: 'you' },
      { id: 'DEMO-108', title: 'Cart badge count is off by one', status: 'Code Review', stage: 'review', ago: 3 * HOUR, assignee: 'Mia' },
      { id: 'DEMO-110', title: 'Fix the coupon expiry check', status: 'Code Review', stage: 'review', ago: HOUR, assignee: 'Sam' },
    ];
    this.items = tickets.map((x) => ({ id: x.id, title: x.title, status: x.status, stage: x.stage, url: null, assignee: x.assignee, updatedAt: t - x.ago }));
  }

  async fetchItems(): Promise<SourceItem[]> {
    return this.items.map((i) => ({ ...i }));
  }

  /** Moves the board along one step, so the UI shows changes as it runs. */
  advance(): void {
    const t = this.now();
    const move = (id: string, status: string, stage: SourceItem['stage']) => {
      const item = this.items.find((i) => i.id === id);
      if (item) Object.assign(item, { status, stage, updatedAt: t });
    };
    const steps = [
      () => move('DEMO-102', 'Code Review', 'review'),
      () => move('DEMO-108', 'Done', 'done'),
      () => this.items.push({ id: 'DEMO-111', title: 'Wishlist button overlaps the price on small screens', status: 'To Do', stage: 'todo', url: null, assignee: null, updatedAt: t }),
      () => move('DEMO-110', 'Ready for test', 'review'),
      () => move('DEMO-111', 'In Progress', 'active'),
      () => move('DEMO-102', 'Ready for test', 'review'),
    ];
    steps[this.step % steps.length]!();
    this.step++;
  }
}

/** Fills the store with a believable few hours of history. */
export function seedDemo(cue: Cue): void {
  const store = cue.store;
  const T = cue.now();
  const at = (msAgo: number) => T - msAgo;
  const { checkout, api, device } = DEMO_SESSIONS;

  store.touchSession({ id: checkout, label: checkout, source: 'demo', at: at(7 * HOUR + 40 * MINUTE), activity: 'Starting the checkout suite' });
  store.addEvent({ type: 'session.started', sessionId: checkout, summary: `${checkout} checked in`, ts: at(7 * HOUR + 40 * MINUTE) });
  store.touchSession({ id: api, label: api, source: 'demo', at: at(6 * HOUR), activity: 'Reviewing the refunds API' });
  store.addEvent({ type: 'session.started', sessionId: api, summary: `${api} checked in`, ts: at(6 * HOUR) });

  store.addEvent({ type: 'item.moved', subjectType: 'item', subjectId: 'demo-board:DEMO-106', summary: 'DEMO-106 Order history pagination: review → done (Done)', ts: at(5 * HOUR) });
  store.addEvent({ type: 'claim.granted', sessionId: checkout, subjectType: 'resource', subjectId: 'staging-env', summary: `${checkout} claimed staging-env: reset the coupon table`, ts: at(4 * HOUR + 10 * MINUTE) });
  store.addEvent({ type: 'claim.released', sessionId: checkout, subjectType: 'resource', subjectId: 'staging-env', summary: `${checkout} released staging-env`, ts: at(3 * HOUR + 30 * MINUTE) });

  const priced = store.createAsk({ summary: 'Use the EUR price list for the checkout tests?', kind: 'answer', sessionId: checkout, askedBy: checkout, origin: 'demo', createdAt: at(3 * HOUR + 20 * MINUTE) });
  store.addEvent({ type: 'ask.created', sessionId: checkout, subjectType: 'ask', subjectId: priced.id, summary: `${checkout} asked (answer): ${priced.summary}`, ts: at(3 * HOUR + 20 * MINUTE) });
  store.closeAsk(priced.id, 'answered', 'Yes, EUR. The GBP list is out of date.');
  store.addEvent({ type: 'ask.answered', sessionId: checkout, subjectType: 'ask', subjectId: priced.id, summary: `you answered ${checkout}: "Yes, EUR. The GBP list is out of date."`, ts: at(3 * HOUR) });

  const oldAsk = store.createAsk({
    summary: 'Which test account should the signup tests use?',
    details: 'The two seeded accounts both have saved cards. The signup tests need one without. Create a new one, or strip the cards from qa-buyer-2?',
    kind: 'answer',
    sessionId: checkout,
    askedBy: checkout,
    origin: 'demo',
    createdAt: at(2 * HOUR + 30 * MINUTE),
  });
  store.addEvent({ type: 'ask.created', sessionId: checkout, subjectType: 'ask', subjectId: oldAsk.id, summary: `${checkout} asked (answer): ${oldAsk.summary}`, ts: at(2 * HOUR + 30 * MINUTE) });

  // The silent session: it claimed the phone, asked for a tap, then went quiet.
  store.touchSession({ id: device, label: device, source: 'demo', at: at(80 * MINUTE), activity: 'Installing build 2.4.0 on pixel-7' });
  store.addEvent({ type: 'session.started', sessionId: device, summary: `${device} checked in`, ts: at(80 * MINUTE) });
  store.claimResource('pixel-7', device, 'Payment flows on the device', 240);
  store.db.prepare('UPDATE claims SET claimed_at = ?, expires_at = ? WHERE resource_id = ? AND released_at IS NULL').run(at(80 * MINUTE), at(80 * MINUTE) + 4 * HOUR, 'pixel-7');
  store.db.prepare("UPDATE events SET ts = ? WHERE type = 'claim.granted' AND subject_id = 'pixel-7'").run(at(79 * MINUTE));
  const tap = store.createAsk({
    summary: "Tap 'Allow' on the USB debugging prompt on pixel-7",
    details: 'The phone shows a USB debugging prompt after the reinstall. Tests cannot start until someone taps Allow on the device.',
    kind: 'action',
    sessionId: device,
    askedBy: device,
    origin: 'demo',
    createdAt: at(50 * MINUTE),
  });
  store.addEvent({ type: 'ask.created', sessionId: device, subjectType: 'ask', subjectId: tap.id, summary: `${device} asked (action): ${tap.summary}`, ts: at(50 * MINUTE) });
  store.addEvent({ type: 'progress', sessionId: device, summary: 'Installed build 2.4.0 (a1b2c3d) on pixel-7', ts: at(47 * MINUTE) });
  store.touchSession({ id: device, source: 'demo', at: at(47 * MINUTE), activity: 'Waiting for the USB debugging prompt' });
  store.setSessionState(device, 'waiting');

  const dev = store.createAsk({
    summary: 'Can you retest DEMO-103 on the new build?',
    details: 'Sam (dev): the currency fix is in build 2.4.0. Repro steps are on the ticket.',
    kind: 'action',
    askedBy: 'Sam (dev)',
    origin: 'demo',
    tags: ['dev'],
    createdAt: at(40 * MINUTE),
  });
  store.addEvent({ type: 'ask.created', subjectType: 'ask', subjectId: dev.id, summary: `Sam (dev) asked (action): ${dev.summary}`, ts: at(40 * MINUTE) });

  for (const [ago, text] of [
    [30 * MINUTE, 'Checkout suite: 8/40 passed'],
    [20 * MINUTE, 'Checkout suite: 14/40 passed, 1 failed (coupon expiry)'],
    [10 * MINUTE, 'Checkout suite: 21/40 passed, 1 failed'],
  ] as const) {
    store.addEvent({ type: 'progress', sessionId: checkout, summary: text, ts: at(ago) });
  }
  store.touchSession({ id: checkout, source: 'demo', at: at(10 * MINUTE), activity: 'Checkout suite: 21/40 passed, 1 failed' });

  const refund = store.createAsk({
    summary: 'Should the refund tests use the sandbox gateway or the mock?',
    details: 'The sandbox is slower (about 40 s per refund) but catches currency rounding. The mock runs the suite in 3 minutes.',
    kind: 'answer',
    sessionId: api,
    askedBy: api,
    origin: 'demo',
    dueMinutes: 30,
    createdAt: at(25 * MINUTE),
  });
  store.addEvent({ type: 'ask.created', sessionId: api, subjectType: 'ask', subjectId: refund.id, summary: `${api} asked (answer): ${refund.summary}`, ts: at(25 * MINUTE) });
  store.touchSession({ id: api, source: 'demo', at: at(4 * MINUTE), activity: 'Comparing sandbox and mock refund responses' });

  const approve = store.createAsk({
    summary: 'Delete 14 leftover test orders on staging?',
    details: 'Orders TEST-5501 to TEST-5514 were left by an earlier run and skew the order-count checks.',
    kind: 'approve',
    sessionId: checkout,
    askedBy: checkout,
    origin: 'demo',
    createdAt: at(5 * MINUTE),
  });
  store.addEvent({ type: 'ask.created', sessionId: checkout, subjectType: 'ask', subjectId: approve.id, summary: `${checkout} asked (approve): ${approve.summary}`, ts: at(5 * MINUTE) });
  store.setSessionState(checkout, 'waiting');
  store.setSessionState(api, 'waiting');
}

const NEW_ASKS: { session: string; summary: string; kind: 'answer' | 'approve' | 'action'; details?: string; dueMinutes?: number }[] = [
  { session: DEMO_SESSIONS.api, summary: 'The refunds API returns 200 on a duplicate refund. Is that expected?', kind: 'answer', details: 'Second POST /refunds with the same order id returns 200 and no new refund. A 409 would be clearer.' },
  { session: DEMO_SESSIONS.checkout, summary: 'Re-run the 2 failed checkout tests on a clean cart?', kind: 'approve' },
  { session: DEMO_SESSIONS.checkout, summary: 'Coupon test expects "Expired"; the page says "Coupon expired". Which is right?', kind: 'answer', dueMinutes: 20 },
  { session: DEMO_SESSIONS.api, summary: 'Approve filing a bug for the 200-on-duplicate-refund behaviour?', kind: 'approve' },
  { session: DEMO_SESSIONS.checkout, summary: 'Turn on the "new checkout" flag on staging for the next run?', kind: 'approve' },
];

const API_STEPS = ['Reading the refund API spec', 'Comparing sandbox and mock refund responses', 'Checking currency rounding on partial refunds', 'Writing up the refund edge cases'];

/** Keeps the demo alive: heartbeats, new asks and board moves on timers. Returns a stop function. */
export function runDemo(cue: Cue, board: DemoBoard, opts: { speed?: number } = {}): () => void {
  const speed = opts.speed ?? 1;
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => void) => {
    const t = setInterval(() => {
      try {
        fn();
      } catch {
        // The demo never takes the server down.
      }
    }, ms / speed);
    t.unref();
    timers.push(t);
  };
  let passed = 21;
  let failed = 1;
  every(15_000, () => {
    passed += 1 + Math.floor(Math.random() * 2);
    if (Math.random() < 0.15) failed++;
    if (passed + failed >= 40) {
      cue.reportProgress(`Checkout suite finished: ${40 - failed} passed, ${failed} failed`, undefined, { via: 'demo', session: DEMO_SESSIONS.checkout });
      passed = 0;
      failed = 0;
      return;
    }
    cue.reportProgress(`Checkout suite: ${passed}/40 passed${failed ? `, ${failed} failed` : ''}`, undefined, { via: 'demo', session: DEMO_SESSIONS.checkout });
  });
  let apiStep = 0;
  every(25_000, () => {
    cue.reportProgress(API_STEPS[apiStep++ % API_STEPS.length]!, 'DEMO-103', { via: 'demo', session: DEMO_SESSIONS.api });
  });
  let next = 0;
  every(70_000, () => {
    if (next >= NEW_ASKS.length || cue.store.listAsks({ status: 'open' }).length >= 9) return;
    const a = NEW_ASKS[next++]!;
    cue.askHuman({ summary: a.summary, kind: a.kind, details: a.details, dueMinutes: a.dueMinutes }, { via: 'demo', session: a.session });
  });
  every(50_000, () => {
    board.advance();
    void cue.syncAll().then(() => cue.evaluate());
  });
  return () => timers.forEach((t) => clearInterval(t));
}
