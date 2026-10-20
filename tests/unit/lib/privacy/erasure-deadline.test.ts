/**
 * Unit tests for lib/privacy/erasure-deadline.ts (t-845)
 *
 * The deadline helpers bound one erasure attempt. The contract:
 *   - `checkDeadline` throws ErasureDeferredError once the deadline has passed
 *     and is a no-op without one.
 *   - `inBoundedTransaction` refuses to start past the deadline, caps the
 *     transaction (and Postgres's statements) at the time left, and turns a
 *     failure after the deadline into a deferral.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  checkDeadline,
  deferredIfLate,
  ErasureDeferredError,
  inBoundedTransaction,
  isTimeoutError,
  msLeft,
} from '@/lib/privacy/erasure-deadline';
import { boundLockWaits } from '@/lib/privacy/erased-subjects';

const NOW = new Date('2026-10-20T12:00:00.000Z');

/** A deadline `ms` after the (faked) current time. */
function deadlineIn(ms: number): Date {
  return new Date(Date.now() + ms);
}

type TxCallback = (tx: Prisma.TransactionClient) => Promise<unknown>;

/** A client whose `$transaction` runs the callback with a fake tx. */
function makeClient() {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };
  const $transaction = vi.fn(async (callback: TxCallback, _options?: unknown) =>
    callback(tx as unknown as Prisma.TransactionClient)
  );
  const client = { $transaction } as unknown as Pick<PrismaClient, '$transaction'>;
  return { tx, $transaction, client };
}

/** The SQL text and bound values of a tagged-template `$executeRaw` call. */
function sqlOf(call: unknown[]): { text: string; values: unknown[] } {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return { text: strings.join('?'), values };
}

describe('erasure-deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('ErasureDeferredError', () => {
    it('names the stage in its message and keeps it on `stage`', () => {
      const error = new ErasureDeferredError('the run pre-pass');

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('ErasureDeferredError');
      expect(error.stage).toBe('the run pre-pass');
      expect(error.message).toBe('Erasure ran out of time before the run pre-pass');
    });

    it('carries the underlying failure as `cause`', () => {
      const cause = new Error('statement timeout');

      expect(new ErasureDeferredError('x', { cause }).cause).toBe(cause);
    });
  });

  describe('msLeft', () => {
    it('returns the milliseconds until the deadline', () => {
      expect(msLeft(deadlineIn(1_500))).toBe(1_500);
    });

    it('never goes negative once the deadline has passed', () => {
      expect(msLeft(deadlineIn(-5_000))).toBe(0);
    });
  });

  describe('checkDeadline', () => {
    it('throws a deferral naming the stage once the deadline has passed', () => {
      expect(() => checkDeadline(deadlineIn(-1), 'the avatars')).toThrow(ErasureDeferredError);
      expect(() => checkDeadline(deadlineIn(-1), 'the avatars')).toThrow(/the avatars/);
    });

    it('throws at the exact deadline, when no time is left', () => {
      expect(() => checkDeadline(deadlineIn(0), 'a hook')).toThrow(ErasureDeferredError);
    });

    it('does nothing while time remains', () => {
      expect(() => checkDeadline(deadlineIn(1), 'a hook')).not.toThrow();
    });

    it('does nothing without a deadline', () => {
      expect(() => checkDeadline(undefined, 'a hook')).not.toThrow();
    });
  });

  describe('boundLockWaits with statementsToo', () => {
    it('sets statement_timeout and lock_timeout, transaction-locally, to the same millisecond value', async () => {
      const { tx } = makeClient();

      await boundLockWaits(tx, 2_500, { statementsToo: true });

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      const { text, values } = sqlOf(tx.$executeRaw.mock.calls[0]);
      expect(text).toContain("set_config('statement_timeout'");
      expect(text).toContain("set_config('lock_timeout'");
      // `true` as the third argument makes each setting local to the transaction.
      expect(text.match(/, \?, true\)/g)).toHaveLength(2);
      expect(values).toEqual(['2500ms', '2500ms']);
    });

    it('rounds a fractional budget down and never sends a zero (Postgres reads 0 as no limit)', async () => {
      const { tx } = makeClient();

      await boundLockWaits(tx, 0, { statementsToo: true });
      await boundLockWaits(tx, 99.9, { statementsToo: true });

      expect(sqlOf(tx.$executeRaw.mock.calls[0]).values).toEqual(['1ms', '1ms']);
      expect(sqlOf(tx.$executeRaw.mock.calls[1]).values).toEqual(['99ms', '99ms']);
    });
  });

  describe('deferredIfLate', () => {
    it('returns an existing deferral unchanged, not wrapped again', () => {
      const deferral = new ErasureDeferredError('first');

      expect(deferredIfLate(deferral, deadlineIn(-1), 'second')).toBe(deferral);
    });

    it('wraps a failure after the deadline in a deferral that keeps it as the cause', () => {
      const failure = new Error('canceling statement due to statement timeout');

      const result = deferredIfLate(failure, deadlineIn(-1), 'the erasure transaction');

      expect(result).toBeInstanceOf(ErasureDeferredError);
      expect((result as ErasureDeferredError).stage).toBe('the erasure transaction');
      expect((result as ErasureDeferredError).cause).toBe(failure);
    });

    it('returns a failure after the deadline as it was when it is not a timeout', () => {
      // A real failure that happens to surface late is still a failure: it is
      // logged as one and backed off, not retried at once for ever.
      const failure = new Error('insert or update violates foreign key constraint');

      expect(deferredIfLate(failure, deadlineIn(-1), 'the erasure transaction')).toBe(failure);
    });

    it('returns a failure before the deadline as it was', () => {
      const failure = new Error('constraint violated');

      expect(deferredIfLate(failure, deadlineIn(10_000), 'x')).toBe(failure);
    });

    it('returns a failure as it was when there is no deadline', () => {
      const failure = new Error('constraint violated');

      expect(deferredIfLate(failure, undefined, 'x')).toBe(failure);
    });
  });

  describe('isTimeoutError', () => {
    /** A Prisma known-request error as Prisma 7's pg adapter raises it. */
    function prismaError(code: string, meta?: Record<string, unknown>) {
      return new Prisma.PrismaClientKnownRequestError('failed', {
        code,
        clientVersion: '7.10.0',
        meta,
      });
    }
    /** A raw query's Postgres error, carried in the adapter's meta. */
    function postgresError(sqlState: string) {
      return prismaError('P2010', {
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { originalCode: sqlState, kind: 'postgres', code: sqlState },
        },
      });
    }

    it.each([
      ['a statement timeout (57014)', postgresError('57014')],
      ['a lock timeout (55P03)', postgresError('55P03')],
      ["Prisma's transaction timeout (P2028)", prismaError('P2028')],
      ["Prisma's pool timeout (P2024)", prismaError('P2024')],
      ['an error in Postgres’s own words', new Error('canceling statement due to lock timeout')],
    ])('is true for %s', (_label, error) => {
      expect(isTimeoutError(error)).toBe(true);
    });

    it.each([
      ['a foreign-key violation (23503)', postgresError('23503')],
      ['a unique violation (P2002)', prismaError('P2002')],
      ['a plain error', new Error('constraint violated')],
      ['a non-error', 'timeout'],
    ])('is false for %s', (_label, error) => {
      expect(isTimeoutError(error)).toBe(false);
    });
  });

  describe('inBoundedTransaction', () => {
    it('throws a deferral without opening a transaction when no time is left', async () => {
      const { $transaction, client } = makeClient();
      const fn = vi.fn();

      await expect(inBoundedTransaction(client, deadlineIn(-1), 'a page', fn)).rejects.toThrow(
        ErasureDeferredError
      );

      expect($transaction).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    });

    it('caps the transaction timeout at the time left, and waits at most 2s for a connection', async () => {
      const { $transaction, client } = makeClient();

      await inBoundedTransaction(client, deadlineIn(8_000), 'a page', async () => 'ok');

      expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 8_000,
        maxWait: 2_000,
      });
    });

    it('bounds the statements by the time left once it has a connection, not before', async () => {
      // Prisma's timeout starts after the connection wait; a bound taken
      // before it would let the work run past the deadline.
      const { $transaction, client, tx } = makeClient();
      const run = $transaction.getMockImplementation();
      $transaction.mockImplementation(async (callback, options) => {
        vi.setSystemTime(Date.now() + 1_500);
        return run!(callback, options);
      });

      await inBoundedTransaction(client, deadlineIn(8_000), 'a page', async () => 'ok');

      expect(sqlOf(tx.$executeRaw.mock.calls[0]).values).toEqual(['6500ms', '6500ms']);
    });

    it('lets the connection wait be shorter than 2s when less time than that is left', async () => {
      const { $transaction, client } = makeClient();

      await inBoundedTransaction(client, deadlineIn(700), 'a page', async () => 'ok');

      expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 700,
        maxWait: 700,
      });
    });

    it('caps at capMs when that is shorter than the time left', async () => {
      const { $transaction, client } = makeClient();

      await inBoundedTransaction(client, deadlineIn(60_000), 'a page', async () => 'ok', 15_000);

      expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 15_000,
        maxWait: 2_000,
      });
    });

    it('does not let capMs lengthen the time past the deadline', async () => {
      const { $transaction, client } = makeClient();

      await inBoundedTransaction(client, deadlineIn(3_000), 'a page', async () => 'ok', 15_000);

      expect($transaction.mock.calls[0][1]).toEqual({ timeout: 3_000, maxWait: 2_000 });
    });

    it('bounds the statements inside the transaction to the same cap, before running fn', async () => {
      const { tx, client } = makeClient();
      const order: string[] = [];
      tx.$executeRaw.mockImplementation(async () => {
        order.push('bound');
        return 1;
      });

      await inBoundedTransaction(client, deadlineIn(4_000), 'a page', async () => {
        order.push('fn');
      });

      expect(order).toEqual(['bound', 'fn']);
      expect(sqlOf(tx.$executeRaw.mock.calls[0]).values).toEqual(['4000ms', '4000ms']);
    });

    it('hands fn the transaction client and returns what it returns', async () => {
      const { tx, client } = makeClient();
      const fn = vi.fn(async (t: Prisma.TransactionClient) => ({ got: t }));

      const result = await inBoundedTransaction(client, deadlineIn(5_000), 'a page', fn);

      expect(fn).toHaveBeenCalledWith(tx);
      expect(result).toEqual({ got: tx });
    });

    it('turns a failure into a deferral when the deadline passed while it ran', async () => {
      const { $transaction, client } = makeClient();
      const failure = new Error('canceling statement due to statement timeout');
      $transaction.mockImplementation(async () => {
        vi.setSystemTime(new Date(NOW.getTime() + 6_000));
        throw failure;
      });

      const error = await inBoundedTransaction(
        client,
        deadlineIn(5_000),
        'the run pre-pass',
        vi.fn()
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ErasureDeferredError);
      expect((error as ErasureDeferredError).stage).toBe('the run pre-pass');
      expect((error as ErasureDeferredError).cause).toBe(failure);
    });

    it('rethrows a failure unchanged while time remains', async () => {
      const { $transaction, client } = makeClient();
      const failure = new Error('deadlock detected');
      $transaction.mockRejectedValue(failure);

      await expect(inBoundedTransaction(client, deadlineIn(5_000), 'a page', vi.fn())).rejects.toBe(
        failure
      );
    });
  });
});
