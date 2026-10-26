import type { GithubSourceConfig } from '../config/types.ts';
import type { Stage } from '../store/types.ts';
import { stageFor, type Source, type SourceItem } from './types.ts';

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

interface GhLabel {
  name?: string;
}
interface GhUser {
  login?: string;
}
interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  updated_at: string;
  labels?: (GhLabel | string)[];
  assignee?: GhUser | null;
  assignees?: GhUser[];
  pull_request?: unknown;
  draft?: boolean;
}

/** Reads the URL marked rel="next" from a GitHub Link header. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Open issues and pull requests of one repository, through the REST API.
 * A token is optional (public repos work without one, at a lower rate limit);
 * it is read from the environment variable named by `tokenEnv`.
 */
export class GitHubSource implements Source {
  readonly type = 'github';
  readonly name: string;
  private readonly cfg: GithubSourceConfig;
  private readonly fetchFn: FetchLike;
  private readonly env: Record<string, string | undefined>;
  private readonly maxPages: number;

  constructor(cfg: GithubSourceConfig, opts: { fetch?: FetchLike; env?: Record<string, string | undefined>; maxPages?: number } = {}) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.env = opts.env ?? process.env;
    this.maxPages = opts.maxPages ?? 10;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cuedesk',
    };
    const token = this.cfg.tokenEnv ? this.env[this.cfg.tokenEnv] : undefined;
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private async getAll(path: string): Promise<GhIssue[]> {
    const out: GhIssue[] = [];
    let url: string | null = `${this.cfg.apiUrl}${path}`;
    for (let page = 0; url && page < this.maxPages; page++) {
      const res: Response = await this.fetchFn(url, { headers: this.headers(), signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(await this.describeError(res));
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) throw new Error(`GitHub returned an unexpected response for ${this.cfg.repo}`);
      out.push(...(body as GhIssue[]));
      url = nextLink(res.headers.get('link'));
    }
    return out;
  }

  private async describeError(res: Response): Promise<string> {
    let message = '';
    try {
      message = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      message = '';
    }
    const repo = this.cfg.repo;
    const tokenNote = this.cfg.tokenEnv ? ` (token from $${this.cfg.tokenEnv})` : '';
    if (res.status === 401) return `GitHub rejected the token for ${repo}${tokenNote}`;
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : '';
      return `GitHub rate limit reached for ${repo}${when}${this.cfg.tokenEnv ? '' : '; set tokenEnv for a higher limit'}`;
    }
    if (res.status === 404) return `GitHub repo ${repo} not found, or the token cannot see it${tokenNote}`;
    return `GitHub answered ${res.status} for ${repo}${message ? `: ${message}` : ''}`;
  }

  private labelStage(issue: GhIssue): { stage: Stage; label: string } | null {
    for (const l of issue.labels ?? []) {
      const name = typeof l === 'string' ? l : l.name;
      if (!name) continue;
      const stage = stageFor(name, this.cfg.stages);
      if (stage) return { stage, label: name };
    }
    return null;
  }

  private toItem(issue: GhIssue, isPull: boolean): SourceItem {
    const byLabel = this.labelStage(issue);
    const assigned = Boolean(issue.assignee?.login || issue.assignees?.length);
    let stage: Stage;
    let status: string;
    if (issue.state === 'closed') {
      stage = 'done';
      status = 'closed';
    } else if (byLabel) {
      stage = byLabel.stage;
      status = byLabel.label;
    } else if (isPull) {
      stage = issue.draft ? 'active' : 'review';
      status = issue.draft ? 'draft PR' : 'PR open';
    } else {
      stage = assigned ? 'active' : 'todo';
      status = assigned ? 'open, assigned' : 'open';
    }
    return {
      id: `#${issue.number}`,
      title: isPull ? `PR: ${issue.title}` : issue.title,
      status,
      stage,
      url: issue.html_url ?? null,
      assignee: issue.assignee?.login ?? issue.assignees?.[0]?.login ?? null,
      updatedAt: Date.parse(issue.updated_at) || null,
    };
  }

  async fetchItems(): Promise<SourceItem[]> {
    const items: SourceItem[] = [];
    const repo = this.cfg.repo;
    if (this.cfg.include.includes('issues')) {
      const issues = await this.getAll(`/repos/${repo}/issues?state=open&per_page=100`);
      // The issues endpoint also lists pull requests; those come from /pulls below.
      for (const i of issues) if (!i.pull_request) items.push(this.toItem(i, false));
    }
    if (this.cfg.include.includes('pulls')) {
      const pulls = await this.getAll(`/repos/${repo}/pulls?state=open&per_page=100`);
      for (const p of pulls) items.push(this.toItem(p, true));
    }
    return items;
  }
}
