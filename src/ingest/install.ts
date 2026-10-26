import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const HOOK_EVENTS = ['Notification', 'Stop', 'SessionStart', 'SessionEnd'] as const;
const MARKER = '/api/hooks/claude';

interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
  [k: string]: unknown;
}

/**
 * The shell command each hook runs: pipe the hook's JSON to Cue. It gives up
 * after 3 seconds and never fails, so a stopped Cue never blocks Claude Code.
 */
export function hookCommand(port: number): string {
  return `curl -sS -m 3 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}${MARKER} >/dev/null 2>&1 || true`;
}

export function hooksSnippet(port: number): { hooks: Record<string, HookGroup[]> } {
  const hooks: Record<string, HookGroup[]> = {};
  for (const event of HOOK_EVENTS) hooks[event] = [{ hooks: [{ type: 'command', command: hookCommand(port), timeout: 5 }] }];
  return { hooks };
}

/**
 * Merges Cue's hooks into a Claude Code settings object without touching
 * anything else. Existing Cue hooks are updated in place (e.g. a new port).
 */
export function mergeHooks(settings: unknown, port: number): { settings: Record<string, unknown>; added: string[]; updated: string[]; unchanged: string[] } {
  if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
    throw new Error('the settings file does not hold a JSON object');
  }
  const out: Record<string, unknown> = structuredClone((settings as Record<string, unknown> | undefined) ?? {});
  if (out.hooks !== undefined && (typeof out.hooks !== 'object' || out.hooks === null || Array.isArray(out.hooks))) {
    throw new Error('"hooks" in the settings file is not an object');
  }
  const hooks = (out.hooks ?? {}) as Record<string, HookGroup[]>;
  out.hooks = hooks;
  const command = hookCommand(port);
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = groups;
    const existing = groups.flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : [])).find((h) => typeof h.command === 'string' && h.command.includes(MARKER));
    if (!existing) {
      groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
      added.push(event);
    } else if (existing.command !== command) {
      existing.command = command;
      updated.push(event);
    } else {
      unchanged.push(event);
    }
  }
  return { settings: out, added, updated, unchanged };
}

/** Writes the merged hooks into the settings file at `path`, keeping a backup of the old file. */
export function writeHooks(path: string, port: number): { added: string[]; updated: string[]; unchanged: string[]; backup: string | null } {
  let current: unknown = undefined;
  let backup: string | null = null;
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    if (text.trim()) {
      try {
        current = JSON.parse(text);
      } catch (err) {
        throw new Error(`${path} is not valid JSON (${(err as Error).message}); fix it or paste the snippet by hand`);
      }
    }
  }
  const result = mergeHooks(current, port);
  if (result.added.length === 0 && result.updated.length === 0) return { ...result, backup: null };
  if (existsSync(path)) {
    backup = `${path}.cuedesk-backup`;
    copyFileSync(path, backup);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result.settings, null, 2)}\n`);
  return { added: result.added, updated: result.updated, unchanged: result.unchanged, backup };
}
