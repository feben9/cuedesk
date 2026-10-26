// Presets are starting points. A config's own rules override preset rules with
// the same id; `disabled: true` turns a preset rule off.

import type { RawRule } from './types.ts';

export const TIERS = ['tagged', 'urgent', 'claimBlocking', 'rest'] as const;
export type Tier = (typeof TIERS)[number];

export interface Preset {
  description: string;
  rules: RawRule[];
  ranking: { order: Tier[]; tags: string[] };
}

export const DEFAULT_RANKING: Preset['ranking'] = { order: ['urgent', 'claimBlocking', 'tagged', 'rest'], tags: [] };

export const PRESETS: Record<string, Preset> = {
  'qa-lead': {
    description: 'Shared test devices, many sessions, a board with test columns. Dev questions come first.',
    rules: [
      { id: 'stale-active', when: { stage: 'active', idleHours: 24 }, severity: 'warn' },
      { id: 'stale-review', when: { stage: 'review', idleHours: 48 }, severity: 'warn' },
      { id: 'stale-blocked', when: { stage: 'blocked', idleHours: 24 }, severity: 'warn' },
      { id: 'silent-claim', when: { session: 'holdsClaim', silentMinutes: 30 }, severity: 'urgent' },
      { id: 'old-ask', when: { ask: 'open', ageHours: 2 }, severity: 'warn' },
    ],
    ranking: { order: ['tagged', 'urgent', 'claimBlocking', 'rest'], tags: ['dev'] },
  },
  'eng-manager': {
    description: 'Reviews and blockers matter most; sessions are fewer and run longer.',
    rules: [
      { id: 'stale-review', when: { stage: 'review', idleHours: 24 }, severity: 'warn' },
      { id: 'stale-blocked', when: { stage: 'blocked', idleHours: 24 }, severity: 'urgent' },
      { id: 'stale-active', when: { stage: 'active', idleHours: 72 }, severity: 'info' },
      { id: 'silent-claim', when: { session: 'holdsClaim', silentMinutes: 60 }, severity: 'warn' },
      { id: 'old-ask', when: { ask: 'open', ageHours: 4 }, severity: 'warn' },
    ],
    ranking: { order: ['urgent', 'tagged', 'claimBlocking', 'rest'], tags: ['blocker', 'review'] },
  },
  'solo-dev': {
    description: 'One person, a few agent sessions, a personal issue list. Keeps asks from going cold.',
    rules: [
      { id: 'old-ask', when: { ask: 'open', ageMinutes: 60 }, severity: 'warn' },
      { id: 'silent-claim', when: { session: 'holdsClaim', silentMinutes: 60 }, severity: 'warn' },
      { id: 'stale-active', when: { stage: 'active', idleHours: 72 }, severity: 'info' },
    ],
    ranking: DEFAULT_RANKING,
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);
