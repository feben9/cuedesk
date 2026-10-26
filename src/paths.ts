import { fileURLToPath } from 'node:url';

/** The package root: one level above src/ (when run from source) or dist/ (when installed). */
export const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
