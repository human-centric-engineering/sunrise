/**
 * Unit tests: refusing to write an erased person back into configuration (t-805).
 *
 * The transaction client is a mock: these tests prove which locks are taken and
 * in what order, which receipt and user queries are made, and how the answers
 * are turned into "erased" / "not erased". Whether the advisory locks really
 * serialise an erasure against a writer is a Postgres property, not testable here.
 *
 * @see lib/privacy/erased-subjects.ts
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Prisma } from '@prisma/client';

import { ValidationError } from '@/lib/api/errors';
import {
  ERASED_SUBJECT_MESSAGE,
  findErasedSubjects,
  lockSubjects,
  matchErasedSubjects,
  refuseErasedSubjects,
  stringsIn,
  subjectEmailHash,
  SUBJECT_LOCK_WAIT_MS,
  SubjectLocksBusyError,
  tryLockSubjects,
  waitForSubjectLocks,
  WRITER_TRANSACTION_OPTIONS,
} from '@/lib/privacy/erased-subjects';

type Receipt = {
  subjectUserId: string;
  subjectEmailHash: string | null;
  metadata: Prisma.JsonValue;
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

type TxClient = Parameters<typeof findErasedSubjects>[0];

function makeTx() {
  const executeRaw = vi.fn().mockResolvedValue(1);
  const receiptFindMany = vi.fn<(args: unknown) => Promise<Receipt[]>>().mockResolvedValue([]);
  const userFindMany = vi
    .fn<(args: unknown) => Promise<Array<{ email: string }>>>()
    .mockResolvedValue([]);
  const tx = {
    $executeRaw: executeRaw,
    dataErasureReceipt: { findMany: receiptFindMany },
    user: { findMany: userFindMany },
  };
  // Only the delegate methods the module calls are stubbed; the cast is the
  // test double's one concession to the full Prisma client type.
  return { tx: tx as unknown as TxClient, executeRaw, receiptFindMany, userFindMany };
}

/** The key each `$executeRaw` tagged-template call was given (its one interpolation). */
/** The key each lock statement took, in the order they were taken. */
function lockedKeys(executeRaw: ReturnType<typeof vi.fn>): unknown[] {
  return executeRaw.mock.calls.map((call) => call[1]);
}

describe('subjectEmailHash', () => {
  it('is the sha256 of the trimmed, lower-cased address', () => {
    expect(subjectEmailHash('  Foo@BAR.com ')).toBe(sha256Hex('foo@bar.com'));
  });
});

describe('lockSubjects', () => {
  it('takes one lock per distinct normalised key, in sorted order, so writers cannot deadlock', async () => {
    const { tx, executeRaw } = makeTx();

    await lockSubjects(tx, {
      addresses: ['Zed@Example.com', ' zed@example.com', 'alpha@example.com'],
      userIds: ['user-b', 'user-a', 'user-a'],
    });

    expect(lockedKeys(executeRaw)).toEqual([
      'sunrise:erased-address:alpha@example.com',
      'sunrise:erased-address:zed@example.com',
      'sunrise:erased-user:user-a',
      'sunrise:erased-user:user-b',
    ]);
    // One statement per key, taken in JS-sorted order: an outer target list
    // is not guaranteed to follow a subquery's ORDER BY (review round 3).
    expect(executeRaw).toHaveBeenCalledTimes(4);
    const sql = (executeRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('pg_advisory_xact_lock');
  });

  it('locks an address however much whitespace surrounds it (review round 1)', async () => {
    const { tx, executeRaw } = makeTx();

    await lockSubjects(tx, { addresses: ['        a@b.co'] });

    expect(lockedKeys(executeRaw)).toEqual(['sunrise:erased-address:a@b.co']);
  });

  it('takes no lock for empty input', async () => {
    const { tx, executeRaw } = makeTx();

    await lockSubjects(tx, {});
    await lockSubjects(tx, { addresses: [], userIds: [] });

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('does not lock strings that are not addresses', async () => {
    const { tx, executeRaw } = makeTx();

    await lockSubjects(tx, { addresses: ['{{input.email}}', 'no-at-sign', '@x', 'x@'] });

    expect(executeRaw).not.toHaveBeenCalled();
  });
});

describe('tryLockSubjects (t-840)', () => {
  function makeTryTx(answers: boolean[]) {
    const queryRaw = vi.fn(async (_strings: TemplateStringsArray, _key: string) => [
      { locked: answers.shift() ?? true },
    ]);
    return {
      tx: { $queryRaw: queryRaw } as unknown as Parameters<typeof tryLockSubjects>[0],
      queryRaw,
    };
  }

  it('tries every key, sorted, with the non-waiting lock, and says true when it got them all', async () => {
    const { tx, queryRaw } = makeTryTx([true, true]);

    await expect(
      tryLockSubjects(tx, { addresses: [' Gone@Example.com '], userIds: ['user-1'] })
    ).resolves.toBe(true);

    expect(queryRaw.mock.calls.map((call) => call[1])).toEqual([
      'sunrise:erased-address:gone@example.com',
      'sunrise:erased-user:user-1',
    ]);
    expect(queryRaw.mock.calls[0][0].join('?')).toContain('pg_try_advisory_xact_lock');
  });

  it('stops at the first key someone else holds and says false', async () => {
    const { tx, queryRaw } = makeTryTx([false, true]);

    await expect(
      tryLockSubjects(tx, { addresses: ['gone@example.com'], userIds: ['user-1'] })
    ).resolves.toBe(false);

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reads a missing row as not locked', async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as Parameters<typeof tryLockSubjects>[0];

    await expect(tryLockSubjects(tx, { userIds: ['user-1'] })).resolves.toBe(false);
  });
});

describe('waitForSubjectLocks (t-840)', () => {
  it('waits for each key in a transaction of its own, so none is held while it waits for the next', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const opened: Array<{ timeout: number; statements: string[] }> = [];
    const $transaction = vi.fn(
      async (
        callback: (client: { $executeRaw: typeof executeRaw }) => Promise<unknown>,
        options: { timeout: number }
      ) => {
        const before = executeRaw.mock.calls.length;
        await callback({ $executeRaw: executeRaw });
        opened.push({
          timeout: options.timeout,
          statements: executeRaw.mock.calls
            .slice(before)
            .map((call) => `${(call[0] as string[]).join('?').trim()} | ${String(call[1])}`),
        });
      }
    );
    const client = { $transaction } as unknown as Parameters<typeof waitForSubjectLocks>[0];

    await waitForSubjectLocks(client, { addresses: [' Gone@Example.com '], userIds: ['user-1'] });

    const lockTimeout = `SELECT set_config('lock_timeout', ?, true) | ${SUBJECT_LOCK_WAIT_MS}ms`;
    expect(opened.map((t) => t.statements)).toEqual([
      [
        lockTimeout,
        'SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) | sunrise:erased-address:gone@example.com',
      ],
      [
        lockTimeout,
        'SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) | sunrise:erased-user:user-1',
      ],
    ]);
    // Postgres's lock_timeout bounds the wait, inside Prisma's own timeout,
    // which does not cancel a statement already waiting (review round 2).
    for (const t of opened) expect(t.timeout).toBeGreaterThan(SUBJECT_LOCK_WAIT_MS);
  });

  it('propagates a failed wait to the caller', async () => {
    const $transaction = vi.fn().mockRejectedValue(new Error('Transaction already closed'));
    const client = { $transaction } as unknown as Parameters<typeof waitForSubjectLocks>[0];

    await expect(waitForSubjectLocks(client, { userIds: ['user-1'] })).rejects.toThrow(
      'Transaction already closed'
    );
  });
});

describe('waitForSubjectLocks with maxWaitMs (t-845)', () => {
  const NOW = new Date('2026-10-20T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A client that records, per transaction, the Prisma timeout and the
   * `lock_timeout` it set, and moves the clock on by `takes[i]` ms as the
   * i-th wait "waits".
   */
  function makeWaitingClient(takes: number[] = []) {
    const opened: Array<{ timeout: number; lockTimeout: unknown; key: unknown }> = [];
    const $transaction = vi.fn(
      async (
        callback: (client: { $executeRaw: ReturnType<typeof vi.fn> }) => Promise<unknown>,
        options: { timeout: number }
      ) => {
        const entry: { timeout: number; lockTimeout: unknown; key: unknown } = {
          timeout: options.timeout,
          lockTimeout: undefined,
          key: undefined,
        };
        const executeRaw = vi.fn(async (strings: TemplateStringsArray, value: unknown) => {
          if (strings.join('?').includes('lock_timeout')) entry.lockTimeout = value;
          else entry.key = value;
          return 1;
        });
        opened.push(entry);
        await callback({ $executeRaw: executeRaw });
        vi.setSystemTime(Date.now() + (takes[opened.length - 1] ?? 0));
      }
    );
    const client = { $transaction } as unknown as Parameters<typeof waitForSubjectLocks>[0];
    return { client, opened, $transaction };
  }

  const TWO_LOCKS = { addresses: ['gone@example.com'], userIds: ['user-1'] };

  it('caps the wait for a lock at the time given, and Prisma’s timeout just above it', async () => {
    const { client, opened } = makeWaitingClient();

    await waitForSubjectLocks(client, { userIds: ['user-1'] }, { maxWaitMs: 10_000 });

    expect(opened).toEqual([
      { timeout: 10_000 + 5_000, lockTimeout: '10000ms', key: 'sunrise:erased-user:user-1' },
    ]);
  });

  it('caps the lock wait at the time left once it has a connection, not before', async () => {
    const { client, opened, $transaction } = makeWaitingClient();
    const run = $transaction.getMockImplementation();
    $transaction.mockImplementation(async (callback, options) => {
      // Waiting 1.5s for a connection.
      vi.setSystemTime(Date.now() + 1_500);
      return run!(callback, options);
    });

    await waitForSubjectLocks(client, { userIds: ['user-1'] }, { maxWaitMs: 10_000 });

    expect(opened[0].lockTimeout).toBe('8500ms');
  });

  it('takes no lock when the connection wait used up the time', async () => {
    const { client, opened, $transaction } = makeWaitingClient();
    const run = $transaction.getMockImplementation();
    $transaction.mockImplementation(async (callback, options) => {
      vi.setSystemTime(Date.now() + 10_000);
      return run!(callback, options);
    });

    await waitForSubjectLocks(client, { userIds: ['user-1'] }, { maxWaitMs: 10_000 });

    // Neither a bound of 0 (no limit at all) nor the lock itself.
    expect(opened[0].lockTimeout).toBeUndefined();
    expect(opened[0].key).toBeUndefined();
  });

  it('never waits longer than the per-lock wait, however much time is given', async () => {
    const { client, opened } = makeWaitingClient();

    await waitForSubjectLocks(
      client,
      { userIds: ['user-1'] },
      { maxWaitMs: SUBJECT_LOCK_WAIT_MS * 10 }
    );

    expect(opened[0].lockTimeout).toBe(`${SUBJECT_LOCK_WAIT_MS}ms`);
    expect(opened[0].timeout).toBe(SUBJECT_LOCK_WAIT_MS + 5_000);
  });

  it('shares the time across the locks: the next lock gets what the earlier ones left', async () => {
    // The first wait takes 7s of the 10s.
    const { client, opened } = makeWaitingClient([7_000]);

    await waitForSubjectLocks(client, TWO_LOCKS, { maxWaitMs: 10_000 });

    expect(opened.map((o) => o.lockTimeout)).toEqual(['10000ms', '3000ms']);
    expect(opened.map((o) => o.key)).toEqual([
      'sunrise:erased-address:gone@example.com',
      'sunrise:erased-user:user-1',
    ]);
  });

  it('returns early, without waiting for the locks left, once the time is spent', async () => {
    // The first wait takes all of the time.
    const { client, opened, $transaction } = makeWaitingClient([10_000]);

    await expect(
      waitForSubjectLocks(client, TWO_LOCKS, { maxWaitMs: 10_000 })
    ).resolves.toBeUndefined();

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(opened.map((o) => o.key)).toEqual(['sunrise:erased-address:gone@example.com']);
  });

  it('opens no transaction at all when given no time', async () => {
    const { client, $transaction } = makeWaitingClient();

    await waitForSubjectLocks(client, TWO_LOCKS, { maxWaitMs: 0 });

    expect($transaction).not.toHaveBeenCalled();
  });

  it('without maxWaitMs, still waits the full per-lock wait for every lock', async () => {
    const { client, opened } = makeWaitingClient([SUBJECT_LOCK_WAIT_MS, SUBJECT_LOCK_WAIT_MS]);

    await waitForSubjectLocks(client, TWO_LOCKS);

    expect(opened.map((o) => o.lockTimeout)).toEqual([
      `${SUBJECT_LOCK_WAIT_MS}ms`,
      `${SUBJECT_LOCK_WAIT_MS}ms`,
    ]);
  });
});

describe('SubjectLocksBusyError', () => {
  it('carries the subjects to wait for', () => {
    const subjects = { addresses: ['gone@example.com'], userIds: ['user-1'] };
    const error = new SubjectLocksBusyError(subjects);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SubjectLocksBusyError');
    expect(error.subjects).toBe(subjects);
  });
});

describe('findErasedSubjects', () => {
  let ctx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    ctx = makeTx();
  });

  it('returns a user id that has a receipt, and asks by subjectUserId', async () => {
    ctx.receiptFindMany.mockResolvedValue([
      { subjectUserId: 'gone-user', subjectEmailHash: null, metadata: null },
    ]);

    const result = await findErasedSubjects(ctx.tx, { userIds: ['gone-user', 'live-user'] });

    expect(result).toEqual({ addresses: [], userIds: ['gone-user'] });
    expect(ctx.receiptFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ subjectUserId: { in: ['gone-user', 'live-user'] } }] },
      })
    );
  });

  it('takes the locks before it reads the receipts', async () => {
    const order: string[] = [];
    ctx.executeRaw.mockImplementation(async () => {
      order.push('lock');
      return 1;
    });
    ctx.receiptFindMany.mockImplementation(async () => {
      order.push('read');
      return [];
    });

    await findErasedSubjects(ctx.tx, { addresses: ['a@example.com'], userIds: ['u1'] });

    expect(order).toEqual(['lock', 'lock', 'read']);
  });

  it('returns an address whose receipt says it was verified, spelled as normalised', async () => {
    ctx.receiptFindMany.mockResolvedValue([
      {
        subjectUserId: 'gone',
        subjectEmailHash: sha256Hex('gone@example.com'),
        metadata: { addressVerified: true },
      },
    ]);

    const result = await findErasedSubjects(ctx.tx, { addresses: ['  Gone@Example.com '] });

    expect(result).toEqual({ addresses: ['gone@example.com'], userIds: [] });
    expect(ctx.receiptFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ subjectEmailHash: { in: [sha256Hex('gone@example.com')] } }] },
      })
    );
  });

  it.each([
    ['addressVerified is false', { addressVerified: false }],
    ['the receipt has no metadata (written before t-805)', null],
    ['the metadata has no addressVerified key', { other: true }],
    ['addressVerified is not boolean true', { addressVerified: 'true' }],
    ['the metadata is an array', [true]],
  ])('does not count an address when %s', async (_label, metadata) => {
    ctx.receiptFindMany.mockResolvedValue([
      {
        subjectUserId: 'gone',
        subjectEmailHash: sha256Hex('gone@example.com'),
        metadata: metadata,
      },
    ]);

    const result = await findErasedSubjects(ctx.tx, { addresses: ['gone@example.com'] });

    expect(result).toEqual({ addresses: [], userIds: [] });
    expect(ctx.userFindMany).not.toHaveBeenCalled();
  });

  it('drops an address a live verified user now holds, matching case-insensitively', async () => {
    ctx.receiptFindMany.mockResolvedValue([
      {
        subjectUserId: 'gone',
        subjectEmailHash: sha256Hex('back@example.com'),
        metadata: { addressVerified: true },
      },
    ]);
    ctx.userFindMany.mockResolvedValue([{ email: 'Back@Example.COM' }]);

    const result = await findErasedSubjects(ctx.tx, { addresses: ['back@example.com'] });

    expect(result).toEqual({ addresses: [], userIds: [] });
    expect(ctx.userFindMany).toHaveBeenCalledWith({
      where: {
        emailVerified: true,
        email: { in: ['back@example.com'], mode: 'insensitive' },
      },
      select: { email: true },
    });
  });

  it('ignores template strings and non-addresses: no lock and no receipt query', async () => {
    const result = await findErasedSubjects(ctx.tx, {
      addresses: ['{{input.email}}', 'Hello world', '', 'a{{x}}@b.com'],
      userIds: [''],
    });

    expect(result).toEqual({ addresses: [], userIds: [] });
    expect(ctx.executeRaw).not.toHaveBeenCalled();
    expect(ctx.receiptFindMany).not.toHaveBeenCalled();
  });
});

describe('matchErasedSubjects (t-843)', () => {
  it('matches as findErasedSubjects does, without taking a lock', async () => {
    const ctx = makeTx();
    ctx.receiptFindMany.mockResolvedValue([
      { subjectUserId: 'gone-user', subjectEmailHash: null, metadata: null },
      {
        subjectUserId: 'other',
        subjectEmailHash: sha256Hex('gone@example.com'),
        metadata: { addressVerified: true },
      },
    ]);

    const result = await matchErasedSubjects(ctx.tx, {
      addresses: [' Gone@Example.com '],
      userIds: ['gone-user'],
    });

    expect(result).toEqual({ addresses: ['gone@example.com'], userIds: ['gone-user'] });
    expect(ctx.executeRaw).not.toHaveBeenCalled();
  });
});

describe('refuseErasedSubjects', () => {
  it('throws a ValidationError keyed by the field when a user id was erased', async () => {
    const { tx, receiptFindMany } = makeTx();
    receiptFindMany.mockResolvedValue([
      { subjectUserId: 'gone-user', subjectEmailHash: null, metadata: null },
    ]);

    const error = await refuseErasedSubjects(
      tx,
      { userIds: ['gone-user'] },
      'approverUserIds'
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).status).toBe(400);
    expect((error as ValidationError).details).toEqual({
      approverUserIds: [ERASED_SUBJECT_MESSAGE],
    });
  });

  it('throws when an erased verified address is named', async () => {
    const { tx, receiptFindMany } = makeTx();
    receiptFindMany.mockResolvedValue([
      {
        subjectUserId: 'gone',
        subjectEmailHash: sha256Hex('gone@example.com'),
        metadata: { addressVerified: true },
      },
    ]);

    await expect(
      refuseErasedSubjects(tx, { addresses: ['Gone@example.com'] }, 'emailAddress')
    ).rejects.toMatchObject({ details: { emailAddress: [ERASED_SUBJECT_MESSAGE] } });
  });

  it('resolves when nothing named is erased', async () => {
    const { tx, receiptFindMany } = makeTx();

    await expect(
      refuseErasedSubjects(tx, { addresses: ['fine@example.com'], userIds: ['u1'] }, 'f')
    ).resolves.toBeUndefined();
    expect(receiptFindMany).toHaveBeenCalledTimes(1);
  });
});

describe('stringsIn', () => {
  it('collects every string in nested objects and arrays, skipping other types', () => {
    expect(
      stringsIn({
        a: 'one',
        b: ['two', { c: 'three', d: 4 }],
        e: null,
        f: true,
        g: { h: ['four'] },
      })
    ).toEqual(['one', 'two', 'three', 'four']);
  });

  it('wraps a bare string and returns nothing for a number or null', () => {
    expect(stringsIn('x')).toEqual(['x']);
    expect(stringsIn(1)).toEqual([]);
    expect(stringsIn(null)).toEqual([]);
  });
});

describe('WRITER_TRANSACTION_OPTIONS', () => {
  it('outlasts the erasure transaction a writer may queue behind', () => {
    // Read from the source rather than imported: erase-user pulls in the
    // whole erasure graph, and only its constant matters here.
    const source = readFileSync('lib/privacy/erase-user.ts', 'utf8');
    const match = /export const ERASURE_TRANSACTION_TIMEOUT_MS = ([\d_]+);/.exec(source);
    expect(match).not.toBeNull();
    const erasureMs = Number((match?.[1] ?? '').replace(/_/g, ''));
    expect(erasureMs).toBeGreaterThan(0);
    expect(WRITER_TRANSACTION_OPTIONS.timeout).toBeGreaterThan(erasureMs);
  });
});
