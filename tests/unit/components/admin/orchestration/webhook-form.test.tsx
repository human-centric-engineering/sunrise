/**
 * WebhookForm Tests
 *
 * Test Coverage:
 * - Renders all form fields (URL, secret, description, events, active toggle)
 * - Validates URL required
 * - Validates secret min length
 * - Generate secret button populates the field
 * - Events checkboxes render all 11 event types
 *
 * @see components/admin/orchestration/webhook-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WebhookForm } from '@/components/admin/orchestration/webhook-form';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebhookForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all form fields', () => {
    render(<WebhookForm mode="create" />);

    expect(screen.getByRole('textbox', { name: /endpoint url/i })).toBeInTheDocument();
    expect(document.getElementById('secret')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /description/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /active/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create webhook/i })).toBeInTheDocument();
  });

  it('renders all 11 event type checkboxes', () => {
    render(<WebhookForm mode="create" />);

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(11);
  });

  it('validates URL is required on submit', async () => {
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    await user.click(screen.getByRole('button', { name: /create webhook/i }));

    await waitFor(() => {
      expect(screen.getByText(/must be a valid url/i)).toBeInTheDocument();
    });
  });

  it('validates secret minimum length', async () => {
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    // Fill URL and a short secret
    await user.type(
      screen.getByRole('textbox', { name: /endpoint url/i }),
      'https://example.com/hook'
    );
    await user.type(document.getElementById('secret')!, 'short');

    // Select an event
    await user.click(screen.getAllByRole('checkbox')[0]);

    await user.click(screen.getByRole('button', { name: /create webhook/i }));

    await waitFor(() => {
      expect(screen.getByText(/at least 16 characters/i)).toBeInTheDocument();
    });
  });

  it('generate button populates secret field', async () => {
    const user = userEvent.setup();
    render(<WebhookForm mode="create" />);

    await user.click(screen.getByTitle(/generate a random secret/i));

    const secretInput = document.getElementById('secret')! as HTMLInputElement;
    await waitFor(() => {
      expect(secretInput.value).toMatch(/^whsec_/);
      expect(secretInput.value.length).toBeGreaterThanOrEqual(38);
    });
  });
});
