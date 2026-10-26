import type { IncomingHttpHeaders } from 'node:http';

/** Host header values that mean "this Cue". Anything else could be DNS rebinding. */
export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/**
 * Cue only answers local requests aimed at itself. Returns why a request is
 * refused, or null when it is fine:
 * - the Host header must be 127.0.0.1, localhost or [::1] on Cue's port
 *   (blocks DNS-rebinding pages that resolve their own name to 127.0.0.1);
 * - an Origin header, when present, must be Cue's own origin (blocks other
 *   web pages, including ones on other localhost ports, from calling the API).
 */
export function refuseReason(headers: IncomingHttpHeaders, port: number): string | null {
  const hosts = allowedHosts(port);
  const host = headers.host?.toLowerCase();
  if (!host) return 'missing Host header';
  if (!hosts.has(host)) return `Host "${host}" is not this Cue`;
  const origin = headers.origin;
  if (origin !== undefined) {
    const ok = [...hosts].some((h) => origin.toLowerCase() === `http://${h}`);
    if (!ok) return `Origin "${origin}" is not allowed`;
  }
  if (headers['sec-fetch-site'] === 'cross-site') return 'cross-site requests are not allowed';
  return null;
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
