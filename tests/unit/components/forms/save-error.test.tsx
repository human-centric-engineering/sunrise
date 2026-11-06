// @vitest-environment happy-dom

/**
 * SaveError Component Tests
 *
 * The movement is the point of the component (§124): a failure is brought
 * into view and focused when it appears, and again on the next failure, or
 * focus goes to the first field the server named, revealing a hidden tab
 * first when the form says how.
 *
 * @see components/forms/form-error.tsx
 */

import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { SaveError, type StaleSaveProps } from '@/components/forms/form-error';
import type { SaveFailure } from '@/lib/errors/save-error';

const scrollIntoView = vi.fn();

/** Where the box sits: below the window unless a test puts it in view. */
function placeBox(top: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 0, y: top, width: 400, height: 48 })
  );
}

beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
  placeBox(window.innerHeight + 500);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function failure(overrides: Partial<SaveFailure> = {}): SaveFailure {
  return { message: 'Could not save.', stale: false, fields: [], ...overrides };
}

/**
 * A form with two visible fields, one on a hidden tab, and the error beside
 * Save. `next` is the failure the Save button produces: a new object each
 * press, as a form's catch block makes one.
 */
function Harness({
  next,
  stale,
  revealable = true,
  keepTab = false,
}: {
  next: () => SaveFailure;
  stale?: StaleSaveProps;
  revealable?: boolean;
  /** A reveal that keeps the showing tab: it holds the earliest named field. */
  keepTab?: boolean;
}) {
  const [current, setCurrent] = useState<SaveFailure | null>(null);
  const [tab, setTab] = useState<'main' | 'advanced'>('main');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setCurrent(next());
      }}
    >
      {tab === 'main' ? (
        <>
          <input aria-label="Name" name="name" />
          <input aria-label="Budget" id="budget" />
        </>
      ) : (
        <input aria-label="Webhook" name="webhookUrl" />
      )}
      <div data-testid="save-row">
        <SaveError
          failure={current}
          stale={stale}
          onRevealField={
            keepTab ? () => setTab('main') : revealable ? () => setTab('advanced') : undefined
          }
        />
        <button type="submit">Save</button>
      </div>
    </form>
  );
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

describe('SaveError', () => {
  it('renders nothing without a failure', () => {
    render(<Harness next={() => failure()} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('appears as an alert where the form placed it, and takes focus and scrolls into view', async () => {
    render(<Harness next={() => failure({ message: 'Budget too high' })} />);

    save();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Budget too high');
    expect(screen.getByTestId('save-row')).toContainElement(alert);
    expect(alert).toHaveClass('bg-red-50');
    expect(alert).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(alert);
  });

  it('takes focus without scrolling when it is already in view, as in a sticky Save bar', async () => {
    // With the admin area's scroll padding, scrolling a box that is in view
    // would move the page under it on every failure (t-964).
    placeBox(100);
    render(<Harness next={() => failure({ message: 'Budget too high' })} />);

    save();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('moves again on a second failure with the same message', async () => {
    render(<Harness next={() => failure({ message: 'Budget too high' })} />);

    save();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveFocus();

    // The person clicks away, then saves again and is refused again.
    screen.getByLabelText('Name').focus();
    scrollIntoView.mockClear();
    save();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('focuses the first named field in page order, not the order the server sent', async () => {
    render(
      <Harness
        next={() =>
          failure({
            message: '2 fields need fixing.',
            fields: [
              { field: 'budget', message: 'Too high' },
              { field: 'name', message: 'Required' },
            ],
          })
        }
      />
    );

    save();

    // The summary still sits by Save; focus is on what needs fixing.
    expect(await screen.findByRole('alert')).toHaveTextContent('2 fields need fixing.');
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByLabelText('Name'));
  });

  it('finds a field by id when it has no name', async () => {
    render(
      <Harness next={() => failure({ fields: [{ field: 'budget', message: 'Too high' }] })} />
    );

    save();

    await waitFor(() => expect(screen.getByLabelText('Budget')).toHaveFocus());
  });

  it('reveals a field on a hidden tab, then focuses it', async () => {
    render(
      <Harness
        next={() => failure({ fields: [{ field: 'webhookUrl', message: 'Must be https' }] })}
      />
    );

    save();

    await waitFor(() => expect(screen.getByLabelText('Webhook')).toHaveFocus());
  });

  it('hands the form every named field to reveal, in the order sent', async () => {
    const reveal = vi.fn();
    function Spy() {
      return (
        <form>
          <SaveError
            failure={failure({
              fields: [
                { field: 'webhookUrl', message: 'Must be https' },
                { field: 'retries', message: 'Too many' },
              ],
            })}
            onRevealField={reveal}
          />
        </form>
      );
    }
    render(<Spy />);

    await waitFor(() => expect(reveal).toHaveBeenCalledWith(['webhookUrl', 'retries']));
  });

  it('follows a tab switch that lands after its first look, rather than losing focus', async () => {
    // The form switches tabs two frames late, so the first look still finds
    // `name` on the tab being left. Focus must end on the revealed field.
    function LateTabs() {
      const [current, setCurrent] = useState<SaveFailure | null>(null);
      const [tab, setTab] = useState<'main' | 'advanced'>('main');
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setCurrent(
              failure({
                fields: [
                  { field: 'name', message: 'Required' },
                  { field: 'webhookUrl', message: 'Must be https' },
                ],
              })
            );
          }}
        >
          {/* Keyed, so the switch unmounts the old field as Radix's tabs do. */}
          {tab === 'main' ? (
            <input key="name" aria-label="Name" name="name" />
          ) : (
            <input key="webhookUrl" aria-label="Webhook" name="webhookUrl" />
          )}
          <SaveError
            failure={current}
            onRevealField={() =>
              requestAnimationFrame(() => requestAnimationFrame(() => setTab('advanced')))
            }
          />
          <button type="submit">Save</button>
        </form>
      );
    }
    render(<LateTabs />);

    save();

    await waitFor(() => expect(screen.getByLabelText('Webhook')).toHaveFocus());
  });

  it('with errors on two tabs, focuses the first named field the revealed tab shows', async () => {
    // `name` is on the showing tab, `webhookUrl` on the hidden one. They can't
    // both be on the page, so the form keeps its earlier tab and focus goes
    // to that tab's field rather than to the summary.
    render(
      <Harness
        revealable={false}
        next={() =>
          failure({
            fields: [
              { field: 'webhookUrl', message: 'Must be https' },
              { field: 'name', message: 'Required' },
            ],
          })
        }
        keepTab
      />
    );

    save();

    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
  });

  it('focuses itself, not a later field, when an earlier named field is not on the page', async () => {
    render(
      <Harness
        revealable={false}
        next={() =>
          failure({
            fields: [
              { field: 'webhookUrl', message: 'Must be https' },
              { field: 'budget', message: 'Too high' },
            ],
          })
        }
      />
    );

    save();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  });

  it('focuses itself when the named field cannot take focus', async () => {
    render(<Harness next={() => failure({ fields: [{ field: 'name', message: 'Required' }] })} />);
    screen.getByLabelText<HTMLInputElement>('Name').disabled = true;

    save();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  });

  it('focuses itself when a named field cannot be found or revealed', async () => {
    render(
      <Harness
        revealable={false}
        next={() => failure({ fields: [{ field: 'webhookUrl', message: 'Must be https' }] })}
      />
    );

    save();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus());
  });

  describe('stale variant', () => {
    const staleFailure = () =>
      failure({ stale: true, code: 'STALE_RECORD', message: 'This changed since you opened it.' });

    it('says what changed, in red, and moves like any other failure', async () => {
      render(<Harness next={staleFailure} stale={{ what: 'The escalation list' }} />);

      save();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/the escalation list changed since you opened it/i);
      expect(alert).toHaveTextContent(/nothing was saved/i);
      expect(alert).toHaveClass('bg-red-50');
      expect(alert).toHaveFocus();
    });

    it('keeps Reload, calling the page’s own reload when it has one', async () => {
      const onReload = vi.fn();
      render(<Harness next={staleFailure} stale={{ what: 'That schedule', onReload }} />);

      save();
      fireEvent.click(await screen.findByRole('button', { name: /reload/i }));

      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it('keeps Copy my changes, and says whether the copy landed', async () => {
      const onCopyChanges = vi.fn().mockRejectedValue(new Error('no clipboard'));
      render(<Harness next={staleFailure} stale={{ what: 'This workflow', onCopyChanges }} />);

      save();
      fireEvent.click(await screen.findByRole('button', { name: /copy my changes/i }));

      expect(await screen.findByRole('button', { name: /copy failed/i })).toBeInTheDocument();
      expect(onCopyChanges).toHaveBeenCalledTimes(1);
    });

    it('shows the message, not the stale body, when the page gave no stale props', async () => {
      render(<Harness next={staleFailure} />);

      save();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('This changed since you opened it.');
      expect(screen.queryByRole('button', { name: /reload/i })).not.toBeInTheDocument();
    });
  });
});
