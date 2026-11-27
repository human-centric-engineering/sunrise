/**
 * Unit Tests: the billing page as the default upgrade link (§139 t-1095)
 *
 * The app's own link always wins; with none, the billing page is offered
 * only to a viewer who opens it, in an org that is billed, and only while
 * billing is on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const billing = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/billing/config', () => ({ billingEnabled: () => billing.on }));

import { ORG_BILLING_PAGE_PATH, upgradeUrlFor } from '@/lib/billing/upgrade-url';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const orgAdmin = { orgId: 'org-1', holdsOrgTier: true };

describe('upgradeUrlFor', () => {
  beforeEach(() => {
    billing.on = true;
  });

  it("keeps the app's own link, whoever is asking and whether or not billing is on", () => {
    expect(upgradeUrlFor('/pricing', orgAdmin)).toBe('/pricing');
    expect(
      upgradeUrlFor('https://example.com/plans', { orgId: 'org-1', holdsOrgTier: false })
    ).toBe('https://example.com/plans');
    expect(upgradeUrlFor('/pricing', { orgId: INSTALL_ORG_ID, holdsOrgTier: true })).toBe(
      '/pricing'
    );
    billing.on = false;
    expect(upgradeUrlFor('/pricing', orgAdmin)).toBe('/pricing');
  });

  it('offers the billing page to a viewer who opens it, while billing is on', () => {
    expect(ORG_BILLING_PAGE_PATH).toBe('/admin/billing');
    expect(upgradeUrlFor(null, orgAdmin)).toBe('/admin/billing');
  });

  it('offers nothing to a viewer who cannot open it, or while billing is off', () => {
    expect(upgradeUrlFor(null, { orgId: 'org-1', holdsOrgTier: false })).toBeNull();
    billing.on = false;
    expect(upgradeUrlFor(null, orgAdmin)).toBeNull();
  });

  it('offers nothing in the install org, which is never billed, or outside any org', () => {
    expect(upgradeUrlFor(null, { orgId: INSTALL_ORG_ID, holdsOrgTier: true })).toBeNull();
    expect(upgradeUrlFor(null, { orgId: null, holdsOrgTier: true })).toBeNull();
    expect(upgradeUrlFor(null, { orgId: undefined, holdsOrgTier: true })).toBeNull();
  });
});
