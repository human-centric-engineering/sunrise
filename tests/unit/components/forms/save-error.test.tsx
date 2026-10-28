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

beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
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
}: {
  next: () => SaveFailure;
  stale?: StaleSaveProps;
  revealable?: boolean;
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
          onRevealField={revealable ? () => setTab('advanced') : undefined}
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
