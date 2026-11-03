/**
 * <Waitlist /> server wrapper tests (§125 t-974)
 *
 * It reads the waitlist through `GET /api/v1/waitlist` (API-first), renders
 * nothing when the app has none or the answer cannot be read, refuses an
 * undeclared list, and hands the form the list's open state and the fields.
 *
 * @see components/waitlist/waitlist.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockServerFetch, mockLogger, incoming } = vi.hoisted(() => ({
  mockServerFetch: vi.fn(),
  incoming: { headers: new Headers() },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/api/server-fetch', () => ({ serverFetch: mockServerFetch }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(incoming.headers) }));

import { Waitlist } from '@/components/waitlist/waitlist';

const FIELDS = [
  { key: 'role', label: 'Role', kind: 'select', options: [{ value: 'dj', label: 'DJ' }] },
];

function answer(data: unknown, status = 200) {
  mockServerFetch.mockResolvedValue(
    Response.json(status === 200 ? { success: true, data } : { success: false, error: {} }, {
      status,
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  incoming.headers = new Headers();
});

describe('<Waitlist />', () => {
  it('asks the public waitlist API as the visitor, so the IP-keyed limit is theirs', async () => {
    // Arrange — the visitor's request reached the page through a proxy
    incoming.headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1', cookie: 'x=1' });
    answer({ lists: [{ key: 'default', open: true }], fields: [] });

    // Act
    await Waitlist({});

    // Assert — the address headers, and nothing else of the visitor's
    expect(mockServerFetch).toHaveBeenCalledWith('/api/v1/waitlist', {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    });
  });

  it('renders nothing and logs when the API cannot be reached', async () => {
    mockServerFetch.mockRejectedValue(new TypeError('fetch failed'));
    expect(await Waitlist({})).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith('<Waitlist> could not reach the waitlist API', {
      error: 'fetch failed',
    });
  });

  it('renders nothing for a 200 that is not JSON (an HTML proxy page)', async () => {
    mockServerFetch.mockResolvedValue(new Response('<html>oops</html>', { status: 200 }));
    expect(await Waitlist({})).toBeNull();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('renders nothing, and logs nothing, when the app has no waitlist (404)', async () => {
    answer(null, 404);
    expect(await Waitlist({})).toBeNull();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('renders nothing and logs when the API fails', async () => {
    answer(null, 500);
    expect(await Waitlist({})).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith('<Waitlist> could not read the waitlist', {
      status: 500,
    });
  });

  it('renders nothing for an answer that does not match the contract', async () => {
    answer({ lists: 'not-an-array', fields: [] });
    expect(await Waitlist({})).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      '<Waitlist> got a waitlist response it could not read'
    );
  });

  it('renders nothing for a list the app does not declare', async () => {
    answer({ lists: [{ key: 'default', open: true }], fields: [] });
    expect(await Waitlist({ list: 'nope' })).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('defaults to the first list and hands the form its closed state and the fields', async () => {
    answer({
      lists: [
        { key: 'alpha', open: false },
        { key: 'beta', open: true },
      ],
      fields: FIELDS,
    });

    const element = await Waitlist({ copy: { submitLabel: 'Go' } });

    expect(element?.props).toEqual({
      fields: FIELDS,
      list: 'alpha',
      closed: true,
      copy: { submitLabel: 'Go' },
      className: undefined,
    });
  });

  it('a named list uses that list’s state', async () => {
    answer({
      lists: [
        { key: 'alpha', open: false },
        { key: 'beta', open: true },
      ],
      fields: [],
    });

    const element = await Waitlist({ list: 'beta', className: 'my-form' });

    expect(element?.props).toMatchObject({ list: 'beta', closed: false, className: 'my-form' });
  });
});
