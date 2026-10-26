import type { NotifyConfig } from '../config/types.ts';
import type { Ask, Signal } from '../store/types.ts';
import { inQuietHours } from '../util/time.ts';
import { truncate } from '../util/misc.ts';

/** The part of fetch the notifier uses, so tests can pass a fake. */
export type PostLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface Alert {
  title: string;
  message: string;
  /** ntfy priority: 1 (min) to 5 (urgent). */
  priority: number;
  /** ntfy tags; emoji short codes show as icons. */
  tags: string[];
}

export interface NotifierOptions {
  project: string;
  quietHours: { start: string; end: string } | null;
  now: () => number;
  post?: PostLike;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  /** Pause before trying a failed send again. Default 2 s. */
  retryDelayMs?: number;
}

/** At most this many alerts a minute; after that one "more are waiting" alert, then quiet. */
const MAX_PER_MINUTE = 6;
const TIMEOUT_MS = 10_000;
/** A slow or patchy connection loses the odd request; an alert is worth two more tries. */
const ATTEMPTS = 3;

/**
 * Sends phone alerts through ntfy (https://ntfy.sh or your own server) for
 * urgent signals and, if asked for, new asks. Only runs when "notify" is in
 * the config; this is the one place Cue sends anything off the machine.
 * Sending never throws: a failure is logged and Cue carries on.
 */
export class Notifier {
  private readonly config: NotifyConfig;
  private readonly opts: NotifierOptions;
  private sentAt: number[] = [];
  private heldBack = false;
  private pending = new Set<Promise<boolean>>();

  constructor(config: NotifyConfig, opts: NotifierOptions) {
    this.config = config;
    this.opts = opts;
  }

  /** For the startup banner. The topic is half hidden: it is the only key to a public ntfy topic. */
  describe(): string {
    const { server, topic } = this.config.ntfy;
    const shown = topic.length > 6 ? `${topic.slice(0, 4)}…` : '…';
    return `ntfy ${server}/${shown} (${this.config.on.join(' + ') || 'nothing'}${this.config.details ? '' : ', no details'})`;
  }

  signalFired(signal: Signal): Promise<boolean> | null {
    if (signal.severity !== 'urgent' || !this.config.on.includes('urgent')) return null;
    const message = this.config.details ? [signal.title, signal.detail].filter(Boolean).join('\n') : 'Something urgent needs you. Open Cue to see it.';
    return this.track(this.send({ title: `Cue · ${this.opts.project}: urgent`, message, priority: 5, tags: ['rotating_light'] }));
  }

  askCreated(ask: Ask): Promise<boolean> | null {
    if (!this.config.on.includes('asks')) return null;
    // Asks wait for the morning; only urgent signals break quiet hours.
    if (inQuietHours(this.opts.quietHours ?? undefined, this.opts.now())) return null;
    const alert: Alert = this.config.details
      ? { title: truncate(`${ask.askedBy} needs you`, 100), message: ask.summary, priority: ask.kind === 'approve' ? 4 : 3, tags: ['raising_hand'] }
      : { title: `Cue · ${this.opts.project}`, message: 'A session is waiting for you. Open Cue to see it.', priority: 3, tags: ['raising_hand'] };
    return this.track(this.send(alert));
  }

  /** Sends one alert. Resolves to whether ntfy accepted it. */
  async send(alert: Alert): Promise<boolean> {
    const now = this.opts.now();
    this.sentAt = this.sentAt.filter((t) => now - t < 60_000);
    if (this.sentAt.length >= MAX_PER_MINUTE) {
      if (this.heldBack) return false;
      this.heldBack = true;
      alert = { title: `Cue · ${this.opts.project}`, message: 'More alerts are waiting in Cue. Holding the rest for a minute.', priority: 4, tags: ['hourglass'] };
    } else {
      this.heldBack = false;
    }
    this.sentAt.push(now);

    const { server, topic, tokenEnv } = this.config.ntfy;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = tokenEnv ? (this.opts.env ?? process.env)[tokenEnv] : undefined;
    if (token) headers.Authorization = `Bearer ${token}`;
    const body = JSON.stringify({ topic, title: alert.title, message: truncate(alert.message, 1000), priority: alert.priority, tags: alert.tags });
    const post = this.opts.post ?? (globalThis.fetch as unknown as PostLike);
    let problem = '';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 2_000));
      try {
        const res = await post(`${server}/`, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.ok) return true;
        problem = `ntfy answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check the topic token)' : ''}`;
        // A refusal won't change on a retry; only server trouble and rate limits might.
        if (res.status < 500 && res.status !== 429) break;
      } catch (err) {
        problem = (err as Error).name === 'TimeoutError' ? `ntfy did not answer within ${TIMEOUT_MS / 1000} s` : (err as Error).message;
      }
    }
    this.opts.log?.(`alert not sent: ${problem}`);
    return false;
  }

  /** Resolves when every alert started so far has finished. For tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private track(p: Promise<boolean>): Promise<boolean> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    return p;
  }
}
