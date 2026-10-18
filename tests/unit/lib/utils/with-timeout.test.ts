/**
 * Tests for `lib/utils/with-timeout.ts` — the bounded, cancellable send shared
 * by the webhook email channel and the workflow notification step.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from '@/lib/utils/with-timeout';

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves with what run resolves, leaving its signal unaborted', async () => {
    let signal: AbortSignal | undefined;
    const result = await withTimeout(1000, 'Send', async (s) => {
      signal = s;
      return 'done';
    });

    expect(result).toBe('done');
    expect(signal?.aborted).toBe(false);
  });

  it('rejects at the bound and aborts the signal, even if run never settles', async () => {
    let signal: AbortSignal | undefined;
    const pending = withTimeout(1000, 'Email send', (s) => {
      signal = s;
      return new Promise(() => undefined);
    }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toEqual(new Error('Email send timed out after 1000 ms'));
    expect(signal?.aborted).toBe(true);
  });

  it('aborts the signal when the caller cancels', async () => {
    const cancel = new AbortController();
    let signal: AbortSignal | undefined;
    const pending = withTimeout(
      1000,
      'Send',
      (s) => {
        signal = s;
        return new Promise((_, reject) =>
          s.addEventListener('abort', () => reject(new Error('x')))
        );
      },
      cancel.signal
    ).catch((e: unknown) => e);

    cancel.abort();
    await pending;

    expect(signal?.aborted).toBe(true);
  });

  it('hands run an aborted signal when the caller had already cancelled', async () => {
    const cancel = new AbortController();
    cancel.abort();
    let signal: AbortSignal | undefined;

    await withTimeout(
      1000,
      'Send',
      async (s) => {
        signal = s;
        return 'x';
      },
      cancel.signal
    );

    // A listener added after the abort never fires, so this is checked up front.
    expect(signal?.aborted).toBe(true);
  });
});
