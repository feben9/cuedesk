import { request } from 'node:http';
import { buildConfig, type CueConfig } from '../src/config/index.ts';
import { Cue } from '../src/cue.ts';
import { Store } from '../src/store/index.ts';
import type { Source } from '../src/sources/types.ts';

export interface FakeClock {
  (): number;
  advance(ms: number): void;
  set(ms: number): void;
}

export function fakeClock(start = Date.parse('2026-10-20T09:00:00Z')): FakeClock {
  let t = start;
  const fn = (() => t) as FakeClock;
  fn.advance = (ms) => {
    t += ms;
  };
  fn.set = (ms) => {
    t = ms;
  };
  return fn;
}

export function testConfig(raw: Record<string, unknown> = {}): CueConfig {
  return buildConfig({ project: 'test', db: ':memory:', ...raw });
}

export function makeCue(raw: Record<string, unknown> = {}, opts: { clock?: FakeClock; sources?: Source[] } = {}) {
  const clock = opts.clock ?? fakeClock();
  const config = testConfig(raw);
  const store = new Store(':memory:', clock);
  const cue = new Cue({ config, store, sources: opts.sources ?? [] });
  return { cue, clock, store, config };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): any;
}

/** A raw HTTP request, so tests can set Host and Origin headers freely. */
export function rawRequest(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}) {
  return rawRequest(port, {
    method: 'POST',
    path,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
