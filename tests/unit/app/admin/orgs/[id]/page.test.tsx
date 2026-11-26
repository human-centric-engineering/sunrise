// @vitest-environment happy-dom

/**
 * Admin — one organisation (§120 t-745): the org, its approved providers,
 * the provider list and its usage this month against its cap (§110 t-790),
 * fetched in parallel.
 *
 * The org is the detail record: only a 404 (or an id that cannot name an org,
 * a 400) is the not-found page, and any other failure throws to the error
 * boundary (#518). The policy, providers and usage keep their own "could not
 * be loaded" text, and every failure is logged. Only `serverFetch` is faked:
 * the real parser and `lib/api/server-load.ts` run.
 *
 * @see app/admin/orgs/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { put: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  unstable_rethrow: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import OrgPage from '@/app/admin/orgs/[id]/page';
import { notFound } from 'next/navigation';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { apiFailure, apiSuccess, apiIdRejected } from '@/tests/helpers/api';

const ID = 'cmorg00000000000000grant';
const ORG_PATH = `/api/v1/admin/orgs/${ID}`;
const POLICY_PATH = `/api/v1/admin/orgs/${ID}/providers`;
const PROVIDERS_PATH = '/api/v1/admin/orchestration/providers?page=1&limit=100';
const USAGE_PATH = `/api/v1/admin/orchestration/costs/orgs?orgId=${ID}`;
const PRIVACY_PATH = `/api/v1/admin/orgs/${ID}/privacy`;
const ENTITLEMENTS_PATH = `/api/v1/admin/orgs/${ID}/entitlements`;
const METERS_PATH = `/api/v1/admin/orgs/${ID}/meters`;
const PLAN_PATH = `/api/v1/admin/orgs/${ID}/plan`;

/** An org that has never saved its privacy settings (§127 t-1010). */
const PRIVACY = {
  orgId: ID,
  saved: false,
  unreadable: false,
  minimumMode: null,
  protectedTerms: [],
};

/** An install whose app registers no entitlement switch, as vanilla Sunrise (§135 t-1033). */
const NO_SWITCHES = {
  orgId: ID,
  nothingSet: true,
  unreadable: false,
  mayChange: true,
  registrationFailed: false,
  switches: [],
  unregistered: [],
};

/** The platform's seats alone, with no limit set, as on vanilla Sunrise (§135 t-1035). */
const SEATS_ONLY = {
  orgId: ID,
  mayChange: true,
  registrationFailed: false,
  meters: [
    {
      key: 'seats',
      label: 'Seats',
      description:
        'Members who are not platform staff, plus open invitations into the organisation.',
      period: 'standing',
      core: true,
      limit: null,
      used: 2,
      window: { from: null, to: null },
      countFailed: false,
    },
  ],
  unregistered: {},
};

/** An install whose app registers no plan, as vanilla Sunrise (§139 t-1093). */
const NO_PLANS = {
  orgId: ID,
  enabled: false,
  multiTenant: false,
  registrationFailed: false,
  mayChange: true,
  plans: [],
  fallbackPlanKey: null,
  subscription: null,
};

/** What each path answers when a test does not name it. */
const DEFAULTS: Record<string, unknown> = {
  [PRIVACY_PATH]: PRIVACY,
  [ENTITLEMENTS_PATH]: NO_SWITCHES,
  [METERS_PATH]: SEATS_ONLY,
  [PLAN_PATH]: NO_PLANS,
};

/**
 * Answer each path with its body. A path mapped to `null` (or not mapped) is a
 * 404; one mapped to a number is that HTTP status. `metas` gives a path's
 * pagination meta. The privacy settings answer as never saved, the switches
 * as none registered, and the meters as seats alone with no limit, unless a
 * test names them.
 */
function serve(bodies: Record<string, unknown>, metas: Record<string, unknown> = {}) {
  vi.mocked(serverFetch).mockImplementation(async (path: string) => {
    const data = path in bodies ? bodies[path] : DEFAULTS[path];
    if (data === null || data === undefined) return apiFailure(404, 'NOT_FOUND');
    if (typeof data === 'number') return apiFailure(data);
    if (data instanceof Response) return data.clone();
    // A list with no meta given is one complete page, as the API reports it.
    const meta =
      metas[path] ??
      (Array.isArray(data)
        ? { page: 1, limit: 100, total: data.length, totalPages: 1 }
        : undefined);
    return apiSuccess(data, meta);
  });
}

const ORG = { id: ID, slug: 'acme', name: 'Acme', status: 'ACTIVE', members: [{ id: 'u1' }] };
const POLICY = {
  orgId: ID,
  unrestricted: false,
  enforced: true,
  approved: [{ id: 'id-anthropic', slug: 'anthropic' }],
  jurisdictions: null,
};
const PROVIDERS = [
  { id: 'id-anthropic', slug: 'anthropic', name: 'Anthropic', isActive: true, jurisdiction: null },
  { id: 'id-openai', slug: 'openai', name: 'OpenAI', isActive: true, jurisdiction: null },
];

const params = Promise.resolve({ id: ID });

describe('OrgPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the org and its approved providers for editing', async () => {
    serve({ [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS });

    render(await OrgPage({ params }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Acme');
    expect(screen.getByText(/1 member$/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /OpenAI/ })).not.toBeChecked();
  });

  it('marks a suspended org, and counts its members', async () => {
    serve({
      [ORG_PATH]: { ...ORG, status: 'SUSPENDED', members: [{ id: 'u1' }, { id: 'u2' }] },
      [POLICY_PATH]: POLICY,
      [PROVIDERS_PATH]: PROVIDERS,
    });

    render(await OrgPage({ params }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('suspended');
    expect(screen.getByText(/2 members$/)).toBeInTheDocument();
  });

  it('treats a fetch that throws as not loaded, and logs which one', async () => {
    serve({ [ORG_PATH]: ORG, [PROVIDERS_PATH]: PROVIDERS });
    const answer = vi.mocked(serverFetch).getMockImplementation()!;
    vi.mocked(serverFetch).mockImplementation(async (path: string) => {
      if (path === POLICY_PATH) throw new Error('network');
      return answer(path);
    });

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.any(Error), {
      path: POLICY_PATH,
    });
  });

  it('is a 404 when the org does not exist', async () => {
    serve({ [ORG_PATH]: null, [POLICY_PATH]: null, [PROVIDERS_PATH]: PROVIDERS });

    await expect(OrgPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('is a 404 when the id cannot name an org (the API answers 400)', async () => {
    serve({
      [ORG_PATH]: apiIdRejected('query'),
      [POLICY_PATH]: apiIdRejected('query'),
      [PROVIDERS_PATH]: PROVIDERS,
    });

    await expect(OrgPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('sends any other failure to load the org to the error boundary, not to a 404', async () => {
    serve({ [ORG_PATH]: 500, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS });

    await expect(OrgPage({ params })).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFound).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), undefined, {
      path: ORG_PATH,
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('sends a fetch that throws for the org to the error boundary', async () => {
    serve({ [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS });
    const answer = vi.mocked(serverFetch).getMockImplementation()!;
    vi.mocked(serverFetch).mockImplementation(async (path: string) => {
      if (path === ORG_PATH) throw new Error('ECONNREFUSED');
      return answer(path);
    });

    await expect(OrgPage({ params })).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('lists providers from every page, so each can be granted or revoked', async () => {
    const PAGE_2 = '/api/v1/admin/orchestration/providers?page=2&limit=100';
    serve(
      {
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [PAGE_2]: [{ id: 'id-far', slug: 'far', name: 'Far', isActive: true, jurisdiction: null }],
      },
      {
        [PROVIDERS_PATH]: { page: 1, limit: 100, total: 101, totalPages: 2 },
        [PAGE_2]: { page: 2, limit: 100, total: 101, totalPages: 2 },
      }
    );

    render(await OrgPage({ params }));

    expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Far/ })).toBeInTheDocument();
  });

  it('lists a provider once when a page boundary shifts between requests', async () => {
    const PAGE_2 = '/api/v1/admin/orchestration/providers?page=2&limit=100';
    serve(
      {
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        // OpenAI slid onto page 2 as well, after a provider was created.
        [PAGE_2]: [PROVIDERS[1]],
      },
      {
        [PROVIDERS_PATH]: { page: 1, limit: 100, total: 101, totalPages: 2 },
        [PAGE_2]: { page: 2, limit: 100, total: 101, totalPages: 2 },
      }
    );

    render(await OrgPage({ params }));

    expect(screen.getAllByRole('checkbox', { name: /OpenAI/ })).toHaveLength(1);
  });

  it('withholds the form when the provider list does not say how many pages it has', async () => {
    serve(
      { [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS },
      { [PROVIDERS_PATH]: { malformed: true } }
    );

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
  });

  it('withholds the form when a later page of providers fails', async () => {
    serve(
      { [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS },
      { [PROVIDERS_PATH]: { page: 1, limit: 100, total: 101, totalPages: 2 } }
    );

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('says the providers could not be loaded rather than offering an empty set to save', async () => {
    serve({ [ORG_PATH]: ORG, [POLICY_PATH]: 500, [PROVIDERS_PATH]: PROVIDERS });

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Save approved providers/ })
    ).not.toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), undefined, {
      path: POLICY_PATH,
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('says so when the provider list cannot be loaded either', async () => {
    serve({ [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: null });

    render(await OrgPage({ params }));

    expect(screen.getByText(/approved providers could not be loaded/)).toBeInTheDocument();
  });

  describe('AI usage this month (§110 t-790)', () => {
    const USAGE = {
      period: '2026-10',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      orgs: [
        {
          orgId: ID,
          name: 'Acme',
          slug: 'acme',
          status: 'ACTIVE',
          totalCostUsd: 40,
          inputTokens: 900,
          outputTokens: 100,
          count: 12,
          monthlyBudgetUsd: 50,
          utilisation: 0.8,
        },
      ],
      detached: null,
      totals: { totalCostUsd: 40, inputTokens: 900, outputTokens: 100, count: 12 },
    };

    it("shows the org's spend against its cap, from the usage endpoint narrowed to it", async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [USAGE_PATH]: USAGE,
      });

      render(await OrgPage({ params }));

      expect(vi.mocked(serverFetch).mock.calls.map((call) => call[0])).toContain(USAGE_PATH);
      expect(screen.getByTestId('org-usage-summary')).toBeInTheDocument();
      expect(screen.getByText('Spend (2026-10)')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');
    });

    it('says usage is install-org only when the endpoint refuses the caller', async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [USAGE_PATH]: 403,
      });

      render(await OrgPage({ params }));

      expect(
        screen.getByText('Usage can only be viewed from the install organisation.')
      ).toBeInTheDocument();
      expect(screen.queryByTestId('org-usage-summary')).not.toBeInTheDocument();
      // An expected refusal, not a failure.
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('says the usage could not be loaded when the fetch fails, and still renders the rest', async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [USAGE_PATH]: 500,
      });

      render(await OrgPage({ params }));

      expect(screen.getByText(/usage could not be loaded/)).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toBeChecked();
      // Before #518 a non-OK usage answer was not logged.
      expect(logger.error).toHaveBeenCalledWith(expect.any(String), undefined, {
        path: USAGE_PATH,
        status: 500,
        code: 'INTERNAL_ERROR',
      });
    });
  });

  describe('LLM privacy (§127 t-1010)', () => {
    it('offers the privacy form, suggesting the org’s own name before a first save', async () => {
      serve({ [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS });

      render(await OrgPage({ params }));

      expect(vi.mocked(serverFetch).mock.calls.map((call) => call[0])).toContain(PRIVACY_PATH);
      expect(screen.getByRole('heading', { name: 'LLM privacy' })).toBeInTheDocument();
      expect(screen.getByTestId('org-privacy-terms')).toHaveTextContent('Acme');
      expect(screen.getByTestId('org-privacy-suggested')).toBeInTheDocument();
    });

    it('says the privacy settings could not be loaded rather than offer an empty form', async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [PRIVACY_PATH]: 500,
      });

      render(await OrgPage({ params }));

      expect(
        screen.getByText('The privacy settings could not be loaded. Reload the page to try again.')
      ).toBeInTheDocument();
      expect(screen.queryByTestId('org-privacy-terms')).not.toBeInTheDocument();
      // The rest of the page still renders.
      expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toBeChecked();
    });
  });

  describe('Entitlements (§135 t-1033)', () => {
    const SWITCH = {
      key: 'reports',
      label: 'Reports',
      description: 'Build and share reports.',
      whenNothingSet: false,
    };
    const ENTITLEMENTS = {
      orgId: ID,
      nothingSet: false,
      unreadable: false,
      mayChange: true,
      registrationFailed: false,
      switches: [{ ...SWITCH, on: true, atDefault: false }],
      unregistered: [],
    };

    it('shows nothing new when the API reports no registered switch', async () => {
      serve({ [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS });

      render(await OrgPage({ params }));

      // Asked the API rather than reading the registry from the page.
      expect(vi.mocked(serverFetch).mock.calls.map((call) => call[0])).toContain(ENTITLEMENTS_PATH);
      expect(screen.getByRole('heading', { name: 'Approved providers' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Entitlements' })).not.toBeInTheDocument();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("offers the org's switches when the app registers some", async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [ENTITLEMENTS_PATH]: ENTITLEMENTS,
      });

      render(await OrgPage({ params }));

      expect(screen.getByRole('heading', { name: 'Entitlements' })).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: /Reports/ })).toBeChecked();
    });

    it("says the app's switches failed to register, rather than show nothing as vanilla Sunrise", async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [ENTITLEMENTS_PATH]: { ...NO_SWITCHES, registrationFailed: true },
      });

      render(await OrgPage({ params }));

      expect(screen.getByRole('heading', { name: 'Entitlements' })).toBeInTheDocument();
      expect(screen.getByText(/could not be registered/)).toBeInTheDocument();
    });

    it('says the switches could not be loaded rather than offer a form to save over them', async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [ENTITLEMENTS_PATH]: 500,
      });

      render(await OrgPage({ params }));

      expect(
        screen.getByText('The switches could not be loaded. Reload the page to try again.')
      ).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: /Reports/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save switches' })).not.toBeInTheDocument();
    });
  });
  describe('Limits (§135 t-1035)', () => {
    it("always shows the org's seats against its limit, asked of the API", async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [METERS_PATH]: {
          ...SEATS_ONLY,
          meters: [{ ...SEATS_ONLY.meters[0], limit: 2 }],
        },
      });

      render(await OrgPage({ params }));

      expect(vi.mocked(serverFetch).mock.calls.map((call) => call[0])).toContain(METERS_PATH);
      expect(screen.getByRole('heading', { name: 'Limits' })).toBeInTheDocument();
      expect(screen.getByTestId('meter-usage-seats')).toHaveTextContent('2 of 2 now');
      expect(screen.getByLabelText(/Seats/)).toHaveValue('2');
    });

    it('says the limits could not be loaded rather than offer a form to save over them', async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [METERS_PATH]: 500,
      });

      render(await OrgPage({ params }));

      expect(
        screen.getByText('The limits could not be loaded. Reload the page to try again.')
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save limits' })).not.toBeInTheDocument();
    });
  });

  describe('Plan (§139 t-1093)', () => {
    const PLANS = {
      ...NO_PLANS,
      enabled: true,
      multiTenant: true,
      plans: [
        {
          key: 'pro',
          label: 'Pro',
          description: 'Reports, and room for a team.',
          priced: false,
          switches: { reports: true },
          meterLimits: { seats: 25 },
          aiBudgetUsd: 100,
          decidesAiBudget: true,
        },
      ],
    };

    it('shows nothing new when plans do not apply', async () => {
      serve({ [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS });

      render(await OrgPage({ params }));

      // Asked the API rather than reading the registry from the page.
      expect(vi.mocked(serverFetch).mock.calls.map((call) => call[0])).toContain(PLAN_PATH);
      expect(screen.queryByRole('heading', { name: 'Plan' })).not.toBeInTheDocument();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('offers the plans, and what each decides, when they apply', async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [PLAN_PATH]: PLANS,
      });

      render(await OrgPage({ params }));

      expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /Pro/ })).not.toBeChecked();
      expect(screen.getByRole('radio', { name: /No plan/ })).toBeChecked();
      expect(screen.getByTestId('plan-summary-pro')).toHaveTextContent(
        'reports on · seats 25 · AI budget $100'
      );
    });

    it('shows the switches a plan wrote once the page refreshes, not what the form first loaded', async () => {
      const SWITCH = { key: 'reports', label: 'Reports', description: '', whenNothingSet: false };
      const switchesWith = (on: boolean) => ({
        ...NO_SWITCHES,
        nothingSet: false,
        switches: [{ ...SWITCH, on, atDefault: false }],
      });
      const onPro = (updatedAt: string) => ({
        ...PLANS,
        subscription: {
          planKey: 'pro',
          provider: null,
          providerManaged: false,
          status: 'ACTIVE',
          planAppliedAt: updatedAt,
          updatedAt,
        },
      });
      const base = { [ORG_PATH]: ORG, [POLICY_PATH]: POLICY, [PROVIDERS_PATH]: PROVIDERS };
      serve({ ...base, [ENTITLEMENTS_PATH]: switchesWith(false), [PLAN_PATH]: PLANS });
      const { rerender } = render(await OrgPage({ params }));
      expect(screen.getByRole('checkbox', { name: /Reports/ })).not.toBeChecked();

      // The plan form saved and refreshed the page: the server now reports
      // the plan's switches, and the record has moved on.
      serve({
        ...base,
        [ENTITLEMENTS_PATH]: switchesWith(true),
        [PLAN_PATH]: onPro('2026-11-26T10:00:00.000Z'),
      });
      rerender(await OrgPage({ params }));

      expect(screen.getByRole('checkbox', { name: /Reports/ })).toBeChecked();
    });

    it("says the app's plans failed to register, rather than show nothing", async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [PLAN_PATH]: { ...NO_PLANS, registrationFailed: true },
      });

      render(await OrgPage({ params }));

      expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
      expect(screen.getByText(/plans could not be registered/)).toBeInTheDocument();
    });

    it('says the plan could not be loaded rather than offer a form to save over it', async () => {
      serve({
        [ORG_PATH]: ORG,
        [POLICY_PATH]: POLICY,
        [PROVIDERS_PATH]: PROVIDERS,
        [PLAN_PATH]: 500,
      });

      render(await OrgPage({ params }));

      expect(
        screen.getByText('The plan could not be loaded. Reload the page to try again.')
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save plan' })).not.toBeInTheDocument();
    });
  });
});
