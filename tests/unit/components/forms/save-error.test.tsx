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
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';

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

/** Runs `fn` after `n` animation frames. */
function afterFrames(n: number, fn: () => void) {
  const step = (left: number) => (left === 0 ? fn() : requestAnimationFrame(() => step(left - 1)));
  step(n);
}

/** Resolves after `n` animation frames. */
function frames(n: number) {
  return new Promise<void>((resolve) => afterFrames(n, resolve));
}

/**
 * A tabbed form whose reveal switches tabs `lateBy` frames after it is asked,
 * as a slow device's does. Each Save fails naming `name` (on the showing tab)
 * and `webhookUrl` (on the hidden one), so the first look finds `name` on the
 * tab being left. `onReveal` runs when the form is asked to reveal, so a test
 * can move focus meanwhile as an admin would.
 */
function LateTabs({
  lateBy,
  lateMs,
  onReveal,
  moveFocusAtSwitch = false,
  updateAt,
  onlyHidden = false,
}: {
  lateBy: number;
  /** Switch this many milliseconds late instead, as a busy scheduler holds a commit. */
  lateMs?: number;
  onReveal?: () => void;
  /** The admin moves focus to Notes in the frame the switch is made, before it commits. */
  moveFocusAtSwitch?: boolean;
  /** Frames after the reveal at which the failure is updated, as a field being fixed does. */
  updateAt?: number;
  /** Name only the hidden field, so no field can take focus until the switch. */
  onlyHidden?: boolean;
}) {
  const [current, setCurrent] = useState<SaveFailure | null>(null);
  const [tab, setTab] = useState<'main' | 'advanced'>('main');
  const [, setRenders] = useState(0);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setCurrent(
          failure({
            fields: [
              ...(onlyHidden ? [] : [{ field: 'name', message: 'Required' }]),
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
      <input aria-label="Notes" />
      <SaveError
        failure={current}
        // A new function each render, as an inline handler is.
        onRevealField={() => {
          onReveal?.();
          if (updateAt !== undefined)
            afterFrames(updateAt, () =>
              setCurrent((c) => c && { ...c, message: '1 field needs fixing.', updated: true })
            );
          if (lateMs !== undefined) setTimeout(() => setTab('advanced'), lateMs);
          else
            afterFrames(lateBy, () => {
              if (moveFocusAtSwitch) screen.getByLabelText('Notes').focus();
              setTab('advanced');
            });
        }}
      />
      <button type="submit">Save</button>
      <button type="button" onClick={() => setRenders((n) => n + 1)}>
        Re-render
      </button>
    </form>
  );
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
    // Two frames late: the first look still finds `name` on the tab being
    // left. Focus must end on the revealed field.
    render(<LateTabs lateBy={2} />);

    save();

    await waitFor(() => expect(screen.getByLabelText('Webhook')).toHaveFocus());
  });

  it('follows a tab switch that lands after its last reveal frame, rather than leaving focus on the page', async () => {
    // t-997: a switch later than the reveal frames, as on a slow device,
    // unmounted the field focus had gone to and left focus on <body>.
    render(<LateTabs lateBy={10} />);

    save();
    await act(() => frames(14));

    expect(screen.getByLabelText('Webhook')).toHaveFocus();
  });

  it('follows a tab switch held up by a busy scheduler, long after its frames', async () => {
    // Frames are no measure of a late commit: React can hold one back for
    // longer than any number of frames take.
    render(<LateTabs lateBy={0} lateMs={150} />);

    save();

    await waitFor(() => expect(screen.getByLabelText('Webhook')).toHaveFocus());
  });

  it('leaves focus where the admin moved it while the tab was switching', async () => {
    // The first look focuses `name`, and the admin then clicks into Notes.
    // The switch lands after the reveal frames, while the look is still
    // watching `name` for a late switch, and unmounts it. Taking focus back to
    // the revealed field would pull it out from under them.
    render(
      <LateTabs
        lateBy={10}
        onReveal={() => afterFrames(2, () => screen.getByLabelText('Notes').focus())}
      />
    );

    save();
    await act(() => frames(14));

    expect(screen.getByLabelText('Webhook')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toHaveFocus();
  });

  it('leaves focus where the admin moved it just before the switch unmounts the field', async () => {
    // Past the reveal frames nothing looks again until the switch commits. By
    // then `name` is gone, but focus went to Notes, not with it: that is focus
    // moved, not lost.
    render(<LateTabs lateBy={10} moveFocusAtSwitch />);

    save();
    await act(() => frames(14));

    expect(screen.getByLabelText('Webhook')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toHaveFocus();
  });

  it('keeps watching for a late switch when the failure is updated meanwhile', async () => {
    // The person starts fixing a field before the switch lands. That update
    // must not end the watch the press started.
    render(<LateTabs lateBy={10} updateAt={7} />);

    save();
    await act(() => frames(14));

    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
    expect(screen.getByLabelText('Webhook')).toHaveFocus();
  });

  it('leaves focus on the page when the admin clicked away before the switch', async () => {
    // A click on blank space puts focus on <body> while the field is still
    // there. When the switch then unmounts it, that is not focus lost with it.
    render(
      <LateTabs
        lateBy={10}
        onReveal={() => afterFrames(7, () => screen.getByLabelText('Name').blur())}
      />
    );

    save();
    await act(() => frames(14));

    expect(screen.getByLabelText('Webhook')).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves focus where the admin moved it before any field could take it', async () => {
    // Only the hidden field is named, so nothing is focused until the switch.
    // The admin clicks into Notes first: the field mounting later must not
    // pull focus out of it.
    render(
      <LateTabs
        lateBy={3}
        onlyHidden
        onReveal={() => afterFrames(1, () => screen.getByLabelText('Notes').focus())}
      />
    );

    save();
    await act(() => frames(8));

    expect(screen.getByLabelText('Webhook')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toHaveFocus();
  });

  it('focuses the hidden field once its tab lands, when nobody moved focus', async () => {
    // waitFor, not act(): inside act() React holds the switch's commit until
    // act() ends, after the reveal frames, and the summary rightly takes focus.
    render(<LateTabs lateBy={3} onlyHidden />);

    save();

    await waitFor(() => expect(screen.getByLabelText('Webhook')).toHaveFocus());
  });

  it('announces a new failure assertively and an update to it politely', async () => {
    render(<LateTabs lateBy={1} updateAt={3} />);

    save();
    expect(screen.getByRole('alert')).not.toHaveAttribute('aria-live');
    await act(() => frames(6));

    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'polite');
  });

  it('does not pull focus back when the form re-renders after the admin moved it', async () => {
    render(<LateTabs lateBy={1} />);
    save();
    await waitFor(() => expect(screen.getByLabelText('Webhook')).toHaveFocus());
    screen.getByLabelText('Notes').focus();

    // A new onRevealField each render; the failure is the same object.
    fireEvent.click(screen.getByRole('button', { name: 'Re-render' }));
    await act(() => frames(8));

    expect(screen.getByLabelText('Notes')).toHaveFocus();
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
