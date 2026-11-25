// @vitest-environment happy-dom

/**
 * Tests: the access explainer page's view, for each viewer (§143 t-1091)
 *
 * Each case builds the explainer the route would return for one viewer, with
 * the real read model over a registered agency app, runs it through the
 * page's response schema, and renders it. So what is pinned is what a
 * platform admin, an org OWNER and a named-tier holder actually see — each
 * their own slice — and that the schema reads what the read model writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const app = vi.hoisted(() => ({ init: (): void => {} }));
vi.mock('@/lib/app/access-explainer', () => ({ initAppAccessExplainer: () => app.init() }));

import { AccessExplainerView } from '@/components/admin/access-explainer/access-explainer-view';
import {
  buildAccessExplainer,
  __resetAccessExplainerForTests,
  type AccessExplainerViewer,
  type AccessTranslator,
} from '@/lib/auth/access-explainer';
import {
  registerAccessSection,
  registerPlatformOnlySurface,
} from '@/lib/auth/access-explainer-registry';
import {
  registerAdminTier,
  registerOrgTierAdminPage,
  type AdminReach,
  type LockedAdminSwitch,
} from '@/lib/auth/admin-tier';
import { __resetAppOrgTierAdminPagesForTests } from '@/lib/auth/org-tier-admin-pages';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
} from '@/lib/tenancy/entitlements';
import { accessExplainerResponseSchema } from '@/lib/validations/access-explainer';
import { translatorFor } from '@/tests/helpers/i18n';

function translator(): AccessTranslator {
  const t = translatorFor();
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

/** The app an agency product would be: a named tier, a locked switch, its own pages. */
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
}

/** What the route returns for this viewer, read back through the page's schema. */
function explainerFor(overrides: Partial<AccessExplainerViewer>) {
  const built = buildAccessExplainer(
    {
      reach: 'platform',
      orgRole: null,
      switchesOn: null,
      locked: [],
      supportEntry: false,
      multiTenant: true,
      ...overrides,
    },
    translator()
  );
  // The response travels as JSON; the schema reads it as the page does.
  return accessExplainerResponseSchema.parse(JSON.parse(JSON.stringify(built)));
}

const ORG_OWNER: Partial<AccessExplainerViewer> = {
  reach: {
    tiers: ['org', 'designers'],
    landing: null,
    switchesMet: [
      { tier: 'org', requires: 'briefs' },
      { tier: 'designers', requires: 'briefs' },
    ],
  } satisfies AdminReach,
  orgRole: 'OWNER',
  switchesOn: ['briefs'],
  locked: [LEAD_LOCK],
};

const HOLDER: Partial<AccessExplainerViewer> = {
  reach: { tiers: ['designers'], landing: '/admin/designs', switchesMet: [] },
  orgRole: 'MEMBER',
  switchesOn: ['briefs'],
  locked: [LEAD_LOCK],
};

const heading = (name: string) => screen.queryByRole('heading', { level: 2, name });

beforeEach(() => {
  app.init = () => {};
  __resetAccessExplainerForTests();
  __resetAppOrgTierAdminPagesForTests();
  __resetEntitlementRegistryForTests();
  registerAgencyApp();
});
afterEach(() => {
  __resetAccessExplainerForTests();
  __resetAppOrgTierAdminPagesForTests();
  __resetEntitlementRegistryForTests();
});

describe('AccessExplainerView — a platform admin', () => {
  it('shows every section, with what the platform keeps, and says switches do not limit them', () => {
    render(<AccessExplainerView explainer={explainerFor({})} orgName={null} />);

    for (const name of ['Your access', 'Roles', 'Pages by area', 'Switches']) {
      expect(heading(name)).toBeInTheDocument();
    }
    expect(heading('Kept for the platform team')).toBeInTheDocument();
    expect(screen.getByText(/You are a platform admin/)).toBeInTheDocument();
    // A platform admin opens every page, so none is listed as closed.
    expect(screen.queryByText("Pages you can't open")).not.toBeInTheDocument();
    // Every switch, the hidden one too.
    const switches = screen.getByRole('region', { name: 'Switches' });
    expect(within(switches).getByText('Briefs')).toBeInTheDocument();
    expect(within(switches).getByText('Lead generation')).toBeInTheDocument();
    // Core's pages and the app's, the platform one linked.
    expect(screen.getByText('/admin/members')).toBeInTheDocument();
    expect(screen.getByText('/admin/designs')).toBeInTheDocument();
  });
});

describe('AccessExplainerView — an org OWNER', () => {
  it('names the org and their role, lists what they open, and says why the locked page is locked', () => {
    render(<AccessExplainerView explainer={explainerFor(ORG_OWNER)} orgName="Acme" />);

    const panel = screen.getByRole('region', { name: 'Your access in Acme' });
    expect(within(panel).getByText('Your role here: Owner')).toBeInTheDocument();
    expect(within(panel).getByText('Owners and admins')).toBeInTheDocument();
    expect(within(panel).getByText('Agency designers')).toBeInTheDocument();
    // The org's switch, and the pages the missing one closes, with the app's words.
    expect(within(panel).getByText('Briefs')).toBeInTheDocument();
    expect(within(panel).getByText('/admin/leads')).toBeInTheDocument();
    expect(
      within(panel).getAllByText(/Lead generation comes with the Growth plan/).length
    ).toBeGreaterThan(0);
    expect(within(panel).getAllByRole('link', { name: 'How to get it' })[0]).toHaveAttribute(
      'href',
      '/pricing'
    );
  });

  it('names what the platform keeps without a link they would be turned away from', () => {
    app.init = () => {
      registerPlatformOnlySurface({
        key: 'billing',
        label: 'Billing',
        reason: 'Invoices are handled by the platform team.',
        href: '/admin/billing',
      });
    };
    render(<AccessExplainerView explainer={explainerFor(ORG_OWNER)} orgName="Acme" />);

    const kept = screen.getByRole('region', { name: 'Kept for the platform team' });
    expect(within(kept).getByText('Billing')).toBeInTheDocument();
    expect(within(kept).queryByRole('link')).not.toBeInTheDocument();
  });

  it('links a page they open, and not one they cannot', () => {
    render(<AccessExplainerView explainer={explainerFor(ORG_OWNER)} orgName="Acme" />);

    const areas = screen.getByRole('region', { name: 'Pages by area' });
    expect(within(areas).getByRole('link', { name: '/admin/briefs' })).toHaveAttribute(
      'href',
      '/admin/briefs'
    );
    expect(within(areas).queryByRole('link', { name: '/admin/leads' })).not.toBeInTheDocument();
  });
  it('says a page is closed for its tier, not its switch, when the org has the switch', () => {
    // The org has Briefs on; the owner does not hold the designers tier.
    registerOrgTierAdminPage('/admin/designs/briefs', { tier: 'designers', requires: 'briefs' });
    const owner = {
      ...ORG_OWNER,
      reach: {
        tiers: ['org'],
        landing: null,
        switchesMet: [{ tier: 'org', requires: 'briefs' }],
      } satisfies AdminReach,
    };
    render(<AccessExplainerView explainer={explainerFor(owner)} orgName="Acme" />);

    const panel = screen.getByRole('region', { name: 'Your access in Acme' });
    const row = within(panel).getByText('/admin/designs/briefs').closest('li');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(/Needs Agency designers\./)).toBeInTheDocument();
    expect(screen.queryByText(/Needs Briefs, which this organisation/)).not.toBeInTheDocument();
  });
});

describe('AccessExplainerView — a named-tier holder', () => {
  it('shows their tier and its pages alone: no core area, no other page', () => {
    render(<AccessExplainerView explainer={explainerFor(HOLDER)} orgName="Acme" />);

    const panel = screen.getByRole('region', { name: 'Your access in Acme' });
    expect(within(panel).getByText('Agency designers')).toBeInTheDocument();
    expect(within(panel).queryByText('Owners and admins')).not.toBeInTheDocument();
    expect(screen.getByText('/admin/designs')).toBeInTheDocument();
    for (const other of [
      '/admin/members',
      '/admin/leads',
      '/admin/briefs',
      '/admin/orchestration',
    ]) {
      expect(screen.queryByText(other)).not.toBeInTheDocument();
    }
    // Only the switch their pages need.
    const switches = screen.getByRole('region', { name: 'Switches' });
    expect(within(switches).queryByText('Briefs')).not.toBeInTheDocument();
  });

  it('names their org role in words, not as the enum', () => {
    render(<AccessExplainerView explainer={explainerFor(HOLDER)} orgName="Acme" />);

    const panel = screen.getByRole('region', { name: 'Your access in Acme' });
    expect(within(panel).getByText('Your role here: Member')).toBeInTheDocument();
    expect(within(panel).queryByText(/MEMBER/)).not.toBeInTheDocument();
  });

  it('says why their tier’s page needing a switch is locked', () => {
    render(<AccessExplainerView explainer={explainerFor(HOLDER)} orgName="Acme" />);

    const panel = screen.getByRole('region', { name: 'Your access in Acme' });
    expect(within(panel).getByText('/admin/designs/[id]')).toBeInTheDocument();
    expect(
      within(panel).getByText(/Lead generation comes with the Growth plan/)
    ).toBeInTheDocument();
  });
});

describe('AccessExplainerView — what the route leaves out', () => {
  it('says the org’s switches could not be read, rather than that it has none', () => {
    render(
      <AccessExplainerView
        explainer={explainerFor({ ...ORG_OWNER, switchesOn: null, locked: [] })}
        orgName="Acme"
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't read this organisation's switches"
    );
    expect(screen.queryByText('This organisation has no switches on.')).not.toBeInTheDocument();
  });

  it('renders the app’s own section for its audience', () => {
    app.init = () => {
      registerAccessSection({
        key: 'agency',
        title: 'Agency access',
        body: 'Your agency is set up by the platform team.',
        audience: ['org'],
      });
    };
    render(<AccessExplainerView explainer={explainerFor(ORG_OWNER)} orgName="Acme" />);

    expect(heading('Agency access')).toBeInTheDocument();
    expect(screen.getByText('Your agency is set up by the platform team.')).toBeInTheDocument();
  });

  it('names a support session as one, not as a role in the org', () => {
    render(
      <AccessExplainerView
        explainer={explainerFor({ ...ORG_OWNER, supportEntry: true })}
        orgName="Acme"
      />
    );

    expect(screen.getByText(/under support access/)).toBeInTheDocument();
    expect(screen.queryByText(/Your role here/)).not.toBeInTheDocument();
  });
});
