/**
 * Unit Tests: the billing page as the default upgrade link (§139 t-1095)
 *
 * The app's own link always wins; with none, the billing page is offered
 * only to a viewer who opens it, and only while billing is on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const billing = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/billing/config', () => ({ billingEnabled: () => billing.on }));

import { ORG_BILLING_PAGE_PATH, upgradeUrlFor } from '@/lib/billing/upgrade-url';

describe('upgradeUrlFor', () => {
  beforeEach(() => {
    billing.on = true;
  });

  it("keeps the app's own link, whoever is asking and whether or not billing is on", () => {
    expect(upgradeUrlFor('/pricing', true)).toBe('/pricing');
    expect(upgradeUrlFor('https://example.com/plans', false)).toBe('https://example.com/plans');
    billing.on = false;
    expect(upgradeUrlFor('/pricing', true)).toBe('/pricing');
  });

  it('offers the billing page to a viewer who opens it, while billing is on', () => {
    expect(ORG_BILLING_PAGE_PATH).toBe('/admin/billing');
    expect(upgradeUrlFor(null, true)).toBe('/admin/billing');
  });

  it('offers nothing to a viewer who cannot open it, or while billing is off', () => {
    expect(upgradeUrlFor(null, false)).toBeNull();
    billing.on = false;
    expect(upgradeUrlFor(null, true)).toBeNull();
  });
});
