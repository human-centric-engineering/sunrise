// @vitest-environment happy-dom

/**
 * CapabilityForm — failed save (§124)
 *
 * A field the server rejected can be on a tab that isn't showing. The save
 * error must bring that tab forward and focus the field, and sit in the
 * sticky bar beside Save.
 *
 * @see components/admin/orchestration/capability-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CapabilityForm } from '@/components/admin/orchestration/capability-form';
import type { AiCapability } from '@/types/prisma';

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter(),
    useSearchParams: () => ({ get: () => null }),
  };
});

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return {
    ...actual,
    apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

function makeCapability(): AiCapability {
  const capability: Partial<AiCapability> = {
    id: 'cap-1',
    name: 'Existing Capability',
    slug: 'existing-capability',
    description: 'Does something useful',
    category: 'api',
    executionType: 'api',
    executionHandler: 'https://example.com/handler',
    executionConfig: null,
    functionDefinition: {
      name: 'existing-capability',
      description: 'Does something',
      parameters: { type: 'object', properties: {} },
    },
    requiresApproval: false,
    rateLimit: 10,
    isActive: true,
    metadata: {},
  };
  return capability as AiCapability;
}

/** `handleAPIError`'s shape on a ZodError. */
async function rejectWith(details: Record<string, string[]>) {
  const { apiClient, APIClientError } = await import('@/lib/api/client');
  vi.mocked(apiClient.patch).mockRejectedValue(
    new APIClientError('Validation failed', 'VALIDATION_ERROR', 400, details)
  );
}

function renderForm() {
  render(
    <CapabilityForm mode="edit" capability={makeCapability()} availableCategories={['api']} />
  );
}

function field(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[name="${name}"]`);
  if (!el) throw new Error(`no field named ${name} on the page`);
  return el;
}

describe('CapabilityForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure in the sticky bar beside Save', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(
      new APIClientError('Slug already taken', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    renderForm();

    const save = screen.getByRole('button', { name: /save changes/i });
    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Slug already taken');
    const bar = alert.parentElement;
    expect(bar).toHaveClass('sticky');
    expect(bar).toContainElement(save);
  });

  it('brings forward the tab holding a field the server rejected, and focuses it', async () => {
    await rejectWith({ rateLimit: ['Must be at most 10000'] });
    const user = userEvent.setup();
    renderForm();
    expect(document.querySelector('[name="rateLimit"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(field('rateLimit')).toHaveFocus());
    expect(screen.getByRole('tab', { name: /safety/i })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Must be at most 10000')).toBeInTheDocument();
  });

  it('says a rejected field that is not showing by Save, so its message is not lost', async () => {
    // The approval timeout shows only while approval is required, and this
    // capability doesn't require it.
    await rejectWith({ approvalTimeoutMs: ['Must be at most 3600000'] });
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Must be at most 3600000');
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('with errors on two tabs, brings forward the earlier one and focuses its field', async () => {
    await rejectWith({
      rateLimit: ['Must be at most 10000'],
      executionHandler: ['Must be a public URL'],
    });
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(field('executionHandler')).toHaveFocus());
    expect(screen.getByRole('tab', { name: /execution/i })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('alert')).toHaveTextContent('2 fields need fixing.');
  });
});
