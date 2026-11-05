// @vitest-environment happy-dom

/**
 * WaitlistEntriesTable — inviting (§125 t-978)
 *
 * Which rows can be invited or ticked, what a single Invite posts and says,
 * and how a ticked set goes out as one wave. Companion to
 * `waitlist-entries-table.test.tsx`, which covers the list itself.
 *
 * @see components/admin/waitlist/waitlist-entries-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  WaitlistEntriesTable,
  type WaitlistEntryRow,
} from '@/components/admin/waitlist/waitlist-entries-table';
import { API } from '@/lib/api/endpoints';
import { WAITLIST_INVITE_REFUSAL_MESSAGES } from '@/lib/waitlist/invite-refusals';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SELECT_ALL = 'Select everyone on this page who can be invited';

function entry(overrides: Partial<WaitlistEntryRow> = {}): WaitlistEntryRow {
  return {
    id: 'e1',
    email: 'alice@example.com',
    name: 'Alice',
    list: 'default',
    details: null,
    source: 'direct',
    utmSource: null,
    referrerHost: null,
    flaggedReason: null,
    confirmedAt: '2026-01-02T00:00:00.000Z',
    removedAt: null,
    rejoinRequests: 0,
    invitedAt: null,
    joinedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function listResponse(entries: WaitlistEntryRow[]): Response {
  return new Response(
    JSON.stringify({
      success: true,
      data: entries,
      meta: { page: 1, limit: 25, total: entries.length, totalPages: 1 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

function renderTable(entries: WaitlistEntryRow[], onChanged?: () => void) {
  return render(
    <WaitlistEntriesTable
      lists={['default']}
      fields={[]}
      initial={{ entries, total: entries.length }}
      exportMaxRows={10000}
      onChanged={onChanged}
    />
  );
}

const rowOf = (email: string) => screen.getByText(email).closest('tr') as HTMLElement;
const inviteSelectedButton = () => screen.getByRole('button', { name: /^Invite selected/ });

async function getApi() {
  return import('@/lib/api/client');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch = vi.fn<typeof fetch>();
  mockFetch.mockImplementation(() => Promise.resolve(listResponse([])));
  vi.stubGlobal('fetch', mockFetch);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WaitlistEntriesTable — who can be invited', () => {
  const ROWS = [
    entry({ id: 'ok', email: 'ok@example.com' }),
    entry({ id: 'again', email: 'again@example.com', invitedAt: '2026-02-01T00:00:00.000Z' }),
    entry({ id: 'unc', email: 'unconfirmed@example.com', confirmedAt: null }),
    entry({ id: 'rem', email: 'removed@example.com', removedAt: '2026-02-01T00:00:00.000Z' }),
    entry({ id: 'joi', email: 'joined@example.com', joinedAt: '2026-02-01T00:00:00.000Z' }),
    entry({ id: 'fla', email: 'flagged@example.com', flaggedReason: 'disposable-domain' }),
  ];

  it('offers Invite and a checkbox only on confirmed, unremoved, unjoined, unflagged rows', () => {
    renderTable(ROWS);

    const invitable = ['ok@example.com', 'again@example.com'];
    for (const row of ROWS) {
      const tr = rowOf(row.email);
      const can = invitable.includes(row.email);
      expect(
        within(tr).queryAllByRole('button', { name: /^(Invite|Resend)$/ }),
        `${row.email} invite button`
      ).toHaveLength(can ? 1 : 0);
      expect(within(tr).queryAllByRole('checkbox'), `${row.email} checkbox`).toHaveLength(
        can ? 1 : 0
      );
    }
  });

  it('labels the button Resend once an invitation has been sent, Invite before', () => {
    renderTable(ROWS);

    expect(within(rowOf('ok@example.com')).getByRole('button', { name: 'Invite' })).toBeVisible();
    expect(
      within(rowOf('again@example.com')).getByRole('button', { name: 'Resend' })
    ).toBeVisible();
    expect(
      within(rowOf('again@example.com')).queryByRole('button', { name: 'Invite' })
    ).not.toBeInTheDocument();
  });
});

describe('WaitlistEntriesTable — inviting one person', () => {
  it('posts to that entry’s invite route, says "Invitation sent." and reloads', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue({ outcome: 'invited', emailStatus: 'sent' });
    mockFetch.mockResolvedValue(
      listResponse([
        entry({ id: 'a/1', email: 'a@example.com', invitedAt: '2026-03-01T00:00:00Z' }),
      ])
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderTable([entry({ id: 'a/1', email: 'a@example.com' })], onChanged);

    await user.click(within(rowOf('a@example.com')).getByRole('button', { name: 'Invite' }));

    expect(apiClient.post).toHaveBeenCalledWith(API.ADMIN.waitlistEntryInvite('a/1'));
    expect(await screen.findByText('Invitation sent.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The reload brought the row back as invited: the button now reads Resend.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Resend' })).toBeInTheDocument();
  });

  it('says "Invitation resent." when the server resent', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue({ outcome: 'resent', emailStatus: 'sent' });
    const user = userEvent.setup();
    renderTable([entry({ invitedAt: '2026-02-01T00:00:00Z' })]);

    await user.click(screen.getByRole('button', { name: 'Resend' }));

    expect(await screen.findByText('Invitation resent.')).toBeInTheDocument();
  });

  it.each([
    ['invited', 'failed', 'Invitation created, but the email did not go. Use Resend to try again.'],
    [
      'invited',
      'disabled',
      'Invitation created, but the email did not go (email is not set up). Use Resend to try again.',
    ],
    ['resent', 'failed', 'Invitation renewed, but the email did not go. Use Resend to try again.'],
  ])('for %s with email %s says: %s', async (outcome, emailStatus, expected) => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue({ outcome, emailStatus });
    const user = userEvent.setup();
    renderTable([entry()]);

    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByRole('status')).toHaveTextContent(expected);
    expect(screen.queryByText('Invitation sent.')).not.toBeInTheDocument();
  });

  it('shows the server’s message for a 409 refusal and does not reload or report a change', async () => {
    const { apiClient, APIClientError } = await getApi();
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError(WAITLIST_INVITE_REFUSAL_MESSAGES.account_exists, 'CONFLICT', 409)
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderTable([entry()], onChanged);

    await user.click(screen.getByRole('button', { name: 'Invite' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      WAITLIST_INVITE_REFUSAL_MESSAGES.account_exists
    );
    expect(screen.queryByText(/Invitation/)).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('clears the last notice when the next invite starts', async () => {
    const { apiClient, APIClientError } = await getApi();
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce({ outcome: 'invited', emailStatus: 'sent' })
      .mockRejectedValueOnce(new APIClientError('Nope', 'CONFLICT', 409));
    const user = userEvent.setup();
    renderTable([entry()]);
    mockFetch.mockResolvedValue(listResponse([entry({ invitedAt: '2026-03-01T00:00:00Z' })]));

    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await screen.findByText('Invitation sent.');
    await user.click(await screen.findByRole('button', { name: 'Resend' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nope');
    expect(screen.queryByText('Invitation sent.')).not.toBeInTheDocument();
  });
});

describe('WaitlistEntriesTable — ticking rows', () => {
  const ROWS = [
    entry({ id: 'a', email: 'a@example.com' }),
    entry({ id: 'b', email: 'b@example.com' }),
    entry({ id: 'x', email: 'x@example.com', confirmedAt: null }),
    entry({ id: 'f', email: 'f@example.com', flaggedReason: 'disposable-domain' }),
  ];

  it('disables Invite selected with nothing ticked', () => {
    renderTable(ROWS);

    expect(inviteSelectedButton()).toHaveTextContent('Invite selected (0)');
    expect(inviteSelectedButton()).toBeDisabled();
  });

  it('counts ticked rows and enables the button', async () => {
    const user = userEvent.setup();
    renderTable(ROWS);

    await user.click(screen.getByRole('checkbox', { name: 'Select a@example.com' }));

    expect(inviteSelectedButton()).toHaveTextContent('Invite selected (1)');
    expect(inviteSelectedButton()).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: 'Select a@example.com' }));
    expect(inviteSelectedButton()).toHaveTextContent('Invite selected (0)');
    expect(inviteSelectedButton()).toBeDisabled();
  });

  it('the header checkbox ticks exactly the invitable rows, and unticks them again', async () => {
    const user = userEvent.setup();
    renderTable(ROWS);

    await user.click(screen.getByRole('checkbox', { name: SELECT_ALL }));

    expect(inviteSelectedButton()).toHaveTextContent('Invite selected (2)');
    expect(screen.getByRole('checkbox', { name: 'Select a@example.com' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select b@example.com' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Select x@example.com' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Select f@example.com' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: SELECT_ALL })).toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: SELECT_ALL }));
    expect(inviteSelectedButton()).toHaveTextContent('Invite selected (0)');
    expect(screen.getByRole('checkbox', { name: 'Select a@example.com' })).not.toBeChecked();
  });

  it('disables the header checkbox when no row on the page can be invited', () => {
    renderTable([entry({ confirmedAt: null })]);

    expect(screen.getByRole('checkbox', { name: SELECT_ALL })).toBeDisabled();
  });

  it('is not "all selected" while one invitable row is still unticked', async () => {
    const user = userEvent.setup();
    renderTable(ROWS);

    await user.click(screen.getByRole('checkbox', { name: 'Select a@example.com' }));

    expect(screen.getByRole('checkbox', { name: SELECT_ALL })).not.toBeChecked();
  });

  it('changing a filter clears the selection', async () => {
    mockFetch.mockResolvedValue(listResponse(ROWS));
    const user = userEvent.setup();
    renderTable(ROWS);

    await user.click(screen.getByRole('checkbox', { name: SELECT_ALL }));
    expect(inviteSelectedButton()).toHaveTextContent('Invite selected (2)');
    await user.click(screen.getByRole('checkbox', { name: /Show removed/ }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(inviteSelectedButton()).toHaveTextContent('Invite selected (0)');
    expect(screen.getByRole('checkbox', { name: 'Select a@example.com' })).not.toBeChecked();
  });
});

describe('WaitlistEntriesTable — Invite selected', () => {
  const ROWS = [
    entry({ id: 'a', email: 'a@example.com' }),
    entry({ id: 'b', email: 'b@example.com' }),
    entry({ id: 'c', email: 'c@example.com' }),
  ];

  it('posts the ticked ids as an ids wave, shows the summary with grouped reasons, and clears the ticks', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue({
      selected: 3,
      invited: 1,
      refused: 2,
      failed: 0,
      emailNotSent: 0,
      rows: [
        { id: 'a', outcome: 'invited' },
        { id: 'b', outcome: 'refused', reason: 'invitation_pending' },
        { id: 'c', outcome: 'refused', reason: 'invitation_pending' },
      ],
    });
    mockFetch.mockResolvedValue(listResponse(ROWS));
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderTable(ROWS, onChanged);

    await user.click(screen.getByRole('checkbox', { name: 'Select c@example.com' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select a@example.com' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select b@example.com' }));
    await user.click(inviteSelectedButton());

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith(API.ADMIN.WAITLIST_INVITE_WAVE, {
      body: { mode: 'ids', ids: ['c', 'a', 'b'] },
    });
    expect(await screen.findByText(/Invited 1 of 3\./)).toBeInTheDocument();
    expect(
      screen.getByText(`2 not invited: ${WAITLIST_INVITE_REFUSAL_MESSAGES.invitation_pending}`)
    ).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(inviteSelectedButton()).toHaveTextContent('Invite selected (0)'));
    expect(screen.getByRole('checkbox', { name: 'Select a@example.com' })).not.toBeChecked();
  });

  it('shows the failure and keeps the ticks when the wave request fails', async () => {
    const { apiClient, APIClientError } = await getApi();
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Too many invitations just now', 'RATE_LIMITED', 429)
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderTable(ROWS, onChanged);

    await user.click(screen.getByRole('checkbox', { name: 'Select a@example.com' }));
    await user.click(inviteSelectedButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many invitations just now');
    expect(screen.queryByText(/Invited \d+ of/)).not.toBeInTheDocument();
    expect(inviteSelectedButton()).toHaveTextContent('Invite selected (1)');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows the failure when the answer is not a wave result', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue({ unexpected: true });
    const user = userEvent.setup();
    renderTable(ROWS);

    await user.click(screen.getByRole('checkbox', { name: 'Select a@example.com' }));
    await user.click(inviteSelectedButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not send the invitations. Try again.'
    );
    expect(screen.queryByText(/Invited \d+ of/)).not.toBeInTheDocument();
  });
});
