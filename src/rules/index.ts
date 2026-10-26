import type { Rule } from '../config/types.ts';
import type { Severity, Signal, Store } from '../store/index.ts';
import { formatDuration } from '../util/time.ts';
import { truncate } from '../util/misc.ts';

interface Candidate {
  key: string;
  ruleId: string;
  subjectType: Signal['subjectType'];
  subjectId: string;
  severity: Severity;
  title: string;
  detail: string | null;
  link: string | null;
  source: string;
}

export interface RulesResult {
  fired: Signal[];
  resolved: Signal[];
  live: number;
}

/** Works out which rule conditions hold right now. Pure read; no writes. */
export function candidates(store: Store, rules: Rule[]): Map<string, Candidate> {
  const now = store.now();
  const out = new Map<string, Candidate>();
  const items = rules.some((r) => r.kind === 'item') ? store.listItems() : [];
  const sessions = rules.some((r) => r.kind === 'session') ? store.listSessions() : [];
  const asks = rules.some((r) => r.kind === 'ask') ? store.listAsks({ status: 'open' }) : [];
  const claims = rules.some((r) => r.kind === 'session') ? store.liveClaims() : [];

  for (const rule of rules) {
    if (rule.kind === 'item') {
      for (const item of items) {
        if (!rule.stages.includes(item.stage)) continue;
        if (rule.source && item.source !== rule.source) continue;
        const idle = now - item.updatedAt;
        if (idle < rule.idleMs) continue;
        const key = `${rule.id}:item:${item.source}:${item.id}`;
        out.set(key, {
          key,
          ruleId: rule.id,
          subjectType: 'item',
          subjectId: `${item.source}:${item.id}`,
          severity: rule.severity,
          title: `${item.id} "${truncate(item.title, 90)}" has had no update in ${item.stage} for ${formatDuration(idle)}`,
          detail: `${item.source} · status "${item.status}"${item.assignee ? ` · ${item.assignee}` : ''}`,
          link: item.url,
          source: item.source,
        });
      }
    } else if (rule.kind === 'session') {
      for (const s of sessions) {
        const held = claims.filter((c) => c.sessionId === s.id);
        if (rule.mode === 'holdsClaim' && held.length === 0) continue;
        // A session waiting at a prompt is quiet on purpose; only a claim makes its silence costly.
        if (rule.mode === 'any' && s.state !== 'working') continue;
        const silent = now - s.lastSeen;
        if (silent < rule.silentMs) continue;
        const key = `${rule.id}:session:${s.id}`;
        const what = held.map((c) => c.resourceId).join(', ');
        out.set(key, {
          key,
          ruleId: rule.id,
          subjectType: 'session',
          subjectId: s.id,
          severity: rule.severity,
          title: held.length
            ? `${s.label} has been silent for ${formatDuration(silent)} while holding ${what}`
            : `${s.label} has been silent for ${formatDuration(silent)}`,
          detail: held.length ? held.map((c) => `${c.resourceId}: ${c.reason}`).join(' · ') : s.activity,
          link: null,
          source: 'sessions',
        });
      }
    } else {
      for (const a of asks) {
        if (a.snoozedUntil && a.snoozedUntil > now) continue;
        const age = now - a.createdAt;
        if (age < rule.ageMs) continue;
        const key = `${rule.id}:ask:${a.id}`;
        out.set(key, {
          key,
          ruleId: rule.id,
          subjectType: 'ask',
          subjectId: a.id,
          severity: rule.severity,
          title: `Ask from ${a.askedBy} open for ${formatDuration(age)}: ${truncate(a.summary, 90)}`,
          detail: null,
          link: null,
          source: 'asks',
        });
      }
    }
  }
  return out;
}

/**
 * Evaluates every rule. New conditions open a signal (one per rule and
 * subject); conditions that cleared resolve theirs. Dismissed signals stay
 * quiet until their condition clears, so they can fire again later.
 */
export function evaluateRules(store: Store, rules: Rule[]): RulesResult {
  store.expireClaims();
  const found = candidates(store, rules);
  const fired: Signal[] = [];
  const resolved: Signal[] = [];
  store.tx(() => {
    for (const live of store.listSignals({ status: 'live' })) {
      const c = found.get(live.key);
      if (c) {
        store.refreshSignal(live.id, c);
        found.delete(live.key);
      } else {
        store.resolveSignal(live.id);
        resolved.push(live);
        store.addEvent({
          type: 'signal.resolved',
          subjectType: live.subjectType,
          subjectId: live.subjectId,
          summary: `Cleared: ${live.title}`,
          data: { signalId: live.id, ruleId: live.ruleId },
        });
      }
    }
    for (const c of found.values()) {
      const s = store.insertSignal(c);
      fired.push(s);
      store.addEvent({
        type: 'signal.fired',
        subjectType: c.subjectType,
        subjectId: c.subjectId,
        summary: `${c.severity === 'urgent' ? 'Urgent: ' : ''}${c.title}`,
        data: { signalId: s.id, ruleId: c.ruleId, severity: c.severity },
      });
    }
  });
  return { fired, resolved, live: store.listSignals({ status: 'live' }).length };
}
