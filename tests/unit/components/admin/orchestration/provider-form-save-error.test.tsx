// @vitest-environment happy-dom

/**
 * ProviderForm — failed save (§124)
 *
 * The error sits in the sticky bar beside Save, so it stays in view; a field
 * the server named gets its message under it and takes focus, with the
 * collapsed Advanced section opened when that is where the field is.
 *
 * @see components/admin/orchestration/provider-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  ProviderForm,
  type ProviderRowWithStatus,
} from '@/components/admin/orchestration/provider-form';

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter(),
    useSearchParams: () => ({ get: () => null }),
  };
});

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

/** An Anthropic provider: no base URL field, Advanced collapsed. */
const PROVIDER = {
  id: 'prov-1',
  name: 'Anthropic',
  slug: 'anthropic',
  providerType: 'anthropic',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  baseUrl: null,
  isActive: true,
  isLocal: false,
  timeoutMs: null,
  maxRetries: null,
  jurisdiction: null,
  apiKeyPresent: true,
  createdBy: 'system',
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  deletedAt: null,
  metadata: {},
} as ProviderRowWithStatus;

async function rejectWith(errors: Array<{ path: string; message: string }>) {
  const { apiClient, APIClientError } = await import('@/lib/api/client');
  vi.mocked(apiClient.patch).mockRejectedValue(
    new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, { errors })
  );
}

describe('ProviderForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure in the sticky bar beside Save, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Provider slug already exists', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<ProviderForm mode="edit" provider={PROVIDER} />);

    const save = screen.getByRole('button', { name: /save changes/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Provider slug already exists');
    const bar = alert.parentElement;
    expect(bar).toHaveClass('sticky');
    expect(bar).toContainElement(save);
    expect(alert).toHaveFocus();
  });

  it('puts a field the server rejected under that field and focuses it', async () => {
    await rejectWith([{ path: 'apiKeyEnvVar', message: 'Must be an env var name' }]);
    const user = userEvent.setup();
    render(<ProviderForm mode="edit" provider={PROVIDER} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Must be an env var name')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[name="apiKeyEnvVar"]')).toHaveFocus());
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
  });

  it('opens the collapsed Advanced section to focus a field in it', async () => {
    await rejectWith([{ path: 'timeoutMs', message: 'Timeout too long' }]);
    const user = userEvent.setup();
    render(<ProviderForm mode="edit" provider={PROVIDER} />);
    expect(document.querySelector('[name="timeoutMs"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(document.querySelector('[name="timeoutMs"]')).toHaveFocus());
    expect(screen.getByText('Timeout too long')).toBeInTheDocument();
  });

  it('keeps a message for a field this flavor hides in the summary', async () => {
    // Anthropic shows no base URL field: placed there, the message would be lost.
    await rejectWith([{ path: 'baseUrl', message: 'Base URL must be https' }]);
    const user = userEvent.setup();
    render(<ProviderForm mode="edit" provider={PROVIDER} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Base URL must be https');
    expect(alert).toHaveFocus();
  });
});
