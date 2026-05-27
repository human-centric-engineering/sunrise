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

import { AdminSidebar } from '@/components/admin/admin-sidebar';
import { registerNavSection, __resetNavRegistryForTests } from '@/lib/admin-nav/registry';

const pathnameMock = vi.fn(() => '/admin/overview');

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
    render(<AdminSidebar />);
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Management')).toBeInTheDocument();
    expect(screen.getByText('AI Orchestration')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('renders the canonical orchestration items with correct hrefs', () => {
    render(<AdminSidebar />);

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

  it('highlights the Agents item when on a nested agents route', () => {
    pathnameMock.mockReturnValue('/admin/orchestration/agents/abc123');
    render(<AdminSidebar />);

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
    render(<AdminSidebar />);

    const dashboardLinks = screen.getAllByRole('link', { name: /^dashboard$/i });
    const orchestrationDashboard = dashboardLinks.find(
      (el) => el.getAttribute('href') === '/admin/orchestration'
    );
    expect(orchestrationDashboard, 'link for /admin/orchestration not found').toBeDefined();
    expect(orchestrationDashboard).toHaveAttribute('aria-current', 'page');
  });

  it('collapse toggle hides labels but keeps icons', async () => {
    const user = userEvent.setup();
    render(<AdminSidebar />);

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

    render(<AdminSidebar />);

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('sums pending + running for the executions badge', async () => {
    mockFetch.mockResolvedValue(countsResponse({ paused_for_approval: 0, pending: 2, running: 4 }));

    render(<AdminSidebar />);

    // 2 + 4 = 6 — proves the call site sums the two statuses rather than
    // displaying either alone.
    await waitFor(() => {
      expect(screen.getByText('6')).toBeInTheDocument();
    });
  });

  it('does not show approval badge when count is zero', async () => {
    mockFetch.mockResolvedValue(countsResponse(ZERO_COUNTS));

    render(<AdminSidebar />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('issues a single counts request per poll (not one per status)', async () => {
    mockFetch.mockResolvedValue(countsResponse(ZERO_COUNTS));

    render(<AdminSidebar />);

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
    render(<AdminSidebar />);

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
    render(<AdminSidebar />);

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
    render(<AdminSidebar />);

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
    render(<AdminSidebar />);

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
    render(<AdminSidebar />);

    // Assert — the "System" heading (last core section) must come before the
    // "App Section" heading in DOM order.
    const systemHeading = screen.getByText('System');
    const appHeading = screen.getByText('App Section');

    // Node.DOCUMENT_POSITION_FOLLOWING (4) means appHeading is after systemHeading.
    const position = systemHeading.compareDocumentPosition(appHeading);
    const appIsAfterSystem = Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(appIsAfterSystem, 'app section must render after the core "System" section').toBe(true);
  });
});
