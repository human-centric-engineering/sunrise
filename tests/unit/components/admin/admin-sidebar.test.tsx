// @vitest-environment happy-dom

/**
 * AdminSidebar Component Tests
 *
 * Covers section rendering, orchestration nav items, active-state
 * highlighting (including the `exact` flag on Dashboard), and the
 * collapse toggle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';

import { AdminSidebar, sectionsForViewer, sectionsForMode } from '@/components/admin/admin-sidebar';
import { registerNavSection, __resetNavRegistryForTests } from '@/lib/admin-nav/registry';
import { ORG_TIER_ADMIN_PAGES } from '@/lib/auth/admin-tier';

const pathnameMock = vi.fn(() => '/admin/overview');

/** The nav items shown at `multi` only: Members (t-813) and Support access (§121 t-823). */
const MULTI_ONLY = ['/admin/members', '/admin/support-access'];

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
}));

function countsResponse(counts: Record<string, number>) {
  return new Response(JSON.stringify({ success: true, data: { counts } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ZERO_COUNTS = {
  paused_for_approval: 0,
  pending: 0,
  running: 0,
};

describe('AdminSidebar', () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    pathnameMock.mockReset();
    pathnameMock.mockReturnValue('/admin/overview');
    mockFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', mockFetch);
    // Default: counts endpoint returns zeros for every requested status.
    mockFetch.mockResolvedValue(countsResponse(ZERO_COUNTS));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Clear any app nav sections registered during tests in this suite so
    // they don't bleed into the integration suite below.
    __resetNavRegistryForTests();
  });

  it('renders all four top-level sections', () => {
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Management')).toBeInTheDocument();
    expect(screen.getByText('AI Orchestration')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('renders the canonical orchestration items with correct hrefs', () => {
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    const expected: Array<{ label: string; href: string }> = [
      { label: 'Dashboard', href: '/admin/orchestration' },
      { label: 'Agents', href: '/admin/orchestration/agents' },
      { label: 'Capabilities', href: '/admin/orchestration/capabilities' },
      { label: 'Providers', href: '/admin/orchestration/providers' },
      { label: 'Workflows', href: '/admin/orchestration/workflows' },
      { label: 'Executions', href: '/admin/orchestration/executions' },
      { label: 'Conversations', href: '/admin/orchestration/conversations' },
      { label: 'Knowledge Base', href: '/admin/orchestration/knowledge' },
      { label: 'Costs & Budget', href: '/admin/orchestration/costs' },
      { label: 'Learning', href: '/admin/orchestration/learn' },
      { label: 'Testing', href: '/admin/orchestration/evaluations' },
    ];

    for (const { href } of expected) {
      const links = screen.getAllByRole('link');
      const link = links.find((el) => el.getAttribute('href') === href);
      expect(link, `link for ${href} not found`).toBeDefined();
    }
  });

  it('lists Organisations under Management, active on an org page (§120 t-745)', () => {
    pathnameMock.mockReturnValue('/admin/orgs/cmorg00000000000000grant');
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    const link = screen.getByRole('link', { name: /^organisations$/i });
    expect(link).toHaveAttribute('href', '/admin/orgs');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('highlights the Agents item when on a nested agents route', () => {
    pathnameMock.mockReturnValue('/admin/orchestration/agents/abc123');
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    const agentsLink = screen.getByRole('link', { name: /^agents$/i });
    expect(agentsLink).toHaveAttribute('aria-current', 'page');

    // The orchestration "Dashboard" item must NOT be active on a nested route
    // because it has `exact: true`.
    const dashboardLinks = screen.getAllByRole('link', { name: /^dashboard$/i });
    const orchestrationDashboard = dashboardLinks.find(
      (el) => el.getAttribute('href') === '/admin/orchestration'
    );
    expect(orchestrationDashboard, 'link for /admin/orchestration not found').toBeDefined();
    expect(orchestrationDashboard).not.toHaveAttribute('aria-current', 'page');
  });

  it('highlights the orchestration Dashboard on exact match', () => {
    pathnameMock.mockReturnValue('/admin/orchestration');
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    const dashboardLinks = screen.getAllByRole('link', { name: /^dashboard$/i });
    const orchestrationDashboard = dashboardLinks.find(
      (el) => el.getAttribute('href') === '/admin/orchestration'
    );
    expect(orchestrationDashboard, 'link for /admin/orchestration not found').toBeDefined();
    expect(orchestrationDashboard).toHaveAttribute('aria-current', 'page');
  });

  it('collapse toggle hides labels but keeps icons', async () => {
    const user = userEvent.setup();
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    expect(screen.getByText('AI Orchestration')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }));

    // Section headings hidden when collapsed
    expect(screen.queryByText('AI Orchestration')).not.toBeInTheDocument();

    // Top-level links are still present (so icons + hrefs remain navigable)
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute(
      'href',
      '/admin/orchestration/settings'
    );
  });

  it('shows approval badge when pending approvals exist', async () => {
    mockFetch.mockResolvedValue(countsResponse({ paused_for_approval: 3, pending: 0, running: 0 }));

    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('sums pending + running for the executions badge', async () => {
    mockFetch.mockResolvedValue(countsResponse({ paused_for_approval: 0, pending: 2, running: 4 }));

    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    // 2 + 4 = 6 — proves the call site sums the two statuses rather than
    // displaying either alone.
    await waitFor(() => {
      expect(screen.getByText('6')).toBeInTheDocument();
    });
  });

  it('does not show approval badge when count is zero', async () => {
    mockFetch.mockResolvedValue(countsResponse(ZERO_COUNTS));

    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('issues a single counts request per poll (not one per status)', async () => {
    mockFetch.mockResolvedValue(countsResponse(ZERO_COUNTS));

    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    // The previous implementation fanned out 3 list-endpoint calls per tick
    // (one per status). The new endpoint collapses them — anything > 1 call
    // on initial mount means the regression is back.
    // Both conditions are asserted inside waitFor so there is no window
    // between "at least one" and "exactly one" where a second tick could fire.
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(url).toContain('/api/v1/admin/orchestration/executions/counts');
    // Comma is an RFC 3986 sub-delim and is not percent-encoded by template
    // literals — the server splits on raw `,` anyway. Assert the statuses
    // travel together in a single query param rather than as N requests.
    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('statuses')?.split(',').sort()).toEqual([
      'paused_for_approval',
      'pending',
      'running',
    ]);
  });

  it('handles network errors gracefully', async () => {
    // Arrange: simulate a rejected promise (network / CORS / abort)
    mockFetch.mockRejectedValue(new Error('Network error'));

    // Act
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    // Assert: fetch was attempted, sidebar still renders, no badge appears
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.getByText('AI Orchestration')).toBeInTheDocument();
  });

  it('does not update badges when server returns a non-2xx response', async () => {
    // Arrange: simulate a 429 Too Many Requests — the !res.ok guard should
    // short-circuit before any JSON parsing, so badges must stay hidden.
    mockFetch.mockResolvedValue(new Response(null, { status: 429 }));

    // Act
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    // Assert: fetch was called, but no numeric badge is rendered
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.queryByText(/^\d+$/)).toBeNull();
    expect(screen.getByText('AI Orchestration')).toBeInTheDocument();
  });

  it('does not update badges when the response body fails schema validation', async () => {
    // Arrange: a 200 OK response whose `data.counts` contains an unknown status
    // key — the superRefine in executionCountsResponseSchema.safeParse rejects
    // it, so the badge must not render "99" or any garbage value.
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { counts: { not_a_real_status: 99 } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    // Act
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    // Assert: fetch was called, the garbage value must never appear, sidebar
    // keeps rendering normally.
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.queryByText('99')).toBeNull();
    expect(screen.getByText('AI Orchestration')).toBeInTheDocument();
  });
});

// ─── Integration: admin nav registry seam (Seam 4) ───────────────────────────
//
// Proves the end-to-end wiring: registerNavSection() → AdminSidebar renders
// app sections appended after the core sections, in DOM order.

describe('AdminSidebar – nav registry integration (Seam 4)', () => {
  const StubIcon: ComponentType<{ className?: string }> = () => null;

  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    pathnameMock.mockReset();
    pathnameMock.mockReturnValue('/admin/overview');
    mockFetch = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { counts: ZERO_COUNTS } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Prevent registered app sections from leaking into other tests.
    __resetNavRegistryForTests();
  });

  it('renders an app-registered section title and its nav link', async () => {
    // Arrange — register an app section before the sidebar renders.
    registerNavSection({
      title: 'My App',
      items: [
        {
          href: '/admin/my-app/dashboard',
          label: 'App Dashboard',
          icon: StubIcon,
          description: 'Main app page',
        },
      ],
    });

    // Act
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    // Assert — the section heading is present.
    expect(screen.getByText('My App')).toBeInTheDocument();
    // The nav link is present and has the correct href.
    const link = screen.getByRole('link', { name: /app dashboard/i });
    expect(link).toHaveAttribute('href', '/admin/my-app/dashboard');
  });

  it('app section appears in the DOM AFTER the core "System" section', () => {
    // Arrange — register an app section.
    registerNavSection({
      title: 'App Section',
      items: [
        {
          href: '/admin/app/page',
          label: 'App Page',
          icon: StubIcon,
          description: 'An app page',
        },
      ],
    });

    // Act
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    // Assert — the "System" heading (last core section) must come before the
    // "App Section" heading in DOM order.
    const systemHeading = screen.getByText('System');
    const appHeading = screen.getByText('App Section');

    // Node.DOCUMENT_POSITION_FOLLOWING (4) means appHeading is after systemHeading.
    const position = systemHeading.compareDocumentPosition(appHeading);
    const appIsAfterSystem = Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(appIsAfterSystem, 'app section must render after the core "System" section').toBe(true);
  });

  // #448: a fork's brand wordmark in its section header
  it('renders titleNode in place of the uppercase label, keeping title as the accessible name', () => {
    registerNavSection({
      title: 'Acme',
      // A raw <img> is the point: titleNode takes arbitrary JSX, and a fork's
      // wordmark is exactly the case that must not be rewritten to next/image.
      // eslint-disable-next-line @next/next/no-img-element
      titleNode: <img src="/acme.svg" alt="" data-testid="wordmark" />,
      items: [
        {
          href: '/admin/acme',
          label: 'Acme Home',
          icon: StubIcon,
          description: 'Acme landing',
        },
      ],
    });

    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    expect(screen.getByTestId('wordmark')).toBeInTheDocument();
    // The literal title text is not rendered — the node replaced it …
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
    // … but the heading still exposes it as its accessible name.
    const heading = screen.getByRole('heading', { name: 'Acme' });
    expect(heading).toContainElement(screen.getByTestId('wordmark'));
    // The uppercase treatment is dropped so a wordmark isn't restyled.
    expect(heading.className).not.toContain('uppercase');
  });

  it('keeps the uppercase label when no titleNode is given', () => {
    registerNavSection({
      title: 'Plain Section',
      items: [{ href: '/admin/plain', label: 'Plain Page', icon: StubIcon, description: 'Plain' }],
    });

    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    const heading = screen.getByRole('heading', { name: 'Plain Section' });
    expect(heading.className).toContain('uppercase');
    expect(heading).not.toHaveAttribute('aria-label');
  });
});

// Admin tiers (§111 t-810): an org viewer sees the items marked `tier: 'org'`
// and nothing else; a platform viewer sees every item, as before.
describe('AdminSidebar — what an org viewer sees', () => {
  const Icon: ComponentType<{ className?: string }> = () => null;

  beforeEach(() => {
    pathnameMock.mockReturnValue('/admin/overview');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(countsResponse(ZERO_COUNTS)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetNavRegistryForTests();
  });

  function registerMixedSection() {
    registerNavSection({
      title: 'Fork Console',
      items: [
        {
          href: '/admin/fork/org-thing',
          label: 'Org Thing',
          icon: Icon,
          description: 'org',
          tier: 'org',
        },
        {
          href: '/admin/fork/platform-thing',
          label: 'Platform Thing',
          icon: Icon,
          description: 'p',
        },
      ],
    });
  }

  it('shows an org viewer only the org-tier items, and no section left empty', () => {
    registerMixedSection();
    // The fork listed its org-tier page, as the roster test makes it.
    render(
      <AdminSidebar
        viewerTier="org"
        orgTierPages={[...ORG_TIER_ADMIN_PAGES, '/admin/fork/org-thing']}
      />
    );

    expect(screen.getByRole('link', { name: /Org Thing/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Platform Thing/ })).not.toBeInTheDocument();
    // The platform's items do not survive — including the Users and
    // Providers links an org admin must never be offered.
    expect(screen.queryByRole('link', { name: /Users/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Providers/ })).not.toBeInTheDocument();
    expect(screen.queryByText('System')).not.toBeInTheDocument();
    expect(screen.getByText('Fork Console')).toBeInTheDocument();
  });

  it('shows an org viewer exactly the customer’s core sections and the mixed pages (t-811, t-812)', () => {
    render(<AdminSidebar viewerTier="org" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    const hrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => href?.startsWith('/admin/') ?? false);
    expect(hrefs).toEqual([
      '/admin/orchestration',
      '/admin/orchestration/agents',
      '/admin/orchestration/workflows',
      '/admin/orchestration/mcp',
      '/admin/orchestration/knowledge',
      '/admin/orchestration/executions',
      '/admin/orchestration/conversations',
      '/admin/orchestration/approvals',
      '/admin/orchestration/triggers',
      '/admin/orchestration/event-subscriptions',
      '/admin/orchestration/evaluations',
      '/admin/orchestration/analytics',
      '/admin/orchestration/costs',
    ]);
  });

  it('shows an org viewer Members and Support access alone when orchestration is closed (t-929)', () => {
    const open = ORG_TIER_ADMIN_PAGES.filter((p) => !p.startsWith('/admin/orchestration'));
    render(<AdminSidebar viewerTier="org" multiTenant orgTierPages={open} />);

    const hrefs = screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => href?.startsWith('/admin/') ?? false);
    expect(hrefs).toEqual(['/admin/members', '/admin/support-access']);
    expect(screen.queryByText('AI Orchestration')).not.toBeInTheDocument();
  });

  it('control: a platform viewer still sees the platform’s items beside them', () => {
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    expect(screen.getByRole('link', { name: /Providers/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Agents/ })).toBeInTheDocument();
  });

  it('does not poll the platform-only execution counts for an org viewer', () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(countsResponse(ZERO_COUNTS));
    vi.stubGlobal('fetch', fetchSpy);
    render(<AdminSidebar viewerTier="org" orgTierPages={ORG_TIER_ADMIN_PAGES} />);
    expect(fetchSpy).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;

    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('control: a platform viewer sees both, and every core section', () => {
    registerMixedSection();
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    expect(screen.getByRole('link', { name: /Org Thing/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Platform Thing/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Users/ })).toBeInTheDocument();
  });
});

describe('sectionsForViewer', () => {
  const Icon: ComponentType<{ className?: string }> = () => null;
  const item = (href: string, tier?: 'org') => ({
    href,
    label: href,
    icon: Icon,
    description: '',
    tier,
  });

  it('returns the very array it was given for a platform viewer', () => {
    const sections = [{ title: 'A', items: [item('/a')] }];
    expect(sectionsForViewer(sections, 'platform', [])).toBe(sections);
  });

  it('filters subgroups too, dropping a subgroup with nothing left in it', () => {
    const sections = [
      {
        title: 'Orchestration',
        subgroups: [
          { label: 'Build', items: [item('/agents', 'org'), item('/providers')] },
          { label: 'Ops', items: [item('/settings')] },
        ],
      },
    ];
    expect(sectionsForViewer(sections, 'org', ['/agents'])).toEqual([
      {
        title: 'Orchestration',
        items: undefined,
        subgroups: [{ label: 'Build', items: [item('/agents', 'org')] }],
      },
    ]);
  });

  it('hides an org-tier item whose page is off the list — a section the fork closed (t-929)', () => {
    const sections = [
      {
        title: 'Management',
        items: [item('/admin/members', 'org'), item('/admin/orchestration/agents?tab=x', 'org')],
      },
    ];
    // Both shown while both pages are open, the query read as the page it opens…
    expect(
      sectionsForViewer(sections, 'org', ['/admin/members', '/admin/orchestration/agents'])[0].items
    ).toHaveLength(2);
    // …and the closed one dropped once its page is not.
    expect(sectionsForViewer(sections, 'org', ['/admin/members'])).toEqual([
      { title: 'Management', items: [item('/admin/members', 'org')], subgroups: undefined },
    ]);
  });
});

// Members (§111 t-813) is shown at `multi` only; at `single` the console is
// what it was before it.
describe('AdminSidebar — Members at multi (t-813)', () => {
  beforeEach(() => {
    pathnameMock.mockReturnValue('/admin/overview');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(countsResponse(ZERO_COUNTS)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetNavRegistryForTests();
  });

  const hrefsOf = () =>
    screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href): href is string => href !== null);

  it('hides Members for a platform viewer when the prop is omitted', () => {
    render(<AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />);
    expect(screen.queryByRole('link', { name: /Members/ })).not.toBeInTheDocument();
    expect(hrefsOf()).not.toContain('/admin/members');
  });

  it('shows Members and Support access for a platform viewer at multi, and every other link is unchanged', () => {
    const { unmount } = render(
      <AdminSidebar viewerTier="platform" orgTierPages={ORG_TIER_ADMIN_PAGES} />
    );
    const single = hrefsOf();
    unmount();

    render(<AdminSidebar viewerTier="platform" multiTenant orgTierPages={ORG_TIER_ADMIN_PAGES} />);
    const multi = hrefsOf();

    const members = screen.getByRole('link', { name: /Members/ });
    expect(members).toHaveAttribute('href', '/admin/members');
    expect(screen.getByRole('link', { name: /Support access/ })).toHaveAttribute(
      'href',
      '/admin/support-access'
    );
    expect(single).not.toContain('/admin/support-access');
    expect(multi.filter((h) => !MULTI_ONLY.includes(h))).toEqual(single);
  });

  it('shows an org viewer Members and Support access at multi but not Users or Organisations', () => {
    render(<AdminSidebar viewerTier="org" multiTenant orgTierPages={ORG_TIER_ADMIN_PAGES} />);

    expect(screen.getByRole('link', { name: /Members/ })).toHaveAttribute('href', '/admin/members');
    expect(screen.getByRole('link', { name: /Support access/ })).toHaveAttribute(
      'href',
      '/admin/support-access'
    );
    expect(screen.queryByRole('link', { name: /^Users/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Organisations/ })).not.toBeInTheDocument();
  });

  it('shows an org viewer no Members or Support access at single', () => {
    render(
      <AdminSidebar viewerTier="org" multiTenant={false} orgTierPages={ORG_TIER_ADMIN_PAGES} />
    );
    expect(screen.queryByRole('link', { name: /Members/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Support access/ })).not.toBeInTheDocument();
  });
});

describe('sectionsForMode', () => {
  const Icon: ComponentType<{ className?: string }> = () => null;
  const item = (href: string) => ({ href, label: href, icon: Icon, description: '' });
  const sections = [
    { title: 'Management', items: [item('/admin/users'), item('/admin/members'), item('/o')] },
    {
      title: 'Grouped',
      subgroups: [{ label: 'G', items: [item('/admin/members'), item('/g')] }],
    },
  ];

  it('returns the very array it was given at multi', () => {
    expect(sectionsForMode(sections, true)).toBe(sections);
  });

  it('removes /admin/members, from items and subgroups, and leaves everything else', () => {
    const result = sectionsForMode(sections, false);

    expect(result).toEqual([
      { title: 'Management', items: [item('/admin/users'), item('/o')] },
      { title: 'Grouped', subgroups: [{ label: 'G', items: [item('/g')] }] },
    ]);
    // The input is not mutated.
    expect(sections[0].items).toHaveLength(3);
  });

  it('removes only the multi-only items from the real core sections at single', async () => {
    const { coreNavSections } = await import('@/components/admin/admin-sidebar');
    const flat = (secs: typeof coreNavSections) =>
      secs.flatMap((s) => [...(s.items ?? []), ...(s.subgroups?.flatMap((g) => g.items) ?? [])]);

    const before = flat(coreNavSections).map((i) => i.href);
    const after = flat(sectionsForMode(coreNavSections, false)).map((i) => i.href);

    for (const href of MULTI_ONLY) expect(before).toContain(href);
    expect(after).toEqual(before.filter((h) => !MULTI_ONLY.includes(h)));
  });
});
