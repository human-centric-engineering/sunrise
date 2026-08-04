/**
 * Server-side Fetch Utilities
 *
 * Helpers for server components that need to call internal API routes.
 * Handles cookie forwarding so that API routes can authenticate the request.
 *
 * @example
 * ```typescript
 * import { serverFetch } from '@/lib/api/server-fetch';
 * import type { APIResponse } from '@/types/api';
 * import type { SystemStats } from '@/types/admin';
 *
 * const res = await serverFetch('/api/v1/admin/stats');
 * const json = (await res.json()) as APIResponse<SystemStats>;
 * ```
 */

import { cookies } from 'next/headers';
import { env } from '@/lib/env';

export { parseApiResponse } from '@/lib/api/parse-response';

/**
 * Build the cookie header string from the current request's cookies.
 *
 * Reads the cookie store from Next.js headers and serializes
 * all cookies into a single header value.
 *
 * @returns Cookie header string (e.g. "session_token=abc; other=xyz")
 */
export async function getCookieHeader(): Promise<string> {
  const cookieStore = await cookies();
  return cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Get the base URL server components use to call this app's **own** API.
 *
 * This is an internal address, not a public one. The two diverge whenever the
 * app is reached through something the server itself cannot use:
 *
 * - A local reverse proxy terminating TLS with a certificate Node does not
 *   trust (Herd, Valet, mkcert). The browser is happy; `fetch` from the server
 *   fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, and every server-rendered
 *   page that loads data comes back empty.
 * - A private network where the public hostname resolves somewhere else.
 *
 * Even when the public URL does work, routing a self-call through it is a
 * pointless round trip out to the proxy and back.
 *
 * Resolution order:
 * 1. `INTERNAL_API_URL` — explicit, wins everywhere. Set this in production if
 *    the public URL is not reachable from inside the server.
 * 2. Loopback, in development only, when the port is known. `npm run dev` sets
 *    `PORT` on the server process (see `scripts/dev-server.mjs`), so this is
 *    the normal path for a proxied local setup.
 * 3. `BETTER_AUTH_URL` — the historical behaviour, and correct whenever the
 *    public URL is reachable from the server (the usual production case).
 *
 * **Do not use this to build a URL someone else has to call** — use
 * {@link getPublicUrl} for that. This address may be loopback-only.
 *
 * @returns Base URL without trailing slash (e.g. "http://127.0.0.1:3010")
 */
export function getBaseUrl(): string {
  const explicit = env.INTERNAL_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  // A port that is not a plain number cannot be trusted to address this app —
  // fall through to the public URL rather than send cookie-bearing self-calls
  // to a guess. (`npm run dev -- -p 4100` also leaves PORT pointing elsewhere,
  // which is the same problem.)
  const port = process.env.PORT;
  if (process.env.NODE_ENV === 'development' && port && /^\d{1,5}$/.test(port)) {
    return `http://127.0.0.1:${port}`;
  }

  return env.BETTER_AUTH_URL;
}

/**
 * Get the app's **public** base URL — the address other people and other
 * systems reach it on.
 *
 * Use this for anything that leaves the server and must be resolvable
 * elsewhere: a webhook endpoint an operator pastes into Slack, a link in an
 * email, a URL rendered for a user to copy. {@link getBaseUrl} is the wrong
 * function for those — in development it is loopback, so the resulting URL
 * would be unreachable from anywhere but this machine.
 *
 * @returns Base URL without trailing slash (e.g. "https://app.example.com")
 */
export function getPublicUrl(): string {
  return env.BETTER_AUTH_URL;
}

/**
 * Fetch an internal API route from a server component with cookie forwarding.
 *
 * - Automatically forwards the current request's cookies
 * - Constructs absolute URL from the relative path
 * - Disables caching by default (server components should see fresh data)
 *
 * @param path - Relative API path (e.g. "/api/v1/admin/stats")
 * @param init - Optional fetch init (merged with cookie headers)
 * @returns Fetch Response
 *
 * @example
 * ```typescript
 * // Simple GET
 * const res = await serverFetch('/api/v1/admin/stats');
 *
 * // With query params
 * const res = await serverFetch('/api/v1/users?limit=20&sortBy=createdAt');
 *
 * // POST with body
 * const res = await serverFetch('/api/v1/users/invite', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ email: 'user@example.com' }),
 * });
 * ```
 */
export async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  const cookieHeader = await getCookieHeader();
  const baseUrl = getBaseUrl();

  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Cookie: cookieHeader,
      ...init?.headers,
    },
    cache: init?.cache ?? 'no-store',
  });
}
