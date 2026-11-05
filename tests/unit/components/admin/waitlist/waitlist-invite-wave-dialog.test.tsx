// @vitest-environment happy-dom

/**
 * WaitlistInviteWaveDialog + WaveSummary (§125 t-978)
 *
 * Pins the body the dialog posts to `POST /api/v1/admin/waitlist/invite` for
 * each choice, what blocks Send, and how the route's answer is read: checked
 * against `waveResultSchema`, never trusted.
 *
 * @see components/admin/waitlist/waitlist-invite-wave-dialog.tsx
 */

import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  WaitlistInviteWaveDialog,
  WaveSummary,
  type WaveResult,
} from '@/components/admin/waitlist/waitlist-invite-wave-dialog';
import { API } from '@/lib/api/endpoints';
import { WAITLIST_INVITE_REFUSAL_MESSAGES } from '@/lib/waitlist/invite-refusals';
import type { WaitlistFieldShape } from '@/lib/validations/waitlist';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FIELDS: WaitlistFieldShape[] = [
  {
    key: 'role',
    label: 'Role',
    kind: 'select',
    options: [
      { value: 'dev', label: 'Developer' },
      { value: 'ops', label: 'Operations' },
    ],
  },
  { key: 'company', label: 'Company', kind: 'text' },
];

function result(overrides: Partial<WaveResult> = {}): WaveResult {
  return {
    selected: 3,
    invited: 3,
    refused: 0,
    failed: 0,
    emailNotSent: 0,
    rows: [],
    ...overrides,
  };
}

/** The footer's Close, not the corner X, which has the same accessible name. */
function footerClose(): HTMLElement {
  const match = screen
    .getAllByRole('button', { name: 'Close' })
    .find((button) => button.querySelector('svg') === null);
  if (!match) throw new Error('footer Close button not found');
  return match;
}

async function getApi() {
  return import('@/lib/api/client');
}

/** Hosts the dialog the way the table does: open state lives outside it. */
function Host(props: {
  lists?: readonly string[];
  fields?: readonly WaitlistFieldShape[];
  onInvited: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>reopen</button>
      <WaitlistInviteWaveDialog
        open={open}
        onOpenChange={setOpen}
        lists={props.lists ?? ['default']}
        fields={props.fields ?? []}
        onInvited={props.onInvited}
      />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('WaitlistInviteWaveDialog — the request', () => {
  it('posts the next 10 by default, with no list or answer', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue(result());
    const user = userEvent.setup();
    render(<Host onInvited={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith(API.ADMIN.WAITLIST_INVITE_WAVE, {
      body: { mode: 'next', count: 10 },
    });
  });

  it('posts mode "sample" after choosing At random, with the typed count as a number', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue(result());
    const user = userEvent.setup();
    render(<Host onInvited={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: /^Who/ }));
    await user.click(screen.getByRole('option', { name: 'At random' }));
    const count = screen.getByRole('spinbutton');
    await user.clear(count);
    await user.type(count, '7');
    await user.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(apiClient.post).toHaveBeenCalledWith(API.ADMIN.WAITLIST_INVITE_WAVE, {
      body: { mode: 'sample', count: 7 },
    });
  });

  it.each(['0', '51', '2.5', ''])(
    'disables Send and explains when the count is %j',
    async (bad) => {
      const { apiClient } = await getApi();
      const user = userEvent.setup();
      render(<Host onInvited={vi.fn()} />);

      const count = screen.getByRole('spinbutton');
      await user.clear(count);
      if (bad) await user.type(count, bad);

      expect(screen.getByText('Enter a whole number from 1 to 50.')).toBeInTheDocument();
      const send = screen.getByRole('button', { name: 'Send invitations' });
      expect(send).toBeDisabled();
      await user.click(send);
      expect(apiClient.post).not.toHaveBeenCalled();
    }
  );

  it.each(['1', '50'])('accepts the boundary count %s', async (ok) => {
    const user = userEvent.setup();
    render(<Host onInvited={vi.fn()} />);

    const count = screen.getByRole('spinbutton');
    await user.clear(count);
    await user.type(count, ok);

    expect(screen.queryByText(/Enter a whole number/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invitations' })).toBeEnabled();
  });
});

describe('WaitlistInviteWaveDialog — list and answer', () => {
  it('shows no list select with one list, and sends no list', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue(result());
    const user = userEvent.setup();
    render(<Host lists={['default']} onInvited={vi.fn()} />);

    expect(screen.queryByRole('combobox', { name: /^List/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send invitations' }));

    const body = vi.mocked(apiClient.post).mock.calls[0][1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('list');
  });

  it('with several lists, sends nothing for "All lists" and the key once one is chosen', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue(result());
    const user = userEvent.setup();
    render(<Host lists={['alpha', 'beta']} onInvited={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Send invitations' }));
    expect(vi.mocked(apiClient.post).mock.calls[0][1]?.body).not.toHaveProperty('list');

    // The dialog stays on the result; reopen from scratch via Close.
    await user.click(footerClose());
    await user.click(screen.getByRole('button', { name: 'reopen' }));
    await user.click(screen.getByRole('combobox', { name: /^List/ }));
    await user.click(screen.getByRole('option', { name: 'beta' }));
    await user.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(vi.mocked(apiClient.post).mock.calls[1][1]?.body).toEqual({
      mode: 'next',
      count: 10,
      list: 'beta',
    });
  });

  it('shows no answer filter when the form has no fields', () => {
    render(<Host fields={[]} onInvited={vi.fn()} />);

    expect(screen.queryByRole('combobox', { name: /Only people who answered/ })).toBeNull();
  });

  it('a select field blocks Send until an option is chosen, then posts answer { field, value }', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue(result());
    const user = userEvent.setup();
    render(<Host fields={FIELDS} onInvited={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: /Only people who answered/ }));
    await user.click(screen.getByRole('option', { name: 'Role' }));

    const send = screen.getByRole('button', { name: 'Send invitations' });
    expect(send).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: 'Answer to Role' }));
    await user.click(screen.getByRole('option', { name: 'Operations' }));
    expect(send).toBeEnabled();
    await user.click(send);

    expect(apiClient.post).toHaveBeenCalledWith(API.ADMIN.WAITLIST_INVITE_WAVE, {
      body: { mode: 'next', count: 10, answer: { field: 'role', value: 'ops' } },
    });
  });

  it('a text field takes typed text, trimmed, and blocks Send while blank', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue(result());
    const user = userEvent.setup();
    render(<Host fields={FIELDS} onInvited={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: /Only people who answered/ }));
    await user.click(screen.getByRole('option', { name: 'Company' }));

    const send = screen.getByRole('button', { name: 'Send invitations' });
    const input = screen.getByLabelText('Answer to Company');
    await user.type(input, '   ');
    expect(send).toBeDisabled();

    await user.type(input, ' Acme ');
    expect(send).toBeEnabled();
    await user.click(send);

    expect(apiClient.post).toHaveBeenCalledWith(API.ADMIN.WAITLIST_INVITE_WAVE, {
      body: { mode: 'next', count: 10, answer: { field: 'company', value: 'Acme' } },
    });
  });

  it('going back to Anyone drops the answer from the request', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue(result());
    const user = userEvent.setup();
    render(<Host fields={FIELDS} onInvited={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: /Only people who answered/ }));
    await user.click(screen.getByRole('option', { name: 'Company' }));
    await user.type(screen.getByLabelText('Answer to Company'), 'Acme');
    await user.click(screen.getByRole('combobox', { name: /Only people who answered/ }));
    await user.click(screen.getByRole('option', { name: 'Anyone' }));
    await user.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(vi.mocked(apiClient.post).mock.calls[0][1]?.body).toEqual({ mode: 'next', count: 10 });
  });
});

describe('WaitlistInviteWaveDialog — the answer', () => {
  it('shows the summary in place of the form and calls onInvited once', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue(result({ selected: 4, invited: 3, refused: 1 }));
    const onInvited = vi.fn();
    const user = userEvent.setup();
    render(<Host onInvited={onInvited} />);

    await user.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(await screen.findByText(/Invited 3 of 4\./)).toBeInTheDocument();
    expect(onInvited).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Send invitations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('says "No one matched" when nothing was selected', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue(result({ selected: 0, invited: 0 }));
    const user = userEvent.setup();
    render(<Host onInvited={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(await screen.findByText(/No one matched/)).toBeInTheDocument();
    expect(screen.queryByText(/Invited 0 of 0/)).not.toBeInTheDocument();
  });

  it('shows the SaveError, not a summary, when the answer fails the schema; onInvited is not called', async () => {
    const { apiClient } = await getApi();
    // `rows` missing and `selected` the wrong type: not a wave result.
    vi.mocked(apiClient.post).mockResolvedValue({ selected: 'lots', invited: 1 });
    const onInvited = vi.fn();
    const user = userEvent.setup();
    render(<Host onInvited={onInvited} />);

    await user.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The invitations could not be sent. Try again.'
    );
    expect(screen.queryByText(/Invited/)).not.toBeInTheDocument();
    expect(onInvited).not.toHaveBeenCalled();
    // The form is still there to retry.
    expect(screen.getByRole('button', { name: 'Send invitations' })).toBeEnabled();
  });

  it('shows the server message when the request fails', async () => {
    const { apiClient, APIClientError } = await getApi();
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Too many invitations just now', 'RATE_LIMITED', 429)
    );
    const onInvited = vi.fn();
    const user = userEvent.setup();
    render(<Host onInvited={onInvited} />);

    await user.click(screen.getByRole('button', { name: 'Send invitations' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many invitations just now');
    expect(onInvited).not.toHaveBeenCalled();
  });

  it('Close resets to the form on reopen', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockResolvedValue(result());
    const user = userEvent.setup();
    render(<Host onInvited={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Send invitations' }));
    await screen.findByText(/Invited 3 of 3\./);
    await user.click(footerClose());
    expect(screen.queryByText(/Invited 3 of 3\./)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'reopen' }));

    expect(screen.queryByText(/Invited 3 of 3\./)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send invitations' })).toBeInTheDocument();
  });

  it('Cancel after a failed send clears the error for the next opening', async () => {
    const { apiClient } = await getApi();
    vi.mocked(apiClient.post).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<Host onInvited={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Send invitations' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'reopen' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('WaveSummary', () => {
  it('reports invited of selected without reasons when no one was refused', () => {
    render(<WaveSummary result={result({ selected: 5, invited: 5 })} />);

    expect(screen.getByRole('status')).toHaveTextContent('Invited 5 of 5.');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('groups refusals by message and counts each group', () => {
    render(
      <WaveSummary
        result={result({
          selected: 5,
          invited: 2,
          refused: 3,
          rows: [
            { id: 'a', outcome: 'invited' },
            { id: 'b', outcome: 'invited' },
            { id: 'c', outcome: 'refused', reason: 'flagged' },
            { id: 'd', outcome: 'refused', reason: 'flagged' },
            { id: 'e', outcome: 'refused', reason: 'account_exists' },
          ],
        })}
      />
    );

    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      `2 not invited: ${WAITLIST_INVITE_REFUSAL_MESSAGES.flagged}`,
      `1 not invited: ${WAITLIST_INVITE_REFUSAL_MESSAGES.account_exists}`,
    ]);
  });

  it('does not list a failed row as a refusal', () => {
    render(
      <WaveSummary
        result={result({
          selected: 1,
          invited: 0,
          failed: 1,
          rows: [{ id: 'a', outcome: 'failed' }],
        })}
      />
    );

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      '1 could not be invited because of an error; try them again.'
    );
  });

  it.each([
    [1, '1 invitation email did not go; use Resend on that row.'],
    [2, '2 invitation emails did not go; use Resend on those rows.'],
  ])('words %i unsent emails with the right plural', (emailNotSent, expected) => {
    render(<WaveSummary result={result({ selected: 2, invited: 2, emailNotSent })} />);

    expect(screen.getByRole('status')).toHaveTextContent(expected);
  });
});
