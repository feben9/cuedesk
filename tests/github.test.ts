import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildConfig, type GithubSourceConfig } from '../src/config/index.ts';
import { GitHubSource, nextLink, type FetchLike } from '../src/sources/github.ts';

// Recorded API responses (trimmed to the fields Cue reads). No network in tests.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/github/${name}`, import.meta.url), 'utf8');
const API = 'https://api.github.com';
const ISSUES_1 = `${API}/repos/acme/widgets/issues?state=open&per_page=100`;
const ISSUES_2 = `${API}/repositories/1/issues?state=open&per_page=100&page=2`;
const PULLS_1 = `${API}/repos/acme/widgets/pulls?state=open&per_page=100`;

function recordedFetch(routes: Record<string, { body: string; status?: number; headers?: Record<string, string> }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r = routes[url];
    if (!r) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(r.body, { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  };
  return { fetchFn, calls };
}

const pages = {
  [ISSUES_1]: { body: fixture('issues-page1.json'), headers: { link: `<${ISSUES_2}>; rel="next", <${ISSUES_2}>; rel="last"` } },
  [ISSUES_2]: { body: fixture('issues-page2.json'), headers: { link: `<${ISSUES_1}>; rel="prev", <${ISSUES_1}>; rel="first"` } },
  [PULLS_1]: { body: fixture('pulls-page1.json') },
};

function source(extra: Record<string, unknown> = {}): GithubSourceConfig {
  return buildConfig({
    project: 'p',
    sources: [{ type: 'github', repo: 'acme/widgets', tokenEnv: 'CUE_TEST_GH_TOKEN', stages: { blocked: ['blocked'], active: ['in progress'] }, ...extra }],
  }).sources[0] as GithubSourceConfig;
}

test('reads open issues and PRs across pages and maps stages from labels and state', async () => {
  const { fetchFn, calls } = recordedFetch(pages);
  const gh = new GitHubSource(source(), { fetch: fetchFn, env: {} });
  const items = await gh.fetchItems();
  assert.deepEqual(calls.map((c) => c.url), [ISSUES_1, ISSUES_2, PULLS_1], 'follows the Link header');
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(byId).sort(), ['#11', '#12', '#14', '#15', '#9']);
  assert.equal(items.filter((i) => i.id === '#14').length, 1, 'a PR in the issues list is not counted twice');

  assert.equal(byId['#12']!.stage, 'blocked', 'label "Blocked" matches the "blocked" mapping');
  assert.equal(byId['#12']!.status, 'Blocked');
  assert.equal(byId['#12']!.assignee, 'mia-dev');
  assert.equal(byId['#12']!.url, 'https://github.com/acme/widgets/issues/12');
  assert.equal(byId['#12']!.updatedAt, Date.parse('2026-10-15T10:20:00Z'));
  assert.equal(byId['#9']!.stage, 'todo', 'unassigned, no stage label');
  assert.equal(byId['#11']!.stage, 'active', 'assigned issue');
  assert.equal(byId['#14']!.stage, 'review', 'open PR');
  assert.equal(byId['#14']!.title, 'PR: Fix empty config crash');
  assert.equal(byId['#15']!.stage, 'active', 'draft PR');
  assert.equal(byId['#15']!.status, 'draft PR');
});

test('sends the token from the named env var, and none when it is unset', async () => {
  const withToken = recordedFetch(pages);
  await new GitHubSource(source(), { fetch: withToken.fetchFn, env: { CUE_TEST_GH_TOKEN: 'test-token-123' } }).fetchItems();
  assert.equal(withToken.calls[0]!.headers.Authorization, 'Bearer test-token-123');
  assert.equal(withToken.calls[0]!.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(withToken.calls[0]!.headers['User-Agent'], 'cuedesk');

  const anonymous = recordedFetch(pages);
  await new GitHubSource(source({ tokenEnv: undefined }), { fetch: anonymous.fetchFn, env: { CUE_TEST_GH_TOKEN: 'ignored' } }).fetchItems();
  assert.equal(anonymous.calls[0]!.headers.Authorization, undefined);
});

test('include limits what is read', async () => {
  const { fetchFn, calls } = recordedFetch(pages);
  const items = await new GitHubSource(source({ include: ['pulls'] }), { fetch: fetchFn, env: {} }).fetchItems();
  assert.deepEqual(calls.map((c) => c.url), [PULLS_1]);
  assert.equal(items.length, 2);
});

test('API errors become readable messages', async () => {
  const cases: [number, Record<string, string>, RegExp][] = [
    [401, {}, /GitHub rejected the token for acme\/widgets \(token from \$CUE_TEST_GH_TOKEN\)/],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792500000' }, /rate limit reached for acme\/widgets until 2026-/],
    [404, {}, /repo acme\/widgets not found, or the token cannot see it/],
    [500, {}, /GitHub answered 500 for acme\/widgets: boom/],
  ];
  for (const [status, headers, expected] of cases) {
    const { fetchFn } = recordedFetch({ [ISSUES_1]: { body: JSON.stringify({ message: 'boom' }), status, headers } });
    await assert.rejects(new GitHubSource(source(), { fetch: fetchFn, env: {} }).fetchItems(), expected);
  }
});

test('nextLink parses the Link header', () => {
  assert.equal(nextLink(null), null);
  assert.equal(nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=5>; rel="last"'), 'https://x/a?page=2');
  assert.equal(nextLink('<https://x/a?page=1>; rel="prev"'), null);
});
