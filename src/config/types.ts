import type { Severity, Stage } from '../store/types.ts';
import type { Tier } from './presets.ts';

/** A rule as written in YAML or a preset, before validation. */
export interface RawRule {
  id: string;
  when: Record<string, unknown>;
  severity?: string;
  disabled?: boolean;
}

export type StageMap = Partial<Record<Stage, string[]>>;

export interface GithubSourceConfig {
  type: 'github';
  name: string;
  repo: string;
  tokenEnv: string | null;
  apiUrl: string;
  include: ('issues' | 'pulls')[];
  stages: StageMap;
}

export interface McpSourceConfig {
  type: 'mcp';
  name: string;
  command: string[] | null;
  url: string | null;
  env: string[];
  headersFromEnv: Record<string, string>;
  query: { tool: string; args: Record<string, unknown> };
  itemsPath: string | null;
  map: { id: string; title: string; status: string; updated: string | null; url: string | null; assignee: string | null };
  urlTemplate: string | null;
  stages: StageMap;
  defaultStage: Stage;
}

export type SourceConfig = GithubSourceConfig | McpSourceConfig;

interface RuleBase {
  id: string;
  severity: Severity;
  /** Plain-English description, e.g. "items in active with no update for 24h". */
  describe: string;
}

export type Rule =
  | (RuleBase & { kind: 'item'; stages: Stage[]; idleMs: number; source: string | null })
  | (RuleBase & { kind: 'session'; mode: 'holdsClaim' | 'any'; silentMs: number })
  | (RuleBase & { kind: 'ask'; ageMs: number });

export interface ResourceConfig {
  id: string;
  kind: string;
  label: string;
}

export interface CueConfig {
  project: string;
  preset: string | null;
  sources: SourceConfig[];
  resources: ResourceConfig[];
  rules: Rule[];
  quietHours: { start: string; end: string } | null;
  ranking: { order: Tier[]; tags: string[] };
  port: number;
  db: string;
  pollMinutes: number;
  configPath: string | null;
}
