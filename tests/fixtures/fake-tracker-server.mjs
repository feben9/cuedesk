// A tiny MCP server over stdio that pretends to be a tracker (Jira-shaped data).
// Used by tests/mcp-source.test.ts. Plain JavaScript so it runs without flags.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ISSUES = [
  {
    key: 'APP-1',
    self: 'https://tracker.example/rest/api/3/issue/1001',
    fields: { summary: 'Login button misaligned on small screens', status: { name: 'In Progress' }, updated: '2026-10-18T09:00:00.000+0000', assignee: { displayName: 'Mia' } },
  },
  {
    key: 'APP-2',
    self: 'https://tracker.example/rest/api/3/issue/1002',
    fields: { summary: 'Checkout total rounds the wrong way', status: { name: 'ready for test' }, updated: '2026-10-19T15:30:00.000+0000', assignee: null },
  },
  {
    key: 'APP-3',
    self: 'https://tracker.example/rest/api/3/issue/1003',
    fields: { summary: 'Crash on resume', status: { name: 'Waiting for vendor' }, updated: 1792400000 },
  },
  // No status: Cue must skip it, not crash.
  { key: 'APP-4', fields: { summary: 'Half a record' } },
];

const server = new Server({ name: 'fake-tracker', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'search_issues', description: 'Search issues', inputSchema: { type: 'object', properties: { jql: { type: 'string' } } } },
    { name: 'broken_search', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
    { name: 'env_probe', description: 'Reports which env vars it can see', inputSchema: { type: 'object', properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === 'search_issues') {
    if (args.jql !== 'project = APP AND status != Done') {
      return { isError: true, content: [{ type: 'text', text: `unexpected jql: ${args.jql}` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ startAt: 0, total: ISSUES.length, issues: ISSUES }) }] };
  }
  if (name === 'broken_search') {
    return { isError: true, content: [{ type: 'text', text: 'JQL syntax error near "statuz"' }] };
  }
  if (name === 'env_probe') {
    const record = {
      key: 'ENV-1',
      fields: {
        summary: `token=${process.env.FAKE_TRACKER_TOKEN ? 'yes' : 'no'} other=${process.env.CUE_TEST_NOT_LISTED ? 'yes' : 'no'}`,
        status: { name: 'In Progress' },
      },
    };
    return { content: [{ type: 'text', text: JSON.stringify([record]) }] };
  }
  return { isError: true, content: [{ type: 'text', text: `no tool ${name}` }] };
});

await server.connect(new StdioServerTransport());
