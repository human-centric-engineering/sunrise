// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Edit Agent Profile Page
 *
 * Server component at `app/admin/orchestration/agent-profiles/[id]/page.tsx`.
 *
 * Covers:
 *   - Fetches the profile and renders <AgentProfileForm mode="edit" />
 *   - Pre-fills the form from the API response
 *   - Calls notFound() on a 404, and only on a 404: a 500 or a network
 *     failure throws to the error boundary instead (#518)
 *
 * @see app/admin/orchestration/agent-profiles/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
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
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(makeProfile()));

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

  it('calls notFound() when the profile does not exist', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { notFound } = await import('next/navigation');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(404, 'NOT_FOUND'));

    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/[id]/page');

    await expect(Page({ params: Promise.resolve({ id: 'missing' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );
    expect(notFound).toHaveBeenCalledOnce();
    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      '/api/v1/admin/orchestration/agent-profiles/missing'
    );
  });

  it('throws to the error boundary, not notFound(), when the load fails', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    const { notFound } = await import('next/navigation');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/[id]/page');

    await expect(Page({ params: Promise.resolve({ id: 'p1' }) })).rejects.toBeInstanceOf(
      ServerLoadError
    );
    expect(notFound).not.toHaveBeenCalled();
  });

  it('throws to the error boundary when serverFetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    const { notFound } = await import('next/navigation');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/[id]/page');

    await expect(Page({ params: Promise.resolve({ id: 'p1' }) })).rejects.toBeInstanceOf(
      ServerLoadError
    );
    expect(notFound).not.toHaveBeenCalled();
  });
});
