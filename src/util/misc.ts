import { randomBytes } from 'node:crypto';

/** Short random id with a readable prefix, e.g. "ask_3f9a2c1b7d". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}

/** Reads a dotted path such as "fields.status.name" or "items.0.key" from a value. */
export function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Parses an updated-at value from a tracker: ISO text, epoch seconds or epoch milliseconds. */
export function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return parseTimestamp(Number(value));
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
