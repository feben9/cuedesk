import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PKG_ROOT } from './paths.ts';

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
