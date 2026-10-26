import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { SEVERITIES, STAGES, type Severity, type Stage } from '../store/types.ts';
import { DEFAULT_RANKING, PRESETS, PRESET_NAMES, TIERS, type Tier } from './presets.ts';
import type { CueConfig, GithubSourceConfig, McpSourceConfig, NotifyConfig, RawRule, ResourceConfig, Rule, SourceConfig, StageMap } from './types.ts';
import { DAY, HOUR, MINUTE, parseClockTime } from '../util/time.ts';

export * from './types.ts';
export { PRESETS, PRESET_NAMES, TIERS, type Tier } from './presets.ts';

export const DEFAULT_PORT = 4520;

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[], file?: string | null) {
    const where = file ?? 'config';
    super(
      problems.length === 1
        ? `${where}: ${problems[0]}`
        : `${where} has ${problems.length} problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Obj = Record<string, unknown>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOKS_LIKE_SECRET = /^(ghp_|gho_|ghu_|ghs_|github_pat_|xox[abpr]-|sk-|eyJ)/;

class Checker {
  readonly problems: string[] = [];

  add(path: string, msg: string): void {
    this.problems.push(path ? `${path}: ${msg}` : msg);
  }

  isObj(v: unknown): v is Obj {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  obj(v: unknown, path: string): Obj | null {
    if (!this.isObj(v)) {
      this.add(path, `expected a mapping (key: value), got ${describe(v)}`);
      return null;
    }
    return v;
  }

  keys(o: Obj, path: string, allowed: string[]): void {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) {
        const hint = closest(k, allowed);
        this.add(path ? `${path}.${k}` : k, `unknown key${hint ? ` (did you mean "${hint}"?)` : ''}. Allowed: ${allowed.join(', ')}`);
      }
    }
  }

  str(o: Obj, key: string, path: string, opts: { required?: boolean; pattern?: RegExp; patternHint?: string } = {}): string | null {
    const v = o[key];
    const p = path ? `${path}.${key}` : key;
    if (v === undefined || v === null || v === '') {
      if (opts.required) this.add(p, 'required');
      return null;
    }
    if (typeof v !== 'string') {
      this.add(p, `expected text, got ${describe(v)}`);
      return null;
    }
    if (opts.pattern && !opts.pattern.test(v)) {
      this.add(p, `${opts.patternHint ?? 'has an invalid format'}, got "${v}"`);
      return null;
    }
    return v;
  }

  num(o: Obj, key: string, path: string, opts: { min?: number; max?: number; int?: boolean } = {}): number | null {
    const v = o[key];
    const p = path ? `${path}.${key}` : key;
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.add(p, `expected a number, got ${describe(v)}`);
      return null;
    }
    if (opts.int && !Number.isInteger(v)) this.add(p, 'must be a whole number');
    if (opts.min !== undefined && v < opts.min) this.add(p, `must be at least ${opts.min}`);
    if (opts.max !== undefined && v > opts.max) this.add(p, `must be at most ${opts.max}`);
    return v;
  }

  strList(v: unknown, path: string): string[] | null {
    if (typeof v === 'string') return [v];
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
      this.add(path, `expected a list of text values, got ${describe(v)}`);
      return null;
    }
    return v as string[];
  }

  envName(o: Obj, key: string, path: string): string | null {
    const v = o[key];
    const p = path ? `${path}.${key}` : key;
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') {
      this.add(p, `expected the name of an environment variable, got ${describe(v)}`);
      return null;
    }
    if (LOOKS_LIKE_SECRET.test(v)) {
      this.add(p, 'looks like a secret. Put the secret in an environment variable and write only its NAME here (e.g. GITHUB_TOKEN)');
      return null;
    }
    if (!ENV_NAME.test(v)) {
      this.add(p, `must be an environment variable name like GITHUB_TOKEN, got "${v}"`);
      return null;
    }
    return v;
  }
}

function describe(v: unknown): string {
  if (v === null || v === undefined) return 'nothing';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'object') return 'a mapping';
  if (typeof v === 'string') return `"${v}"`;
  return `${typeof v} ${String(v)}`;
}

function closest(word: string, options: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const o of options) {
    const d = editDistance(word.toLowerCase(), o.toLowerCase());
    if (d < bestScore) {
      bestScore = d;
      best = o;
    }
  }
  return bestScore <= 2 ? best : null;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}

function checkStageMap(c: Checker, v: unknown, path: string): StageMap {
  const out: StageMap = {};
  if (v === undefined || v === null) return out;
  const o = c.obj(v, path);
  if (!o) return out;
  const owner = new Map<string, string>();
  for (const [stage, names] of Object.entries(o)) {
    if (!(STAGES as readonly string[]).includes(stage)) {
      c.add(`${path}.${stage}`, `unknown stage. Stages are: ${STAGES.join(', ')}`);
      continue;
    }
    const list = c.strList(names, `${path}.${stage}`);
    if (!list) continue;
    for (const name of list) {
      const key = name.trim().toLowerCase();
      const prev = owner.get(key);
      if (prev && prev !== stage) c.add(`${path}.${stage}`, `"${name}" is also listed under ${prev}; a status maps to one stage`);
      owner.set(key, stage);
    }
    out[stage as Stage] = list;
  }
  return out;
}

function checkSource(c: Checker, raw: unknown, i: number): SourceConfig | null {
  const path = `sources[${i}]`;
  const o = c.obj(raw, path);
  if (!o) return null;
  const type = c.str(o, 'type', path, { required: true });
  if (type === 'github') {
    c.keys(o, path, ['type', 'name', 'repo', 'tokenEnv', 'apiUrl', 'include', 'stages']);
    const repo = c.str(o, 'repo', path, { required: true, pattern: /^[\w.-]+\/[\w.-]+$/, patternHint: 'expected "owner/name"' });
    const apiUrl = c.str(o, 'apiUrl', path, { pattern: /^https?:\/\//, patternHint: 'expected an http(s) URL' }) ?? 'https://api.github.com';
    let include: GithubSourceConfig['include'] = ['issues', 'pulls'];
    if (o.include !== undefined) {
      const list = c.strList(o.include, `${path}.include`);
      if (list) {
        const bad = list.filter((x) => x !== 'issues' && x !== 'pulls');
        if (bad.length) c.add(`${path}.include`, `allowed values are issues and pulls, got ${bad.join(', ')}`);
        include = list.filter((x): x is 'issues' | 'pulls' => x === 'issues' || x === 'pulls');
      }
    }
    const stages = checkStageMap(c, o.stages, `${path}.stages`);
    const tokenEnv = c.envName(o, 'tokenEnv', path);
    const name = c.str(o, 'name', path);
    if (!repo) return null;
    return { type: 'github', name: name ?? repo, repo, tokenEnv, apiUrl: apiUrl.replace(/\/+$/, ''), include, stages };
  }
  if (type === 'mcp') {
    c.keys(o, path, ['type', 'name', 'command', 'url', 'env', 'headersFromEnv', 'query', 'itemsPath', 'map', 'urlTemplate', 'stages', 'defaultStage']);
    const name = c.str(o, 'name', path, { required: true });
    let command: string[] | null = null;
    if (o.command !== undefined) {
      if (typeof o.command === 'string') c.add(`${path}.command`, 'write the command as a list, e.g. ["npx", "-y", "some-mcp-server"]');
      else {
        command = c.strList(o.command, `${path}.command`);
        if (command && command.length === 0) {
          c.add(`${path}.command`, 'must not be empty');
          command = null;
        }
      }
    }
    const url = c.str(o, 'url', path, { pattern: /^https?:\/\//, patternHint: 'expected an http(s) URL' });
    if (!command && !url && o.command === undefined && o.url === undefined) c.add(path, 'needs either command (to start the server) or url (to connect to it)');
    if (o.command !== undefined && o.url !== undefined) c.add(path, 'use command or url, not both');
    const env: string[] = [];
    if (o.env !== undefined) {
      const list = c.strList(o.env, `${path}.env`);
      for (const e of list ?? []) {
        if (!ENV_NAME.test(e)) c.add(`${path}.env`, `"${e}" is not an environment variable name; list names only, values stay in your environment`);
        else env.push(e);
      }
    }
    const headersFromEnv: Record<string, string> = {};
    if (o.headersFromEnv !== undefined) {
      const h = c.obj(o.headersFromEnv, `${path}.headersFromEnv`);
      for (const [header, envName] of Object.entries(h ?? {})) {
        const v = c.envName({ [header]: envName }, header, `${path}.headersFromEnv`);
        if (v) headersFromEnv[header] = v;
      }
    }
    let query: McpSourceConfig['query'] | null = null;
    const q = o.query === undefined ? (c.add(`${path}.query`, 'required (which tool to call, e.g. { tool: search_issues, args: {...} })'), null) : c.obj(o.query, `${path}.query`);
    if (q) {
      c.keys(q, `${path}.query`, ['tool', 'args']);
      const tool = c.str(q, 'tool', `${path}.query`, { required: true });
      const args = q.args === undefined ? {} : c.obj(q.args, `${path}.query.args`);
      if (tool && args) query = { tool, args };
    }
    let map: McpSourceConfig['map'] | null = null;
    const m = o.map === undefined ? (c.add(`${path}.map`, 'required (which fields hold id, title and status)'), null) : c.obj(o.map, `${path}.map`);
    if (m) {
      c.keys(m, `${path}.map`, ['id', 'title', 'status', 'updated', 'url', 'assignee']);
      const id = c.str(m, 'id', `${path}.map`, { required: true });
      const title = c.str(m, 'title', `${path}.map`, { required: true });
      const status = c.str(m, 'status', `${path}.map`, { required: true });
      if (id && title && status) {
        map = {
          id,
          title,
          status,
          updated: c.str(m, 'updated', `${path}.map`),
          url: c.str(m, 'url', `${path}.map`),
          assignee: c.str(m, 'assignee', `${path}.map`),
        };
      }
    }
    const urlTemplate = c.str(o, 'urlTemplate', path, { pattern: /\{id\}/, patternHint: 'must contain {id}' });
    const defaultStage = c.str(o, 'defaultStage', path) ?? 'todo';
    if (!(STAGES as readonly string[]).includes(defaultStage)) c.add(`${path}.defaultStage`, `must be one of ${STAGES.join(', ')}`);
    const stages = checkStageMap(c, o.stages, `${path}.stages`);
    const itemsPath = c.str(o, 'itemsPath', path);
    if (!name || !query || !map) return null;
    return { type: 'mcp', name, command, url, env, headersFromEnv, query, itemsPath, map, urlTemplate, stages, defaultStage: defaultStage as Stage };
  }
  if (type) c.add(`${path}.type`, `unknown source type "${type}". Use github or mcp`);
  return null;
}

function threshold(c: Checker, when: Obj, path: string, units: Record<string, number>): number | null {
  const present = Object.keys(units).filter((k) => when[k] !== undefined);
  if (present.length === 0) {
    c.add(path, `needs one of ${Object.keys(units).join(', ')}`);
    return null;
  }
  if (present.length > 1) {
    c.add(path, `use only one of ${present.join(', ')}`);
    return null;
  }
  const key = present[0]!;
  const n = c.num(when, key, path);
  if (n === null) return null;
  if (n <= 0) {
    c.add(`${path}.${key}`, 'must be more than 0');
    return null;
  }
  return n * units[key]!;
}

function compileRule(c: Checker, raw: unknown, path: string, sourceNames: Set<string>): Rule | null {
  const o = c.obj(raw, path);
  if (!o) return null;
  c.keys(o, path, ['id', 'when', 'severity', 'disabled']);
  const id = c.str(o, 'id', path, { required: true, pattern: /^[\w.-]+$/, patternHint: 'use letters, digits, dot, dash or underscore' });
  const sevRaw = c.str(o, 'severity', path) ?? 'warn';
  if (!(SEVERITIES as readonly string[]).includes(sevRaw)) c.add(`${path}.severity`, `must be one of ${SEVERITIES.join(', ')}`);
  const severity = sevRaw as Severity;
  const when = o.when === undefined ? (c.add(`${path}.when`, 'required'), null) : c.obj(o.when, `${path}.when`);
  if (!id || !when) return null;
  const wp = `${path}.when`;
  const subjects = ['stage', 'session', 'ask'].filter((k) => when[k] !== undefined);
  if (subjects.length !== 1) {
    c.add(wp, subjects.length ? `use one of stage, session or ask, not ${subjects.join(' and ')}` : 'needs one of stage, session or ask');
    return null;
  }
  const subject = subjects[0];
  if (subject === 'stage') {
    c.keys(when, wp, ['stage', 'source', 'idleMinutes', 'idleHours', 'idleDays']);
    const stages = c.strList(when.stage, `${wp}.stage`);
    const bad = (stages ?? []).filter((s) => !(STAGES as readonly string[]).includes(s));
    if (bad.length) c.add(`${wp}.stage`, `unknown stage ${bad.join(', ')}. Stages are: ${STAGES.join(', ')}`);
    const source = c.str(when, 'source', wp);
    if (source && !sourceNames.has(source)) c.add(`${wp}.source`, `no source named "${source}"`);
    const idleMs = threshold(c, when, wp, { idleMinutes: MINUTE, idleHours: HOUR, idleDays: DAY });
    if (!stages || bad.length || idleMs === null) return null;
    return {
      id,
      severity,
      kind: 'item',
      stages: stages as Stage[],
      idleMs,
      source,
      describe: `items in ${stages.join('/')} with no update for ${humanSpan(idleMs)}`,
    };
  }
  if (subject === 'session') {
    c.keys(when, wp, ['session', 'silentMinutes', 'silentHours']);
    const mode = c.str(when, 'session', wp);
    if (mode !== 'holdsClaim' && mode !== 'any') {
      c.add(`${wp}.session`, 'must be holdsClaim or any');
      return null;
    }
    const silentMs = threshold(c, when, wp, { silentMinutes: MINUTE, silentHours: HOUR });
    if (silentMs === null) return null;
    return {
      id,
      severity,
      kind: 'session',
      mode,
      silentMs,
      describe: `${mode === 'holdsClaim' ? 'sessions holding a claim' : 'sessions'} silent for ${humanSpan(silentMs)}`,
    };
  }
  c.keys(when, wp, ['ask', 'ageMinutes', 'ageHours']);
  if (when.ask !== 'open') {
    c.add(`${wp}.ask`, 'must be open');
    return null;
  }
  const ageMs = threshold(c, when, wp, { ageMinutes: MINUTE, ageHours: HOUR });
  if (ageMs === null) return null;
  return { id, severity, kind: 'ask', ageMs, describe: `asks open longer than ${humanSpan(ageMs)}` };
}

function humanSpan(ms: number): string {
  if (ms % DAY === 0) return `${ms / DAY}d`;
  if (ms % HOUR === 0) return `${ms / HOUR}h`;
  return `${Math.round(ms / MINUTE)}m`;
}

export interface BuildOptions {
  /** Directory relative paths (db) resolve against. */
  baseDir?: string;
  configPath?: string | null;
}

/** Validates a parsed config object, merges its preset, and returns the final config. */
export function buildConfig(raw: unknown, opts: BuildOptions = {}): CueConfig {
  const c = new Checker();
  const file = opts.configPath ?? null;
  if (!c.isObj(raw)) throw new ConfigError([`expected a YAML mapping at the top level, got ${describe(raw)}`], file);
  c.keys(raw, '', ['project', 'preset', 'sources', 'resources', 'rules', 'quietHours', 'notify', 'ranking', 'port', 'db', 'pollMinutes']);

  const project = c.str(raw, 'project', '', { required: true }) ?? 'cue';
  const preset = c.str(raw, 'preset', '');
  if (preset && !PRESETS[preset]) c.add('preset', `unknown preset "${preset}". Presets: ${PRESET_NAMES.join(', ')}`);

  // Sources
  const sources: SourceConfig[] = [];
  if (raw.sources !== undefined && raw.sources !== null) {
    if (!Array.isArray(raw.sources)) c.add('sources', 'expected a list');
    else raw.sources.forEach((s, i) => {
      const src = checkSource(c, s, i);
      if (!src) return;
      if (sources.some((x) => x.name === src.name)) c.add(`sources[${i}].name`, `"${src.name}" is used by another source; names must be unique`);
      else sources.push(src);
    });
  }
  const sourceNames = new Set(sources.map((s) => s.name));

  // Resources
  const resources: ResourceConfig[] = [];
  if (raw.resources !== undefined && raw.resources !== null) {
    if (!Array.isArray(raw.resources)) c.add('resources', 'expected a list');
    else raw.resources.forEach((r, i) => {
      const path = `resources[${i}]`;
      const o = c.obj(r, path);
      if (!o) return;
      c.keys(o, path, ['id', 'kind', 'label']);
      const id = c.str(o, 'id', path, { required: true, pattern: /^[\w.:-]+$/, patternHint: 'use letters, digits, dot, colon, dash or underscore' });
      if (!id) return;
      if (resources.some((x) => x.id === id)) {
        c.add(`${path}.id`, `"${id}" is listed twice`);
        return;
      }
      resources.push({ id, kind: c.str(o, 'kind', path) ?? 'resource', label: c.str(o, 'label', path) ?? id });
    });
  }

  // Rules: preset rules first, then the config's own (same id overrides).
  const rawRules = new Map<string, { raw: unknown; path: string }>();
  if (preset && PRESETS[preset]) {
    PRESETS[preset].rules.forEach((r: RawRule) => rawRules.set(r.id, { raw: r, path: `preset ${preset} rule ${r.id}` }));
  }
  const disabled = new Set<string>();
  if (raw.rules !== undefined && raw.rules !== null) {
    if (!Array.isArray(raw.rules)) c.add('rules', 'expected a list');
    else {
      const seen = new Set<string>();
      raw.rules.forEach((r, i) => {
        const path = `rules[${i}]`;
        if (!c.isObj(r)) {
          c.add(path, `expected a mapping, got ${describe(r)}`);
          return;
        }
        const id = typeof r.id === 'string' ? r.id : null;
        if (id && seen.has(id)) c.add(`${path}.id`, `"${id}" is used by another rule`);
        if (id) seen.add(id);
        if (r.disabled === true) {
          if (!id) c.add(`${path}.id`, 'required');
          else if (!rawRules.has(id)) c.add(path, `disables "${id}", but no preset rule has that id`);
          else disabled.add(id);
          return;
        }
        if (r.disabled !== undefined && typeof r.disabled !== 'boolean') c.add(`${path}.disabled`, 'expected true or false');
        if (id) rawRules.delete(id); // a config rule replaces the preset rule with the same id
        rawRules.set(id ?? `#${i}`, { raw: r, path });
      });
    }
  }
  const rules: Rule[] = [];
  for (const [id, { raw: r, path }] of rawRules) {
    if (disabled.has(id)) continue;
    const rule = compileRule(c, r, path, sourceNames);
    if (rule) rules.push(rule);
  }

  // Quiet hours
  let quietHours: CueConfig['quietHours'] = null;
  if (raw.quietHours !== undefined && raw.quietHours !== null) {
    const q = c.obj(raw.quietHours, 'quietHours');
    if (q) {
      c.keys(q, 'quietHours', ['start', 'end']);
      const start = c.str(q, 'start', 'quietHours', { required: true });
      const end = c.str(q, 'end', 'quietHours', { required: true });
      if (start && parseClockTime(start) === null) c.add('quietHours.start', `expected a 24-hour time like "19:00", got "${start}"`);
      if (end && parseClockTime(end) === null) c.add('quietHours.end', `expected a 24-hour time like "08:00", got "${end}"`);
      if (start && end) quietHours = { start, end };
    }
  }

  // Phone alerts
  let notify: CueConfig['notify'] = null;
  if (raw.notify !== undefined && raw.notify !== null) {
    const n = c.obj(raw.notify, 'notify');
    if (n) {
      c.keys(n, 'notify', ['ntfy', 'on', 'details']);
      let ntfy: NotifyConfig['ntfy'] | null = null;
      if (n.ntfy === undefined || n.ntfy === null) c.add('notify.ntfy', 'required (ntfy is the only alert channel so far)');
      const t = n.ntfy === undefined || n.ntfy === null ? null : c.obj(n.ntfy, 'notify.ntfy');
      if (t) {
        c.keys(t, 'notify.ntfy', ['server', 'topic', 'tokenEnv']);
        const serverText = c.str(t, 'server', 'notify.ntfy', { pattern: /^https?:\/\/[^\s/]+(\/[^\s]*)?$/i, patternHint: 'expected a URL like https://ntfy.sh' });
        const server = (serverText ?? 'https://ntfy.sh').replace(/\/+$/, '');
        const topic = c.str(t, 'topic', 'notify.ntfy', { required: true, pattern: /^[A-Za-z0-9_-]{1,64}$/, patternHint: 'expected letters, digits, - or _ (at most 64)' });
        const tokenEnv = c.envName(t, 'tokenEnv', 'notify.ntfy');
        if (topic && /^https:\/\/ntfy\.sh$/i.test(server) && topic.length < 12) {
          c.add('notify.ntfy.topic', 'on the public ntfy.sh server anyone who guesses the topic reads your alerts. Use at least 12 random characters, e.g. cue-k3v9q2m7xa');
        } else if (topic) {
          ntfy = { server, topic, tokenEnv };
        }
      }
      let on: NotifyConfig['on'] = ['urgent'];
      if (n.on !== undefined) {
        const list = c.strList(n.on, 'notify.on');
        if (list) {
          const bad = list.filter((x) => x !== 'urgent' && x !== 'asks');
          if (bad.length) c.add('notify.on', `unknown value ${bad.join(', ')}. Use urgent and/or asks`);
          else on = [...new Set(list)] as NotifyConfig['on'];
        }
      }
      let details = true;
      if (n.details !== undefined) {
        if (typeof n.details === 'boolean') details = n.details;
        else c.add('notify.details', `expected true or false, got ${describe(n.details)}`);
      }
      if (ntfy) notify = { ntfy, on, details };
    }
  }

  // Ranking
  const base = (preset && PRESETS[preset]?.ranking) || DEFAULT_RANKING;
  const ranking = { order: [...base.order], tags: [...base.tags] };
  if (raw.ranking !== undefined && raw.ranking !== null) {
    const r = c.obj(raw.ranking, 'ranking');
    if (r) {
      c.keys(r, 'ranking', ['order', 'tags']);
      if (r.order !== undefined) {
        const list = c.strList(r.order, 'ranking.order');
        if (list) {
          const bad = list.filter((t) => !(TIERS as readonly string[]).includes(t));
          if (bad.length) c.add('ranking.order', `unknown tier ${bad.join(', ')}. Tiers: ${TIERS.join(', ')}`);
          const unique = [...new Set(list.filter((t): t is Tier => (TIERS as readonly string[]).includes(t)))];
          ranking.order = [...unique, ...TIERS.filter((t) => !unique.includes(t))];
        }
      }
      if (r.tags !== undefined) ranking.tags = c.strList(r.tags, 'ranking.tags') ?? ranking.tags;
    }
  }

  const port = c.num(raw, 'port', '', { min: 0, max: 65535, int: true }) ?? DEFAULT_PORT;
  const pollMinutes = c.num(raw, 'pollMinutes', '', { min: 0.1, max: 1440 }) ?? 5;
  const dbText = c.str(raw, 'db', '');
  const dbRaw = dbText?.startsWith('~/') ? join(homedir(), dbText.slice(2)) : dbText;
  const baseDir = opts.baseDir ?? process.cwd();
  const slug = project.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'cue';
  const db = dbRaw === ':memory:' ? ':memory:' : dbRaw ? (isAbsolute(dbRaw) ? dbRaw : resolve(baseDir, dbRaw)) : join(homedir(), '.cuedesk', `${slug}.sqlite`);

  if (c.problems.length) throw new ConfigError(c.problems, file);
  return { project, preset, sources, resources, rules, quietHours, notify, ranking, port, db, pollMinutes, configPath: opts.configPath ?? null };
}

/** Parses YAML text and builds the config. YAML syntax errors name the line. */
export function parseConfig(text: string, opts: BuildOptions = {}): CueConfig {
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length) {
    throw new ConfigError(
      doc.errors.map((e) => {
        const line = e.linePos?.[0];
        return `${line ? `line ${line.line}, column ${line.col}: ` : ''}${e.message.split('\n')[0]}`;
      }),
      opts.configPath,
    );
  }
  return buildConfig(doc.toJS(), opts);
}

export function loadConfig(path: string): CueConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError([code === 'ENOENT' ? 'file not found' : `cannot read it (${code ?? String(err)})`], path);
  }
  return parseConfig(text, { baseDir: dirname(resolve(path)), configPath: path });
}
