/**
 * Tests: lib/tenancy/tier-grant-view.ts — the grantable tiers named for the
 * reader (t-1123).
 *
 * The registry is the real one; `next-intl/server` is a stand-in catalogue,
 * so a tier labelled `{ message }` is shown to resolve through it, and a key
 * the catalogue lacks to show as the key rather than fail the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const catalogue: Record<string, unknown> = {
  'app.tiers.media': 'Bibliothèque',
  'app.tiers.group': { nested: 'not a string' },
};
const getTranslations = vi.hoisted(() => vi.fn());
vi.mock('next-intl/server', () => ({ getTranslations }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { registerAdminTier, restoreNamedAdminTiers } from '@/lib/auth/admin-tier';
import { logger } from '@/lib/logging';
import { env } from '@/lib/env';
import { grantableTiersFor } from '@/lib/tenancy/tier-grant-view';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const ORG = 'cmorg000000000000000other';

const previousMode = env.TENANCY_MODE;
beforeEach(() => {
  // Named tiers admit anyone only at multi, so only there is one grantable.
  env.TENANCY_MODE = 'multi';
  restoreNamedAdminTiers([]);
  getTranslations.mockReset().mockResolvedValue(
    Object.assign((key: string) => catalogue[key] as string, {
      has: (key: string) => key in catalogue,
      raw: (key: string) => catalogue[key],
    })
  );
});
afterEach(() => {
  restoreNamedAdminTiers([]);
  env.TENANCY_MODE = previousMode;
});

describe('grantableTiersFor', () => {
  it('names each grantable tier: a catalogue key through the catalogue, plain text as it is, none by its name', async () => {
    registerAdminTier('media', {
      label: { message: 'app.tiers.media' },
      description: 'Images.',
    });
    registerAdminTier('page_designs', {});
    registerAdminTier('reports', { holds: () => true }); // not grantable

    expect(await grantableTiersFor(ORG)).toEqual([
      { name: 'media', label: 'Bibliothèque', description: 'Images.' },
      { name: 'page_designs', label: 'Page designs' },
    ]);
  });

  it('shows a key the catalogue lacks, or names a group, as the key', async () => {
    registerAdminTier('media', { label: { message: 'app.tiers.missing' } });
    registerAdminTier('brand', { label: { message: 'app.tiers.group' } });

    expect((await grantableTiersFor(ORG)).map((tier) => tier.label)).toEqual([
      'app.tiers.missing',
      'app.tiers.group',
    ]);
  });

  it('offers nothing in the install org, and asks no catalogue', async () => {
    registerAdminTier('media', {});
    expect(await grantableTiersFor(INSTALL_ORG_ID)).toEqual([]);
    expect(getTranslations).not.toHaveBeenCalled();
  });

  it('offers nothing, and asks no catalogue, when the app registered no grantable tier', async () => {
    registerAdminTier('reports', { holds: () => true });
    expect(await grantableTiersFor(ORG)).toEqual([]);
    expect(getTranslations).not.toHaveBeenCalled();
  });

  it('answers [] and logs at error when the translations cannot be read, rather than throw (t-1124)', async () => {
    registerAdminTier('media', { label: { message: 'app.tiers.media' } });
    getTranslations.mockReset().mockRejectedValue(new Error('no request locale'));

    await expect(grantableTiersFor(ORG)).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'Grantable tiers could not be read; the roster is served without them',
      { orgId: ORG, error: 'no request locale' }
    );
  });

  it('answers [] when resolving a tier label throws', async () => {
    registerAdminTier('media', { label: { message: 'app.tiers.media' } });
    getTranslations.mockReset().mockResolvedValue(
      Object.assign(
        () => {
          throw new Error('bad message');
        },
        { has: () => true, raw: () => 'x' }
      )
    );

    await expect(grantableTiersFor(ORG)).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });
});
