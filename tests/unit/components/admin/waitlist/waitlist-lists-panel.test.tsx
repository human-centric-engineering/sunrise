// @vitest-environment happy-dom

/**
 * WaitlistListsPanel (§125 t-976)
 *
 * Per-list counts, open/closed state, and the open/close toggle.
 *
 * @see components/admin/waitlist/waitlist-lists-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useState } from 'react';

import {
  WaitlistListsPanel,
  type WaitlistListCountsView,
  type WaitlistListStateChange,
} from '@/components/admin/waitlist/waitlist-lists-panel';
import { API } from '@/lib/api/endpoints';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

/**
 * The page's part, as `WaitlistAdmin` plays it: hold the lists, and record a
 * toggle's answer in them. The panel draws only what it is given.
 */
function Harness({
  lists,
  onListChange,
}: {
  lists: WaitlistListCountsView[];
  onListChange?: (key: string, change: WaitlistListStateChange) => void;
}) {
  const [state, setState] = useState(lists);
  return (
    <WaitlistListsPanel
      lists={state}
      onListChange={(key, change) => {
        onListChange?.(key, change);
        setState((current) => current.map((l) => (l.key === key ? { ...l, ...change } : l)));
      }}
    />
  );
}

function view(overrides: Partial<WaitlistListCountsView> = {}): WaitlistListCountsView {
  return {
    key: 'default',
    open: true,
    closedSince: null,
    confirmed: 11,
    unconfirmed: 22,
    flagged: 3,
    removed: 4,
    invited: 5,
    joined: 6,
    bySource: [],
    ...overrides,
  };
}

/** The number shown under a label in a list card. */
function countFor(card: HTMLElement, label: string): string | null {
  return within(card).getByText(label).nextElementSibling?.textContent ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('WaitlistListsPanel — counts', () => {
  it('shows each list’s counts under the right label', () => {
    render(<Harness lists={[view()]} />);

    const card = screen.getByTestId('waitlist-list-default');
    expect(within(card).getByRole('heading', { name: 'default' })).toBeInTheDocument();
    expect(countFor(card, 'Confirmed')).toBe('11');
    expect(countFor(card, 'Unconfirmed')).toBe('22');
    expect(countFor(card, 'Flagged')).toBe('3');
    expect(countFor(card, 'Invited')).toBe('5');
    expect(countFor(card, 'Signed up')).toBe('6');
    expect(countFor(card, 'Removed')).toBe('4');
  });

  it('shows one card per list, each with its own numbers and state', () => {
    render(
      <Harness lists={[view(), view({ key: 'beta', open: false, confirmed: 99, removed: 0 })]} />
    );

    const beta = screen.getByTestId('waitlist-list-beta');
    expect(countFor(beta, 'Confirmed')).toBe('99');
    expect(countFor(beta, 'Removed')).toBe('0');
    expect(within(beta).getByText('Closed')).toBeInTheDocument();
    const def = screen.getByTestId('waitlist-list-default');
    expect(countFor(def, 'Confirmed')).toBe('11');
    expect(within(def).getByText('Taking joins')).toBeInTheDocument();
  });

  it('shows "Taking joins" and "Close list" for an open list, "Closed" and "Open list" for a closed one', () => {
    const { unmount } = render(<Harness lists={[view({ open: true })]} />);
    expect(screen.getByText('Taking joins')).toBeInTheDocument();
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close list' })).toBeInTheDocument();
    unmount();

    render(<Harness lists={[view({ open: false })]} />);
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByText('Taking joins')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open list' })).toBeInTheDocument();
  });

  it('shows the confirmed-by-source line only when there are sources', () => {
    const { unmount } = render(
      <Harness
        lists={[
          view({
            bySource: [
              { source: 'direct', count: 7 },
              { source: 'twitter', count: 2 },
            ],
          }),
        ]}
      />
    );
    expect(screen.getByText('Confirmed by source: direct 7 · twitter 2')).toBeInTheDocument();
    unmount();

    render(<Harness lists={[view({ bySource: [] })]} />);
    expect(screen.queryByText(/Confirmed by source/)).not.toBeInTheDocument();
  });
});

describe('WaitlistListsPanel — close and open', () => {
  it('PATCHes open:false for that list and then shows Closed and "Open list"', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ key: 'default', open: false });
    const user = userEvent.setup();
    render(<Harness lists={[view()]} />);

    await user.click(screen.getByRole('button', { name: 'Close list' }));

    expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.waitlistList('default'), {
      body: { open: false },
    });
    expect(await screen.findByText('Closed')).toBeInTheDocument();
    expect(screen.queryByText('Taking joins')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open list' })).toBeInTheDocument();
    // The counts are untouched by the toggle.
    expect(countFor(screen.getByTestId('waitlist-list-default'), 'Confirmed')).toBe('11');
  });

  it('PATCHes open:true on a closed list, and shows what the server answered', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ key: 'beta', open: true });
    const user = userEvent.setup();
    render(<Harness lists={[view({ key: 'beta', open: false })]} />);

    await user.click(screen.getByRole('button', { name: 'Open list' }));

    expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.waitlistList('beta'), {
      body: { open: true },
    });
    expect(await screen.findByText('Taking joins')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close list' })).toBeInTheDocument();
  });

  it('only changes the list that was toggled', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({ key: 'beta', open: false });
    const user = userEvent.setup();
    render(<Harness lists={[view(), view({ key: 'beta' })]} />);

    await user.click(
      within(screen.getByTestId('waitlist-list-beta')).getByRole('button', { name: 'Close list' })
    );

    await waitFor(() =>
      expect(within(screen.getByTestId('waitlist-list-beta')).getByText('Closed')).toBeVisible()
    );
    expect(
      within(screen.getByTestId('waitlist-list-default')).getByText('Taking joins')
    ).toBeVisible();
  });

  it('disables the button while the request is in flight', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<Harness lists={[view()]} />);

    await user.click(screen.getByRole('button', { name: 'Close list' }));

    expect(screen.getByRole('button', { name: 'Close list' })).toBeDisabled();
    expect(apiClient.patch).toHaveBeenCalledTimes(1);
  });

  it('shows "Could not close the list" beside the button and leaves the badge alone on failure', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<Harness lists={[view()]} />);

    await user.click(screen.getByRole('button', { name: 'Close list' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not close the list. Try again.'
    );
    expect(screen.getByText('Taking joins')).toBeInTheDocument();
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close list' })).toBeEnabled();
  });

  it('says "Could not open the list" when opening fails, and clears the error on the next attempt', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ key: 'default', open: true });
    const user = userEvent.setup();
    render(<Harness lists={[view({ open: false })]} />);

    await user.click(screen.getByRole('button', { name: 'Open list' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not open the list. Try again.'
    );
    expect(screen.getByText('Closed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open list' }));
    expect(await screen.findByText('Taking joins')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('WaitlistListsPanel — a list closed only by the config (code review round 2)', () => {
  it('offers Mark closed only for a closed list with no recorded close, and says why', () => {
    render(
      <Harness
        lists={[
          view({ key: 'config-closed', open: false, closedSince: null }),
          view({ key: 'admin-closed', open: false, closedSince: '2026-01-01T00:00:00.000Z' }),
          view({ key: 'open' }),
        ]}
      />
    );

    const card = (key: string) => within(screen.getByTestId(`waitlist-list-${key}`));
    expect(card('config-closed').getByRole('button', { name: 'Mark closed' })).toBeInTheDocument();
    expect(card('config-closed').getByText(/no close date recorded/)).toBeInTheDocument();
    expect(card('admin-closed').queryByRole('button', { name: 'Mark closed' })).toBeNull();
    expect(card('open').queryByRole('button', { name: 'Mark closed' })).toBeNull();
  });

  it('records the close with open:false, keeps the list closed, and drops the offer', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({
      key: 'default',
      open: false,
      changedAt: '2026-11-04T10:00:00.000Z',
    });
    const user = userEvent.setup();
    render(<Harness lists={[view({ open: false, closedSince: null })]} />);

    await user.click(screen.getByRole('button', { name: 'Mark closed' }));

    expect(apiClient.patch).toHaveBeenCalledWith(API.ADMIN.waitlistList('default'), {
      body: { open: false },
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Mark closed' })).not.toBeInTheDocument()
    );
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('reports a failed Mark closed with its own message, and a failed Open with the open one', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<Harness lists={[view({ open: false, closedSince: null })]} />);

    await user.click(screen.getByRole('button', { name: 'Mark closed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not record the close. Try again.'
    );

    await user.click(screen.getByRole('button', { name: 'Open list' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not open the list. Try again.')
    );
  });
});

describe('WaitlistListsPanel — new counts from the page (code review round 2)', () => {
  it('hands the page the toggle’s answer once it succeeded, and nothing when it failed', async () => {
    const { apiClient } = await import('@/lib/api/client');
    const onListChange = vi.fn();
    vi.mocked(apiClient.patch).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      key: 'default',
      open: false,
      changedAt: '2026-11-04T10:00:00.000Z',
    });
    const user = userEvent.setup();
    render(<Harness lists={[view()]} onListChange={onListChange} />);

    await user.click(screen.getByRole('button', { name: 'Close list' }));
    await screen.findByRole('alert');
    expect(onListChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Close list' }));
    await waitFor(() =>
      expect(onListChange).toHaveBeenCalledWith('default', {
        open: false,
        closedSince: '2026-11-04T10:00:00.000Z',
      })
    );
  });

  it('draws only what it is given: a toggle shows nothing until the page records it', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockResolvedValue({
      key: 'default',
      open: false,
      changedAt: '2026-11-04T10:00:00.000Z',
    });
    const user = userEvent.setup();
    const onListChange = vi.fn();
    render(<WaitlistListsPanel lists={[view()]} onListChange={onListChange} />);

    await user.click(screen.getByRole('button', { name: 'Close list' }));

    await waitFor(() => expect(onListChange).toHaveBeenCalled());
    expect(screen.getByText('Taking joins')).toBeInTheDocument();
  });

  it('shows the spinner on the button that was pressed', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<Harness lists={[view({ open: false, closedSince: null })]} />);

    await user.click(screen.getByRole('button', { name: 'Mark closed' }));

    const mark = screen.getByRole('button', { name: 'Mark closed' });
    const open = screen.getByRole('button', { name: 'Open list' });
    expect(mark.querySelector('.animate-spin')).not.toBeNull();
    expect(open.querySelector('.animate-spin')).toBeNull();
    expect(mark).toBeDisabled();
    expect(open).toBeDisabled();
  });

  it('follows the page’s open state', () => {
    const noop = vi.fn();
    const { rerender } = render(
      <WaitlistListsPanel lists={[view({ open: true })]} onListChange={noop} />
    );

    rerender(
      <WaitlistListsPanel
        lists={[view({ open: false, closedSince: '2026-11-04T10:00:00.000Z' })]}
        onListChange={noop}
      />
    );

    expect(screen.getByText('Closed')).toBeInTheDocument();
  });
});
