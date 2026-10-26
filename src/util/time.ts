export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** "3d 2h", "47m", "20s". Short and readable, for titles and briefs. */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, Math.round(ms));
  if (abs < MINUTE) return `${Math.round(abs / 1000)}s`;
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)}m`;
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MINUTE);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

export function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

/**
 * Parses a point in time for `since`: an ISO 8601 date, epoch milliseconds,
 * or a relative span such as "90m", "8h" or "2d" (meaning that long ago).
 */
export function parseSince(input: string | number, now: number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('timestamp must be a finite number');
    return input;
  }
  const text = input.trim();
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)$/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = unit === 'd' ? DAY : unit === 'h' ? HOUR : MINUTE;
    return now - n * ms;
  }
  if (/^\d{10,}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`timestamp "${input}" is not an ISO date, epoch milliseconds or a span like "8h"`);
  }
  return parsed;
}

/** Parses "HH:MM" into minutes after midnight, or null when malformed. */
export function parseClockTime(text: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** True when the local time of `now` falls inside [start, end), wrapping past midnight. */
export function inQuietHours(quiet: { start: string; end: string } | undefined, now: number): boolean {
  if (!quiet) return false;
  const start = parseClockTime(quiet.start);
  const end = parseClockTime(quiet.end);
  if (start === null || end === null || start === end) return false;
  const d = new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes();
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
