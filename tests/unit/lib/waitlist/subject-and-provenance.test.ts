/**
 * Unit tests: the waitlist subject matcher, provenance reducers, list state
 * and join schema (§125 t-974)
 *
 * @see lib/waitlist/subject.ts
 * @see lib/waitlist/provenance.ts
 * @see lib/waitlist/lists.ts
 * @see lib/validations/waitlist.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { waitlistListState: { findFirst: vi.fn(), findMany: vi.fn() } },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

import { waitlistEntriesOf, waitlistEntriesUnder } from '@/lib/waitlist/subject';
import { localeFromAcceptLanguage, referrerHost } from '@/lib/waitlist/provenance';
import { isWaitlistListOpen } from '@/lib/waitlist/lists';
import { buildWaitlistJoinSchema } from '@/lib/validations/waitlist';
import type { ResolvedWaitlistConfig } from '@/lib/waitlist/config';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('waitlistEntriesOf', () => {
  it('a verified account matches its linked entries and its normalised address, exactly', () => {
    expect(
      waitlistEntriesOf({ userId: 'u1', email: '  A_b%C@Example.com ', emailVerified: true })
    ).toEqual({ OR: [{ userId: 'u1' }, { email: 'a_b%c@example.com' }] });
  });

  it('an unverified account matches only what is linked to it, never the address', () => {
    // anyone can open an account under someone else's address
    const where = waitlistEntriesOf({ userId: 'u1', email: 'a@example.com', emailVerified: false });
    expect(where).toEqual({ userId: 'u1' });
    expect(JSON.stringify(where)).not.toContain('a@example.com');
  });

  it('never asks for a case-insensitive match', () => {
    const where = waitlistEntriesOf({ userId: 'u1', email: 'a@example.com', emailVerified: true });
    expect(JSON.stringify(where)).not.toContain('insensitive');
    expect(waitlistEntriesUnder(' X@Y.com')).toEqual({ email: 'x@y.com' });
  });
});

describe('localeFromAcceptLanguage', () => {
  it.each([
    ['en-GB,en;q=0.9', 'en-GB'],
    ['fr', 'fr'],
    ['zh-Hant-TW;q=0.8', 'zh-Hant-TW'],
    [null, null],
    ['', null],
    ['*', null],
    ['<script>', null],
    ['en-' + 'x'.repeat(60), null],
  ])('%j → %j', (header, expected) => {
    expect(localeFromAcceptLanguage(header)).toBe(expected);
  });
});

describe('referrerHost', () => {
  it.each([
    ['https://blog.example.org/post?id=tracking', 'blog.example.org'],
    ['http://localhost:3000/x', 'localhost'],
    ['javascript:alert(1)', null],
    ['not a url', null],
    [null, null],
  ])('%j → %j', (referrer, expected) => {
    expect(referrerHost(referrer)).toBe(expected);
  });
});

describe('isWaitlistListOpen', () => {
  const config: ResolvedWaitlistConfig = {
    consentVersion: 'v1',
    fields: [],
    lists: [{ key: 'open' }, { key: 'shut', startsClosed: true }],
    screen: null,
  };

  it('with no stored row, follows the config’s starting state', async () => {
    mockPrisma.waitlistListState.findFirst.mockResolvedValue(null);
    expect(await isWaitlistListOpen(config, 'open')).toBe(true);
    expect(await isWaitlistListOpen(config, 'shut')).toBe(false);
  });

  it('a stored row wins either way, so a redeploy never re-opens a list an admin closed', async () => {
    mockPrisma.waitlistListState.findFirst.mockResolvedValue({ open: false });
    expect(await isWaitlistListOpen(config, 'open')).toBe(false);
    mockPrisma.waitlistListState.findFirst.mockResolvedValue({ open: true });
    expect(await isWaitlistListOpen(config, 'shut')).toBe(true);
  });

  it('an undeclared list is never open, even with a stale row saying so', async () => {
    mockPrisma.waitlistListState.findFirst.mockResolvedValue({ open: true });
    expect(await isWaitlistListOpen(config, 'removed-from-config')).toBe(false);
    expect(mockPrisma.waitlistListState.findFirst).not.toHaveBeenCalled();
  });
});

describe('buildWaitlistJoinSchema', () => {
  const schema = buildWaitlistJoinSchema(
    [
      { key: 'bio', label: 'Bio', kind: 'textarea', maxLength: 10 },
      { key: 'role', label: 'Role', kind: 'text', required: true },
    ],
    ['default']
  );

  it('normalises the address and defaults the only list', () => {
    const parsed = schema.parse({ email: ' A@B.COM ', details: { role: 'x' } });
    expect(parsed.email).toBe('a@b.com');
    expect(parsed.list).toBe('default');
    expect(parsed.name).toBeNull();
  });

  it('drops empty optional answers rather than storing empty strings', () => {
    const parsed = schema.parse({ email: 'a@b.com', details: { role: 'x', bio: '   ' } });
    expect(parsed.details).toEqual({ role: 'x' });
  });

  it('enforces required and maxLength', () => {
    expect(schema.safeParse({ email: 'a@b.com', details: {} }).success).toBe(false);
    expect(schema.safeParse({ email: 'a@b.com', details: { role: '  ' } }).success).toBe(false);
    expect(
      schema.safeParse({ email: 'a@b.com', details: { role: 'x', bio: '12345678901' } }).success
    ).toBe(false);
  });

  it('caps attribution values', () => {
    expect(
      schema.safeParse({ email: 'a@b.com', details: { role: 'x' }, utm_source: 'u'.repeat(101) })
        .success
    ).toBe(false);
  });
});
