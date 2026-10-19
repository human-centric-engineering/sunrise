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
 *   "Try again" re-fetches. With `{ notFound: true }`, a 404 from the API, or
 *   a 400 that rejected the id itself, renders the not-found page instead.
 *
 * @see components/admin/load-failed-notice.tsx
 */

import { notFound, unstable_rethrow } from 'next/navigation';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { parsePaginationMeta } from '@/lib/validations/common';

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
 * The field names a 400's validation details name.
 *
 * The routes reject input in two shapes: `validatePathParam` and hand-rolled
 * checks send `{ id: [...] }`, and `validateQueryParams` sends
 * `{ errors: [{ path: 'id', ... }] }`. Anything else names no fields.
 */
function invalidFields(details: unknown): string[] {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return [];
  const fields: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (key !== 'errors') {
      fields.push(key);
      continue;
    }
    if (!Array.isArray(value)) continue;
    const issues: unknown[] = value;
    for (const issue of issues) {
      if (typeof issue === 'object' && issue !== null && 'path' in issue) {
        if (typeof issue.path === 'string') fields.push(issue.path);
      }
    }
  }
  return fields;
}

/** A load's result, plus whether a 400 rejected only the `id`. */
interface FetchOutcome<T> {
  result: LoadResult<T>;
  idRejected: boolean;
}

/**
 * {@link loadServerData} without its 404 logging, which differs per caller.
 * A failed response whose status is in `expected` is returned unlogged.
 */
async function fetchServerData<T>(
  path: string,
  init?: RequestInit,
  expected: readonly number[] = []
): Promise<FetchOutcome<T>> {
  let res: Response;
  try {
    res = await serverFetch(path, init);
  } catch (err) {
    // `cookies()` inside serverFetch throws Next's own control-flow errors
    // (e.g. the bailout that makes a route dynamic). Those must propagate.
    unstable_rethrow(err);
    logger.error('Server data load failed: no response', err, { path });
    return {
      result: { ok: false, failure: { kind: 'failed', status: null, code: null } },
      idRejected: false,
    };
  }

  if (res.status === 404)
    return { result: { ok: false, failure: { kind: 'not_found' } }, idRejected: false };

  let body;
  try {
    body = await parseApiResponse<T>(res);
  } catch (err) {
    logger.error('Server data load failed: unreadable response', err, {
      path,
      status: res.status,
    });
    return {
      result: { ok: false, failure: { kind: 'failed', status: res.status, code: null } },
      idRejected: false,
    };
  }

  if (!res.ok || !body.success) {
    const code = body.success ? null : (body.error.code ?? null);
    const meta = { path, status: res.status, code };
    // A status the caller expects is an answer it handles itself: not logged.
    if (!expected.includes(res.status)) {
      if (res.status === 400) logger.warn('Server data load rejected as a bad request', meta);
      else logger.error('Server data load failed', undefined, meta);
    }
    const fields = body.success ? [] : invalidFields(body.error.details);
    return {
      result: { ok: false, failure: { kind: 'failed', status: res.status, code } },
      idRejected:
        res.status === 400 &&
        code === 'VALIDATION_ERROR' &&
        fields.length > 0 &&
        fields.every((field) => field === 'id'),
    };
  }

  return { result: { ok: true, data: body.data, meta: body.meta }, idRejected: false };
}

/**
 * Load an internal API route from a server component.
 *
 * Every failure is logged here, so a caller never needs its own
 * catch-and-log. A 400 or a 404 is logged as a warning, not an error: a 400 is
 * usually a malformed id or filter from the URL, and a 404 may be a record
 * that was just deleted.
 *
 * @param options.expected - Statuses the caller treats as an answer, not a
 *   failure, such as a 403 from a route only some viewers may read. They are
 *   still returned as `failed`, and are not logged.
 */
export async function loadServerData<T>(
  path: string,
  options: { init?: RequestInit; expected?: readonly number[] } = {}
): Promise<LoadResult<T>> {
  const { result } = await fetchServerData<T>(path, options.init, options.expected);
  const expected = options.expected ?? [];
  if (!result.ok && result.failure.kind === 'not_found' && !expected.includes(404)) {
    logger.warn('Server data load failed: not found', { path, status: 404 });
  }
  return result;
}

/**
 * Load a page's main data, or stop rendering the page.
 *
 * @param options.notFound - Render the not-found page when the API answers
 *   404, or a 400 whose validation error names only the `id`: the detail
 *   routes validate their id, so a malformed one identifies nothing. Any other
 *   400 is still a failure. For a detail page whose id comes from the URL.
 *   Without it, either is a failure like any other: a list endpoint that 404s
 *   is misconfigured.
 * @throws {ServerLoadError} when the data cannot be loaded.
 */
export async function requireServerData<T>(
  path: string,
  options: { notFound?: boolean; init?: RequestInit } = {}
): Promise<{ data: T; meta: unknown }> {
  const { result, idRejected } = await fetchServerData<T>(path, options.init);
  if (result.ok) return { data: result.data, meta: result.meta };

  const { failure } = result;
  if (options.notFound && (failure.kind === 'not_found' || idRejected)) notFound();

  if (failure.kind === 'not_found') {
    logger.error('Server data load failed: 404 from an endpoint expected to exist', undefined, {
      path,
    });
  }
  throw new ServerLoadError(path, failure);
}

/** The most rows the list routes return per page (`paginationQuerySchema`). */
const MAX_PAGE_SIZE = 100;

/**
 * Load every row of a paginated list route, or stop rendering the page.
 *
 * For options a form must offer in full: past one page, a list that stops
 * short drops the very row a record is set to, and nothing on screen says so.
 * Rows are de-duplicated by `id`, since a row created between two requests
 * shifts onto the next page as well.
 *
 * @param path - The list route, with or without its own query string.
 * @throws {ServerLoadError} when any page fails, or a page has no pagination
 *   meta (then there is no telling whether the list is complete).
 */
export async function requireAllServerData<T extends { id: string }>(path: string): Promise<T[]> {
  const separator = path.includes('?') ? '&' : '?';
  const rows: T[] = [];
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    const pagePath = `${path}${separator}page=${page}&limit=${MAX_PAGE_SIZE}`;
    const { data, meta } = await requireServerData<T[]>(pagePath);
    for (const row of data) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    const pagination = parsePaginationMeta(meta);
    if (!pagination) {
      logger.error('Server data load failed: list has no pagination meta', undefined, {
        path: pagePath,
      });
      throw new ServerLoadError(pagePath, { kind: 'failed', status: 200, code: null });
    }
    if (page >= pagination.totalPages || data.length === 0) return rows;
  }
}
