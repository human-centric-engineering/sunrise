// @vitest-environment happy-dom

/**
 * OrgPrivacyForm (§127 t-1010) — a platform admin sets an org's minimum LLM
 * privacy mode and protected terms through `PUT /api/v1/admin/orgs/[id]/privacy`.
 *
 * @see components/admin/orgs/org-privacy-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OrgPrivacyForm, type OrgPrivacyView } from '@/components/admin/orgs/org-privacy-form';
import { apiClient, APIClientError } from '@/lib/api/client';

vi.mock('@/lib/api/client', () => ({
  apiClient: { put: vi.fn() },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code?: string,
      public status?: number,
      public details?: Record<string, unknown>
    ) {
      super(message);
    }
  },
}));

const ORG = 'cmorg00000000000000grant';

function view(overrides: Partial<OrgPrivacyView> = {}): OrgPrivacyView {
  return {
    orgId: ORG,
    saved: true,
    unreadable: false,
    minimumMode: null,
    protectedTerms: [],
    ...overrides,
  };
}

function renderForm(privacy: OrgPrivacyView = view(), orgName = 'Acme Ltd') {
  const user = userEvent.setup();
  render(<OrgPrivacyForm orgId={ORG} orgName={orgName} privacy={privacy} />);
  return user;
}

/** The body of the one PUT the form sent. */
function sentBody() {
  expect(apiClient.put).toHaveBeenCalledTimes(1);
  const [path, options] = vi.mocked(apiClient.put).mock.calls[0];
  expect(path).toBe(`/api/v1/admin/orgs/${ORG}/privacy`);
  return (options as { body: unknown }).body;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.put).mockImplementation(async (_path, options) => ({
    ...view(),
    ...(options as { body: object }).body,
  }));
});

describe('OrgPrivacyForm', () => {
  it('suggests the org’s own name before a first save, and saves it only when asked', async () => {
    const user = renderForm(view({ saved: false }));

    expect(screen.getByTestId('org-privacy-terms')).toHaveTextContent('Acme Ltd');
    expect(screen.getByTestId('org-privacy-suggested')).toBeInTheDocument();
    expect(apiClient.put).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save privacy settings' }));

    expect(sentBody()).toEqual({
      minimumMode: null,
      protectedTerms: [{ value: 'Acme Ltd', type: 'ORG' }],
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('does not suggest a name once the org has saved, even an empty set', () => {
    renderForm(view({ saved: true, protectedTerms: [] }));

    expect(screen.getByText('No protected terms.')).toBeInTheDocument();
    expect(screen.queryByTestId('org-privacy-suggested')).not.toBeInTheDocument();
  });

  it('adds a person and removes a term, and saves what is left with the minimum chosen', async () => {
    const user = renderForm(view({ protectedTerms: [{ value: 'Old Client', type: 'PERSON' }] }));

    await user.type(screen.getByRole('textbox', { name: 'New protected term' }), 'Jane Hart');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Remove Old Client' }));
    await user.click(screen.getByRole('combobox', { name: /minimum privacy mode/i }));
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: /^Pseudonymise/ })
    );
    await user.click(screen.getByRole('button', { name: 'Save privacy settings' }));

    expect(sentBody()).toEqual({
      minimumMode: 'pseudonymise',
      protectedTerms: [{ value: 'Jane Hart', type: 'PERSON' }],
    });
  });

  it('adds an organisation with Enter, as the kind chosen', async () => {
    const user = renderForm();

    await user.click(screen.getByRole('combobox', { name: 'Kind of name' }));
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: 'Organisation' })
    );
    await user.type(
      screen.getByRole('textbox', { name: 'New protected term' }),
      'Brightwater{Enter}'
    );
    await user.click(screen.getByRole('button', { name: 'Save privacy settings' }));

    expect(sentBody()).toEqual({
      minimumMode: null,
      protectedTerms: [{ value: 'Brightwater', type: 'ORG' }],
    });
  });

  it('offers no "off" minimum, and "no minimum" saves null', async () => {
    const user = renderForm(view({ minimumMode: 'redact' }));

    await user.click(screen.getByRole('combobox', { name: /minimum privacy mode/i }));
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).not.toContain('Off');
    await user.click(
      within(screen.getByRole('listbox')).getByRole('option', { name: /^No minimum/ })
    );
    await user.click(screen.getByRole('button', { name: 'Save privacy settings' }));

    expect(sentBody()).toMatchObject({ minimumMode: null });
  });

  it('warns that a block minimum refuses every call naming a protected term, the org included', async () => {
    const user = renderForm(view({ saved: false }), 'Acme Ltd');
    expect(screen.queryByTestId('org-privacy-block-terms')).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /minimum privacy mode/i }));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: /^Block/ }));

    expect(screen.getByTestId('org-privacy-block-terms')).toHaveTextContent(
      'an agent told it works for Acme Ltd cannot answer at all'
    );
  });

  it('shows what still parses of an unreadable slice, so saving keeps it', () => {
    renderForm(
      view({
        unreadable: true,
        minimumMode: 'redact',
        protectedTerms: [{ value: 'Jane Hart', type: 'PERSON' }],
      })
    );

    expect(screen.getByRole('combobox', { name: /minimum privacy mode/i })).toHaveTextContent(
      /^Redact/
    );
    expect(screen.getByTestId('org-privacy-terms')).toHaveTextContent('Jane Hart');
  });

  it('says every call is refused while the stored settings cannot be read', () => {
    renderForm(view({ unreadable: true }));

    expect(screen.getByTestId('org-privacy-unreadable')).toHaveTextContent(
      'every AI call made for it is refused'
    );
    expect(screen.queryByTestId('org-privacy-suggested')).not.toBeInTheDocument();
  });

  it('refuses a term under three characters where it was typed, and adds nothing', async () => {
    const user = renderForm();

    await user.type(screen.getByRole('textbox', { name: 'New protected term' }), 'Al');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByTestId('org-privacy-term-error')).toHaveTextContent(
      'A protected term needs at least 3 characters'
    );
    expect(screen.getByText('No protected terms.')).toBeInTheDocument();
  });

  it('refuses a term over 200 characters where it was typed', async () => {
    const user = renderForm();

    await user.click(screen.getByRole('textbox', { name: 'New protected term' }));
    await user.paste('x'.repeat(201));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByTestId('org-privacy-term-error')).toHaveTextContent(
      'at most 200 characters'
    );
    expect(screen.getByText('No protected terms.')).toBeInTheDocument();
  });

  it('refuses a term past the 500th', async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      value: `Client ${i}`,
      type: 'PERSON' as const,
    }));
    const user = renderForm(view({ protectedTerms: full }));

    await user.type(screen.getByRole('textbox', { name: 'New protected term' }), 'One More');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByTestId('org-privacy-term-error')).toHaveTextContent(
      'At most 500 protected terms'
    );
  });

  it('refuses the same name twice, ignoring case', async () => {
    const user = renderForm(view({ protectedTerms: [{ value: 'Jane Hart', type: 'PERSON' }] }));

    await user.type(screen.getByRole('textbox', { name: 'New protected term' }), 'jane hart');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByTestId('org-privacy-term-error')).toHaveTextContent('already protected');
    expect(screen.getAllByRole('button', { name: /^Remove/ })).toHaveLength(1);
  });

  it('shows a failed save beside Save, with the message the API sent', async () => {
    vi.mocked(apiClient.put).mockRejectedValueOnce(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'protectedTerms', message: 'At most 500 protected terms' }],
      })
    );
    const user = renderForm();

    await user.click(screen.getByRole('button', { name: 'Save privacy settings' }));

    expect(await screen.findByText(/At most 500 protected terms/)).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
