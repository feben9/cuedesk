export const STAGES = ['todo', 'active', 'review', 'blocked', 'done'] as const;
export type Stage = (typeof STAGES)[number];

export const ASK_KINDS = ['answer', 'approve', 'action'] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export const SEVERITIES = ['info', 'warn', 'urgent'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type SessionState = 'working' | 'waiting' | 'idle' | 'ended';
export type AskStatus = 'open' | 'answered' | 'dismissed';
export type SignalStatus = 'open' | 'dismissed' | 'resolved';

export interface Session {
  id: string;
  label: string;
  source: string;
  cwd: string | null;
  transcriptPath: string | null;
  state: SessionState;
  activity: string | null;
  firstSeen: number;
  lastSeen: number;
}

export interface Ask {
  id: string;
  sessionId: string | null;
  kind: AskKind;
  summary: string;
  details: string | null;
  askedBy: string;
  origin: string; // 'mcp' | 'api' | 'hook' | 'demo'
  tags: string[];
  createdAt: number;
  dueAt: number | null;
  status: AskStatus;
  answer: string | null;
  answeredAt: number | null;
  snoozedUntil: number | null;
}

export interface Item {
  source: string;
  id: string;
  title: string;
  status: string;
  stage: Stage;
  url: string | null;
  assignee: string | null;
  updatedAt: number;
  stageSince: number;
  firstSeen: number;
  lastSynced: number;
  gone: boolean;
}

export interface Resource {
  id: string;
  kind: string;
  label: string;
}

export interface Claim {
  id: number;
  resourceId: string;
  sessionId: string;
  reason: string;
  claimedAt: number;
  expiresAt: number;
  releasedAt: number | null;
  releaseReason: string | null;
}

export interface Signal {
  id: string;
  ruleId: string;
  key: string;
  subjectType: 'item' | 'session' | 'ask';
  subjectId: string;
  severity: Severity;
  title: string;
  detail: string | null;
  link: string | null;
  source: string;
  status: SignalStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  snoozedUntil: number | null;
}

export interface CueEvent {
  id: number;
  ts: number;
  type: string;
  sessionId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  summary: string;
  data: Record<string, unknown> | null;
}
