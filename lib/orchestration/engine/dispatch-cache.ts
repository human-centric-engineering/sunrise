/**
 * Side-effect dispatch cache.
 *
 * Risky executors (`external_call`, `send_notification`, `tool_call`) call
 * `lookupDispatch` before firing. A hit returns the cached result and the
 * executor returns it without re-firing the side effect — exactly what's
 * needed when an execution is re-driven after a crash. After a successful
 * dispatch, the executor calls `recordDispatch` to seed the cache for a
 * future re-drive.
 *
 * The unique constraint on `idempotencyKey` is the dedup gate. When two
 * hosts race on the same key (a brief window between the orphan sweep
 * claiming a row and the original host's heartbeat noticing it lost the
 * lease), `recordDispatch` returns `false` for the loser; the executor
 * treats its in-flight result as discarded and reads the winner's via
 * `lookupDispatch`. This avoids the read-then-write race that a
 * `findUnique` then `create` pattern would introduce.
 *
 * Key derivation lives in the executors (commit 2 of PR 2). The shape is
 * deterministic per attempt:
 *   - `${executionId}:${stepId}` for single-shot steps
 *   - `${executionId}:${stepId}:turn=${turnIndex}` for multi-turn steps
 * Per-attempt-index is intentionally absent: the engine's `recoveryAttempts`
 * cap means a step that throws is not retried in-place — the run is
 * re-driven from the last completed step, and a step that had no successful
 * dispatch on the prior attempt has no cache row to hit. The miss IS the
 * right behaviour.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

export interface DispatchKeyParts {
  executionId: string;
  stepId: string;
  /** Set for multi-turn step types where each turn dispatches independently. */
  turnIndex?: number;
}

/**
 * Build the deterministic idempotency key the dispatch cache is keyed on.
 * Pure function — safe to call before any DB work to log or trace the key.
 */
export function buildIdempotencyKey({ executionId, stepId, turnIndex }: DispatchKeyParts): string {
  if (turnIndex !== undefined) {
    return `${executionId}:${stepId}:turn=${turnIndex}`;
  }
  return `${executionId}:${stepId}`;
}

/**
 * Return the cached result for a previously-fired side effect, or `null`
 * when no row exists. The caller decides what shape the result takes:
 * typically the API response body, the notification provider's message id,
 * or the capability's `CapabilityResult`. We return the JSON as-is — type
 * assertion happens at the call site so the cache stays domain-agnostic.
 */
export async function lookupDispatch<T = unknown>(idempotencyKey: string): Promise<T | null> {
  const row = await prisma.aiWorkflowStepDispatch.findUnique({
    where: { idempotencyKey },
    select: { result: true },
  });
  return row ? (row.result as T) : null;
}

export interface RecordDispatchInput {
  executionId: string;
  stepId: string;
  /** Set for multi-turn step types; omit for single-shot steps. */
  turnIndex?: number;
  idempotencyKey: string;
  result: unknown;
}

/**
 * Record a successful dispatch. Returns `true` when the row was inserted,
 * `false` when another host had already recorded one for the same key
 * (P2002 — unique constraint violation on `idempotencyKey`). The caller
 * should treat `false` as "I lost the race; my in-flight result is the
 * loser" and look up the winner's via `lookupDispatch` if it needs to
 * read the cached result.
 *
 * Any other Prisma error is rethrown — the executor's outer try/catch
 * decides whether to fail the step.
 */
export async function recordDispatch({
  executionId,
  stepId,
  turnIndex,
  idempotencyKey,
  result,
}: RecordDispatchInput): Promise<boolean> {
  try {
    await prisma.aiWorkflowStepDispatch.create({
      data: {
        executionId,
        stepId,
        ...(turnIndex !== undefined ? { turnIndex } : {}),
        idempotencyKey,
        result: result as Prisma.InputJsonValue,
      },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      logger.warn('Dispatch cache: lost unique-key race; another host recorded first', {
        executionId,
        stepId,
        idempotencyKey,
      });
      return false;
    }
    throw err;
  }
}
