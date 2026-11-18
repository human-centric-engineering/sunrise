/**
 * Tests: where `/admin` sends an org admin (t-928)
 *
 * The fork may name the page in `lib/app/admin-landing.ts`, and it is used only
 * if an org admin may open it — anything else would turn them away the moment
 * they landed. Judged against the real roster, so "may open" means what the
 * admin layout means by it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const app = vi.hoisted(() => ({ route: null as string | null }));
vi.mock('@/lib/app/admin-landing', () => ({
  get appOrgAdminLandingRoute() {
    return app.route;
  },
}));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  ORG_TIER_ADMIN_PAGES,
  closeCoreOrgTierSection,
  registerAdminTier,
  registerOrgTierAdminPage,
} from '@/lib/auth/admin-tier';
import { __resetAppOrgTierAdminPagesForTests } from '@/lib/auth/org-tier-admin-pages';
import {
  __resetLandingLogForTests,
  CLOSED_DEFAULT_ORG_ADMIN_LANDING,
  DEFAULT_ORG_ADMIN_LANDING,
  heldTierLanding,
  namedTierLandingProblem,
  orgAdminLanding,
  orgAdminLandingProblem,
} from '@/lib/auth/admin-landing';

beforeEach(() => {
  vi.clearAllMocks();
  app.route = null;
  __resetAppOrgTierAdminPagesForTests();
  __resetLandingLogForTests();
});

describe('orgAdminLandingProblem', () => {
  const pages = [...ORG_TIER_ADMIN_PAGES, '/admin/reports', '/admin/reports/[id]'];

  it.each([
    ['a core org-tier page', '/admin/members'],
    ['a fork’s listed page', '/admin/reports'],
  ])('accepts %s', (_l, route) => {
    expect(orgAdminLandingProblem(route, pages)).toBeNull();
  });

  it.each([
    ['a platform page', '/admin/users', 'not a page an org admin may open'],
    ['a page nobody listed', '/admin/nowhere', 'not a page an org admin may open'],
    // One org's row: every other org's admin would land on a not-found.
    [
      'a concrete URL of a listed [x] page',
      '/admin/reports/q3',
      'not a page an org admin may open',
    ],
    // `/admin` sends here, so landing on it would loop.
    ['the console index itself', '/admin', 'not a path under /admin/'],
    ['a path outside the console', '/dashboard', 'not a path under /admin/'],
    ['an off-site URL', 'https://evil.example/admin/members', 'not a path under /admin/'],
    ['a trailing slash', '/admin/members/', 'not a plain path'],
    ['a query string', '/admin/members?tab=invites', 'not a plain path'],
    ['a fragment', '/admin/members#top', 'not a plain path'],
    ['a pattern rather than a URL', '/admin/reports/[id]', 'not a plain path'],
    ['a dot segment', '/admin/reports/../users', 'not a plain path'],
  ])('refuses %s', (_l, route, why) => {
    expect(orgAdminLandingProblem(route, pages)).toContain(why);
  });

  it('refuses a value that is not a string', () => {
    expect(orgAdminLandingProblem(42, pages)).toContain('not a path under /admin/');
  });
});

describe('orgAdminLanding', () => {
  it('is the orchestration dashboard when the fork names nowhere', () => {
    expect(orgAdminLanding()).toBe('/admin/orchestration');
    expect(DEFAULT_ORG_ADMIN_LANDING).toBe('/admin/orchestration');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('is the fork’s page when an org admin may open it', () => {
    app.route = '/admin/members';
    expect(orgAdminLanding()).toBe('/admin/members');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('falls back to the default, and says why, when they may not', () => {
    app.route = '/admin/users';
    expect(orgAdminLanding()).toBe('/admin/orchestration');
    expect(logger.error).toHaveBeenCalledWith(
      'admin-landing: ignoring the app org-admin landing',
      expect.objectContaining({
        route: '/admin/users',
        problem: expect.stringContaining('not a page an org admin may open'),
      })
    );
  });
});

describe('orgAdminLanding, with orchestration closed to org admins (t-929)', () => {
  beforeEach(() => {
    closeCoreOrgTierSection('orchestration');
  });

  it('is Members when the fork names nowhere, not the closed dashboard', () => {
    expect(orgAdminLanding()).toBe('/admin/members');
    expect(CLOSED_DEFAULT_ORG_ADMIN_LANDING).toBe('/admin/members');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('refuses a fork landing in the closed section, and falls back to Members', () => {
    app.route = '/admin/orchestration/agents';
    expect(orgAdminLanding()).toBe('/admin/members');
    expect(logger.error).toHaveBeenCalledWith(
      'admin-landing: ignoring the app org-admin landing',
      expect.objectContaining({ route: '/admin/orchestration/agents' })
    );
  });
});

describe('namedTierLandingProblem (t-999)', () => {
  const named = [
    { pattern: '/admin/designs', tier: 'page_designs' },
    { pattern: '/admin/designs/[id]', tier: 'page_designs' },
    { pattern: '/admin/media', tier: 'media' },
  ];

  it('accepts a page registered for the tier, word for word', () => {
    expect(namedTierLandingProblem('page_designs', '/admin/designs', named)).toBeNull();
  });

  it.each([
    ['another tier’s page', '/admin/media', 'not a page registered for tier'],
    ['an org page', '/admin/members', 'not a page registered for tier'],
    ['one row of an [x] page', '/admin/designs/d1', 'not a page registered for tier'],
    ['a pattern', '/admin/designs/[id]', 'not a plain path'],
    ['a path outside /admin', '/designs', 'not a path under /admin/'],
  ])('refuses %s', (_l, route, why) => {
    expect(namedTierLandingProblem('page_designs', route, named)).toContain(why);
  });
});

describe('heldTierLanding (t-999)', () => {
  const holds = (): boolean => true;

  it('is null for a viewer who holds no named tier, and when nothing is registered', () => {
    expect(heldTierLanding([])).toBeNull();
    expect(heldTierLanding(['page_designs'])).toBeNull();
  });

  it('is the landing of the first held tier, in registration order, that names a usable one', () => {
    registerAdminTier('brand_themes', { holds });
    registerAdminTier('page_designs', { holds, landing: '/admin/designs' });
    registerAdminTier('media', { holds, landing: '/admin/media' });
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
    registerOrgTierAdminPage('/admin/media', { tier: 'media' });

    expect(heldTierLanding(['media', 'page_designs'])).toBe('/admin/designs');
    expect(heldTierLanding(['media'])).toBe('/admin/media');
    // brand_themes names no landing, so it is passed over, not chosen.
    expect(heldTierLanding(['brand_themes', 'media'])).toBe('/admin/media');
    expect(heldTierLanding(['brand_themes'])).toBeNull();
  });

  it('without a landing, uses the tier’s first page with no [x] segment', () => {
    registerAdminTier('page_designs', { holds });
    registerOrgTierAdminPage('/admin/designs/[id]', { tier: 'page_designs' });
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });
    registerOrgTierAdminPage('/admin/designs/archive', { tier: 'page_designs' });

    expect(heldTierLanding(['page_designs'])).toBe('/admin/designs');
  });

  it('falls back to that default when the landing named is not the tier’s page', () => {
    registerAdminTier('page_designs', { holds, landing: '/admin/members' });
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });

    expect(heldTierLanding(['page_designs'])).toBe('/admin/designs');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('passes over a landing that is not the tier’s page, and logs it once', () => {
    registerAdminTier('page_designs', { holds, landing: '/admin/members' });
    registerAdminTier('media', { holds, landing: '/admin/media' });
    registerOrgTierAdminPage('/admin/media', { tier: 'media' });

    expect(heldTierLanding(['page_designs'])).toBeNull();
    expect(heldTierLanding(['page_designs', 'media'])).toBe('/admin/media');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("ignoring a named tier's landing"),
      expect.objectContaining({ tier: 'page_designs', route: '/admin/members' })
    );
  });
});

describe('a landing that requires a switch (t-1034)', () => {
  const holds = (): boolean => true;
  const has =
    (...keys: string[]) =>
    (_tier: string, requires: string): boolean =>
      keys.includes(requires);

  it('is no configuration problem: whether it is usable depends on the viewer', () => {
    const pages = [...ORG_TIER_ADMIN_PAGES, '/admin/leads'];
    expect(orgAdminLandingProblem('/admin/leads', pages)).toBeNull();
  });

  it("sends an org admin to the fork's landing when their org has its switch, else to the default, unlogged", () => {
    registerOrgTierAdminPage('/admin/leads', { requires: 'lead_gen' });
    app.route = '/admin/leads';

    expect(orgAdminLanding(has('lead_gen'))).toBe('/admin/leads');
    expect(orgAdminLanding(has())).toBe(DEFAULT_ORG_ADMIN_LANDING);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('with no viewer to ask, meets no switch, and passes such a landing over', () => {
    registerOrgTierAdminPage('/admin/leads', { requires: 'lead_gen' });
    app.route = '/admin/leads';
    expect(orgAdminLanding()).toBe(DEFAULT_ORG_ADMIN_LANDING);

    registerAdminTier('sales', { holds, landing: '/admin/sales' });
    registerOrgTierAdminPage('/admin/sales', { tier: 'sales', requires: 'lead_gen' });
    expect(heldTierLanding(['sales'])).toBeNull();
  });

  it("asks about an org admin's landing in the page's own tier, as the layout does", () => {
    registerAdminTier('sales', { holds });
    registerOrgTierAdminPage('/admin/sales', { tier: 'sales', requires: 'lead_gen' });
    app.route = '/admin/sales';
    const asked: string[] = [];
    orgAdminLanding((tier, requires) => {
      asked.push(`${tier}:${requires}`);
      return true;
    });
    expect(asked).toEqual(['sales:lead_gen']);
  });

  it("uses a tier's landing that requires a switch for a holder whose org has it", () => {
    registerAdminTier('sales', { holds, landing: '/admin/leads' });
    registerOrgTierAdminPage('/admin/leads', { tier: 'sales', requires: 'lead_gen' });
    registerOrgTierAdminPage('/admin/contacts', { tier: 'sales' });

    expect(heldTierLanding(['sales'], has('lead_gen'))).toBe('/admin/leads');
  });

  it("passes over it, and the tier's other such pages, for one they can open — without a log line", () => {
    registerAdminTier('sales', { holds, landing: '/admin/leads' });
    registerOrgTierAdminPage('/admin/leads', { tier: 'sales', requires: 'lead_gen' });
    registerOrgTierAdminPage('/admin/pipeline', { tier: 'sales', requires: 'lead_gen' });
    registerOrgTierAdminPage('/admin/contacts', { tier: 'sales' });

    expect(heldTierLanding(['sales'], has())).toBe('/admin/contacts');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('lands a holder on a tier whose every page requires a switch when their org has it', () => {
    registerAdminTier('sales', { holds });
    registerOrgTierAdminPage('/admin/leads', { tier: 'sales', requires: 'lead_gen' });

    expect(heldTierLanding(['sales'], has('lead_gen'))).toBe('/admin/leads');
    expect(heldTierLanding(['sales'], has())).toBeNull();
  });

  it('moves on to the next held tier when one has nothing they can open', () => {
    registerAdminTier('sales', { holds });
    registerAdminTier('media', { holds });
    registerOrgTierAdminPage('/admin/leads', { tier: 'sales', requires: 'lead_gen' });
    registerOrgTierAdminPage('/admin/media', { tier: 'media' });

    expect(heldTierLanding(['sales', 'media'], has())).toBe('/admin/media');
  });
});
