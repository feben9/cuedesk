import type { CueConfig, Tier } from '../config/index.ts';
import type { Ask, AskKind, Severity, Signal, Store } from '../store/index.ts';
import { formatDuration, inQuietHours, iso } from '../util/time.ts';
import { truncate } from '../util/misc.ts';

export interface NeedEntry {
  type: 'ask' | 'signal';
  id: string;
  tier: Tier;
  severity: Severity;
  title: string;
  detail: string | null;
  /** Why the entry sits where it does, in plain words. */
  why: string;
  createdAt: string;
  ageMs: number;
  link: string | null;
  actions: string[];
  // Asks only
  kind?: AskKind;
  askedBy?: string;
  origin?: string;
  sessionId?: string | null;
  sessionLabel?: string | null;
  dueAt?: string | null;
  overdue?: boolean;
  tags?: string[];
  /** Rule signals about this ask (e.g. "open for 2h"), folded into its card. */
  flags?: { id: string; severity: Severity; title: string }[];
  // Signals only
  ruleId?: string;
  subjectType?: string;
  subjectId?: string;
}

export interface WhatsNext {
  generatedAt: string;
  quietHours: boolean;
  needs: NeedEntry[];
  /** Non-urgent signals held back during quiet hours; they wait for the brief. */
  held: NeedEntry[];
  priorities: string[];
  counts: { asks: number; signals: number; urgent: number; snoozed: number; held: number };
}

const SEVERITY_RANK: Record<Severity, number> = { urgent: 0, warn: 1, info: 2 };

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

function askActions(a: Ask): string[] {
  if (a.origin === 'hook') return ['done', 'dismiss', 'snooze'];
  if (a.kind === 'approve') return ['approve', 'reject', 'dismiss', 'snooze'];
  if (a.kind === 'action') return ['done', 'dismiss', 'snooze'];
  return ['answer', 'done', 'dismiss', 'snooze'];
}

/**
 * Orders everything that needs the human. Tiers come from config (presets
 * reorder them); inside a tier, more severe first, then oldest first.
 *   urgent        urgent signals and overdue asks
 *   claimBlocking asks from a session that holds a claim (a resource sits idle)
 *   tagged        asks carrying a tag the ranking names (e.g. "dev")
 *   rest          everything else
 */
export function whatsNext(store: Store, config: Pick<CueConfig, 'ranking' | 'quietHours'>): WhatsNext {
  const now = store.now();
  const order = config.ranking.order;
  const tagSet = new Set(config.ranking.tags.map((t) => t.toLowerCase()));
  const holders = new Map<string, string[]>();
  for (const c of store.liveClaims()) holders.set(c.sessionId, [...(holders.get(c.sessionId) ?? []), c.resourceId]);

  let snoozed = 0;
  const entries: NeedEntry[] = [];
  const askEntries = new Map<string, NeedEntry>();

  for (const a of store.listAsks({ status: 'open' })) {
    if (a.snoozedUntil && a.snoozedUntil > now) {
      snoozed++;
      continue;
    }
    const overdue = a.dueAt !== null && a.dueAt <= now;
    const label = a.sessionId ? store.sessionLabel(a.sessionId) : null;
    const held = a.sessionId ? holders.get(a.sessionId) : undefined;
    const tagged = a.tags.some((t) => tagSet.has(t.toLowerCase()));
    const qualifies: Partial<Record<Tier, string>> = { rest: `waiting ${formatDuration(now - a.createdAt)}` };
    if (overdue) qualifies.urgent = `overdue by ${formatDuration(now - a.dueAt!)}`;
    if (held?.length) qualifies.claimBlocking = `${label} is waiting and holds ${held.join(', ')}`;
    if (tagged) qualifies.tagged = `tagged ${a.tags.filter((t) => tagSet.has(t.toLowerCase())).join(', ')}`;
    const tier = order.find((t) => qualifies[t]) ?? 'rest';
    const entry: NeedEntry = {
      type: 'ask',
      id: a.id,
      tier,
      severity: overdue ? 'urgent' : 'warn',
      title: a.summary,
      detail: a.details,
      why: qualifies[tier]!,
      createdAt: iso(a.createdAt)!,
      ageMs: now - a.createdAt,
      link: null,
      actions: askActions(a),
      kind: a.kind,
      askedBy: a.askedBy,
      origin: a.origin,
      sessionId: a.sessionId,
      sessionLabel: label,
      dueAt: iso(a.dueAt),
      overdue,
      tags: a.tags,
      flags: [],
    };
    askEntries.set(a.id, entry);
    entries.push(entry);
  }

  const signals: Signal[] = store.listSignals({ status: 'open' });
  for (const s of signals) {
    if (s.snoozedUntil && s.snoozedUntil > now) {
      snoozed++;
      continue;
    }
    // A rule about an open ask is shown on the ask's own card.
    const askEntry = s.subjectType === 'ask' ? askEntries.get(s.subjectId) : undefined;
    if (askEntry) {
      askEntry.flags!.push({ id: s.id, severity: s.severity, title: `Open for ${formatDuration(askEntry.ageMs)}, past the "${s.ruleId}" limit` });
      askEntry.severity = maxSeverity(askEntry.severity, s.severity);
      if (s.severity === 'urgent' && order.indexOf('urgent') < order.indexOf(askEntry.tier)) {
        askEntry.tier = 'urgent';
        askEntry.why = `flagged urgent by rule ${s.ruleId}`;
      }
      continue;
    }
    entries.push({
      type: 'signal',
      id: s.id,
      tier: s.severity === 'urgent' ? 'urgent' : 'rest',
      severity: s.severity,
      title: s.title,
      detail: s.detail,
      why: `rule ${s.ruleId}`,
      createdAt: iso(s.createdAt)!,
      ageMs: now - s.createdAt,
      link: s.link,
      actions: s.link ? ['open', 'dismiss', 'snooze'] : ['dismiss', 'snooze'],
      ruleId: s.ruleId,
      subjectType: s.subjectType,
      subjectId: s.subjectId,
    });
  }

  entries.sort(
    (a, b) =>
      order.indexOf(a.tier) - order.indexOf(b.tier) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.ageMs - a.ageMs ||
      a.id.localeCompare(b.id),
  );

  const quiet = inQuietHours(config.quietHours ?? undefined, now);
  const needs = quiet ? entries.filter((e) => e.type === 'ask' || e.severity === 'urgent') : entries;
  const held = quiet ? entries.filter((e) => e.type === 'signal' && e.severity !== 'urgent') : [];

  return {
    generatedAt: iso(now)!,
    quietHours: quiet,
    needs,
    held,
    priorities: priorities(store, needs),
    counts: {
      asks: needs.filter((e) => e.type === 'ask').length,
      signals: needs.filter((e) => e.type === 'signal').length,
      urgent: needs.filter((e) => e.severity === 'urgent').length,
      snoozed,
      held: held.length,
    },
  };
}

function priorities(store: Store, needs: NeedEntry[]): string[] {
  const lines = needs.slice(0, 5).map((e, i) => {
    const n = `${i + 1}.`;
    if (e.type === 'signal') return `${n} ${e.title}`;
    const who = e.sessionLabel ?? e.askedBy ?? 'someone';
    const what = truncate(e.title, 100);
    if (e.origin === 'hook') return `${n} ${who} is waiting in its terminal: ${what}`;
    if (e.kind === 'approve') return `${n} Approve or reject for ${who}: ${what}`;
    if (e.kind === 'action') return `${n} Do for ${who}: ${what}`;
    return `${n} Answer ${who}: ${what}`;
  });
  if (needs.length > 5) lines.push(`…and ${needs.length - 5} more.`);
  const active = store.listItems({ stage: 'active' }).length;
  const review = store.listItems({ stage: 'review' }).length;
  const blocked = store.listItems({ stage: 'blocked' }).length;
  if (active + review + blocked > 0) lines.push(`Board: ${active} active, ${review} in review, ${blocked} blocked.`);
  if (lines.length === 0) lines.push('Nothing needs you right now.');
  return lines;
}
