/**
 * Unit Tests: server-component data loading
 *
 * The property under test is the one #518 was about: a load that fails must
 * never come back looking like a load that returned nothing. Each failure
 * shape (no response, 5xx, success:false, unreadable body, 404) is driven
 * through the real `parseApiResponse`, with only `serverFetch` faked.
 *
 * @see lib/api/server-load.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { notFound } from 'next/navigation';
import { serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { loadServerData, requireServerData, ServerLoadError } from '@/lib/api/server-load';

const PATH = '/api/v1/admin/things';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class NotFoundSignal extends Error {}

beforeEach(() => {
  vi.mocked(serverFetch).mockReset();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
  // The real notFound() throws and never returns; the global mock does not.
  vi.mocked(notFound).mockImplementation(() => {
    throw new NotFoundSignal();
  });
});

describe('loadServerData', () => {
  it('returns the data and meta on success, and logs nothing', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      jsonResponse({ success: true, data: [{ id: 'a' }], meta: { total: 1 } })
    );

    const result = await loadServerData<Array<{ id: string }>>(PATH);

    expect(result).toEqual({ ok: true, data: [{ id: 'a' }], meta: { total: 1 } });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps an empty list a success, distinct from a failure', async () => {
    vi.mocked(serverFetch).mockResolvedValue(jsonResponse({ success: true, data: [] }));

    const result = await loadServerData<unknown[]>(PATH);

    expect(result).toEqual({ ok: true, data: [], meta: undefined });
  });

  it('reports a thrown fetch as failed with no status, and logs it', async () => {
    const err = new TypeError('fetch failed');
    vi.mocked(serverFetch).mockRejectedValue(err);

    const result = await loadServerData(PATH);

    expect(result).toEqual({ ok: false, failure: { kind: 'failed', status: null, code: null } });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), err, { path: PATH });
  });

  it('reports a 500 envelope as failed with its status and code', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500)
    );

    const result = await loadServerData(PATH);

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'failed', status: 500, code: 'INTERNAL_ERROR' },
    });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), undefined, {
      path: PATH,
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('reports success:false on a 200 as failed', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      jsonResponse({ success: false, error: { message: 'nope' } })
    );

    const result = await loadServerData(PATH);

    expect(result).toEqual({ ok: false, failure: { kind: 'failed', status: 200, code: null } });
  });

  it('reports a body that is not an API envelope as failed', async () => {
    // e.g. a proxy's HTML error page
    vi.mocked(serverFetch).mockResolvedValue(
      new Response('<html>Bad Gateway</html>', { status: 502 })
    );

    const result = await loadServerData(PATH);

    expect(result).toEqual({ ok: false, failure: { kind: 'failed', status: 502, code: null } });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('reports a 404 as not_found and leaves logging to the caller', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'NOT_FOUND', message: 'gone' } }, 404)
    );

    const result = await loadServerData(PATH);

    expect(result).toEqual({ ok: false, failure: { kind: 'not_found' } });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('requireServerData', () => {
  it('returns the data on success', async () => {
    vi.mocked(serverFetch).mockResolvedValue(jsonResponse({ success: true, data: { id: 'a' } }));

    await expect(requireServerData(PATH)).resolves.toEqual({ data: { id: 'a' }, meta: undefined });
  });

  it('throws ServerLoadError on a failure rather than returning empty data', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      jsonResponse({ success: false, error: { message: 'boom' } }, 500)
    );

    const error = await requireServerData(PATH).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServerLoadError);
    expect(error).toMatchObject({ path: PATH, failure: { kind: 'failed', status: 500 } });
    expect(notFound).not.toHaveBeenCalled();
  });

  it('renders not-found on a 404 only when asked to', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      jsonResponse({ success: false, error: { message: 'gone' } }, 404)
    );

    await expect(requireServerData(PATH, { notFound: true })).rejects.toBeInstanceOf(
      NotFoundSignal
    );
  });

  it('does not turn a 500 into not-found, even on a detail page', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      jsonResponse({ success: false, error: { message: 'boom' } }, 500)
    );

    await expect(requireServerData(PATH, { notFound: true })).rejects.toBeInstanceOf(
      ServerLoadError
    );
    expect(notFound).not.toHaveBeenCalled();
  });

  it('renders not-found on a 400 when asked to: a malformed id identifies nothing', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'VALIDATION_ERROR', message: 'bad id' } }, 400)
    );

    await expect(requireServerData(PATH, { notFound: true })).rejects.toBeInstanceOf(
      NotFoundSignal
    );
    // A malformed id in a URL is not a server fault: warned, not an error.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      path: PATH,
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  });

  it('throws on a 400 when the caller did not ask for not-found', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      jsonResponse({ success: false, error: { message: 'bad query' } }, 400)
    );

    await expect(requireServerData(PATH)).rejects.toMatchObject({
      failure: { kind: 'failed', status: 400 },
    });
    expect(notFound).not.toHaveBeenCalled();
  });

  it('treats a 404 as a logged failure when the caller did not expect one', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      jsonResponse({ success: false, error: { message: 'gone' } }, 404)
    );

    await expect(requireServerData(PATH)).rejects.toMatchObject({
      failure: { kind: 'not_found' },
    });
    expect(notFound).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), undefined, { path: PATH });
  });
});
