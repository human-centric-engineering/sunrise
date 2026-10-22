/**
 * Unit tests: reading and writing a run under its row lock (§122 t-901).
 *
 * The transaction is a mock: these prove the lock statement and that it comes
 * before anything the caller reads. That the lock orders an action against an
 * erasure is Postgres's, proved by `scripts/smoke/erasure-run-actions.ts`.
 *
 * @see lib/orchestration/engine/run-row-lock.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const tx = vi.hoisted(() => ({ $queryRaw: vi.fn() }));
const prismaMock = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

import { Prisma } from '@prisma/client';
import {
  RUN_BUSY_MESSAGE,
  RUN_ROW_WRITE_OPTIONS,
  lockRunRow,
  withRunRowLocked,
} from '@/lib/orchestration/engine/run-row-lock';
import { ConflictError } from '@/lib/api/errors';
import { WRITER_TRANSACTION_OPTIONS } from '@/lib/privacy/erased-subjects';

beforeEach(() => {
  vi.clearAllMocks();
  tx.$queryRaw.mockResolvedValue([]);
  prismaMock.$transaction.mockImplementation((run: (client: typeof tx) => Promise<unknown>) =>
    run(tx)
  );
});

describe('lockRunRow', () => {
  it('takes the run’s row lock FOR NO KEY UPDATE, as erasure and the engine do', async () => {
    await lockRunRow(tx as never, 'exec-1');

    const [strings, id] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(strings.join('?')).toBe(
      'SELECT id FROM ai_workflow_execution WHERE id = ? FOR NO KEY UPDATE'
    );
    expect(id).toBe('exec-1');
  });
});

describe('withRunRowLocked', () => {
  it('locks the row before the caller reads anything, and returns what the caller returns', async () => {
    const order: string[] = [];
    tx.$queryRaw.mockImplementation(async () => {
      order.push('lock');
      return [];
    });

    const result = await withRunRowLocked('exec-1', async () => {
      order.push('read and write');
      return 'done';
    });

    expect(result).toBe('done');
    expect(order).toEqual(['lock', 'read and write']);
  });

  it('waits as long as an erasure may hold the row, and for a connection', async () => {
    await withRunRowLocked('exec-1', async () => undefined);

    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      RUN_ROW_WRITE_OPTIONS
    );
    expect(RUN_ROW_WRITE_OPTIONS).toEqual({ ...WRITER_TRANSACTION_OPTIONS, maxWait: 10_000 });
  });

  it('propagates what the caller throws, so its transaction rolls back', async () => {
    await expect(
      withRunRowLocked('exec-1', async () => {
        throw new Error('refused');
      })
    ).rejects.toThrow('refused');
  });

  it('answers a wait past its bound as a 409 saying nothing changed, not a bare 500', async () => {
    // A failure the plain writes this replaced did not have: an erasure can
    // hold the row for its 60 s, or the pool be slow (code review).
    prismaMock.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Transaction already closed', {
        code: 'P2028',
        clientVersion: 'test',
      })
    );

    const err = await withRunRowLocked('exec-1', async () => undefined).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toBe(RUN_BUSY_MESSAGE);
  });

  it('passes any other database error through unchanged', async () => {
    const other = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prismaMock.$transaction.mockRejectedValue(other);

    await expect(withRunRowLocked('exec-1', async () => undefined)).rejects.toBe(other);
  });
});
