/**
 * Server-component data loading that tells "failed" apart from "empty".
 *
 * Admin pages used to wrap each `serverFetch` in a try/catch that returned
 * `[]` or `null` on any failure. A 500, a timeout or a misconfigured base URL
 * then looked exactly like an empty table ("No users found") or, on a detail
 * page, like a 404 — with nothing on screen and often nothing in the log
 * (#518). These two helpers are the replacement:
 *
 * - {@link loadServerData} never throws. It returns the data, or a typed
 *   failure the page can render, and logs every failure. Use it for a
 *   secondary panel the rest of the page can live without, and render
 *   `<LoadFailedNotice>` in that panel's place.
 * - {@link requireServerData} returns the data or throws. Use it for the data
 *   a page exists to show. The throw reaches the route's error boundary, whose
 *   "Try again" re-fetches. With `{ notFound: true }`, a genuine 404 from the
 *   API renders the not-found page instead — and only a 404 does.
 *
 * @see components/admin/load-failed-notice.tsx
 */

import { notFound } from 'next/navigation';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

/** Why a load produced no data. */
export type LoadFailure =
  /** The API answered 404: the thing asked for does not exist. */
  | { kind: 'not_found' }
  /** Anything else: the data exists, or may, and could not be read. */
  | {
      kind: 'failed';
      /** HTTP status, or `null` when no response arrived. */
      status: number | null;
      /** The API's error code, when it sent one. */
      code: string | null;
    };

export type LoadResult<T> =
  { ok: true; data: T; meta: unknown } | { ok: false; failure: LoadFailure };

/**
 * Thrown by {@link requireServerData} when a page's main data cannot be
 * loaded. Next replaces the message with a digest in production, so it is
 * for logs and development only.
 */
export class ServerLoadError extends Error {
  constructor(
    readonly path: string,
    readonly failure: LoadFailure
  ) {
    const status = failure.kind === 'failed' ? (failure.status ?? 'no response') : 404;
    super(`Could not load ${path} (${status})`);
    this.name = 'ServerLoadError';
  }
}

/**
 * Load an internal API route from a server component.
 *
 * Every `failed` result is logged here, so a caller never needs its own
 * catch-and-log. A `not_found` is not logged: whether a 404 is expected is
 * the caller's to decide. A 400 is logged as a warning, not an error: on a
 * detail page it is usually an id the API rejected as malformed.
 */
export async function loadServerData<T>(path: string, init?: RequestInit): Promise<LoadResult<T>> {
  let res: Response;
  try {
    res = await serverFetch(path, init);
  } catch (err) {
    logger.error('Server data load failed: no response', err, { path });
    return { ok: false, failure: { kind: 'failed', status: null, code: null } };
  }

  if (res.status === 404) return { ok: false, failure: { kind: 'not_found' } };

  let body;
  try {
    body = await parseApiResponse<T>(res);
  } catch (err) {
    logger.error('Server data load failed: unreadable response', err, {
      path,
      status: res.status,
    });
    return { ok: false, failure: { kind: 'failed', status: res.status, code: null } };
  }

  if (!res.ok || !body.success) {
    const code = body.success ? null : (body.error.code ?? null);
    const meta = { path, status: res.status, code };
    if (res.status === 400) logger.warn('Server data load rejected as a bad request', meta);
    else logger.error('Server data load failed', undefined, meta);
    return { ok: false, failure: { kind: 'failed', status: res.status, code } };
  }

  return { ok: true, data: body.data, meta: body.meta };
}

/**
 * Load a page's main data, or stop rendering the page.
 *
 * @param options.notFound - Render the not-found page when the API answers
 *   404, or 400: the detail routes validate their id, so a malformed one is
 *   answered 400 and identifies nothing. For a detail page whose id comes
 *   from the URL. Without it either is a failure like any other: a list
 *   endpoint that 404s is misconfigured.
 * @throws {ServerLoadError} when the data cannot be loaded.
 */
export async function requireServerData<T>(
  path: string,
  options: { notFound?: boolean; init?: RequestInit } = {}
): Promise<{ data: T; meta: unknown }> {
  const result = await loadServerData<T>(path, options.init);
  if (result.ok) return { data: result.data, meta: result.meta };

  const { failure } = result;
  const isBadRequest = failure.kind === 'failed' && failure.status === 400;
  if (options.notFound && (failure.kind === 'not_found' || isBadRequest)) notFound();

  if (failure.kind === 'not_found') {
    logger.error('Server data load failed: 404 from an endpoint expected to exist', undefined, {
      path,
    });
  }
  throw new ServerLoadError(path, failure);
}
