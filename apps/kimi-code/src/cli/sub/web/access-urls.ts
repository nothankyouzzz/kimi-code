/**
 * Build the clickable/copyable access URLs for the running server.
 *
 * Shared by the `kimi web` ready banner and `kimi web rotate-token` so both
 * show the same Local/Network links. When a token is known it rides in the
 * `#token=` fragment (never sent to the server, so never logged), letting a
 * user open the link on another device and be authenticated automatically.
 */

import { formatHostForUrl, listNetworkAddresses, type NetworkAddress } from './networks';

/**
 * Build a directly-openable server URL. When the token is known it is appended
 * as `#token=<token>`; otherwise the bare origin (with a trailing slash) is
 * returned.
 */
export function buildOpenableUrl(bareOrigin: string, token: string | undefined): string {
  const base = bareOrigin.endsWith('/') ? bareOrigin.slice(0, -1) : bareOrigin;
  return token === undefined ? `${base}/` : `${base}/#token=${token}`;
}

/**
 * Split a full URL into the part before `#token=` and the `#token=…` fragment
 * itself, so callers can render the fragment in a de-emphasized color. Returns
 * `[fullUrl, '']` when there is no token fragment.
 */
export function splitTokenFragment(fullUrl: string): [string, string] {
  const marker = '#token=';
  const idx = fullUrl.indexOf(marker);
  return idx < 0 ? [fullUrl, ''] : [fullUrl.slice(0, idx), fullUrl.slice(idx)];
}

export interface AccessUrlLine {
  /** Fixed-width label including trailing padding, e.g. `"Local:    "`. */
  label: string;
  /** Full URL, carrying `#token=` when a token is known. */
  url: string;
}

function isWildcard(host: string): boolean {
  return host === '' || host === '0.0.0.0' || host === '::';
}

/**
 * Rewrite a bound origin for browser auto-open. A wildcard bind host
 * (`0.0.0.0` / `::` / empty) is not navigable, so open localhost on the same
 * port instead — the same address the ready banner's `Local:` line shows.
 */
export function browserOpenOrigin(origin: string): string {
  const separator = origin.lastIndexOf(':');
  const host = origin.slice(origin.indexOf('://') + 3, separator);
  if (!isWildcard(host)) return origin;
  return `http://localhost${origin.slice(separator)}`;
}

/** True when `host` is a loopback address (this host only). */
export function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.') ||
    host.endsWith('.localhost')
  );
}

function hostOrigin(host: string, port: number): string {
  const family = host.includes(':') ? 'IPv6' : 'IPv4';
  return `http://${formatHostForUrl(host, family)}:${port}`;
}

/**
 * Compute the access-URL lines for a bind host/port.
 *
 * - wildcard (`0.0.0.0` / `::` / empty): a `Local:` line (localhost) plus one
 *   `Network:` line per non-loopback interface.
 * - loopback: a single `Local:` line.
 * - specific host: a single `URL:` line.
 */
export function accessUrlLines(
  host: string | readonly string[],
  port: number,
  token: string | undefined,
  networkAddresses?: NetworkAddress[],
): AccessUrlLine[] {
  const hosts = Array.isArray(host) ? host : [host];
  if (hosts.some(isWildcard)) {
    const lines: AccessUrlLine[] = [
      { label: 'Local:    ', url: buildOpenableUrl(`http://localhost:${port}`, token) },
    ];
    const addrs = networkAddresses ?? listNetworkAddresses();
    for (const addr of addrs) {
      lines.push({
        label: 'Network:  ',
        url: buildOpenableUrl(`http://${formatHostForUrl(addr.address, addr.family)}:${port}`, token),
      });
    }
    return lines;
  }
  const first = hosts[0];
  if (hosts.length === 1 && first !== undefined && !isLoopbackHost(first)) {
    return [{ label: 'URL:      ', url: buildOpenableUrl(hostOrigin(first, port), token) }];
  }
  const lines: AccessUrlLine[] = [];
  for (const h of hosts) {
    const label = isLoopbackHost(h) ? 'Local:    ' : 'Network:  ';
    lines.push({ label, url: buildOpenableUrl(hostOrigin(h, port), token) });
  }
  return lines;
}
