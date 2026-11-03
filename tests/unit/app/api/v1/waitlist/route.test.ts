/**
 * Unit tests: GET / POST /api/v1/waitlist (§125 t-974)
 *
 * Runs the REAL config resolution, schema and join service against a mocked
 * Prisma, so the rules are tested where they are enforced: the route's answer
 * for every kind of accepted join is compared byte for byte, and what reached
 * the database is asserted, not just that something was called.
 *
 * @see app/api/v1/waitlist/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import type { WaitlistConfig } from '@/lib/waitlist/config';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const { mockPrisma, mockLimiterCheck, seen } = vi.hoisted(() => ({
  mockPrisma: {
    waitlistEntry: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    waitlistListState: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
  mockLimiterCheck: vi.fn(),
  /** The tenant context each Prisma call ran in. */
  seen: {
    orgs: [] as Array<string | null | undefined>,
    /** The context reader of the module instance the loaded route uses. */
    context: (): { orgId: string | null } | null => null,
  },
}));

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

vi.mock('@/lib/security/rate-limit', () => ({
  waitlistLimiter: { check: mockLimiterCheck },
  getRateLimitHeaders: () => ({ 'X-RateLimit-Limit': '5', 'X-RateLimit-Remaining': '4' }),
  createRateLimitResponse: () =>
    Response.json(
      { success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' } },
      { status: 429 }
    ),
}));

const BASE_CONFIG: WaitlistConfig = {
  consentVersion: '2026-11-01',
  fields: [
    {
      key: 'role',
      label: 'Role',
      kind: 'select',
      options: [
        { value: 'producer', label: 'Producer' },
        { value: 'dj', label: 'DJ' },
      ],
    },
    { key: 'useCase', label: 'Use case', kind: 'textarea' },
  ],
};

/** Load the route with this config in the seam (null = the shipped default). */
async function loadRoute(config: WaitlistConfig | null) {
  vi.resetModules();
  vi.doMock('@/lib/app/waitlist-config', () => ({ waitlistConfig: config }));
  const route = await import('@/app/api/v1/waitlist/route');
  const { __resetWaitlistConfigForTests } = await import('@/lib/waitlist/config');
  __resetWaitlistConfigForTests();
  seen.context = (await import('@/lib/tenancy/context')).getTenantContext;
  return route;
}

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new Request('http://localhost:3000/api/v1/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

/** Status, body and every header: what a stranger could compare between two joins. */
async function snapshot(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    headers: [...res.headers.entries()].sort(),
  };
}

const STORED = {
  id: 'entry-1',
  name: 'Ada',
  details: { role: 'producer' },
  confirmedAt: null as Date | null,
  removedAt: null as Date | null,
  flaggedReason: null as string | null,
  updatedAt: new Date('2026-11-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  seen.orgs = [];
  mockLimiterCheck.mockReturnValue({ success: true, limit: 5, remaining: 4, reset: 0 });
  const record = <T>(value: T) =>
    vi.fn(() => {
      seen.orgs.push(seen.context()?.orgId);
      return Promise.resolve(value);
    });
  mockPrisma.waitlistEntry.findFirst.mockImplementation(record(null));
  mockPrisma.waitlistEntry.create.mockImplementation(record({ id: 'entry-new' }));
  mockPrisma.waitlistEntry.updateMany.mockImplementation(record({ count: 1 }));
  mockPrisma.waitlistListState.findFirst.mockImplementation(record(null));
  mockPrisma.waitlistListState.findMany.mockImplementation(record([]));
});

describe('with the shipped (empty) config', () => {
  it('POST answers 404 and writes nothing', async () => {
    // Arrange
    const { POST } = await loadRoute(null);

    // Act
    const res = await POST(post({ email: 'a@example.com' }));

    // Assert — not even the rate limiter is consulted: the route does not exist
    expect(res.status).toBe(404);
    expect(mockLimiterCheck).not.toHaveBeenCalled();
    expect(mockPrisma.waitlistEntry.create).not.toHaveBeenCalled();
    expect(mockPrisma.waitlistEntry.findFirst).not.toHaveBeenCalled();
  });

  it('GET answers 404', async () => {
    const { GET } = await loadRoute(null);
    expect((await GET()).status).toBe(404);
  });

  it('an invalid config is the same as none: 404, nothing written', async () => {
    // Arrange — a select with no options; a half-working form would be worse
    const { POST } = await loadRoute({
      consentVersion: 'v1',
      fields: [{ key: 'role', label: 'Role', kind: 'select' }],
    });

    // Act
    const res = await POST(post({ email: 'a@example.com' }));

    // Assert
    expect(res.status).toBe(404);
    expect(mockPrisma.waitlistEntry.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/waitlist', () => {
  it('a first join writes an unconfirmed entry in the install org, with its provenance', async () => {
    // Arrange
    const { POST } = await loadRoute(BASE_CONFIG);

    // Act
    const res = await POST(
      post(
        {
          email: '  Ada@Example.COM ',
          name: ' Ada ',
          details: { role: 'producer', useCase: ' sampling ' },
          utm_source: 'instagram',
          utm_medium: 'social',
          utm_campaign: 'launch',
          referrer: 'https://blog.example.org/post?id=secret-tracking-id',
        },
        { 'accept-language': 'en-GB,en;q=0.9' }
      )
    );

    // Assert — the stored row (HB9: nothing reads it yet, so this is the proof)
    expect(res.status).toBe(200);
    expect(mockPrisma.waitlistEntry.create).toHaveBeenCalledTimes(1);
    const [{ data }] = mockPrisma.waitlistEntry.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(data).toEqual({
      email: 'ada@example.com',
      name: 'Ada',
      list: 'default',
      details: { role: 'producer', useCase: 'sampling' },
      source: 'form',
      locale: 'en-GB',
      utmSource: 'instagram',
      utmMedium: 'social',
      utmCampaign: 'launch',
      // the host only: the path and query of the referring page are not kept
      referrerHost: 'blog.example.org',
      consentedAt: expect.any(Date),
      consentVersion: '2026-11-01',
      flaggedReason: null,
    });
    expect(data).not.toHaveProperty('confirmedAt');
    // every read and write ran inside the install org
    expect(seen.orgs.length).toBeGreaterThan(0);
    expect(new Set(seen.orgs)).toEqual(new Set([INSTALL_ORG_ID]));
  });

  it('answers every accepted join identically: first, repeat, confirmed repeat, removed, flagged, honeypot', async () => {
    // Arrange — the joins a stranger could compare to learn whether an address is listed
    const flagging: WaitlistConfig = {
      ...BASE_CONFIG,
      screen: () => ({ action: 'flag', reason: 'disposable-domain' }),
    };
    const scenarios: Array<{
      name: string;
      config: WaitlistConfig;
      existing: unknown;
      body: unknown;
    }> = [
      { name: 'first join', config: BASE_CONFIG, existing: null, body: { email: 'a@example.com' } },
      {
        name: 'unconfirmed repeat',
        config: BASE_CONFIG,
        existing: STORED,
        body: { email: 'a@example.com' },
      },
      {
        name: 'confirmed repeat',
        config: BASE_CONFIG,
        existing: { ...STORED, confirmedAt: new Date() },
        body: { email: 'a@example.com', details: { useCase: 'x' } },
      },
      {
        name: 'removed re-join',
        config: BASE_CONFIG,
        existing: { ...STORED, removedAt: new Date() },
        body: { email: 'a@example.com' },
      },
      { name: 'flagged', config: flagging, existing: null, body: { email: 'a@example.com' } },
      {
        name: 'honeypot',
        config: BASE_CONFIG,
        existing: null,
        body: { email: 'a@example.com', website: 'http://spam.example' },
      },
    ];

    // Act
    const answers: Array<{ name: string; snap: Awaited<ReturnType<typeof snapshot>> }> = [];
    for (const s of scenarios) {
      mockPrisma.waitlistEntry.findFirst.mockResolvedValueOnce(s.existing);
      const { POST } = await loadRoute(s.config);
      answers.push({ name: s.name, snap: await snapshot(await POST(post(s.body))) });
    }

    // Assert — one answer, and it is the success answer
    const [first] = answers;
    expect(first.snap.status).toBe(200);
    for (const a of answers) expect(a.snap, a.name).toEqual(first.snap);
  });

  it('decides the honeypot on its value: null and empty are a person, anything else a bot', async () => {
    const { POST } = await loadRoute(BASE_CONFIG);

    // A person whose form sent website: null — must be written, not swallowed
    await POST(post({ email: 'a@example.com', website: null }));
    await POST(post({ email: 'b@example.com', website: '' }));
    expect(mockPrisma.waitlistEntry.create).toHaveBeenCalledTimes(2);

    // Bots — a string, or a non-string the schema would have rejected
    mockPrisma.waitlistEntry.create.mockClear();
    const bot = await POST(post({ email: 'c@example.com', website: 'x' }));
    await POST(post({ email: 'd@example.com', website: 42 }));
    await POST(post({ email: 'not-an-email', website: 'x' }));
    expect(bot.status).toBe(200);
    expect(mockPrisma.waitlistEntry.create).not.toHaveBeenCalled();
    expect(mockPrisma.waitlistEntry.findFirst).toHaveBeenCalledTimes(2); // only the two people
  });

  it('refuses a closed list with WAITLIST_CLOSED, and writes nothing', async () => {
    // Arrange — an admin closed it (the stored row wins over the config's open default)
    mockPrisma.waitlistListState.findFirst.mockResolvedValue({ open: false });
    const { POST } = await loadRoute(BASE_CONFIG);

    // Act
    const res = await POST(post({ email: 'a@example.com' }));

    // Assert
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, error: { code: 'WAITLIST_CLOSED' } });
    expect(mockPrisma.waitlistEntry.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('a list declared startsClosed refuses joins until a stored row opens it', async () => {
    const config: WaitlistConfig = { ...BASE_CONFIG, lists: [{ key: 'beta', startsClosed: true }] };

    // No row: the config's starting state — closed
    let { POST } = await loadRoute(config);
    expect((await POST(post({ email: 'a@example.com' }))).status).toBe(409);

    // An admin opened it: the row wins
    mockPrisma.waitlistListState.findFirst.mockResolvedValue({ open: true });
    ({ POST } = await loadRoute(config));
    expect((await POST(post({ email: 'a@example.com' }))).status).toBe(200);
    expect(mockPrisma.waitlistEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ list: 'beta' }),
    });
  });

  it('rejects an undeclared list, an undeclared answer, and a bad select value with 400', async () => {
    const { POST } = await loadRoute({
      ...BASE_CONFIG,
      lists: [{ key: 'alpha' }, { key: 'beta' }],
    });

    const cases = [
      { email: 'a@example.com' }, // two lists, none named
      { email: 'a@example.com', list: 'gamma' },
      { email: 'a@example.com', list: 'alpha', details: { favouriteColour: 'red' } },
      { email: 'a@example.com', list: 'alpha', details: { role: 'astronaut' } },
    ];
    for (const body of cases) {
      const res = await POST(post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(mockPrisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('answers malformed JSON and a non-object body with 400', async () => {
    const { POST } = await loadRoute(BASE_CONFIG);
    expect((await POST(post('{not json'))).status).toBe(400);
    expect((await POST(post('[1,2]'))).status).toBe(400);
  });

  it('answers 429 over the per-IP cap, before reading the body', async () => {
    // Arrange
    mockLimiterCheck.mockReturnValue({ success: false, limit: 5, remaining: 0, reset: 0 });
    const { POST } = await loadRoute(BASE_CONFIG);

    // Act
    const res = await POST(post({ email: 'a@example.com' }));

    // Assert — keyed on the caller's IP
    expect(res.status).toBe(429);
    expect(mockLimiterCheck).toHaveBeenCalledWith('203.0.113.7');
    expect(mockPrisma.waitlistEntry.create).not.toHaveBeenCalled();
  });

  it('a concurrent first join for the same address is treated as a repeat, not a 500', async () => {
    // Arrange — the create loses the race on the unique key; the re-read finds the winner
    const collision = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: {
        modelName: 'WaitlistEntry',
        driverAdapterError: {
          cause: { constraint: { index: 'waitlist_entry_orgId_list_email_key' } },
        },
      },
    });
    mockPrisma.waitlistEntry.create.mockRejectedValueOnce(collision);
    mockPrisma.waitlistEntry.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(STORED);
    const { POST } = await loadRoute(BASE_CONFIG);

    // Act
    const res = await POST(post({ email: 'a@example.com', name: 'Second' }));

    // Assert — answered as any join, and applied to the winner's row
    expect(res.status).toBe(200);
    expect(mockPrisma.waitlistEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'entry-1' }) })
    );
  });

  it('never logs the address', async () => {
    // Arrange
    const { getRouteLogger } = await import('@/lib/api/context');
    const { POST } = await loadRoute(BASE_CONFIG);

    // Act
    await POST(post({ email: 'secret.person@example.com' }));
    await POST(post({ email: 'secret.person@example.com', website: 'bot' }));

    // Assert — a log of strangers' addresses is a copy of the list
    const log = await vi.mocked(getRouteLogger).mock.results[0]?.value;
    const calls = [...vi.mocked(log.info).mock.calls, ...vi.mocked(log.warn).mock.calls];
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).not.toContain('secret.person');
  });
});

describe('GET /api/v1/waitlist', () => {
  it('lists each declared list with its open state, the stored row winning', async () => {
    // Arrange
    mockPrisma.waitlistListState.findMany.mockResolvedValue([{ list: 'alpha', open: false }]);
    const { GET } = await loadRoute({
      ...BASE_CONFIG,
      lists: [{ key: 'alpha' }, { key: 'beta', startsClosed: true }, { key: 'gamma' }],
    });

    // Act
    const res = await GET();

    // Assert
    expect(await res.json()).toEqual({
      success: true,
      data: {
        lists: [
          { key: 'alpha', open: false },
          { key: 'beta', open: false },
          { key: 'gamma', open: true },
        ],
      },
    });
  });
});
