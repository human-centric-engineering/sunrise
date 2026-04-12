/**
 * Integration Test: Admin Orchestration — New Provider Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/providers/new/page.tsx`.
 *
 * Test Coverage:
 * - Renders the create-mode form shell
 * - All 4 flavor radio options render
 * - "Create provider" submit button visible
 *
 * Note: NewProviderPage is a synchronous (non-async) server component.
 *
 * @see app/admin/orchestration/providers/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewProviderPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all 4 flavor radio options', async () => {
    const { default: NewProviderPage } =
      await import('@/app/admin/orchestration/providers/new/page');

    render(NewProviderPage());

    await waitFor(() => {
      // Flavor radios are custom <button role="radio"> containing both label and description text.
      // Use getAllByRole and check for buttons whose span text matches the flavor label exactly.
      const radios = screen.getAllByRole('radio');
      const labels = radios.map((r) =>
        Array.from(r.querySelectorAll('span'))
          .map((s) => s.textContent?.trim())
          .filter(Boolean)
      );
      const flatLabels = labels.flat().map((l) => l.toLowerCase());
      expect(flatLabels).toContain('anthropic');
      expect(flatLabels).toContain('openai');
      expect(flatLabels.some((l) => l.includes('ollama'))).toBe(true);
      expect(flatLabels.some((l) => l.includes('openai-compatible'))).toBe(true);
    });
  });

  it('renders "Create provider" submit button', async () => {
    const { default: NewProviderPage } =
      await import('@/app/admin/orchestration/providers/new/page');

    render(NewProviderPage());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
    });
  });

  it('renders a form element', async () => {
    const { default: NewProviderPage } =
      await import('@/app/admin/orchestration/providers/new/page');

    render(NewProviderPage());

    expect(document.querySelector('form')).toBeTruthy();
  });

  it('renders breadcrumb navigation links', async () => {
    const { default: NewProviderPage } =
      await import('@/app/admin/orchestration/providers/new/page');

    render(NewProviderPage());

    expect(screen.getByRole('link', { name: /ai orchestration/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /providers/i })).toBeInTheDocument();
  });
});
