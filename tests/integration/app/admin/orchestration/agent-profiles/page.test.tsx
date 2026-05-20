/**
 * Integration Test: Admin Orchestration — Agent Profiles List Page
 *
 * Server component at `app/admin/orchestration/agent-profiles/page.tsx`.
 *
 * Covers:
 *   - Renders the page heading
 *   - Renders each profile row (name link, slug, agent count)
 *   - "+ New profile" CTA link present
 *   - Empty-state message when no profiles exist
 *   - Tolerates fetch failure (no throw, empty list shown)
 *
 * @see app/admin/orchestration/agent-profiles/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => '/admin/orchestration/agent-profiles'),
}));

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prof-1',
    name: 'Support Family',
    slug: 'support-family',
    description: 'Shared persona / voice / guardrails for the support team.',
    persona: null,
    brandVoiceInstructions: null,
    guardrails: null,
    isSystem: false,
    createdBy: 'system',
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
    agentCount: 0,
    ...overrides,
  };
}

const MOCK_PROFILES = [
  makeProfile({ id: 'p1', name: 'Support Family', slug: 'support-family', agentCount: 3 }),
  makeProfile({ id: 'p2', name: 'VIP Concierge', slug: 'vip-concierge', agentCount: 1 }),
];

describe('AgentProfilesListPage (server component)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  async function renderPage(profiles: ReturnType<typeof makeProfile>[] | null = MOCK_PROFILES) {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: profiles,
    } as never);
    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/page');
    render(await Page());
  }

  it('renders the "Agent Profiles" heading', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { name: /agent profiles/i })).toBeInTheDocument();
  });

  it('renders each profile name as a link and shows its slug + agent count', async () => {
    await renderPage();

    await waitFor(() => {
      const supportLink = screen.getByRole('link', { name: 'Support Family' });
      expect(supportLink).toHaveAttribute('href', '/admin/orchestration/agent-profiles/p1');
      const vipLink = screen.getByRole('link', { name: 'VIP Concierge' });
      expect(vipLink).toHaveAttribute('href', '/admin/orchestration/agent-profiles/p2');
    });

    expect(screen.getByText('support-family')).toBeInTheDocument();
    expect(screen.getByText('vip-concierge')).toBeInTheDocument();
    // Agent counts render in their own cells.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders the "+ New profile" CTA link to the create page', async () => {
    await renderPage();
    const cta = screen.getByRole('link', { name: /new profile/i });
    expect(cta).toHaveAttribute('href', '/admin/orchestration/agent-profiles/new');
  });

  it('renders the empty-state hint when no profiles exist', async () => {
    await renderPage([]);
    expect(screen.getByText(/no profiles yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Create a profile to share persona/i)).toBeInTheDocument();
  });

  it('returns empty list when serverFetch returns not ok (no throw)', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);
    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/page');

    render(await Page());

    expect(screen.getByRole('heading', { name: /agent profiles/i })).toBeInTheDocument();
    expect(screen.getByText(/no profiles yet/i)).toBeInTheDocument();
  });

  it('returns empty list when parseApiResponse reports success: false', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL', message: 'DB error' },
    } as never);
    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/page');

    render(await Page());

    expect(screen.getByText(/no profiles yet/i)).toBeInTheDocument();
  });

  it('does not throw when serverFetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));
    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/page');

    let thrown = false;
    try {
      render(await Page());
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(false);
    expect(screen.getByRole('heading', { name: /agent profiles/i })).toBeInTheDocument();
  });
});
