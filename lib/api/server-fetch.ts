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

export { parseApiResponse } from './parse-response';

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
 * Get the application base URL for internal API calls.
 *
 * Uses BETTER_AUTH_URL (always set via env validation) so that
 * server components can construct absolute URLs for fetch.
 *
 * @returns Base URL without trailing slash (e.g. "http://localhost:3000")
 */
export function getBaseUrl(): string {
  return env.BETTER_AUTH_URL;
}

/**
 * Fetch an internal API route from a server component with cookie forwarding.
 *
 * **WARNING: Do NOT use this to call this app's own API routes from server
 * components.** Self-referential HTTP calls break async context isolation
 * under concurrent SSR, causing intermittent auth failures. Query Prisma
 * or call helper functions directly instead.
 * See `.context/architecture/data-fetching.md` for details.
 *
 * This function is appropriate for:
 * - Client-initiated fetches that happen to run on the server
 * - Calling external third-party APIs with cookie forwarding
 *
 * - Automatically forwards the current request's cookies
 * - Constructs absolute URL from the relative path
 * - Disables caching by default (server components should see fresh data)
 *
 * @param path - Relative API path (e.g. "/api/v1/admin/stats")
 * @param init - Optional fetch init (merged with cookie headers)
 * @returns Fetch Response
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
