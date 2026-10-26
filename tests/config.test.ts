import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, ConfigError, loadConfig, parseConfig, PRESET_NAMES } from '../src/config/index.ts';
import { parseArgs } from '../src/cli.ts';

const SPEC_EXAMPLE = `
project: my-app
preset: qa-lead            # qa-lead | eng-manager | solo-dev; rules below override it

sources:
  - type: github
    repo: owner/name
    tokenEnv: GITHUB_TOKEN
  - type: mcp
    name: jira
    command: ["npx", "-y", "some-jira-mcp"]
    query: { tool: search_issues, args: { jql: "project = APP AND status != Done" } }
    map:
      id: key
      title: fields.summary
      status: fields.status.name
      updated: fields.updated
      url: self
    stages:
      active: ["In Progress", "In Testing"]
      review: ["Code Review", "Ready for test"]
      done: ["Done", "Tested"]

resources:
  - id: tablet-1
    kind: device
  - id: staging-config
    kind: config

rules:
  - id: stale-active
    when: { stage: active, idleHours: 24 }
    severity: warn
  - id: silent-claim
    when: { session: holdsClaim, silentMinutes: 30 }
    severity: urgent
  - id: old-ask
    when: { ask: open, ageHours: 2 }
    severity: warn

quietHours: { start: "19:00", end: "08:00" }
`;

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
    return err.problems;
  }
  assert.fail('expected a ConfigError');
}

test('the SPEC example config loads and merges the qa-lead preset', () => {
  const c = parseConfig(SPEC_EXAMPLE);
  assert.equal(c.project, 'my-app');
  assert.equal(c.preset, 'qa-lead');
  assert.equal(c.sources.length, 2);
  const [gh, jira] = c.sources;
  assert.equal(gh!.type, 'github');
  assert.equal(gh!.type === 'github' && gh!.tokenEnv, 'GITHUB_TOKEN');
  assert.equal(jira!.type, 'mcp');
  if (jira!.type === 'mcp') {
    assert.deepEqual(jira!.command, ['npx', '-y', 'some-jira-mcp']);
    assert.equal(jira!.map.status, 'fields.status.name');
    assert.deepEqual(jira!.stages.active, ['In Progress', 'In Testing']);
  }
  assert.deepEqual(c.resources.map((r) => r.id), ['tablet-1', 'staging-config']);
  // Preset rules (stale-review, stale-blocked) plus the config's three overrides.
  const ids = c.rules.map((r) => r.id).sort();
  assert.deepEqual(ids, ['old-ask', 'silent-claim', 'stale-active', 'stale-blocked', 'stale-review']);
  const silent = c.rules.find((r) => r.id === 'silent-claim')!;
  assert.equal(silent.kind, 'session');
  assert.equal(silent.kind === 'session' && silent.silentMs, 30 * 60_000);
  assert.deepEqual(c.quietHours, { start: '19:00', end: '08:00' });
  assert.deepEqual(c.ranking.tags, ['dev']);
  assert.equal(c.ranking.order[0], 'tagged');
});

test('every preset builds on its own', () => {
  for (const preset of PRESET_NAMES) {
    const c = buildConfig({ project: 'p', preset });
    assert.ok(c.rules.length >= 3, `${preset} has rules`);
    assert.equal(new Set(c.ranking.order).size, 4, `${preset} ranks all four tiers`);
  }
  assert.equal(buildConfig({ project: 'p', preset: 'eng-manager' }).rules.find((r) => r.id === 'stale-blocked')!.severity, 'urgent');
});

test('config rules override preset rules by id, and disabled removes one', () => {
  const c = buildConfig({
    project: 'p',
    preset: 'qa-lead',
    rules: [
      { id: 'old-ask', when: { ask: 'open', ageMinutes: 15 }, severity: 'urgent' },
      { id: 'stale-review', disabled: true },
      { id: 'my-rule', when: { stage: ['todo', 'blocked'], idleDays: 7 }, severity: 'info' },
    ],
  });
  const oldAsk = c.rules.find((r) => r.id === 'old-ask')!;
  assert.equal(oldAsk.severity, 'urgent');
  assert.equal(oldAsk.kind === 'ask' && oldAsk.ageMs, 15 * 60_000);
  assert.equal(c.rules.find((r) => r.id === 'stale-review'), undefined);
  const mine = c.rules.find((r) => r.id === 'my-rule')!;
  assert.equal(mine.kind === 'item' && mine.idleMs, 7 * 24 * 3600_000);
});

test('ranking order from config is completed with the missing tiers', () => {
  const c = buildConfig({ project: 'p', ranking: { order: ['rest', 'urgent'], tags: ['x'] } });
  assert.deepEqual(c.ranking.order, ['rest', 'urgent', 'tagged', 'claimBlocking']);
  assert.deepEqual(c.ranking.tags, ['x']);
});

test('clear errors: unknown keys with a suggestion, and every problem at once', () => {
  const p = problems(() => buildConfig({ project: 'p', sorces: [], preset: 'qa-boss', port: 'abc' }));
  assert.ok(p.some((x) => x.includes('sorces') && x.includes('did you mean "sources"')), p.join('\n'));
  assert.ok(p.some((x) => x.includes('unknown preset "qa-boss"')));
  assert.ok(p.some((x) => x.startsWith('port:')));
  assert.equal(p.length, 3);
});

test('clear errors: a token pasted where an env var name belongs', () => {
  const p = problems(() => buildConfig({ project: 'p', sources: [{ type: 'github', repo: 'o/r', tokenEnv: 'ghp_abcdef1234567890' }] }));
  assert.match(p[0]!, /sources\[0\]\.tokenEnv: looks like a secret/);
});

test('clear errors: sources, stages and rules', () => {
  const p = problems(() =>
    buildConfig({
      project: 'p',
      sources: [
        { type: 'github', repo: 'not-a-repo' },
        { type: 'mcp', name: 'jira', query: { tool: 't' }, map: { id: 'key', title: 'x' }, stages: { doing: ['In Progress'] } },
        { type: 'linear' },
      ],
      rules: [
        { id: 'two', when: { stage: 'active', ask: 'open', idleHours: 1 } },
        { id: 'none', when: { stage: 'active' } },
        { id: 'neg', when: { session: 'holdsClaim', silentMinutes: -5 } },
        { id: 'badstage', when: { stage: 'doing', idleHours: 1 } },
      ],
    }),
  );
  const text = p.join('\n');
  assert.match(text, /sources\[0\]\.repo: expected "owner\/name", got "not-a-repo"/);
  assert.match(text, /sources\[1\]: needs either command .* or url/);
  assert.match(text, /sources\[1\]\.map\.status: required/);
  assert.match(text, /sources\[1\]\.stages\.doing: unknown stage/);
  assert.match(text, /sources\[2\]\.type: unknown source type "linear"/);
  assert.match(text, /rules\[0\]\.when: use one of stage, session or ask, not stage and ask/);
  assert.match(text, /rules\[1\]\.when: needs one of idleMinutes, idleHours, idleDays/);
  assert.match(text, /rules\[2\]\.when\.silentMinutes: must be more than 0/);
  assert.match(text, /rules\[3\]\.when\.stage: unknown stage doing/);
});

test('clear errors: a status listed under two stages', () => {
  const p = problems(() =>
    buildConfig({
      project: 'p',
      sources: [{ type: 'mcp', name: 'j', url: 'http://localhost:9/mcp', query: { tool: 't' }, map: { id: 'a', title: 'b', status: 'c' }, stages: { active: ['QA'], review: ['qa'] } }],
    }),
  );
  assert.match(p[0]!, /"qa" is also listed under active/);
});

test('YAML syntax errors name the line', () => {
  const p = problems(() => parseConfig('project: x\nsources:\n  - type: github\n   repo: bad-indent\n'));
  assert.match(p[0]!, /^line \d+, column \d+/);
});

test('loadConfig reports a missing file and resolves db next to the config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-config-'));
  assert.throws(() => loadConfig(join(dir, 'nope.yaml')), /file not found/);
  const file = join(dir, 'cue.config.yaml');
  writeFileSync(file, 'project: Demo App\ndb: data/cue.sqlite\n');
  const c = loadConfig(file);
  assert.equal(c.db, join(dir, 'data', 'cue.sqlite'));
  assert.equal(buildConfig({ project: 'Demo App' }).db.endsWith(join('.cuedesk', 'demo-app.sqlite')), true);
});

test('CLI arguments are checked', () => {
  assert.equal(parseArgs(['--demo', '--port', '0']).port, 0);
  assert.equal(parseArgs(['--port=4600']).port, 4600);
  assert.equal(parseArgs(['hooks', 'install', '--write', '/tmp/x.json']).write, '/tmp/x.json');
  assert.equal(parseArgs(['--version']).command, 'version');
  assert.throws(() => parseArgs(['--port', 'abc']), /--port must be a number/);
  assert.throws(() => parseArgs(['--write', 'x']), /only works with "cuedesk hooks install"/);
  assert.throws(() => parseArgs(['--demo', '--config', 'x.yaml']), /drop --config/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
});
