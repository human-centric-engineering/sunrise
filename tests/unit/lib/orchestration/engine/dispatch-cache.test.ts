/**
 * Unit tests for the dispatch-cache helpers.
 *
 * Contract under test:
 *   buildIdempotencyKey — pure function, deterministic key derivation
 *   lookupDispatch      — thin Prisma read; returns cached result or null; propagates errors
 *   recordDispatch      — Prisma write with P2002 race-loss handling; returns true/false
 *
 * Critical invariants tested here:
 *   - turnIndex === 0 (falsy but defined) MUST produce the :turn=0 suffix
 *   - recordDispatch omits `turnIndex` entirely when not provided (not undefined / null)
 *   - P2002 → false + logger.warn; any other error → rethrow, no warn
 *
 * @see lib/orchestration/engine/dispatch-cache.ts
 */

import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── module mocks ─────────────────────────────────────────────────────────────
// Must appear before any import of the modules under test.

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowStepDispatch: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── imports (after mocks) ────────────────────────────────────────────────────
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

import {
  buildIdempotencyKey,
  lookupDispatch,
  recordDispatch,
} from '@/lib/orchestration/engine/dispatch-cache';

// ─── typed mock references ────────────────────────────────────────────────────
const mockFindUnique = vi.mocked(prisma.aiWorkflowStepDispatch.findUnique);
const mockCreate = vi.mocked(prisma.aiWorkflowStepDispatch.create);
const mockLoggerWarn = vi.mocked(logger.warn);

// ─── helpers ──────────────────────────────────────────────────────────────────
/**
 * Build a real PrismaClientKnownRequestError for the given code.
 * Using the real class (not a plain object) ensures the instanceof check in
 * recordDispatch fires correctly — the same way production code works.
 */
function makePrismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Fake Prisma error: ${code}`, {
    code,
    clientVersion: '7.0.0',
  });
}

// ─── buildIdempotencyKey ──────────────────────────────────────────────────────
describe('buildIdempotencyKey', () => {
  it('produces ${executionId}:${stepId} format when turnIndex is omitted', () => {
    // Arrange
    const parts = { executionId: 'exec-abc', stepId: 'step-xyz' };

    // Act
    const key = buildIdempotencyKey(parts);

    // Assert — no turn suffix appended
    expect(key).toBe('exec-abc:step-xyz');
  });

  it('appends :turn=${turnIndex} suffix when turnIndex is provided (positive)', () => {
    // Arrange
    const parts = { executionId: 'exec-abc', stepId: 'step-xyz', turnIndex: 5 };

    // Act
    const key = buildIdempotencyKey(parts);

    // Assert
    expect(key).toBe('exec-abc:step-xyz:turn=5');
  });

  it('appends :turn=0 suffix when turnIndex === 0 (falsy but defined)', () => {
    // Arrange — turnIndex 0 is falsy; a naive `if (turnIndex)` check would skip the suffix.
    // This test guards against that specific bug.
    const parts = { executionId: 'exec-abc', stepId: 'step-xyz', turnIndex: 0 };

    // Act
    const key = buildIdempotencyKey(parts);

    // Assert — turn=0 must NOT be silently dropped
    expect(key).toBe('exec-abc:step-xyz:turn=0');
  });

  it('is a pure function — same input produces the same key on repeated calls', () => {
    // Arrange
    const parts = { executionId: 'exec-123', stepId: 'step-456', turnIndex: 3 };

    // Act
    const key1 = buildIdempotencyKey(parts);
    const key2 = buildIdempotencyKey(parts);

    // Assert — no module-level state mutation between calls
    expect(key1).toBe(key2);
    expect(key1).toBe('exec-123:step-456:turn=3');
  });
});

// ─── lookupDispatch ───────────────────────────────────────────────────────────
describe('lookupDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the cached result when findUnique returns a matching row', async () => {
    // Arrange — DB row contains a previously-recorded result
    const cachedResult = { statusCode: 200, body: { id: 'msg-1' } };
    mockFindUnique.mockResolvedValue({ result: cachedResult } as never);

    // Act
    const result = await lookupDispatch('exec-abc:step-xyz');

    // Assert — function returns the stored result, not just "something truthy"
    expect(result).toEqual(cachedResult);
  });

  it('calls findUnique with the exact where + select shape expected by the schema', async () => {
    // Arrange
    mockFindUnique.mockResolvedValue({ result: { ok: true } } as never);

    // Act
    await lookupDispatch('exec-abc:step-xyz');

    // Assert — only `result` is fetched; no extra fields in the select
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'exec-abc:step-xyz' },
      select: { result: true },
    });
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  it('returns null when findUnique returns null (cache miss)', async () => {
    // Arrange — no matching row
    mockFindUnique.mockResolvedValue(null);

    // Act
    const result = await lookupDispatch('exec-abc:step-xyz');

    // Assert
    expect(result).toBeNull();
  });

  it('propagates Prisma connection errors without swallowing them', async () => {
    // Arrange — simulate a connection failure
    const connectionError = new Error('Connection refused');
    mockFindUnique.mockRejectedValue(connectionError);

    // Act + Assert — the function must NOT swallow the error
    await expect(lookupDispatch('exec-abc:step-xyz')).rejects.toThrow('Connection refused');
  });

  it('fetches only the result field — select shape does not include extra columns', async () => {
    // This test verifies the specific select shape so that adding new fields
    // to the schema doesn't accidentally bloat the query.
    mockFindUnique.mockResolvedValue({ result: null } as never);

    await lookupDispatch('exec-abc:step-xyz');

    const callArg = mockFindUnique.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    // The select object should have exactly one key: result
    expect(Object.keys(callArg?.select ?? {})).toEqual(['result']);
  });
});

// ─── recordDispatch ───────────────────────────────────────────────────────────
describe('recordDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when the row is inserted successfully', async () => {
    // Arrange
    mockCreate.mockResolvedValue({} as never);

    // Act
    const result = await recordDispatch({
      executionId: 'exec-abc',
      stepId: 'step-xyz',
      idempotencyKey: 'exec-abc:step-xyz',
      result: { ok: true },
    });

    // Assert — success path returns true
    expect(result).toBe(true);
  });

  it('calls create with the correct data shape when turnIndex is omitted', async () => {
    // Arrange
    mockCreate.mockResolvedValue({} as never);

    // Act
    await recordDispatch({
      executionId: 'exec-abc',
      stepId: 'step-xyz',
      idempotencyKey: 'exec-abc:step-xyz',
      result: { statusCode: 200 },
    });

    // Assert — data must match the record contract; turnIndex must be absent
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        executionId: 'exec-abc',
        stepId: 'step-xyz',
        idempotencyKey: 'exec-abc:step-xyz',
        result: { statusCode: 200 },
      },
    });
  });

  it('includes turnIndex in data when it is explicitly provided', async () => {
    // Arrange
    mockCreate.mockResolvedValue({} as never);

    // Act
    await recordDispatch({
      executionId: 'exec-abc',
      stepId: 'step-xyz',
      turnIndex: 3,
      idempotencyKey: 'exec-abc:step-xyz:turn=3',
      result: { token: 'resp-xyz' },
    });

    // Assert — turnIndex is forwarded when present
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        executionId: 'exec-abc',
        stepId: 'step-xyz',
        turnIndex: 3,
        idempotencyKey: 'exec-abc:step-xyz:turn=3',
        result: { token: 'resp-xyz' },
      },
    });
  });

  it('does NOT include turnIndex field at all when turnIndex is omitted', async () => {
    // Arrange
    mockCreate.mockResolvedValue({} as never);

    // Act
    await recordDispatch({
      executionId: 'exec-abc',
      stepId: 'step-xyz',
      idempotencyKey: 'exec-abc:step-xyz',
      result: { ok: true },
    });

    // Assert — the data object passed to create must not contain turnIndex
    // (not even as undefined or null — the spread `...(turnIndex !== undefined ? { turnIndex } : {})` drops it)
    const createCallData = mockCreate.mock.calls[0]?.[0]?.data;
    expect(createCallData).not.toMatchObject({ turnIndex: expect.anything() });
    expect(Object.prototype.hasOwnProperty.call(createCallData, 'turnIndex')).toBe(false);
  });

  it('returns false and calls logger.warn when create throws a P2002 race-loss error', async () => {
    // Arrange — another host won the unique-key race
    const p2002 = makePrismaError('P2002');
    mockCreate.mockRejectedValue(p2002);

    // Act
    const result = await recordDispatch({
      executionId: 'exec-abc',
      stepId: 'step-xyz',
      idempotencyKey: 'exec-abc:step-xyz',
      result: { ok: true },
    });

    // Assert — race-loss returns false (not a throw)
    expect(result).toBe(false);

    // Assert — logger.warn must be called exactly once with the correct message and context
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Dispatch cache: lost unique-key race; another host recorded first',
      {
        executionId: 'exec-abc',
        stepId: 'step-xyz',
        idempotencyKey: 'exec-abc:step-xyz',
      }
    );
  });

  it('rethrows non-P2002 Prisma errors and does NOT call logger.warn', async () => {
    // Arrange — P2003 foreign-key violation is unrelated to dedup
    const p2003 = makePrismaError('P2003');
    mockCreate.mockRejectedValue(p2003);

    // Act + Assert — must rethrow
    await expect(
      recordDispatch({
        executionId: 'exec-abc',
        stepId: 'step-xyz',
        idempotencyKey: 'exec-abc:step-xyz',
        result: { ok: true },
      })
    ).rejects.toThrow();

    // Assert — logger.warn must NOT have been called
    expect(mockLoggerWarn).toHaveBeenCalledTimes(0);
  });

  it('rethrows generic non-Prisma errors and does NOT call logger.warn', async () => {
    // Arrange — plain Error (e.g. network timeout from a connection pool)
    const genericError = new Error('boom');
    mockCreate.mockRejectedValue(genericError);

    // Act + Assert — must rethrow the original error
    await expect(
      recordDispatch({
        executionId: 'exec-abc',
        stepId: 'step-xyz',
        idempotencyKey: 'exec-abc:step-xyz',
        result: { ok: true },
      })
    ).rejects.toThrow('boom');

    // Assert — P2002 branch was not entered; no warn logged
    expect(mockLoggerWarn).toHaveBeenCalledTimes(0);
  });
});
