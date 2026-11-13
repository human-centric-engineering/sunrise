// @vitest-environment happy-dom

/**
 * useSaveFailure tests
 *
 * The hook is how every form keeps §124's two wiring rules without writing
 * them out: each failure is a new object (so `<SaveError>` moves again), and
 * every press of Save clears the last one, including a press client
 * validation blocks.
 *
 * @see lib/hooks/use-save-failure.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { APIClientError } from '@/lib/api/client';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import type { FieldErrors, FieldValues } from 'react-hook-form';

function validationError(errors: Array<{ path: string; message: string }>) {
  return new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, { errors });
}

describe('useSaveFailure', () => {
  it('starts with no failure', () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'Could not save.' }));

    expect(result.current.failure).toBeNull();
  });

  it('reports what a save threw, with the fallback for an error the server never wrote', () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'Could not save.' }));

    let returned;
    act(() => {
      returned = result.current.report(new TypeError('Failed to fetch'));
    });

    expect(result.current.failure).toEqual({
      message: 'Could not save.',
      stale: false,
      fields: [],
    });
    expect(returned).toBe(result.current.failure);
  });

  it('puts field messages on the form through its table, without focusing them itself', () => {
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useSaveFailure({ fallback: 'x', fields: { 'limits.max': 'max' }, setError })
    );

    act(() => {
      result.current.report(
        validationError([
          { path: 'limits.max', message: 'Too big' },
          { path: 'unknown', message: 'Not a field here' },
        ])
      );
    });

    expect(setError).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith(
      'max',
      { type: 'server', message: 'Too big' },
      { shouldFocus: false }
    );
    // A path the table doesn't list joins the summary.
    expect(result.current.failure?.message).toBe('1 field needs fixing. Not a field here');
  });

  it('with an empty table, says every server message by Save', () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'x', fields: {} }));

    act(() => {
      result.current.report(
        validationError([
          { path: 'jurisdictions.0', message: 'Unknown jurisdiction' },
          { path: 'providers', message: 'Pick at least one' },
        ])
      );
    });

    expect(result.current.failure?.fields).toEqual([]);
    expect(result.current.failure?.message).toBe('Unknown jurisdiction Pick at least one');
  });

  it('leads with what the failure was about, for a list row reported above the table', () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'Could not save.' }));

    act(() => {
      result.current.report(
        new APIClientError('Slug already taken', 'CONFLICT', 409),
        'Couldn’t update "Support bot"'
      );
    });

    expect(result.current.failure?.message).toBe(
      'Couldn’t update "Support bot": Slug already taken'
    );
  });

  it('with nothing from the server, says the context and to try again, not the fallback too', () => {
    const { result } = renderHook(() =>
      useSaveFailure({ fallback: 'Could not update the agents. Try again in a moment.' })
    );

    act(() => {
      result.current.report(new TypeError('Failed to fetch'), 'Couldn’t update "Support bot"');
    });

    expect(result.current.failure?.message).toBe('Couldn’t update "Support bot". Try again.');
  });

  it('makes a new failure object each time, so the same message moves again', () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'Could not save.' }));

    act(() => {
      result.current.report(new Error('boom'));
    });
    const first = result.current.failure;
    act(() => {
      result.current.report(new Error('boom'));
    });

    expect(result.current.failure).toEqual(first);
    expect(result.current.failure).not.toBe(first);
  });

  it('shows a failure the page found itself, with any fields it names', () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));

    act(() => {
      result.current.show('Metadata is not valid JSON.', [{ field: 'metadata', message: 'Bad' }]);
    });

    expect(result.current.failure).toEqual({
      message: 'Metadata is not valid JSON.',
      stale: false,
      fields: [{ field: 'metadata', message: 'Bad' }],
    });
  });

  it("shows react-hook-form's blocked fields as a count by Save, each named for focus", () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));
    act(() => {
      result.current.report(new Error('boom'));
    });
    const before = result.current.failure;

    act(() => {
      result.current.invalid({
        email: { type: 'invalid_string', message: 'Invalid email address' },
      });
    });

    expect(result.current.failure).toEqual({
      message: '1 field needs fixing.',
      stale: false,
      fields: [{ field: 'email', message: 'Invalid email address' }],
    });
    expect(result.current.failure).not.toBe(before);
  });

  it("puts a plain form's own messages by Save and says it blocked", () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));
    let blocked: boolean | undefined;

    act(() => {
      blocked = result.current.block([
        { field: 'name', message: 'Name is required.' },
        { field: 'signingSecret', message: 'Signing secret must be at least 16 characters.' },
      ]);
    });

    expect(blocked).toBe(true);
    expect(result.current.failure).toEqual({
      message: 'Name is required. Signing secret must be at least 16 characters.',
      stale: false,
      fields: [
        { field: 'name', message: 'Name is required.' },
        { field: 'signingSecret', message: 'Signing secret must be at least 16 characters.' },
      ],
    });
  });

  it('lets the save through, and leaves the failure alone, when the plain check finds nothing', () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));
    act(() => {
      result.current.report(new Error('boom'));
    });
    const before = result.current.failure;
    let blocked: boolean | undefined;

    act(() => {
      blocked = result.current.block([]);
    });

    expect(blocked).toBe(false);
    expect(result.current.failure).toBe(before);
  });

  it('clears the last failure on every press, before the handler runs', () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));
    act(() => {
      result.current.report(new Error('boom'));
    });
    // A handler that never reaches the save: client validation blocked it.
    const handler = vi.fn();
    const event = { preventDefault: vi.fn() } as unknown as Parameters<
      ReturnType<typeof result.current.submit>
    >[0];

    act(() => {
      result.current.submit(handler)(event);
    });

    expect(result.current.failure).toBeNull();
    expect(handler).toHaveBeenCalledWith(event);
  });

  describe('a number field the browser could not read (t-964)', () => {
    /**
     * A form with a number field holding `typed`. happy-dom has no number
     * parsing, so the browser's verdict is set the way a real one reports it:
     * `validity.badInput`, with the value read back as ''.
     */
    function formWith(badInput: boolean) {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.type = 'number';
      input.name = 'globalMonthlyBudgetUsd';
      Object.defineProperty(input, 'validity', { value: { badInput } });
      form.append(input);
      return form;
    }
    function submitEvent(form: HTMLFormElement) {
      const preventDefault = vi.fn();
      const event = { currentTarget: form, preventDefault } as unknown as Parameters<
        ReturnType<ReturnType<typeof useSaveFailure>['submit']>
      >[0];
      return { event, preventDefault };
    }

    it('blocks the press before the handler, naming the field, instead of saving it as blank', () => {
      const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));
      const handler = vi.fn();
      const { event, preventDefault } = submitEvent(formWith(true));

      act(() => {
        result.current.submit(handler)(event);
      });

      expect(handler).not.toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
      expect(result.current.failure).toEqual({
        message: '1 field needs a number.',
        stale: false,
        fields: [{ field: 'globalMonthlyBudgetUsd', message: 'Enter a number.' }],
      });
    });

    it('counts several, and skips a readable field beside them', () => {
      const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));
      const form = formWith(true);
      const second = form.querySelector('input')!.cloneNode() as HTMLInputElement;
      second.name = 'defaultMaxCostPerTurnUsd';
      Object.defineProperty(second, 'validity', { value: { badInput: true } });
      const fine = document.createElement('input');
      fine.name = 'maxConversationsPerUser';
      form.append(second, fine);

      act(() => {
        result.current.submit(vi.fn())(submitEvent(form).event);
      });

      expect(result.current.failure?.message).toBe('2 fields need a number.');
      expect(result.current.failure?.fields.map((f) => f.field)).toEqual([
        'globalMonthlyBudgetUsd',
        'defaultMaxCostPerTurnUsd',
      ]);
    });

    it('lets a readable one through', () => {
      const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));
      const handler = vi.fn();
      const { event } = submitEvent(formWith(false));

      act(() => {
        result.current.submit(handler)(event);
      });

      expect(handler).toHaveBeenCalledWith(event);
      expect(result.current.failure).toBeNull();
    });
  });

  it('clears on request', () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));
    act(() => {
      result.current.report(new Error('boom'));
    });

    act(() => result.current.clear());

    expect(result.current.failure).toBeNull();
  });

  describe('given the live field errors (t-1013)', () => {
    const name = { type: 'too_small', message: 'Name is required' };
    const email = { type: 'invalid_string', message: 'Invalid email address' };

    function setup(initial: FieldErrors<FieldValues>) {
      const hook = renderHook(
        ({ errors }: { errors: FieldErrors<FieldValues> }) =>
          useSaveFailure({ fallback: 'x', errors }),
        { initialProps: { errors: initial } }
      );
      act(() => hook.result.current.invalid(initial));
      return hook;
    }

    it('lowers the count as fields are fixed, as an update that moves nothing', () => {
      const { result, rerender } = setup({ name, email });
      expect(result.current.failure?.message).toBe('2 fields need fixing.');

      rerender({ errors: { email } });

      expect(result.current.failure).toEqual({
        message: '1 field needs fixing.',
        stale: false,
        fields: [{ field: 'email', message: 'Invalid email address' }],
        updated: true,
      });
    });

    it('removes the summary once the last field is fixed, without another press', () => {
      const { result, rerender } = setup({ name });

      rerender({ errors: {} });

      expect(result.current.failure).toBeNull();
    });

    it('follows errors react-hook-form changed in place, on the same object', () => {
      const errors: FieldErrors<FieldValues> = { name, email };
      const { result, rerender } = setup(errors);

      delete errors.name;
      rerender({ errors });

      expect(result.current.failure?.message).toBe('1 field needs fixing.');
    });

    it('keeps the same object while the errors say the same thing', () => {
      const { result, rerender } = setup({ name, email });
      const first = result.current.failure;

      rerender({ errors: { name: { ...name }, email: { ...email } } });

      expect(result.current.failure).toBe(first);
    });

    it("leaves a server's failure alone as the field errors change", () => {
      const initial: FieldErrors<FieldValues> = { name };
      const { result, rerender } = renderHook(
        ({ errors }: { errors: FieldErrors<FieldValues> }) =>
          useSaveFailure({ fallback: 'Could not save.', errors }),
        { initialProps: { errors: initial } }
      );
      act(() => {
        result.current.report(new Error('boom'));
      });
      const reported = result.current.failure;

      rerender({ errors: {} });

      expect(result.current.failure).toBe(reported);
    });

    it('moves again on the next press, as a new failure rather than an update', () => {
      const { result, rerender } = setup({ name, email });
      rerender({ errors: { email } });
      expect(result.current.failure?.updated).toBe(true);

      act(() => result.current.invalid({ email }));

      expect(result.current.failure?.updated).toBeUndefined();
      expect(result.current.failure?.message).toBe('1 field needs fixing.');
    });

    it('stays an update when the errors go back to what the press said', () => {
      // Fix a field, then break it again: the count is back to the press's,
      // but the person is typing, so it must not read as a new failure.
      const { result, rerender } = setup({ name, email });
      const pressed = result.current.failure;
      rerender({ errors: { name } });

      rerender({ errors: { name, email } });

      expect(result.current.failure).not.toBe(pressed);
      expect(result.current.failure).toMatchObject({
        message: '2 fields need fixing.',
        updated: true,
      });
    });

    it('does not bring the summary back for a field broken after all were fixed', () => {
      const { result, rerender } = setup({ name });
      rerender({ errors: {} });
      expect(result.current.failure).toBeNull();

      rerender({ errors: { name } });

      expect(result.current.failure).toBeNull();
    });

    it('without the live errors, keeps the count from the press until the next one', () => {
      const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));
      act(() => result.current.invalid({ name, email }));

      expect(result.current.failure?.message).toBe('2 fields need fixing.');
    });
  });
});
