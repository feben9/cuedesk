import type { SourceConfig } from '../config/types.ts';
import type { Store } from '../store/index.ts';
import { GitHubSource, type FetchLike } from './github.ts';
import { McpSource } from './mcp.ts';
import type { Source } from './types.ts';

export * from './types.ts';
export { GitHubSource, McpSource };

export function createSource(cfg: SourceConfig, opts: { fetch?: FetchLike; env?: Record<string, string | undefined> } = {}): Source {
  if (cfg.type === 'github') return new GitHubSource(cfg, opts);
  return new McpSource(cfg, { env: opts.env });
}

export type SyncResult = { source: string; ok: true; count: number; added: number; moved: number; gone: number } | { source: string; ok: false; error: string };

/** Last error per source, so a failing source logs one event per new error, not one per poll. */
const lastErrors = new WeakMap<Store, Map<string, string>>();

/** Fetches one source and writes the result into the store, logging what changed. */
export async function syncSource(store: Store, source: Source): Promise<SyncResult> {
  const errors = lastErrors.get(store) ?? new Map<string, string>();
  lastErrors.set(store, errors);
  let fetched;
  try {
    fetched = await source.fetchItems();
  } catch (err) {
    const error = (err as Error).message;
    if (errors.get(source.name) !== error) {
      errors.set(source.name, error);
      store.addEvent({ type: 'source.error', subjectType: 'source', subjectId: source.name, summary: `Could not read ${source.name}: ${error}` });
    }
    return { source: source.name, ok: false, error };
  }
  if (errors.has(source.name)) {
    errors.delete(source.name);
    store.addEvent({ type: 'source.recovered', subjectType: 'source', subjectId: source.name, summary: `${source.name} is readable again` });
  }
  const firstSync = store.listItems({ source: source.name, includeGone: true }).length === 0;
  const changes = store.syncItems(source.name, fetched);
  if (firstSync) {
    if (changes.added.length) {
      store.addEvent({
        type: 'source.imported',
        subjectType: 'source',
        subjectId: source.name,
        summary: `Imported ${changes.added.length} items from ${source.name}`,
      });
    }
  } else {
    for (const item of changes.added) {
      store.addEvent({ type: 'item.new', subjectType: 'item', subjectId: `${source.name}:${item.id}`, summary: `New in ${source.name}: ${item.id} ${item.title} (${item.stage})`, data: { url: item.url } });
    }
  }
  for (const { item, from, to } of changes.moved) {
    store.addEvent({
      type: 'item.moved',
      subjectType: 'item',
      subjectId: `${source.name}:${item.id}`,
      summary: `${item.id} ${item.title}: ${from} → ${to} (${item.status})`,
      data: { from, to, url: item.url },
    });
  }
  for (const item of changes.gone) {
    store.addEvent({ type: 'item.gone', subjectType: 'item', subjectId: `${source.name}:${item.id}`, summary: `${item.id} ${item.title} left ${source.name} (closed or no longer matched)` });
  }
  return { source: source.name, ok: true, count: fetched.length, added: changes.added.length, moved: changes.moved.length, gone: changes.gone.length };
}
