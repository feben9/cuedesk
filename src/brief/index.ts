import type { CueEvent, Store } from '../store/index.ts';
import { formatDuration, iso } from '../util/time.ts';
import { truncate } from '../util/misc.ts';

export interface BriefEvent {
  id: number;
  ts: string;
  type: string;
  summary: string;
  sessionId: string | null;
  sessionLabel: string | null;
  subjectType: string | null;
  subjectId: string | null;
}

export interface Brief {
  since: string;
  until: string;
  headline: string;
  highlights: string[];
  counts: Record<string, number>;
  openNow: { asks: number; signals: number; urgent: number };
  events: BriefEvent[];
  totalEvents: number;
}

const SCAN_LIMIT = 20_000;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Since you left" and the morning brief: a plain summary of the event log since a time. */
export function buildBrief(store: Store, since: number, opts: { limit?: number } = {}): Brief {
  const now = store.now();
  const limit = opts.limit ?? 300;
  const events = store.eventsSince(since, SCAN_LIMIT);
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const of = (type: string) => events.filter((e) => e.type === type);
  const n = (type: string) => counts[type] ?? 0;
  const highlights: string[] = [];

  // Asks
  const asked = n('ask.created');
  const answered = n('ask.answered');
  const dismissed = n('ask.dismissed');
  const openAsks = store.listAsks({ status: 'open' }).length;
  if (asked || answered || dismissed) {
    const parts = [`${plural(asked, 'new ask')}`];
    if (answered) parts.push(`${answered} answered`);
    if (dismissed) parts.push(`${dismissed} dismissed`);
    highlights.push(`Asks: ${parts.join(', ')}; ${openAsks} open now.`);
  }

  // Signals
  const fired = of('signal.fired');
  const urgentFired = fired.filter((e) => e.data?.severity === 'urgent');
  if (fired.length || n('signal.resolved')) {
    highlights.push(
      `Signals: ${fired.length} fired${urgentFired.length ? ` (${urgentFired.length} urgent)` : ''}, ${n('signal.resolved')} cleared.`,
    );
  }
  for (const e of urgentFired.slice(-3)) highlights.push(`Urgent: ${truncate(e.summary.replace(/^Urgent: /, ''), 140)}`);

  // Board
  const moved = of('item.moved');
  if (moved.length || n('item.new') || n('item.gone') || n('source.imported')) {
    const parts: string[] = [];
    if (moved.length) parts.push(plural(moved.length, 'move'));
    if (n('item.new')) parts.push(`${n('item.new')} new`);
    if (n('item.gone')) parts.push(`${n('item.gone')} closed or gone`);
    if (n('source.imported')) parts.push(`${n('source.imported')} source imported`);
    highlights.push(`Board: ${parts.join(', ')}.`);
    for (const e of moved.slice(-5)) highlights.push(`Moved: ${truncate(e.summary, 140)}`);
  }

  // Resources
  const refused = of('claim.refused');
  if (n('claim.granted') || n('claim.released') || n('claim.expired') || refused.length) {
    const parts = [`${n('claim.granted')} claimed`, `${n('claim.released')} released`];
    if (n('claim.expired')) parts.push(`${n('claim.expired')} expired`);
    if (refused.length) parts.push(`${refused.length} refused (collisions avoided)`);
    highlights.push(`Resources: ${parts.join(', ')}.`);
  }

  // Sessions
  if (n('session.started') || n('session.ended')) {
    highlights.push(`Sessions: ${n('session.started')} started, ${n('session.ended')} ended.`);
  }
  const progressBySession = new Map<string, CueEvent[]>();
  for (const e of of('progress')) {
    if (!e.sessionId) continue;
    progressBySession.set(e.sessionId, [...(progressBySession.get(e.sessionId) ?? []), e]);
  }
  for (const [sid, list] of progressBySession) {
    const last = list[list.length - 1]!;
    highlights.push(`${store.sessionLabel(sid)}: ${plural(list.length, 'update')}, last "${truncate(last.summary, 100)}" (${formatDuration(now - last.ts)} ago).`);
  }

  // Sources
  for (const e of of('source.error').slice(-3)) highlights.push(`Source problem: ${truncate(e.summary, 160)}`);

  const live = store.listSignals({ status: 'open' });
  const openNow = { asks: openAsks, signals: live.length, urgent: live.filter((s) => s.severity === 'urgent').length };
  const span = formatDuration(now - since);
  const headline =
    events.length === 0
      ? `Nothing happened in the last ${span}.`
      : `In the last ${span}: ${plural(asked, 'ask')}, ${plural(fired.length, 'signal')}, ${plural(moved.length, 'board move')}. Open now: ${plural(openNow.asks, 'ask')}, ${plural(openNow.signals, 'signal')}${openNow.urgent ? ` (${openNow.urgent} urgent)` : ''}.`;

  const labels = new Map<string, string>();
  const label = (id: string | null) => {
    if (!id) return null;
    if (!labels.has(id)) labels.set(id, store.sessionLabel(id));
    return labels.get(id)!;
  };
  return {
    since: iso(since)!,
    until: iso(now)!,
    headline,
    highlights,
    counts,
    openNow,
    events: events.slice(-limit).map((e) => ({
      id: e.id,
      ts: iso(e.ts)!,
      type: e.type,
      summary: e.summary,
      sessionId: e.sessionId,
      sessionLabel: label(e.sessionId),
      subjectType: e.subjectType,
      subjectId: e.subjectId,
    })),
    totalEvents: events.length,
  };
}
