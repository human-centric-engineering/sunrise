// @vitest-environment happy-dom

/**
 * OrgMetersForm (§135 t-1035) — a platform admin reads an org's usage against
 * its limits and sets them through `PATCH /api/v1/admin/orgs/[id]/meters`.
 *
 * @see components/admin/orgs/org-meters-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { OrgMetersForm, type OrgMetersView } from '@/components/admin/orgs/org-meters-form';
import { SharedSettingsAccessProvider } from '@/components/admin/shared-settings-access';
import { apiClient } from '@/lib/api/client';

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn() },
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

const ORG = 'cmorg000000000000000acme1';
const PATH = `/api/v1/admin/orgs/${ORG}/meters`;

type Meter = OrgMetersView['meters'][number];

function meter(overrides: Partial<Meter> = {}): Meter {
  return {
    key: 'seats',
    label: 'Seats',
    description: 'People in the organisation.',
    period: 'standing',
    core: true,
    limit: 5,
    used: 3,
    window: null,
    countFailed: false,
    ...overrides,
  };
}

function view(overrides: Partial<OrgMetersView> = {}): OrgMetersView {
  return {
    orgId: ORG,
    mayChange: true,
    registrationFailed: false,
    meters: [
      meter(),
      meter({
        key: 'reports',
        label: 'Reports',
        description: 'Reports built.',
        period: 'month',
        core: false,
        limit: null,
        used: 12,
      }),
    ],
    unregistered: {},
    ...overrides,
  };
}

function renderForm(initial: OrgMetersView = view()) {
  const user = userEvent.setup();
  render(<OrgMetersForm orgId={ORG} meters={initial} />);
  return user;
}

const usage = (key: string) => screen.getByTestId(`meter-usage-${key}`);
const box = (key: string) => screen.getByRole('textbox', { name: new RegExp(`^.*${key}`) });
const saveButton = () => screen.getByRole('button', { name: 'Save limits' });

describe('OrgMetersForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows each meter with its label, key, description and limit in the box', () => {
    renderForm();

    expect(screen.getByText('Seats')).toBeInTheDocument();
    expect(screen.getByText('seats')).toBeInTheDocument();
    expect(screen.getByText('People in the organisation.')).toBeInTheDocument();
    expect(screen.getByText('Reports')).toBeInTheDocument();
    expect(screen.getByText('reports')).toBeInTheDocument();
    expect(box('seats')).toHaveValue('5');
    expect(box('reports')).toHaveValue('');
  });

  it('says a standing count as "N of L now"', () => {
    renderForm();

    expect(usage('seats')).toHaveTextContent(/^3 of 5 now$/);
  });

  it('says a monthly count is for this month in UTC, and a meter with no limit has none', () => {
    renderForm();

    expect(usage('reports')).toHaveTextContent(/^12\s+this month \(UTC\), no limit$/);
  });

  it('says a custom window as its days, ending the day before the exclusive end', () => {
    renderForm(
      view({
        meters: [
          meter({
            key: 'exports',
            label: 'Exports',
            period: 'custom',
            limit: 10,
            used: 4,
            window: { from: '2026-03-01T00:00:00.000Z', to: '2026-04-01T00:00:00.000Z' },
          }),
        ],
      })
    );

    expect(usage('exports')).toHaveTextContent('4 of 10 2026-03-01 to 2026-03-31');
  });

  it('falls back to "this period" for a custom meter with no window', () => {
    renderForm(
      view({
        meters: [meter({ key: 'exports', label: 'Exports', period: 'custom', window: null })],
      })
    );

    expect(usage('exports')).toHaveTextContent('3 of 5 this period');
  });

  it('badges a meter at its limit, and one over it, and neither when under', () => {
    renderForm(
      view({
        meters: [
          meter({ key: 'a', label: 'A', limit: 5, used: 5 }),
          meter({ key: 'b', label: 'B', limit: 5, used: 7 }),
          meter({ key: 'c', label: 'C', limit: 5, used: 2 }),
        ],
      })
    );

    // Exactly at the limit is "at", over is only "over" (not both).
    expect(screen.getAllByText('at its limit')).toHaveLength(1);
    expect(screen.getAllByText('over its limit')).toHaveLength(1);
    expect(screen.getByText('at its limit').closest('label')).toHaveTextContent('A');
    expect(screen.getByText('over its limit').closest('label')).toHaveTextContent('B');
  });

  it('gives no badge to a meter with no limit, however high its count', () => {
    renderForm(view({ meters: [meter({ limit: null, used: 999 })] }));

    expect(screen.queryByText('at its limit')).not.toBeInTheDocument();
    expect(screen.queryByText('over its limit')).not.toBeInTheDocument();
  });

  it('says a meter could not be counted instead of showing a count, and badges nothing', () => {
    renderForm(view({ meters: [meter({ countFailed: true, used: null })] }));

    expect(usage('seats')).toHaveTextContent(/Could not be counted, so it refuses nothing/);
    expect(usage('seats')).not.toHaveTextContent(/of 5/);
    expect(screen.queryByText('at its limit')).not.toBeInTheDocument();
  });

  it('offers Save only once something has changed', async () => {
    const user = renderForm();

    expect(saveButton()).toBeDisabled();
    await user.type(box('seats'), '0');
    expect(saveButton()).toBeEnabled();
    // Back to what it was: nothing to save again.
    await user.clear(box('seats'));
    await user.type(box('seats'), '5');
    expect(saveButton()).toBeDisabled();
  });

  it('PATCHes only the meter whose limit changed, as a number', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue(view());
    const user = renderForm();

    await user.clear(box('seats'));
    await user.type(box('seats'), '8');
    await user.click(saveButton());

    expect(apiClient.patch).toHaveBeenCalledTimes(1);
    expect(apiClient.patch).toHaveBeenCalledWith(PATH, { body: { limits: { seats: 8 } } });
  });

  it('sends null for a box the admin emptied', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue(view());
    const user = renderForm();

    await user.clear(box('seats'));
    await user.click(saveButton());

    expect(apiClient.patch).toHaveBeenCalledWith(PATH, { body: { limits: { seats: null } } });
  });

  it('sets a limit on a meter that had none', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue(view());
    const user = renderForm();

    await user.type(box('reports'), '20');
    await user.click(saveButton());

    expect(apiClient.patch).toHaveBeenCalledWith(PATH, { body: { limits: { reports: 20 } } });
  });

  it.each(['abc', '1.5', '-1'])(
    'refuses "%s" as a limit: says so and disables Save',
    async (text) => {
      const user = renderForm();

      await user.clear(box('seats'));
      await user.type(box('seats'), text);

      expect(screen.getByText('A whole number, or empty')).toBeInTheDocument();
      expect(box('seats')).toHaveAttribute('aria-invalid', 'true');
      expect(saveButton()).toBeDisabled();
      expect(apiClient.patch).not.toHaveBeenCalled();
    }
  );

  it('keeps Save disabled while any one box is invalid, even if another changed validly', async () => {
    const user = renderForm();

    await user.type(box('reports'), '20');
    expect(saveButton()).toBeEnabled();
    await user.type(box('seats'), 'x');

    expect(saveButton()).toBeDisabled();
  });

  it('refreshes from the response after a save and says Saved', async () => {
    // The server stores something other than what was typed.
    vi.mocked(apiClient.patch).mockResolvedValue(
      view({ meters: [meter({ limit: 4, used: 3 }), meter({ key: 'reports', limit: null })] })
    );
    const user = renderForm();

    await user.clear(box('seats'));
    await user.type(box('seats'), '9');
    await user.click(saveButton());

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(box('seats')).toHaveValue('4');
    expect(usage('seats')).toHaveTextContent(/^3 of 4 now$/);
    expect(saveButton()).toBeDisabled();
  });

  it('drops "Saved" as soon as the admin edits again', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue(view());
    const user = renderForm();

    await user.type(box('reports'), '2');
    await user.click(saveButton());
    expect(await screen.findByText('Saved')).toBeInTheDocument();

    await user.type(box('reports'), '3');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('shows a failed save beside Save, keeps the edit, and does not say Saved', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(new APIClientError('Limit refused'));
    const user = renderForm();

    await user.type(box('reports'), '20');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Limit refused');
    expect(box('reports')).toHaveValue('20');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
  });

  it('locks the boxes while a save runs', async () => {
    let land: (value: OrgMetersView) => void = () => {};
    vi.mocked(apiClient.patch).mockReturnValue(
      new Promise<OrgMetersView>((resolve) => {
        land = resolve;
      })
    );
    const user = renderForm();

    await user.type(box('reports'), '20');
    await user.click(saveButton());

    expect(box('seats')).toBeDisabled();
    land(view());
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(box('seats')).toBeEnabled();
  });

  it('shows the limits but offers no change where they cannot be changed, with the shared notice', () => {
    render(
      <SharedSettingsAccessProvider readOnly canSwitch>
        <OrgMetersForm orgId={ORG} meters={view({ mayChange: false })} />
      </SharedSettingsAccessProvider>
    );

    const notice = screen.getByTestId('shared-settings-read-only');
    expect(notice).toHaveTextContent(/limits can only be changed from the install organisation/);
    expect(box('seats')).toBeDisabled();
    expect(box('seats')).toHaveValue('5');
    expect(screen.queryByRole('button', { name: 'Save limits' })).not.toBeInTheDocument();
  });

  it('lists stored limits nothing registers, saying a save keeps them', () => {
    renderForm(view({ unregistered: { retired: 7, old: 2 } }));

    expect(screen.getByText('retired (7), old (2)')).toBeInTheDocument();
    expect(screen.getByText(/Nothing registers those meters any more/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear them' })).toBeInTheDocument();
  });

  it('clears every unregistered limit by PATCHing each with null, then shows the result', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue(view({ unregistered: {} }));
    const user = renderForm(view({ unregistered: { retired: 7, old: 2 } }));

    await user.click(screen.getByRole('button', { name: 'Clear them' }));

    expect(apiClient.patch).toHaveBeenCalledWith(PATH, {
      body: { limits: { retired: null, old: null } },
    });
    expect(await screen.findByText('Cleared')).toBeInTheDocument();
    expect(screen.queryByText(/Also stored/)).not.toBeInTheDocument();
  });

  it('says "Clear it" for a single unregistered limit', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue(view());
    const user = renderForm(view({ unregistered: { retired: 7 } }));

    expect(screen.getByText(/Nothing registers that meter any more/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear it' }));

    expect(apiClient.patch).toHaveBeenCalledWith(PATH, { body: { limits: { retired: null } } });
  });

  it('lists unregistered limits but offers no clear where limits cannot be changed', () => {
    renderForm(view({ mayChange: false, unregistered: { retired: 7 } }));

    expect(screen.getByText('retired (7)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear it' })).not.toBeInTheDocument();
  });

  it('keeps an unsaved limit edit when clearing the unregistered ones', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue(view({ unregistered: {} }));
    const user = renderForm(view({ unregistered: { retired: 7 } }));

    await user.clear(box('seats'));
    await user.type(box('seats'), '20');
    await user.click(screen.getByRole('button', { name: 'Clear it' }));

    expect(apiClient.patch).toHaveBeenCalledWith(PATH, { body: { limits: { retired: null } } });
    expect(await screen.findByText('Cleared')).toBeInTheDocument();
    expect(box('seats')).toHaveValue('20');
    expect(saveButton()).toBeEnabled();
  });

  it('shows what is stored now in boxes the admin did not edit, after a save', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue(
      view({
        meters: [
          meter({ limit: 8 }),
          meter({ key: 'reports', label: 'Reports', core: false, limit: 30 }),
        ],
      })
    );
    const user = renderForm();

    await user.clear(box('seats'));
    await user.type(box('seats'), '8');
    await user.click(saveButton());

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(box('seats')).toHaveValue('8');
    // Changed elsewhere meanwhile, and not edited here: the stored value.
    expect(box('reports')).toHaveValue('30');
  });

  it('offers no clear while the app registration has failed, saying the limits may be its own', () => {
    renderForm(view({ registrationFailed: true, unregistered: { completed_conversations: 500 } }));

    expect(screen.getByText('completed_conversations (500)')).toBeInTheDocument();
    expect(screen.getByText(/this may be a limit for one of them/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing registers/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear it' })).not.toBeInTheDocument();
  });

  it('says the app meters failed to register', () => {
    renderForm(view({ registrationFailed: true }));

    expect(screen.getByText(/could not be registered, so only seats is shown/)).toBeInTheDocument();
  });

  it('does not mention registration or stored limits when all is well', () => {
    renderForm();

    expect(screen.queryByText(/could not be registered/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Also stored/)).not.toBeInTheDocument();
  });
});
