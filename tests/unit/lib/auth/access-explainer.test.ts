/**
 * Tests: the access explainer's read model (§143 t-1090)
 *
 * Pinned:
 * - **Derived, not written.** Every org-tier page, named tier and switch the
 *   install registers reaches a platform admin's explainer, read from the
 *   registries themselves, so adding a registration the explainer drops fails
 *   here. Every core org-tier page sits in one of core's areas.
 * - **Each viewer's slice.** An org admin sees the switches the org holds and
 *   those it lacks that the app locks, never one it hides, nor the pages
 *   needing it. A holder sees only their tiers, their pages and those pages'
 *   switches. Nobody else gets an explainer.
 * - **The seam.** Inert when empty; an area, surface, audience or section an
 *   app registers shows as it says; a throw part-way rolls all of it back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const app = vi.hoisted(() => ({ init: (): void => {} }));
vi.mock('@/lib/app/access-explainer', () => ({ initAppAccessExplainer: () => app.init() }));
vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  accessExplainerRegistrations,
  buildAccessExplainer,
  __resetAccessExplainerForTests,
  type AccessExplainer,
  type AccessExplainerViewer,
  type AccessTranslator,
} from '@/lib/auth/access-explainer';
import {
  CORE_ACCESS_AREAS,
  registerAccessArea,
  registerAccessSection,
  registerPlatformOnlySurface,
  setAccessSectionAudience,
} from '@/lib/auth/access-explainer-registry';
import {
  closeCoreOrgTierSection,
  ORG_TIER_ADMIN_PAGES,
  registerAdminTier,
  registerOrgTierAdminPage,
  type AdminReach,
  type LockedAdminSwitch,
} from '@/lib/auth/admin-tier';
import {
  __resetAppOrgTierAdminPagesForTests,
  namedAdminTiers,
  orgTierAdminPages,
} from '@/lib/auth/org-tier-admin-pages';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
  registeredEntitlementSwitches,
} from '@/lib/tenancy/entitlements';
import { translatorFor } from '@/tests/helpers/i18n';
import en from '@/lib/i18n/messages/en.json';

function translator(messages: Record<string, unknown> = en): AccessTranslator {
  const t = translatorFor(undefined, messages);
  return Object.assign((key: string) => t(key as never), {
    has: (key: string) => t.has(key as never),
  });
}

const LEAD_LOCK: LockedAdminSwitch = {
  requires: 'lead_gen',
  label: 'Lead generation',
  message: 'Lead generation comes with the Growth plan.',
  upgradeUrl: '/pricing',
};

function viewer(overrides: Partial<AccessExplainerViewer> = {}): AccessExplainerViewer {
  return {
    reach: 'platform',
    orgRole: null,
    switchesOn: null,
    locked: [],
    supportEntry: false,
    multiTenant: true,
    ...overrides,
  };
}

/** An org admin, as the policy answers one whose org holds `has`. */
function orgAdminReach(...has: string[]): AdminReach {
  return {
    tiers: ['org', 'designers'],
    landing: null,
    switchesMet: ['lead_gen', 'briefs']
      .filter((key) => has.includes(key))
      .flatMap((requires) => [
        { tier: 'org', requires },
        { tier: 'designers', requires },
      ]),
  };
}

function pagesOf(explainer: AccessExplainer | null): string[] {
  return (explainer?.areas ?? []).flatMap((area) => area.pages.map((page) => page.pattern));
}

/** The app an agency product would be: a named tier, two switches, its own pages. */
function registerAgencyApp(): void {
  registerEntitlementSwitch({
    key: 'lead_gen',
    label: 'Lead generation',
    description: 'Funnels and leads.',
    whenLacking: 'lock',
    refusalMessage: 'Lead generation comes with the Growth plan.',
    upgradeUrl: '/pricing',
  });
  registerEntitlementSwitch({ key: 'briefs', label: 'Briefs', description: 'Lead briefs.' });
  registerAdminTier('designers', {
    holds: () => true,
    label: 'Agency designers',
    description: 'Agency staff who build pages for a client.',
  });
  registerOrgTierAdminPage('/admin/designs', { tier: 'designers' });
  registerOrgTierAdminPage('/admin/designs/[id]', { tier: 'designers', requires: 'lead_gen' });
  registerOrgTierAdminPage('/admin/leads', { requires: 'lead_gen' });
  registerOrgTierAdminPage('/admin/briefs', { requires: 'briefs' });
  registerOrgTierAdminPage('/admin/reports/[id]');
}

beforeEach(() => {
  app.init = () => {};
  __resetAccessExplainerForTests();
  __resetAppOrgTierAdminPagesForTests();
  __resetEntitlementRegistryForTests();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
});
afterEach(() => {
  __resetAccessExplainerForTests();
  __resetAppOrgTierAdminPagesForTests();
  __resetEntitlementRegistryForTests();
});

describe('derived from the registrations', () => {
  it('shows a platform admin every org-tier page, named tier and switch the install registers', () => {
    registerAgencyApp();
    // The population the assertions below range over is not empty.
    expect(namedAdminTiers()).toEqual(['designers']);
    expect(registeredEntitlementSwitches().map((s) => s.key)).toEqual(['lead_gen', 'briefs']);

    const explainer = buildAccessExplainer(viewer(), translator());

    const everyPage = orgTierAdminPages().filter((pattern) => pattern !== '/admin');
    expect(everyPage.length).toBeGreaterThan(ORG_TIER_ADMIN_PAGES.length);
    expect(pagesOf(explainer).sort()).toEqual([...everyPage].sort());
    for (const tier of namedAdminTiers()) {
      expect(explainer?.roles?.map((role) => role.key)).toContain(tier);
    }
    expect(explainer?.switches?.map((s) => s.key)).toEqual(
      registeredEntitlementSwitches().map((s) => s.key)
    );
  });

  it('places every core org-tier page in one of core’s areas', () => {
    const explainer = buildAccessExplainer(viewer(), translator());

    const areas = explainer?.areas ?? [];
    expect(areas.length).toBeGreaterThan(0);
    expect(areas.filter((area) => area.source !== 'core')).toEqual([]);
    expect(pagesOf(explainer).length).toBe(ORG_TIER_ADMIN_PAGES.length - 1);
    expect(areas.map((area) => area.key).sort()).toEqual(
      CORE_ACCESS_AREAS.map((area) => area.key).sort()
    );
  });

  it('puts a page in the narrowest area that claims it', () => {
    const areas = buildAccessExplainer(viewer(), translator())?.areas ?? [];
    const areaOf = (pattern: string) =>
      areas.find((area) => area.pages.some((page) => page.pattern === pattern))?.key;

    expect(areaOf('/admin/orchestration')).toBe('orchestration');
    expect(areaOf('/admin/orchestration/agents/[id]')).toBe('orchestrationBuild');
    expect(areaOf('/admin/orchestration/costs')).toBe('orchestrationOperate');
    expect(areas.find((area) => area.key === 'members')).toMatchObject({
      label: 'Members',
      description: 'Invite people to the organisation and change their roles.',
    });
  });

  it('shows a fork page no area claims under its first segment, and a named tier by its label', () => {
    registerAgencyApp();
    const explainer = buildAccessExplainer(viewer(), translator());

    expect(explainer?.areas?.find((area) => area.key === 'reports')).toMatchObject({
      label: 'Reports',
      source: 'section',
      pages: [{ pattern: '/admin/reports/[id]', href: null, tier: 'org', opens: true }],
    });
    expect(explainer?.roles?.find((role) => role.key === 'designers')).toEqual({
      key: 'designers',
      kind: 'named-tier',
      label: 'Agency designers',
      description: 'Agency staff who build pages for a client.',
      held: false,
    });
  });

  it('names a tier registered with no label by its name, with the platform’s description', () => {
    registerAdminTier('page_designs', { holds: () => true });
    registerOrgTierAdminPage('/admin/designs', { tier: 'page_designs' });

    const role = buildAccessExplainer(viewer(), translator())?.roles?.find(
      (r) => r.key === 'page_designs'
    );
    expect(role).toMatchObject({
      label: 'Page designs',
      description: en.admin.access.roles.namedTier.description,
    });
  });

  it('lists a core section the fork closed as the platform’s, with the reason', () => {
    closeCoreOrgTierSection('orchestration');
    const explainer = buildAccessExplainer(viewer(), translator());

    expect(explainer?.platformOnly).toEqual([
      {
        key: 'orchestration',
        label: 'AI orchestration',
        reason: en.admin.access.closedSections.orchestration.reason,
        href: '/admin/orchestration',
      },
    ]);
    expect(pagesOf(explainer).some((p) => p.startsWith('/admin/orchestration'))).toBe(false);
  });
});

describe('each viewer’s slice', () => {
  beforeEach(registerAgencyApp);

  it('refuses a viewer the console admits to nothing', () => {
    expect(
      buildAccessExplainer(viewer({ reach: { tiers: [], landing: null } }), translator())
    ).toBeNull();
  });

  it('shows an org admin the switches the org has and those the app locks, never one it hides', () => {
    const explainer = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: [], locked: [LEAD_LOCK] }),
      translator()
    );

    expect(explainer?.audience).toBe('org');
    // `briefs` is hidden from an org lacking it: neither it nor its page shows.
    expect(explainer?.switches).toEqual([
      {
        key: 'lead_gen',
        label: 'Lead generation',
        description: 'Funnels and leads.',
        whenLacking: 'lock',
        setBy: 'platform',
        held: false,
        refusal: 'Lead generation comes with the Growth plan.',
        upgradeUrl: '/pricing',
      },
    ]);
    const pages = pagesOf(explainer);
    expect(pages).toContain('/admin/leads');
    expect(pages).not.toContain('/admin/briefs');
    // A locked page says why.
    const leads = explainer?.areas
      ?.flatMap((area) => area.pages)
      .find((page) => page.pattern === '/admin/leads');
    expect(leads).toMatchObject({
      opens: false,
      locked: {
        label: 'Lead generation',
        message: 'Lead generation comes with the Growth plan.',
        upgradeUrl: '/pricing',
      },
    });
    // An org admin opens a named tier's pages too.
    expect(pages).toContain('/admin/designs');
    expect(explainer?.roles?.find((role) => role.key === 'admin')?.held).toBe(true);
  });

  it('shows an org admin a switch the org holds, and the page it opens', () => {
    const explainer = buildAccessExplainer(
      viewer({ reach: orgAdminReach('briefs'), orgRole: 'OWNER', switchesOn: ['briefs'] }),
      translator()
    );

    expect(explainer?.switches?.map((s) => [s.key, s.held])).toEqual([['briefs', true]]);
    const briefs = explainer?.areas
      ?.flatMap((area) => area.pages)
      .find((page) => page.pattern === '/admin/briefs');
    expect(briefs).toMatchObject({ opens: true, locked: null });
    expect(explainer?.you).toMatchObject({ orgRole: 'OWNER', switchesOn: ['briefs'] });
  });

  it('shows a holder only their tier, its pages and the switches those pages need', () => {
    const explainer = buildAccessExplainer(
      viewer({
        reach: { tiers: ['designers'], landing: '/admin/designs' },
        orgRole: 'MEMBER',
        switchesOn: ['lead_gen', 'briefs'],
      }),
      translator()
    );

    expect(explainer?.audience).toBe('holder');
    expect(explainer?.roles?.map((role) => [role.key, role.held])).toEqual([['designers', true]]);
    expect(pagesOf(explainer).sort()).toEqual(['/admin/designs', '/admin/designs/[id]']);
    // `briefs` is the org's, but no page of theirs needs it.
    expect(explainer?.switches?.map((s) => s.key)).toEqual(['lead_gen']);
    expect(explainer?.you?.switchesOn).toEqual(['lead_gen']);
  });

  it('says so when the org’s switches could not be read', () => {
    const explainer = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: null }),
      translator()
    );
    expect(explainer?.you).toMatchObject({ switchesUnreadable: true, switchesOn: null });
  });

  it('shows a page the policy opens even when the org’s switches could not be read', () => {
    registerAgencyApp();
    const explainer = buildAccessExplainer(
      viewer({ reach: orgAdminReach('briefs'), orgRole: 'ADMIN', switchesOn: null }),
      translator()
    );
    const briefs = explainer?.areas
      ?.flatMap((area) => area.pages)
      .find((page) => page.pattern === '/admin/briefs');
    expect(briefs).toMatchObject({ requires: 'briefs', opens: true });
    // `lead_gen` is not met and could not be explained, so its pages stay hidden.
    expect(pagesOf(explainer)).not.toContain('/admin/leads');
  });

  it('marks the support role held for a viewer who entered under a support grant', () => {
    const roles = (supportEntry: boolean) =>
      buildAccessExplainer(
        viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: [], supportEntry }),
        translator()
      )?.roles?.find((role) => role.key === 'support')?.held;
    expect(roles(true)).toBe(true);
    expect(roles(false)).toBe(false);
  });

  it('at single, shows the platform role alone and no org pages', () => {
    const explainer = buildAccessExplainer(viewer({ multiTenant: false }), translator());
    expect(explainer?.tenancy).toBe('single');
    expect(explainer?.roles?.map((role) => role.key)).toEqual(['platform_admin']);
    expect(explainer?.areas).toEqual([]);
  });

  it('gives only a platform admin a link to a platform-only surface', () => {
    registerPlatformOnlySurface({
      key: 'billing',
      label: 'Billing',
      reason: 'Your plan is managed by our account team.',
      href: '/admin/billing',
    });
    const platform = buildAccessExplainer(viewer(), translator());
    const org = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: [] }),
      translator()
    );
    expect(platform?.platformOnly?.[0]?.href).toBe('/admin/billing');
    expect(org?.platformOnly).toEqual([
      {
        key: 'billing',
        label: 'Billing',
        reason: 'Your plan is managed by our account team.',
        href: null,
      },
    ]);
  });
});

describe('the app seam (lib/app/access-explainer.ts)', () => {
  it('is inert when empty: every section, core’s areas, nothing of the app’s', () => {
    const explainer = buildAccessExplainer(viewer(), translator());

    expect(explainer?.sections).toEqual([
      'your-access',
      'roles',
      'areas',
      'switches',
      'platform-only',
    ]);
    expect(explainer?.areas?.every((area) => area.source === 'core')).toBe(true);
    expect(explainer?.platformOnly).toEqual([]);
    expect(explainer?.appSections).toEqual([]);
  });

  it('regroups pages into an app area, which wins a tie with core’s', () => {
    registerOrgTierAdminPage('/admin/reports');
    app.init = () =>
      registerAccessArea({
        key: 'team',
        label: 'Your team',
        description: 'People and reports.',
        pages: ['/admin/members', '/admin/reports'],
      });

    const team = buildAccessExplainer(viewer(), translator())?.areas?.find(
      (area) => area.key === 'team'
    );
    expect(team).toMatchObject({ label: 'Your team', source: 'app' });
    expect(team?.pages.map((page) => page.pattern)).toEqual(['/admin/members', '/admin/reports']);
  });

  it('folds an unclaimed section into the area that shares its key, so area keys stay unique', () => {
    registerOrgTierAdminPage('/admin/reports/[id]');
    registerOrgTierAdminPage('/admin/analytics-x');
    app.init = () =>
      registerAccessArea({ key: 'reports', label: 'Reports', pages: ['/admin/analytics-x'] });

    const areas = buildAccessExplainer(viewer(), translator())?.areas ?? [];
    const keys = areas.map((area) => area.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(areas.find((area) => area.key === 'reports')).toMatchObject({
      source: 'app',
      pages: [
        expect.objectContaining({ pattern: '/admin/reports/[id]' }),
        expect.objectContaining({ pattern: '/admin/analytics-x' }),
      ],
    });
  });

  it('narrows a section’s audience, and shows an app section to its audience only', () => {
    app.init = () => {
      setAccessSectionAudience('switches', ['platform']);
      registerAccessSection({
        key: 'agency',
        title: { message: 'app.access.agency.title' },
        body: 'Your agency builds your pages.',
        audience: ['org', 'holder'],
      });
    };
    const messages = { ...en, app: { access: { agency: { title: 'Working with an agency' } } } };

    const platform = buildAccessExplainer(viewer(), translator(messages));
    const org = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: [] }),
      translator(messages)
    );

    expect(platform?.sections).toContain('switches');
    expect(platform?.appSections).toEqual([]);
    expect(org?.sections).not.toContain('switches');
    expect(org?.switches).toBeUndefined();
    expect(org?.appSections).toEqual([
      { key: 'agency', title: 'Working with an agency', body: 'Your agency builds your pages.' },
    ]);
  });

  it('shows a catalogue key the app’s catalogue lacks as the key, and logs it', () => {
    app.init = () =>
      registerPlatformOnlySurface({
        key: 'billing',
        label: { message: 'app.access.billing' },
        reason: 'Ask your account manager.',
      });

    const surface = buildAccessExplainer(viewer(), translator())?.platformOnly?.[0];
    buildAccessExplainer(viewer(), translator());
    expect(surface?.label).toBe('app.access.billing');
    // Once per key, not once per request.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'access-explainer: a catalogue key the app named is missing',
      { key: 'app.access.billing' }
    );
  });

  it('rolls back everything the init registered when it throws part-way', () => {
    app.init = () => {
      registerAccessArea({ key: 'team', label: 'Team', pages: ['/admin/members'] });
      registerPlatformOnlySurface({ key: 'billing', label: 'Billing', reason: 'Ours.' });
      setAccessSectionAudience('roles', []);
      throw new Error('boom');
    };

    const registered = accessExplainerRegistrations();
    expect([...registered.areas.keys()]).toEqual([]);
    expect([...registered.platformOnly.keys()]).toEqual([]);
    expect([...registered.audiences.keys()]).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
    expect(buildAccessExplainer(viewer(), translator())?.sections).toContain('roles');
  });

  it.each([
    [
      'a core area’s key',
      () => registerAccessArea({ key: 'members', label: 'X', pages: ['/admin/x'] }),
    ],
    ['an area claiming no pages', () => registerAccessArea({ key: 'x', label: 'X', pages: [] })],
    [
      'an area claiming a pattern',
      () => registerAccessArea({ key: 'x', label: 'X', pages: ['/admin/x/[id]'] }),
    ],
    ['an empty label', () => registerAccessArea({ key: 'x', label: '  ', pages: ['/admin/x'] })],
    [
      'a section nobody sees',
      () => registerAccessSection({ key: 'x', title: 'X', body: 'Y', audience: [] }),
    ],
    ['an audience that is not one', () => setAccessSectionAudience('roles', ['everyone' as never])],
    ['a section that is not one', () => setAccessSectionAudience('nope' as never, ['org'])],
    [
      'a surface link that is not an admin path',
      () =>
        registerPlatformOnlySurface({ key: 'x', label: 'X', reason: 'Y', href: 'https://x.test' }),
    ],
    [
      'a tier label that is neither text nor a key',
      () => registerAdminTier('designers', { holds: () => true, label: { message: 'nodots' } }),
    ],
  ])('refuses %s', (_name, register) => {
    expect(register).toThrow();
  });
});
