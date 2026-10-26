import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildConfig, type McpSourceConfig } from '../src/config/index.ts';
import { McpSource, extractRecords } from '../src/sources/mcp.ts';
import { syncSource } from '../src/sources/index.ts';
import { Store } from '../src/store/index.ts';
import { fakeClock } from './helpers.ts';

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-tracker-server.mjs', import.meta.url));

function jiraSource(extra: Record<string, unknown> = {}): McpSourceConfig {
  const c = buildConfig({
    project: 'p',
    sources: [
      {
        type: 'mcp',
        name: 'jira',
        command: [process.execPath, FAKE_SERVER],
        query: { tool: 'search_issues', args: { jql: 'project = APP AND status != Done' } },
        map: { id: 'key', title: 'fields.summary', status: 'fields.status.name', updated: 'fields.updated', assignee: 'fields.assignee.displayName' },
        urlTemplate: 'https://tracker.example/browse/{id}',
        stages: { active: ['In Progress', 'In Testing'], review: ['Code Review', 'Ready for test'], done: ['Done', 'Tested'] },
        ...extra,
      },
    ],
  });
  return c.sources[0] as McpSourceConfig;
}

test('McpSource starts a stdio MCP server, calls the tool and maps fields by dotted path', async (t) => {
  const source = new McpSource(jiraSource());
  t.after(() => source.close());
  const items = await source.fetchItems();
  assert.equal(items.length, 3, 'the record without a status is skipped');
  assert.equal(source.skipped, 1);
  const [a, b, c] = items;
  assert.deepEqual(a, {
    id: 'APP-1',
    title: 'Login button misaligned on small screens',
    status: 'In Progress',
    stage: 'active',
    url: 'https://tracker.example/browse/APP-1',
    assignee: 'Mia',
    updatedAt: Date.parse('2026-10-18T09:00:00Z'),
  });
  assert.equal(b!.stage, 'review', 'status matching ignores case');
  assert.equal(b!.assignee, null);
  assert.equal(c!.stage, 'todo', 'unmapped statuses fall back to defaultStage');
  assert.equal(c!.updatedAt, 1792400000 * 1000, 'epoch seconds are understood');

  // The connection is reused on the next poll.
  assert.equal((await source.fetchItems()).length, 3);
});

test('a URL field mapping wins over the template', async (t) => {
  const source = new McpSource(jiraSource({ map: { id: 'key', title: 'fields.summary', status: 'fields.status.name', url: 'self' }, urlTemplate: undefined }));
  t.after(() => source.close());
  const [first] = await source.fetchItems();
  assert.equal(first!.url, 'https://tracker.example/rest/api/3/issue/1001');
  assert.equal(first!.updatedAt, null, 'no updated mapping: Cue tracks changes itself');
});

test('only the env vars named in the config reach the server', async (t) => {
  const source = new McpSource(jiraSource({ query: { tool: 'env_probe' }, env: ['FAKE_TRACKER_TOKEN'] }), {
    env: { FAKE_TRACKER_TOKEN: 'secret-value', CUE_TEST_NOT_LISTED: 'also-secret' },
  });
  process.env.CUE_TEST_NOT_LISTED = 'from-parent';
  t.after(() => {
    delete process.env.CUE_TEST_NOT_LISTED;
    return source.close();
  });
  const [probe] = await source.fetchItems();
  assert.equal(probe!.title, 'token=yes other=no');
});

test('tool errors and bad commands come back as clear errors, and sync logs them once', async (t) => {
  const broken = new McpSource(jiraSource({ query: { tool: 'broken_search' } }));
  t.after(() => broken.close());
  await assert.rejects(broken.fetchItems(), /MCP source "jira": broken_search returned an error: JQL syntax error near "statuz"/);

  const store = new Store(':memory:', fakeClock());
  const r1 = await syncSource(store, broken);
  const r2 = await syncSource(store, broken);
  assert.equal(r1.ok, false);
  assert.equal(r2.ok, false);
  assert.equal(store.eventsSince(0).filter((e) => e.type === 'source.error').length, 1, 'one event per new error, not per poll');

  const missing = new McpSource(jiraSource({ command: [process.execPath, '/nonexistent/cue-fake-server.mjs'] }), { timeoutMs: 10_000 });
  t.after(() => missing.close());
  await assert.rejects(missing.fetchItems(), /could not connect to MCP source "jira"/);
});

test('syncSource writes items into the store, then logs moves and removals', async () => {
  const clock = fakeClock(Date.parse('2026-10-20T09:00:00Z'));
  const store = new Store(':memory:', clock);
  let records: unknown[] = [
    { id: 'T-1', name: 'First', state: 'Doing', changed: '2026-10-19T09:00:00Z' },
    { id: 'T-2', name: 'Second', state: 'Backlog', changed: '2026-10-19T09:00:00Z' },
  ];
  // An in-memory MCP server whose data the test changes between polls.
  const makeTransport = () => {
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: 'mem', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [], structuredContent: { data: { tickets: records } } }));
    void server.connect(serverSide);
    return client;
  };
  const cfg = buildConfig({
    project: 'p',
    sources: [
      {
        type: 'mcp',
        name: 'mem',
        url: 'http://127.0.0.1:9/mcp',
        query: { tool: 'list' },
        itemsPath: 'data.tickets',
        map: { id: 'id', title: 'name', status: 'state', updated: 'changed' },
        stages: { active: ['Doing'], done: ['Done'] },
      },
    ],
  }).sources[0] as McpSourceConfig;
  const source = new McpSource(cfg, { transport: makeTransport });

  let r = await syncSource(store, source);
  assert.deepEqual(r, { source: 'mem', ok: true, count: 2, added: 2, moved: 0, gone: 0 });
  assert.equal(store.eventsSince(0).filter((e) => e.type === 'source.imported').length, 1, 'first import is one event');

  records = [{ id: 'T-1', name: 'First', state: 'Done', changed: '2026-10-20T08:00:00Z' }];
  r = await syncSource(store, source);
  assert.deepEqual(r, { source: 'mem', ok: true, count: 1, added: 0, moved: 1, gone: 1 });
  const moved = store.eventsSince(0).find((e) => e.type === 'item.moved')!;
  assert.match(moved.summary, /T-1 First: active → done/);
  assert.equal(store.getItem('mem', 'T-2')!.gone, true);
  assert.equal(store.listItems().length, 1, 'gone items leave the board');
  await source.close();
});

test('extractRecords finds the list in common result shapes', () => {
  const text = (v: unknown) => ({ type: 'text', text: JSON.stringify(v) });
  assert.deepEqual(extractRecords({ content: [text([{ a: 1 }])] }, null), [{ a: 1 }]);
  assert.deepEqual(extractRecords({ content: [text({ total: 1, issues: [{ a: 1 }] })] }, null), [{ a: 1 }]);
  assert.deepEqual(extractRecords({ content: [{ type: 'text', text: 'Found 2 issues:' }, text({ a: 1 }), text({ a: 2 })] }, null), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(extractRecords({ structuredContent: { page: { rows: [1] } }, content: [] }, 'page.rows'), [1]);
  assert.throws(() => extractRecords({ content: [{ type: 'text', text: 'no json here' }] }, null), /returned no JSON: "no json here"/);
  assert.throws(() => extractRecords({ content: [text({ total: 0 })] }, null), /set itemsPath/);
  assert.throws(() => extractRecords({ content: [text({ x: 1 })] }, 'x.y'), /itemsPath "x\.y" does not point to a list/);
});
