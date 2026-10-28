// @vitest-environment happy-dom

/**
 * OrgProvidersForm — failed save (§124)
 *
 * The form places no message under a field, so every message the server
 * sends joins the summary beside Save, which takes the focus.
 *
 * @see components/admin/orgs/org-providers-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OrgProvidersForm } from '@/components/admin/orgs/org-providers-form';

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

function renderForm() {
  render(
    <OrgProvidersForm
      orgId="org-1"
      policy={{
        orgId: 'org-1',
        unrestricted: false,
        enforced: true,
        approved: [],
        jurisdictions: null,
      }}
      providers={[
        { id: 'p1', slug: 'anthropic', name: 'Anthropic', isActive: true, jurisdiction: 'US' },
      ]}
    />
  );
  return screen.getByRole('button', { name: 'Save approved providers' });
}

describe('OrgProvidersForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure beside Save, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.put).mockRejectedValue(
      new APIClientError('Organisation not found', 'NOT_FOUND', 404)
    );
    const user = userEvent.setup();
    const save = renderForm();

    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Organisation not found');
    expect(alert.parentElement).toContainElement(save);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('joins every field message, once each, into the summary', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.put).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [
          { path: 'jurisdictions.0', message: 'Jurisdiction must be a short code' },
          { path: 'jurisdictions.1', message: 'Jurisdiction must be a short code' },
          { path: 'approved.0', message: 'Unknown provider' },
        ],
      })
    );
    const user = userEvent.setup();
    const save = renderForm();

    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Jurisdiction must be a short code Unknown provider');
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('says which slug the server could not find, not just the slug', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    // What the PUT route sends when an approved provider was deleted meanwhile.
    vi.mocked(apiClient.put).mockRejectedValue(
      new APIClientError('No provider has the slug acme', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'approved', message: 'No provider has the slug acme' }],
        unknownProviders: ['acme'],
      })
    );
    const user = userEvent.setup();
    const save = renderForm();

    await user.click(save);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('No provider has the slug acme');
  });

  it('clears the last failure when Save is pressed again', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.put)
      .mockRejectedValueOnce(new APIClientError('Organisation not found', 'NOT_FOUND', 404))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const user = userEvent.setup();
    const save = renderForm();

    await user.click(save);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(save);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
