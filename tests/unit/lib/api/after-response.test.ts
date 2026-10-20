/**
 * Tests for `lib/api/after-response.ts` (t-846).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAfter = vi.hoisted(() => vi.fn());
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mockAfter,
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { keepRunningAfterResponse } from '@/lib/api/after-response';
import { logger } from '@/lib/logging';

/** What Next throws when `after()` runs with no request scope. */
const OUTSIDE_REQUEST = new Error(
  '`after` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context'
);

function deferred(): {
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockAfter.mockImplementation(() => undefined);
});

describe('keepRunningAfterResponse', () => {
  it('hands after() a promise that settles only when the task does', async () => {
    const task = deferred();

    keepRunningAfterResponse(task.promise, 'test');

    expect(mockAfter).toHaveBeenCalledTimes(1);
    const handed = mockAfter.mock.calls[0]?.[0] as Promise<unknown>;
    let settled = false;
    void handed.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    task.resolve('done');
    await handed;
    expect(settled).toBe(true);
  });

  it('logs a rejection under its label, and the promise after() holds still resolves', async () => {
    const task = deferred();
    const failure = new Error('engine blew up');

    keepRunningAfterResponse(task.promise, 'Inbound: drain', { executionId: 'exec_1' });
    const handed = mockAfter.mock.calls[0]?.[0] as Promise<unknown>;
    task.reject(failure);

    await expect(handed).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Inbound: drain failed', failure, {
      executionId: 'exec_1',
    });
  });

  it('outside a request (the dev ticker), lets the task run on and says nothing', async () => {
    mockAfter.mockImplementation(() => {
      throw OUTSIDE_REQUEST;
    });
    const task = deferred();
    let ran = false;
    void task.promise.then(() => {
      ran = true;
    });

    expect(() => keepRunningAfterResponse(task.promise, 'test')).not.toThrow();
    task.resolve('done');
    await flush();

    expect(ran).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('recognises no request scope by Next’s error code, whatever the wording', () => {
    mockAfter.mockImplementation(() => {
      throw Object.assign(new Error('reworded in a later Next release'), {
        __NEXT_ERROR_CODE: 'E468',
      });
    });

    keepRunningAfterResponse(Promise.resolve(), 'test');

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a coded Next error other than E468 is a real refusal, even if its text matches', () => {
    mockAfter.mockImplementation(() => {
      throw Object.assign(new Error('something outside a request scope'), {
        __NEXT_ERROR_CODE: 'E1376',
      });
    });

    keepRunningAfterResponse(Promise.resolve(), 'test');

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warns when after() refuses for any other reason, and still does not throw', () => {
    mockAfter.mockImplementation(() => {
      throw new Error('`waitUntil` is not available in the current environment.');
    });

    expect(() =>
      keepRunningAfterResponse(Promise.resolve(), 'test', { executionId: 'x' })
    ).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      'test: could not keep background work alive after the response',
      { executionId: 'x', error: '`waitUntil` is not available in the current environment.' }
    );
  });

  it('a task that rejects outside a request is still logged, not left unhandled', async () => {
    mockAfter.mockImplementation(() => {
      throw OUTSIDE_REQUEST;
    });
    const failure = new Error('boom');

    keepRunningAfterResponse(Promise.reject(failure), 'test');
    await flush();

    expect(logger.error).toHaveBeenCalledWith('test failed', failure, {});
  });
});
