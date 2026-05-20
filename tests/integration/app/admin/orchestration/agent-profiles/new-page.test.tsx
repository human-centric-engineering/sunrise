/**
 * Integration Test: Admin Orchestration — New Agent Profile Page
 *
 * Server component at `app/admin/orchestration/agent-profiles/new/page.tsx`.
 *
 * Thin shell that renders <AgentProfileForm mode="create" /> wrapped in a
 * breadcrumb nav. Confirms the form mounts and the nav points back to
 * the list.
 *
 * @see app/admin/orchestration/agent-profiles/new/page.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => '/admin/orchestration/agent-profiles/new'),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

describe('NewAgentProfilePage (server component)', () => {
  it('renders the create form and the breadcrumb back to the list', async () => {
    const { default: Page } = await import('@/app/admin/orchestration/agent-profiles/new/page');

    render(Page());

    expect(screen.getByRole('heading', { name: /new agent profile/i })).toBeInTheDocument();
    // Breadcrumb link back to the list.
    const back = screen.getByRole('link', { name: /agent profiles/i });
    expect(back).toHaveAttribute('href', '/admin/orchestration/agent-profiles');
    // CTA on the form is "Create profile" (create mode).
    expect(screen.getByRole('button', { name: /create profile/i })).toBeInTheDocument();
  });
});
