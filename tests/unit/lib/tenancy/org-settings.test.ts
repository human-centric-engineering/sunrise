/**
 * Tests: the platform's slice of `Org.settings` (§108 t-713)
 *
 * The two halves that matter are asymmetric, and the tests say so:
 *
 * - **Reading** is per key. A window that cannot be read is absent, which the
 *   vocabulary already reads as "inherit the global one" — the whole slice is
 *   never discarded over one bad key, because that would silently shorten
 *   every other window an org had asked to lengthen.
 * - **Writing** replaces the `retention` slice and preserves everything else
 *   in the column, which is what a fork keeping its own org config there is
 *   relying on.
 *
 * @see lib/tenancy/org-settings.ts
 * @see lib/validations/tenancy.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mockLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockFindUnique = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({
  prisma: { org: { findUnique: mockFindUnique } },
}));

import {
  ORG_RETENTION_KEY,
  applyRetentionPatch,
  loadOrgRetention,
  readOrgRetention,
} from '@/lib/tenancy/org-settings';

const ORG_A = 'cmorg00000000000000000orga';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readOrgRetention', () => {
  it('reads the windows an org has set, keeping an explicit null as "forever"', () => {
    const slice = readOrgRetention({
      retention: { executionRetentionDays: 365, costLogRetentionDays: null },
    });

    expect(slice).toEqual({ executionRetentionDays: 365, costLogRetentionDays: null });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['an unset column', null],
    ['an absent column', undefined],
    ['a column with no retention slice', { theme: 'dark' }],
    ['an explicitly null slice', { retention: null }],
  ])('returns null for %s, so every window inherits', (_label, settings) => {
    expect(readOrgRetention(settings)).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['settings that are not an object', 'not-json'],
    ['a retention slice that is not an object', { retention: 7 }],
  ])('warns and inherits everything for %s', (_label, settings) => {
    expect(readOrgRetention(settings, { orgId: ORG_A })).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ orgId: ORG_A })
    );
  });

  it('drops ONLY the unreadable window, and says which', () => {
    // The finding this shape exists for: reading the slice as a whole would
    // discard the 365-day execution window over the malformed one beside it,
    // and the org would silently inherit the platform's shorter default —
    // deleting nine months of history on a validation technicality.
    const slice = readOrgRetention(
      {
        retention: {
          executionRetentionDays: 365,
          costLogRetentionDays: 'thirty',
          evaluationRetentionDays: 0,
        },
      },
      { orgId: ORG_A }
    );

    expect(slice).toEqual({ executionRetentionDays: 365 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
      expect.objectContaining({
        orgId: ORG_A,
        keys: expect.arrayContaining(['costLogRetentionDays', 'evaluationRetentionDays']),
      })
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['past the bound', 4000],
    ['a string', '90'],
  ])('refuses %s as a window and inherits that one', (_label, value) => {
    expect(readOrgRetention({ retention: { executionRetentionDays: value } })).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('ignores a key it does not recognise rather than failing the slice', () => {
    // The write path is strict, so an unknown key here came from a fork or an
    // older release. Treating it as fatal would be the whole-slice failure
    // this design exists to avoid.
    const slice = readOrgRetention({
      retention: { executionRetentionDays: 30, somethingElseRetentionDays: 9 },
    });

    expect(slice).toEqual({ executionRetentionDays: 30 });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe('loadOrgRetention', () => {
  it('reads one org by id and validates what it finds', async () => {
    mockFindUnique.mockResolvedValue({ settings: { retention: { webhookRetentionDays: 7 } } });

    await expect(loadOrgRetention(ORG_A)).resolves.toEqual({ webhookRetentionDays: 7 });
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: ORG_A },
      select: { settings: true },
    });
  });

  it('returns null for an org that is gone', async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(loadOrgRetention(ORG_A)).resolves.toBeNull();
  });
});

describe('applyRetentionPatch', () => {
  it('replaces the slice and leaves a fork’s own keys alone', () => {
    const written = applyRetentionPatch(
      { branding: { logo: 'x' }, retention: { webhookRetentionDays: 7 } },
      { executionRetentionDays: 30 }
    );

    expect(written).toEqual({
      branding: { logo: 'x' },
      retention: { executionRetentionDays: 30 },
    });
  });

  it('replaces the slice outright rather than merging key by key', () => {
    // Merging would leave no way to stop overriding a window: a PATCH states
    // the org's whole set.
    const written = applyRetentionPatch(
      { retention: { webhookRetentionDays: 7, costLogRetentionDays: 90 } },
      { costLogRetentionDays: 120 }
    );

    expect(written).toEqual({ retention: { costLogRetentionDays: 120 } });
  });

  it('removes the slice on null, keeping the rest of the column', () => {
    expect(
      applyRetentionPatch({ branding: { logo: 'x' }, retention: { webhookRetentionDays: 7 } }, null)
    ).toEqual({ branding: { logo: 'x' } });
  });

  it('nulls the column when nothing is left, so "never set" has one shape', () => {
    expect(applyRetentionPatch({ retention: { webhookRetentionDays: 7 } }, null)).toBe(
      Prisma.DbNull
    );
    expect(applyRetentionPatch(null, null)).toBe(Prisma.DbNull);
  });

  it('writes the slice into an unset column', () => {
    expect(applyRetentionPatch(null, { webhookRetentionDays: 7 })).toEqual({
      [ORG_RETENTION_KEY]: { webhookRetentionDays: 7 },
    });
  });

  it('replaces a column that is not an object at all', () => {
    // Nothing the platform writes produces this; a hand-edit can.
    expect(applyRetentionPatch('nonsense', { webhookRetentionDays: 7 })).toEqual({
      retention: { webhookRetentionDays: 7 },
    });
  });
});
