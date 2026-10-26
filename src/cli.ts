import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, DEFAULT_PORT, loadConfig, type CueConfig } from './config/index.ts';
import { Cue } from './cue.ts';
import { DemoBoard, demoConfig, runDemo, seedDemo } from './demo/index.ts';
import { HOOK_EVENTS, hooksSnippet, writeHooks } from './ingest/install.ts';
import { Notifier } from './notify/index.ts';
import { startServer } from './server/index.ts';
import { VERSION } from './version.ts';

const HELP = `Cue ${VERSION}: a local-first chief of staff for people who run many AI sessions.

Usage
  cuedesk [--config <path>] [--port <n>] [--db <path>]   start Cue with a config file
  cuedesk --demo [--port <n>]                            start with a fake project, no accounts needed
  cuedesk hooks install [--port <n>] [--write <path>]    print (or merge) the Claude Code hooks snippet
  cuedesk notify test [--config <path>]                  send one test alert to your phone (needs "notify" in the config)
  cuedesk --help | --version

Options
  --config <path>   config file (default: ./cue.config.yaml)
  --port <n>        port on 127.0.0.1 (default: ${DEFAULT_PORT}, or "port" in the config)
  --db <path>       SQLite file (default: ~/.cuedesk/<project>.sqlite, or "db" in the config)
  --demo            seed a fake project with sessions, asks, a board and resources
  --write <path>    with "hooks install": merge the hooks into this settings file
                    (a backup is kept next to it). Without it, Cue only prints.

Cue listens on 127.0.0.1 only. UI at http://127.0.0.1:<port>, MCP at /mcp, JSON API under /api.
`;

interface Args {
  command: 'serve' | 'hooks-install' | 'notify-test' | 'help' | 'version';
  config?: string;
  port?: number;
  db?: string;
  demo: boolean;
  write?: string;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: 'serve', demo: false };
  const rest = [...argv];
  if (rest[0] === 'hooks') {
    if (rest[1] !== 'install') throw new Error('unknown hooks command; use "cuedesk hooks install"');
    args.command = 'hooks-install';
    rest.splice(0, 2);
  } else if (rest[0] === 'notify') {
    if (rest[1] !== 'test') throw new Error('unknown notify command; use "cuedesk notify test"');
    args.command = 'notify-test';
    rest.splice(0, 2);
  }
  const value = (flag: string): string => {
    const v = rest.shift();
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  while (rest.length) {
    const a = rest.shift()!;
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    if (inline !== undefined) rest.unshift(inline);
    switch (flag) {
      case '--help':
      case '-h':
        args.command = 'help';
        return args;
      case '--version':
      case '-v':
        args.command = 'version';
        return args;
      case '--config':
      case '-c':
        args.config = value(flag);
        break;
      case '--port':
      case '-p': {
        const v = value(flag);
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`--port must be a number from 0 to 65535, got "${v}"`);
        args.port = n;
        break;
      }
      case '--db':
        args.db = value(flag);
        break;
      case '--demo':
        args.demo = true;
        break;
      case '--write':
        if (args.command !== 'hooks-install') throw new Error('--write only works with "cuedesk hooks install"');
        args.write = value(flag);
        break;
      default:
        throw new Error(`unknown option "${a}"`);
    }
  }
  if (args.demo && args.config) throw new Error('--demo uses its own fake project; drop --config');
  return args;
}

function hooksInstall(args: Args): number {
  const port = args.port ?? DEFAULT_PORT;
  if (!args.write) {
    process.stdout.write(
      [
        '# Claude Code hooks for Cue. Paste the "hooks" block into your Claude Code settings',
        '# (~/.claude/settings.json for every project, or .claude/settings.json in one repo),',
        '# merging with any hooks you already have. Or let Cue merge it for you:',
        '#   cuedesk hooks install --write <path-to-settings.json>',
        '',
        JSON.stringify(hooksSnippet(port), null, 2),
        '',
        '# To give your sessions the MCP tools (ask_human, claim_resource, ...):',
        `#   claude mcp add --transport http cue http://127.0.0.1:${port}/mcp`,
        '',
      ].join('\n'),
    );
    return 0;
  }
  const path = resolve(args.write);
  const r = writeHooks(path, port);
  if (!r.added.length && !r.updated.length) {
    process.stdout.write(`${path} already sends ${HOOK_EVENTS.join(', ')} to Cue on port ${port}. Nothing changed.\n`);
    return 0;
  }
  process.stdout.write(
    `Updated ${path}\n` +
      (r.added.length ? `  added hooks: ${r.added.join(', ')}\n` : '') +
      (r.updated.length ? `  updated hooks: ${r.updated.join(', ')}\n` : '') +
      (r.backup ? `  backup of the old file: ${r.backup}\n` : ''),
  );
  return 0;
}

async function serve(args: Args): Promise<number> {
  let config: CueConfig;
  if (args.demo) {
    config = demoConfig(args.port ?? DEFAULT_PORT);
  } else {
    const path = args.config ?? 'cue.config.yaml';
    if (!args.config && !existsSync(path)) {
      process.stderr.write(
        'No cue.config.yaml in this folder.\n' +
          '  Try the demo:          cuedesk --demo\n' +
          '  Or start from the example config in the README (or cue.config.example.yaml) and run:\n' +
          '                         cuedesk --config path/to/cue.config.yaml\n',
      );
      return 1;
    }
    config = loadConfig(path);
    if (args.port !== undefined) config = { ...config, port: args.port };
  }
  if (args.db) config = { ...config, db: resolve(args.db) };

  const log = (msg: string) => process.stderr.write(`[cue] ${msg}\n`);
  let board: DemoBoard | null = null;
  let cue: Cue;
  if (args.demo) {
    board = new DemoBoard(() => Date.now());
    cue = new Cue({ config, sources: [board], rulesIntervalMs: 5_000, log });
    seedDemo(cue);
  } else {
    cue = new Cue({ config, log });
  }

  let server;
  try {
    server = await startServer(cue, { port: config.port, log });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      process.stderr.write(`Port ${config.port} on 127.0.0.1 is busy (another Cue?). Pass --port <n>.\n`);
      return 1;
    }
    throw err;
  }
  cue.start();
  const stopDemo = board ? runDemo(cue, board) : () => undefined;

  process.stdout.write(
    [
      `Cue ${VERSION} · project ${config.project}${args.demo ? ' (demo: fake data, nothing leaves this machine)' : ''}`,
      `  UI    ${server.url}`,
      `  MCP   ${server.url}/mcp`,
      `  API   ${server.url}/api/whats_next`,
      `  Data  ${config.db === ':memory:' ? 'in memory (gone when Cue stops)' : config.db}`,
      config.sources.length ? `  Sources  ${config.sources.map((s) => s.name).join(', ')} (every ${config.pollMinutes} min)` : '',
      cue.notifier ? `  Alerts ${cue.notifier.describe()}` : '',
      'Press Ctrl+C to stop.',
      '',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );

  await new Promise<void>((done) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      stopDemo();
      await cue.stop();
      await server.close();
      cue.store.close();
      done();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

/** Sends one test alert with the config's "notify" settings, so you know your phone gets them. */
async function notifyTest(args: Args): Promise<number> {
  const config = loadConfig(args.config ?? 'cue.config.yaml');
  if (!config.notify) {
    process.stderr.write('There is no "notify" section in the config. See "Phone alerts" in the README.\n');
    return 1;
  }
  const notifier = new Notifier(config.notify, {
    project: config.project,
    quietHours: config.quietHours,
    now: () => Date.now(),
    log: (msg) => process.stderr.write(`${msg}\n`),
  });
  const ok = await notifier.send({
    title: `Cue · ${config.project}`,
    message: 'Test alert from Cue. If this is on your phone, alerts work.',
    priority: 3,
    tags: ['white_check_mark'],
  });
  process.stdout.write(ok ? `Sent a test alert via ${notifier.describe()}.\n` : 'The test alert was not sent.\n');
  return ok ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`cuedesk: ${(err as Error).message}\nRun "cuedesk --help" for usage.\n`);
    return 2;
  }
  try {
    if (args.command === 'help') {
      process.stdout.write(HELP);
      return 0;
    }
    if (args.command === 'version') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (args.command === 'hooks-install') return hooksInstall(args);
    if (args.command === 'notify-test') return await notifyTest(args);
    return await serve(args);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    process.stderr.write(`cuedesk: ${(err as Error).message}\n`);
    return 1;
  }
}

// Run when executed directly (node src/cli.ts or dist/cli.js), not when imported by tests.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
    // Let stdout drain, then make sure nothing left open keeps the process alive.
    setTimeout(() => process.exit(code), 1000).unref();
  });
}
