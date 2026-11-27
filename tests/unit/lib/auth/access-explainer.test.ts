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
// Billing on, so every core org-tier page is listed; off is tested on its own (t-1095).
const billing = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/billing/config', () => ({ billingEnabled: () => billing.on }));

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
  CORE_ACCESS_PERMISSIONS,
  registerAccessArea,
  registerAccessPermission,
  registerAccessSection,
  registerPlatformOnlySurface,
  setAccessPermission,
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
  billing.on = true;
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
      // The policy admits a platform admin to every tier.
      expect(explainer?.roles?.find((role) => role.key === tier)?.held).toBe(true);
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

  it('leaves out the billing page while billing is off (§139 t-1095)', () => {
    const on = pagesOf(buildAccessExplainer(viewer(), translator()));
    billing.on = false;
    const off = pagesOf(buildAccessExplainer(viewer(), translator()));

    expect(on).toContain('/admin/billing');
    expect(off).toEqual(on.filter((page) => page !== '/admin/billing'));
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
      // The viewer is a platform admin, whom the policy admits to every tier.
      held: true,
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

  it('says so when the org’s switches could not be read, and does not guess a switch off', () => {
    registerEntitlementSwitch({
      key: 'beta_reports',
      label: 'Beta reports',
      description: 'Early reports.',
      setBy: 'org',
    });
    const explainer = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: null }),
      translator()
    );
    expect(explainer?.you).toMatchObject({ switchesUnreadable: true, switchesOn: null });
    // The org sets this switch itself, so its admin is shown it; its state is unknown.
    expect(explainer?.switches?.find((s) => s.key === 'beta_reports')).toMatchObject({
      held: null,
      refusal: null,
      upgradeUrl: null,
    });
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

  it('under a support grant, marks support held and no org role, as a member is not', () => {
    const held = (supportEntry: boolean) =>
      buildAccessExplainer(
        viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: [], supportEntry }),
        translator()
      )
        ?.roles?.filter((role) => role.kind === 'support' || role.kind === 'org-role')
        .filter((role) => role.held)
        .map((role) => role.key);
    expect(held(true)).toEqual(['support']);
    expect(held(false)).toEqual(['admin']);
  });

  it('under a support grant, says the viewer has no org role of their own', () => {
    const you = (supportEntry: boolean) =>
      buildAccessExplainer(
        viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: [], supportEntry }),
        translator()
      )?.you?.orgRole;
    expect(you(true)).toBeNull();
    expect(you(false)).toBe('ADMIN');
  });

  it('shows an org admin a switch the org sets itself, even one the app hides while off', () => {
    registerEntitlementSwitch({
      key: 'beta_reports',
      label: 'Beta reports',
      description: 'Early reports.',
      setBy: 'org',
    });
    registerOrgTierAdminPage('/admin/beta-reports', { requires: 'beta_reports' });
    registerOrgTierAdminPage('/admin/designs/beta', {
      tier: 'designers',
      requires: 'beta_reports',
    });

    const org = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: [] }),
      translator()
    );
    const holder = buildAccessExplainer(
      viewer({ reach: { tiers: ['designers'], landing: null }, orgRole: 'MEMBER', switchesOn: [] }),
      translator()
    );

    expect(org?.switches?.find((s) => s.key === 'beta_reports')).toMatchObject({
      held: false,
      setBy: 'org',
    });
    expect(pagesOf(org)).toContain('/admin/beta-reports');
    // A holder cannot set it, so an off switch the app hides stays hidden from them.
    expect(holder?.switches?.map((s) => s.key)).not.toContain('beta_reports');
    expect(pagesOf(holder)).not.toContain('/admin/designs/beta');
  });

  it('at single, shows the platform role alone and no org pages', () => {
    const explainer = buildAccessExplainer(viewer({ multiTenant: false }), translator());
    expect(explainer?.tenancy).toBe('single');
    expect(explainer?.roles?.map((role) => role.key)).toEqual(['platform_admin']);
    expect(explainer?.sections).not.toContain('areas');
    expect(explainer?.areas).toBeUndefined();
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

describe('why a page is closed, and the names that say so', () => {
  const pageOf = (explainer: AccessExplainer | null, pattern: string) =>
    explainer?.areas?.flatMap((area) => area.pages).find((page) => page.pattern === pattern);

  it('puts a closed page down to its tier when the viewer lacks it, and to its switch when not', () => {
    registerAgencyApp();
    registerOrgTierAdminPage('/admin/designs/briefs', { tier: 'designers', requires: 'briefs' });
    // An org owner the policy does not admit to the designers tier; the org has briefs.
    const explainer = buildAccessExplainer(
      viewer({
        reach: {
          tiers: ['org'],
          landing: null,
          switchesMet: [{ tier: 'org', requires: 'briefs' }],
        },
        orgRole: 'OWNER',
        switchesOn: ['briefs'],
        locked: [LEAD_LOCK],
      }),
      translator()
    );

    expect(pageOf(explainer, '/admin/designs/briefs')).toMatchObject({
      opens: false,
      closedBy: 'tier',
      tierLabel: 'Agency designers',
      requiresLabel: 'Briefs',
    });
    expect(pageOf(explainer, '/admin/leads')).toMatchObject({
      opens: false,
      closedBy: 'switch',
      tierLabel: 'Owners and admins',
      requiresLabel: 'Lead generation',
    });
    expect(pageOf(explainer, '/admin/briefs')).toMatchObject({ opens: true, closedBy: null });
  });

  it('puts a page the policy keeps closed down to the policy, not a switch the org has', () => {
    registerAgencyApp();
    // The org has briefs on; this policy still does not meet it for the org tier.
    const explainer = buildAccessExplainer(
      viewer({
        reach: { tiers: ['org'], landing: null, switchesMet: [] },
        orgRole: 'ADMIN',
        switchesOn: ['briefs'],
      }),
      translator()
    );

    expect(pageOf(explainer, '/admin/briefs')).toMatchObject({ opens: false, closedBy: 'policy' });
  });

  it('calls the switch unknown, not missing, when the org’s switches could not be read', () => {
    registerAgencyApp();
    const explainer = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: null, locked: [LEAD_LOCK] }),
      translator()
    );

    expect(pageOf(explainer, '/admin/leads')).toMatchObject({ opens: false, closedBy: 'unread' });
  });

  it('names the viewer’s tiers and switches in their panel when the app hides those sections', () => {
    registerAgencyApp();
    app.init = () => {
      setAccessSectionAudience('roles', ['platform']);
      setAccessSectionAudience('switches', ['platform']);
    };
    const explainer = buildAccessExplainer(
      viewer({
        reach: { tiers: ['designers'], landing: '/admin/designs' },
        orgRole: 'MEMBER',
        switchesOn: ['lead_gen'],
      }),
      translator()
    );

    expect(explainer?.roles).toBeUndefined();
    expect(explainer?.switches).toBeUndefined();
    expect(explainer?.you).toMatchObject({
      tierLabels: { designers: 'Agency designers' },
      switchLabels: { lead_gen: 'Lead generation' },
      anySwitches: true,
      supportEntry: false,
    });
  });

  it('says a support entry is one, and that an install with no switches has none to show', () => {
    const explainer = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', switchesOn: [], supportEntry: true }),
      translator()
    );

    expect(explainer?.you).toMatchObject({ supportEntry: true, orgRole: null, anySwitches: false });
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
    expect(logger.warn).toHaveBeenCalledWith('access-explainer: a catalogue key is missing', {
      key: 'app.access.billing',
    });
  });

  it('rolls back everything the init registered when it throws part-way', () => {
    app.init = () => {
      registerAccessArea({ key: 'team', label: 'Team', pages: ['/admin/members'] });
      registerPlatformOnlySurface({ key: 'billing', label: 'Billing', reason: 'Ours.' });
      setAccessSectionAudience('roles', []);
      setAccessPermission('manageMembers', null);
      registerAccessPermission({
        key: 'publish',
        label: 'Publish',
        allowed: { platform_admin: true, owner: true, admin: true, member: false },
      });
      throw new Error('boom');
    };

    const registered = accessExplainerRegistrations();
    expect([...registered.permissions.keys()]).toEqual([]);
    expect([...registered.permissionOverrides.keys()]).toEqual([]);
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
      'a restated permission that is not one of core’s',
      () =>
        setAccessPermission('publish', {
          platform_admin: true,
          owner: true,
          admin: true,
          member: true,
        }),
    ],
    [
      'a restated permission missing a cell',
      () =>
        setAccessPermission('manageMembers', {
          platform_admin: true,
          owner: true,
          admin: false,
        } as never),
    ],
    [
      'a permission cell for a column that is not one',
      () =>
        registerAccessPermission({
          key: 'publish',
          label: 'Publish',
          allowed: {
            platform_admin: true,
            owner: true,
            admin: true,
            member: false,
            guest: true,
          } as never,
        }),
    ],
    [
      'an app permission with core’s key',
      () =>
        registerAccessPermission({
          key: 'manageMembers',
          label: 'X',
          allowed: { platform_admin: true, owner: true, admin: true, member: true },
        }),
    ],
    [
      'a permission cell that is not true or false',
      () =>
        registerAccessPermission({
          key: 'publish',
          label: 'Publish',
          allowed: { platform_admin: true, owner: 'yes', admin: true, member: false } as never,
        }),
    ],
    [
      'a tier label that is neither text nor a key',
      () => registerAdminTier('designers', { holds: () => true, label: { message: 'nodots' } }),
    ],
    [
      'a label naming a platform key rather than one of the app’s',
      () =>
        registerAccessArea({ key: 'x', label: { message: 'admin.access' }, pages: ['/admin/x'] }),
    ],
  ])('refuses %s', (_name, register) => {
    expect(register).toThrow();
  });
});

describe('the role model (RBAC tables)', () => {
  const cells = (explainer: AccessExplainer | null) =>
    Object.fromEntries((explainer?.model?.permissions ?? []).map((p) => [p.key, p.allowed]));

  it('sends every core role and Sunrise’s permission table, in the viewer’s words', () => {
    const explainer = buildAccessExplainer(viewer(), translator());

    expect(explainer?.model?.platformRoles.map((r) => [r.key, r.label, r.held])).toEqual([
      ['user', 'User', false],
      ['platform_admin', 'Platform admin', true],
      ['support', 'Support access', false],
    ]);
    expect(explainer?.model?.orgRoles.map((r) => r.label)).toEqual(['Owner', 'Admin', 'Member']);
    expect(explainer?.model?.columns.map((c) => c.label)).toEqual([
      'Platform admin',
      'Owner',
      'Admin',
      'Member',
    ]);
    expect(explainer?.model?.permissions?.map((p) => p.key)).toEqual(
      CORE_ACCESS_PERMISSIONS.map((p) => p.key)
    );
    expect(explainer?.model?.permissions?.every((p) => p.source === 'core')).toBe(true);
  });

  it('pins every cell of Sunrise’s table to the rule it restates', () => {
    expect(cells(buildAccessExplainer(viewer(), translator()))).toEqual({
      useProduct: { platform_admin: true, owner: true, admin: true, member: true },
      openConsole: { platform_admin: true, owner: true, admin: true, member: false },
      manageMembers: { platform_admin: true, owner: true, admin: true, member: false },
      // lib/tenancy/lifecycle.ts: only an OWNER, or a platform admin, touches OWNER.
      manageOwners: { platform_admin: true, owner: true, admin: false, member: false },
      orgSettings: { platform_admin: true, owner: true, admin: true, member: false },
      // lib/tenancy/support-grants.ts: only the org's own OWNER grants.
      grantSupport: { platform_admin: false, owner: true, admin: false, member: false },
      endSupport: { platform_admin: true, owner: true, admin: true, member: false },
      switchesOff: { platform_admin: true, owner: false, admin: false, member: false },
      platformPages: { platform_admin: true, owner: false, admin: false, member: false },
      manageOrgs: { platform_admin: true, owner: false, admin: false, member: false },
    });
  });

  it('sends the whole model at single too, where `roles` is the platform admin alone', () => {
    const explainer = buildAccessExplainer(viewer({ multiTenant: false }), translator());

    expect(explainer?.tenancy).toBe('single');
    expect(explainer?.roles?.map((r) => r.key)).toEqual(['platform_admin']);
    expect(explainer?.model?.orgRoles.map((r) => r.key)).toEqual(['owner', 'admin', 'member']);
    // No org role is in force there, so none is the viewer's.
    expect(explainer?.model?.orgRoles.some((r) => r.held)).toBe(false);
  });

  it('marks an org owner as a User and as the Owner, and a support entry as neither', () => {
    const owner = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'OWNER' }),
      translator()
    );
    expect(owner?.model?.platformRoles.find((r) => r.key === 'user')?.held).toBe(true);
    expect(owner?.model?.orgRoles.find((r) => r.key === 'owner')?.held).toBe(true);

    const support = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'ADMIN', supportEntry: true }),
      translator()
    );
    expect(support?.model?.platformRoles.filter((r) => r.held).map((r) => r.key)).toEqual([
      'support',
    ]);
    expect(support?.model?.orgRoles.some((r) => r.held)).toBe(false);
  });

  it('is not sent to a named-tier holder, nor when the app hides the roles section', () => {
    registerAgencyApp();
    const holder = buildAccessExplainer(
      viewer({
        reach: { tiers: ['designers'], landing: null, switchesMet: [] },
        orgRole: 'MEMBER',
      }),
      translator()
    );
    expect(holder?.roles).toBeDefined();
    expect(holder?.model).toBeUndefined();

    __resetAccessExplainerForTests();
    app.init = () => setAccessSectionAudience('roles', ['platform']);
    const org = buildAccessExplainer(
      viewer({ reach: orgAdminReach(), orgRole: 'OWNER' }),
      translator()
    );
    expect(org?.model).toBeUndefined();
  });

  it('lets an app restate a core row its policy answers differently, or leave one out', () => {
    app.init = () => {
      setAccessPermission('manageMembers', {
        platform_admin: true,
        owner: true,
        admin: false,
        member: false,
      });
      setAccessPermission('useProduct', null);
    };
    const explainer = buildAccessExplainer(viewer(), translator());

    expect(cells(explainer).manageMembers).toEqual({
      platform_admin: true,
      owner: true,
      admin: false,
      member: false,
    });
    expect(explainer?.model?.permissions?.map((p) => p.key)).not.toContain('useProduct');
    expect(explainer?.model?.permissions?.find((p) => p.key === 'manageMembers')?.source).toBe(
      'core'
    );
  });

  it('sends no permission table when the app’s init throws, since its restatements went with it', () => {
    app.init = () => {
      setAccessPermission('manageMembers', {
        platform_admin: true,
        owner: true,
        admin: false,
        member: false,
      });
      throw new Error('boom');
    };
    const explainer = buildAccessExplainer(viewer(), translator());

    expect(explainer?.model?.permissions).toBeNull();
    expect(explainer?.model?.orgRoles).toHaveLength(3);
  });

  it('adds an app row after core’s, in its own words', () => {
    app.init = () =>
      registerAccessPermission({
        key: 'publish',
        label: 'Publish a client’s pages',
        allowed: { platform_admin: true, owner: true, admin: true, member: false },
      });
    const permissions = buildAccessExplainer(viewer(), translator())?.model?.permissions ?? [];

    expect(permissions.at(-1)).toEqual({
      key: 'publish',
      label: 'Publish a client’s pages',
      allowed: { platform_admin: true, owner: true, admin: true, member: false },
      source: 'app',
    });
  });
});
