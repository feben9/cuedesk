import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpSourceConfig } from '../config/types.ts';
import { asText, getPath, parseTimestamp, truncate } from '../util/misc.ts';
import { stageFor, type Source, type SourceItem } from './types.ts';
import { VERSION } from '../version.ts';

const LIST_KEYS = ['issues', 'items', 'results', 'data', 'nodes', 'values', 'tickets', 'records'];

/** Pulls the list of records out of a tool result. */
export function extractRecords(result: { structuredContent?: unknown; content?: unknown }, itemsPath: string | null): unknown[] {
  let payload: unknown = result.structuredContent;
  if (payload === undefined) {
    const texts = (Array.isArray(result.content) ? result.content : [])
      .filter((c): c is { type: 'text'; text: string } => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text')
      .map((c) => c.text);
    const parsed: unknown[] = [];
    for (const t of texts) {
      try {
        parsed.push(JSON.parse(t));
      } catch {
        // Not JSON: prose around the data. Skip it.
      }
    }
    if (parsed.length === 0) {
      throw new Error(`the tool returned no JSON${texts[0] ? `: "${truncate(texts[0], 120)}"` : ''}`);
    }
    // Several JSON text parts, each one record, are treated as a list.
    payload = parsed.length === 1 ? parsed[0] : parsed;
  }
  if (itemsPath) {
    const list = getPath(payload, itemsPath);
    if (!Array.isArray(list)) throw new Error(`itemsPath "${itemsPath}" does not point to a list in the tool result`);
    return list;
  }
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const k of LIST_KEYS) if (Array.isArray(obj[k])) return obj[k] as unknown[];
    const firstList = Object.values(obj).find(Array.isArray);
    if (firstList) return firstList as unknown[];
  }
  throw new Error('the tool result holds no list of items; set itemsPath to the field that does');
}

/**
 * A tracker reached through any MCP server the user already runs (Jira, Linear,
 * an in-house tool). Cue connects as an MCP client, calls one configured tool,
 * and maps fields by dotted path.
 */
export class McpSource implements Source {
  readonly type = 'mcp';
  readonly name: string;
  private readonly cfg: McpSourceConfig;
  private readonly env: Record<string, string | undefined>;
  private readonly makeTransport: () => Transport;
  private readonly timeoutMs: number;
  private client: Client | null = null;
  private stderrTail: string[] = [];
  /** Records skipped on the last fetch because a mapped field was missing. */
  skipped = 0;

  constructor(
    cfg: McpSourceConfig,
    opts: { env?: Record<string, string | undefined>; transport?: () => Transport; timeoutMs?: number } = {},
  ) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.env = opts.env ?? process.env;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.makeTransport = opts.transport ?? (() => this.defaultTransport());
  }

  private defaultTransport(): Transport {
    if (this.cfg.command) {
      const [command, ...args] = this.cfg.command;
      const env: Record<string, string> = getDefaultEnvironment();
      for (const name of this.cfg.env) {
        const v = this.env[name];
        if (v !== undefined) env[name] = v;
      }
      const t = new StdioClientTransport({ command: command!, args, env, stderr: 'pipe' });
      t.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail.push(...chunk.toString('utf8').split('\n').filter(Boolean));
        this.stderrTail = this.stderrTail.slice(-5);
      });
      return t;
    }
    const headers: Record<string, string> = {};
    for (const [header, envName] of Object.entries(this.cfg.headersFromEnv)) {
      const v = this.env[envName];
      if (v !== undefined) headers[header] = v;
    }
    return new StreamableHTTPClientTransport(new URL(this.cfg.url!), { requestInit: { headers } });
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'cuedesk', version: VERSION });
    try {
      await client.connect(this.makeTransport(), { timeout: this.timeoutMs });
    } catch (err) {
      await client.close().catch(() => undefined);
      const tail = this.stderrTail.length ? ` (server said: ${truncate(this.stderrTail.join(' | '), 300)})` : '';
      throw new Error(`could not connect to MCP source "${this.name}": ${(err as Error).message}${tail}`);
    }
    this.client = client;
    return client;
  }

  mapRecord(rec: unknown): SourceItem | null {
    const { map } = this.cfg;
    const id = asText(getPath(rec, map.id));
    const title = asText(getPath(rec, map.title));
    const status = asText(getPath(rec, map.status));
    if (!id || title === null || status === null) return null;
    const url = map.url ? asText(getPath(rec, map.url)) : this.cfg.urlTemplate ? this.cfg.urlTemplate.replaceAll('{id}', encodeURIComponent(id)) : null;
    return {
      id,
      title,
      status,
      stage: stageFor(status, this.cfg.stages) ?? this.cfg.defaultStage,
      url,
      assignee: map.assignee ? asText(getPath(rec, map.assignee)) : null,
      updatedAt: map.updated ? parseTimestamp(getPath(rec, map.updated)) : null,
    };
  }

  async fetchItems(): Promise<SourceItem[]> {
    const client = await this.connect();
    let result: Awaited<ReturnType<Client['callTool']>>;
    try {
      result = await client.callTool({ name: this.cfg.query.tool, arguments: this.cfg.query.args }, undefined, { timeout: this.timeoutMs });
    } catch (err) {
      // Drop the connection so the next sync starts fresh.
      await this.close();
      throw new Error(`MCP source "${this.name}": calling ${this.cfg.query.tool} failed: ${(err as Error).message}`);
    }
    if (result.isError) {
      const text = (Array.isArray(result.content) ? result.content : [])
        .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
        .join(' ');
      throw new Error(`MCP source "${this.name}": ${this.cfg.query.tool} returned an error: ${truncate(text || 'no details', 300)}`);
    }
    const records = extractRecords(result as { structuredContent?: unknown; content?: unknown }, this.cfg.itemsPath);
    const items: SourceItem[] = [];
    this.skipped = 0;
    for (const rec of records) {
      const item = this.mapRecord(rec);
      if (item) items.push(item);
      else this.skipped++;
    }
    if (records.length > 0 && items.length === 0) {
      throw new Error(
        `MCP source "${this.name}": none of the ${records.length} records had the mapped id, title and status fields (${this.cfg.map.id}, ${this.cfg.map.title}, ${this.cfg.map.status})`,
      );
    }
    return items;
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.close().catch(() => undefined);
  }
}
