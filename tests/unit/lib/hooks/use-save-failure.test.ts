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

  it('clears on request', () => {
    const { result } = renderHook(() => useSaveFailure({ fallback: 'x' }));
    act(() => {
      result.current.report(new Error('boom'));
    });

    act(() => result.current.clear());

    expect(result.current.failure).toBeNull();
  });
});
