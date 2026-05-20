/**
 * Integration Test: Admin Orchestration — Edit Agent Profile Page
 *
 * Server component at `app/admin/orchestration/agent-profiles/[id]/page.tsx`.
 *
 * Covers:
 *   - Fetches the profile and renders <AgentProfileForm mode="edit" />
 *   - Pre-fills the form from the API response
 *   - Calls notFound() when the API returns a non-ok response
 *
 * @see app/admin/orchestration/agent-profiles/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>('next/navigation');
  return {
    ...actual,
    notFound: vi.fn(() => {
      // Throw a sentinel so the test can assert it was invoked without
      // letting the page continue rendering.
      throw new Error('NEXT_NOT_FOUND');
    }),
    useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
    useSearchParams: vi.fn(() => new URLSearchParams()),
    usePathname: vi.fn(() => '/admin/orchestration/agent-profiles/p1'),
  };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

function makeProfile() {
  return {
    id: 'p1',
    name: 'Support Family',
    slug: 'support-family',
    description: 'Shared profile.',
    persona: 'You are a calm senior support specialist.',
    brandVoiceInstructions: 'Friendly and concise.',
    guardrails: 'Never give medical advice.',
    agents: [],
  };
}

describe('EditAgentProfilePage (server component)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the edit form pre-filled from the API response', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: makeProfile(),
    } as never);

    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/[id]/page');

    render(await Page({ params: Promise.resolve({ id: 'p1' }) }));

    expect(screen.getByRole('heading', { name: /support family/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    // Pre-filled fields.
    expect(screen.getByRole('textbox', { name: /^name/i })).toHaveValue('Support Family');
    expect(screen.getByRole('textbox', { name: /^persona/i })).toHaveValue(
      'You are a calm senior support specialist.'
    );
    // Slug input is disabled on edit.
    expect(screen.getByRole('textbox', { name: /^slug/i })).toBeDisabled();
  });

  it('calls notFound() when serverFetch returns not ok', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/[id]/page');

    await expect(Page({ params: Promise.resolve({ id: 'missing' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );
  });

  it('calls notFound() when parseApiResponse reports success: false', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'NOT_FOUND', message: 'gone' },
    } as never);

    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/[id]/page');

    await expect(Page({ params: Promise.resolve({ id: 'missing' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );
  });
});
