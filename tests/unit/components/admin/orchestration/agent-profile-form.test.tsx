// @vitest-environment happy-dom

/**
 * AgentProfileForm Component Tests
 *
 * Covers:
 *   - Renders all six fields in create + edit mode
 *   - Slug auto-derives from name on create; locked on edit
 *   - FieldHelp present on every labelled field (contextual-help directive)
 *   - Validation rejects oversize text (>10 000 chars)
 *   - Empty trimmed text fields submit as `null`
 *   - POST on create, PATCH on edit, error banner on API failure
 *   - Attached-agents panel renders on edit when `agents` is non-empty
 *
 * @see components/admin/orchestration/agent-profile-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  AgentProfileForm,
  type AgentProfileRow,
} from '@/components/admin/orchestration/agent-profile-form';
import { SharedSettingsAccessProvider } from '@/components/admin/shared-settings-access';

const mockPush = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: () => createMockRouter({ push: mockPush }),
    useSearchParams: () => ({ get: () => null }),
  };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
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

function makeProfile(overrides: Partial<AgentProfileRow> = {}): AgentProfileRow {
  return {
    id: 'prof-1',
    name: 'Support Family',
    slug: 'support-family',
    description: 'Shared profile.',
    persona: 'You are a calm senior support specialist.',
    brandVoiceInstructions: 'Friendly and concise.',
    guardrails: 'Never give medical advice.',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentProfileForm — create mode', () => {
  it('renders all six fields with empty defaults', () => {
    render(<AgentProfileForm mode="create" />);

    expect(screen.getByRole('textbox', { name: /^name/i })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /^slug/i })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /^description/i })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /^persona/i })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /^brand voice/i })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /^guardrails/i })).toHaveValue('');
    expect(screen.getByRole('button', { name: /create profile/i })).toBeEnabled();
  });

  it('auto-derives slug from name until the user edits the slug directly', async () => {
    const user = userEvent.setup();
    render(<AgentProfileForm mode="create" />);

    const name = screen.getByRole('textbox', { name: /^name/i });
    await user.type(name, 'VIP Concierge Team');

    const slug = screen.getByRole('textbox', { name: /^slug/i });
    expect(slug).toHaveValue('vip-concierge-team');
  });

  it('typing in the slug input disables auto-derive — further name edits leave slug alone', async () => {
    const user = userEvent.setup();
    render(<AgentProfileForm mode="create" />);

    const name = screen.getByRole('textbox', { name: /^name/i });
    const slug = screen.getByRole('textbox', { name: /^slug/i });

    // Operator types a custom slug first.
    await user.type(slug, 'custom-slug');
    expect(slug).toHaveValue('custom-slug');

    // Subsequent name changes must NOT overwrite the slug.
    await user.type(name, 'Some Name');
    expect(slug).toHaveValue('custom-slug');
  });

  it('FieldHelp ⓘ icons render on every labelled field', () => {
    render(<AgentProfileForm mode="create" />);
    // FieldHelp exposes its trigger via aria-label="More information" by default.
    const triggers = screen.getAllByRole('button', { name: /more information/i });
    // Six labelled inputs: name, slug, description, persona, voice, guardrails.
    expect(triggers.length).toBeGreaterThanOrEqual(6);
  });

  it('POSTs and redirects on successful create', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValueOnce({ id: 'new-id', slug: 'support-team' });
    render(<AgentProfileForm mode="create" />);

    await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Support team');
    await user.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    const [endpoint, opts] = mockPost.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(endpoint).toBe('/api/v1/admin/orchestration/agent-profiles');
    expect(opts.body).toMatchObject({
      name: 'Support team',
      slug: 'support-team',
      // Empty trimmed text fields normalise to null.
      description: null,
      persona: null,
      brandVoiceInstructions: null,
      guardrails: null,
    });
    expect(mockPush).toHaveBeenCalledWith('/admin/orchestration/agent-profiles/new-id');
  });

  it('shows an inline error banner when the API call fails', async () => {
    const user = userEvent.setup();
    const { APIClientError } = await import('@/lib/api/client');
    mockPost.mockRejectedValueOnce(
      new (APIClientError as unknown as new (m: string) => Error)('Slug already in use')
    );
    render(<AgentProfileForm mode="create" />);

    await user.type(screen.getByRole('textbox', { name: /^name/i }), 'Support');
    await user.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(screen.getByText(/slug already in use/i)).toBeInTheDocument());
  });

  it('rejects oversize persona via the Zod resolver', async () => {
    const user = userEvent.setup();
    render(<AgentProfileForm mode="create" />);

    const oversize = 'a'.repeat(10_001);
    await user.type(screen.getByRole('textbox', { name: /^name/i }), 'X');
    // fireEvent bypasses the O(n) cost of userEvent.type for the long string
    // and stays HTMLElement-typed (no cast needed for type-check).
    const persona = screen.getByRole('textbox', { name: /^persona/i });
    fireEvent.input(persona, { target: { value: oversize } });
    fireEvent.blur(persona);

    await user.click(screen.getByRole('button', { name: /create profile/i }));

    // POST must not fire — Zod rejects before the network call.
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('AgentProfileForm — edit mode', () => {
  it('pre-fills every field from the profile prop', () => {
    const profile = makeProfile();
    render(<AgentProfileForm mode="edit" profile={profile} />);

    expect(screen.getByRole('textbox', { name: /^name/i })).toHaveValue(profile.name);
    expect(screen.getByRole('textbox', { name: /^slug/i })).toHaveValue(profile.slug);
    expect(screen.getByRole('textbox', { name: /^persona/i })).toHaveValue(profile.persona);
    expect(screen.getByRole('textbox', { name: /^brand voice/i })).toHaveValue(
      profile.brandVoiceInstructions
    );
    expect(screen.getByRole('textbox', { name: /^guardrails/i })).toHaveValue(profile.guardrails);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });

  it('disables the slug input on edit (rename = create-new + re-point)', () => {
    render(<AgentProfileForm mode="edit" profile={makeProfile()} />);
    expect(screen.getByRole('textbox', { name: /^slug/i })).toBeDisabled();
  });

  it('PATCHes with the agent-id endpoint and shows a "Saved" confirmation', async () => {
    const user = userEvent.setup();
    const profile = makeProfile();
    mockPatch.mockResolvedValueOnce({ ...profile, name: 'Renamed' });

    render(<AgentProfileForm mode="edit" profile={profile} />);

    const name = screen.getByRole('textbox', { name: /^name/i });
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    const [endpoint] = mockPatch.mock.calls[0] as [string, unknown];
    expect(endpoint).toBe(`/api/v1/admin/orchestration/agent-profiles/${profile.id}`);
    expect(mockPush).not.toHaveBeenCalled();

    // Saved indicator appears in the action bar.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^saved$/i })).toBeInTheDocument()
    );
  });

  it('renders the attached-agents panel with deep-links when agents are populated', () => {
    const profile = makeProfile({
      agents: [
        { id: 'a1', slug: 'support', name: 'Support', isActive: true },
        { id: 'a2', slug: 'vip', name: 'VIP', isActive: false },
      ],
    });
    render(<AgentProfileForm mode="edit" profile={profile} />);

    expect(screen.getByText(/agents using this profile/i)).toBeInTheDocument();
    const supportLink = screen.getByRole('link', { name: 'Support' });
    expect(supportLink).toHaveAttribute('href', '/admin/orchestration/agents/a1/edit');
    expect(screen.getByText(/\(inactive\)/i)).toBeInTheDocument();
  });

  it('omits the attached-agents panel when no agents are attached', () => {
    render(<AgentProfileForm mode="edit" profile={makeProfile({ agents: [] })} />);
    expect(screen.queryByText(/agents using this profile/i)).not.toBeInTheDocument();
  });

  it('counts, without listing, other orgs’ agents that inherit from it (t-731)', () => {
    render(
      <AgentProfileForm
        mode="edit"
        profile={makeProfile({
          agents: [{ id: 'a1', slug: 'support', name: 'Support', isActive: true }],
          otherOrgAgentCount: 2,
        })}
      />
    );

    expect(screen.getByText('Agents using this profile (1)')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Also, 2 agents in other organisations inherit from this profile\. Changes here reach them too/
      )
    ).toBeInTheDocument();
  });

  it('shows the panel when only other orgs’ agents inherit from it', () => {
    render(
      <AgentProfileForm mode="edit" profile={makeProfile({ agents: [], otherOrgAgentCount: 1 })} />
    );

    // No own list, so no own count or "each of these agents" blurb over an empty list.
    expect(screen.getByRole('heading', { name: 'Agents using this profile' })).toBeInTheDocument();
    expect(screen.queryByText(/each of these agents/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/^1 agent in other organisations inherits from this profile/)
    ).toBeInTheDocument();
  });
});

describe('AgentProfileForm — read-only outside the install org (§107 t-753)', () => {
  it('disables the submit button in create mode with valid input and never POSTs', async () => {
    const user = userEvent.setup();
    mockPost.mockResolvedValue({});

    // Contrast: same form without the provider -> submit enabled with the same input
    const editable = render(<AgentProfileForm mode="create" />);
    await user.type(screen.getByRole('textbox', { name: /^name/i }), 'VIP Concierge Team');
    expect(screen.getByRole('button', { name: /create profile/i })).toBeEnabled();
    editable.unmount();

    render(
      <SharedSettingsAccessProvider readOnly canSwitch>
        <AgentProfileForm mode="create" />
      </SharedSettingsAccessProvider>
    );
    await user.type(screen.getByRole('textbox', { name: /^name/i }), 'VIP Concierge Team');

    // Form is valid and filled in, so readOnly is the only reason it is disabled
    expect(screen.getByRole('textbox', { name: /^slug/i })).toHaveValue('vip-concierge-team');
    const submit = screen.getByRole('button', { name: /create profile/i });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText('Read-only here: changes save from the install organisation.')
    ).toBeInTheDocument();
    await user.click(submit);
    expect(mockPost).not.toHaveBeenCalled();
    // The Cancel link survives
    expect(screen.getByRole('link', { name: /cancel/i })).toBeInTheDocument();
  });

  it('disables the save button in edit mode and never PATCHes, while the profile stays visible', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue({});

    // Contrast: same profile without the provider -> save enabled
    const editable = render(<AgentProfileForm mode="edit" profile={makeProfile()} />);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
    editable.unmount();

    render(
      <SharedSettingsAccessProvider readOnly canSwitch>
        <AgentProfileForm mode="edit" profile={makeProfile()} />
      </SharedSettingsAccessProvider>
    );

    expect(screen.getByRole('textbox', { name: /^name/i })).toHaveValue('Support Family');
    const save = screen.getByRole('button', { name: /save changes/i });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
