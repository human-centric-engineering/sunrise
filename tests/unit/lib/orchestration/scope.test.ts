/**
 * Tests for `lib/orchestration/scope.ts`.
 *
 * `resolvePersistedScope` is the validate-on-read guard for the persisted
 * `AiWorkflow*.scope` JSON columns. It must:
 *   - return a valid flat string→string map unchanged
 *   - return undefined (never throw) for null/undefined columns
 *   - drop a malformed value to undefined AND log a warning with the caller's
 *     context, so a hand-edited row can never wedge a run
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { resolvePersistedScope } from '@/lib/orchestration/scope';
import { logger } from '@/lib/logging';

describe('resolvePersistedScope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a valid flat string→string scope unchanged', () => {
    const scope = { projectId: 'proj-42', tenant: 'acme' };
    expect(resolvePersistedScope(scope, { executionId: 'e1' })).toEqual(scope);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns an empty object for an empty (but valid) map', () => {
    // `{}` is a valid string→string map — the caller decides whether an empty
    // scope is meaningful; the helper does not collapse it to undefined.
    expect(resolvePersistedScope({}, { executionId: 'e1' })).toEqual({});
  });

  it('returns undefined for a null column without logging', () => {
    expect(resolvePersistedScope(null, { scheduleId: 's1' })).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns undefined for an undefined column without logging', () => {
    expect(resolvePersistedScope(undefined, { scheduleId: 's1' })).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('drops a scope with non-string values and warns with the caller context', () => {
    const result = resolvePersistedScope({ projectId: 42 }, { triggerId: 't1' });
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Dropped malformed persisted workflow scope',
      expect.objectContaining({ triggerId: 't1', issues: expect.any(Number) })
    );
  });

  it('drops a non-object scope value (array / primitive) and warns', () => {
    expect(resolvePersistedScope(['a', 'b'], { executionId: 'e1' })).toBeUndefined();
    expect(resolvePersistedScope('nope', { executionId: 'e1' })).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('warns via the supplied logger (preserving its bound context), not the default', () => {
    // The engine passes a context-bound baseLogger (workflowId/userId) so the
    // malformed-drop warning keeps correlation; verify the override is honoured.
    const customLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = resolvePersistedScope(
      { projectId: 42 },
      { executionId: 'e1' },
      customLogger as never
    );

    expect(result).toBeUndefined();
    expect(customLogger.warn).toHaveBeenCalledWith(
      'Dropped malformed persisted workflow scope',
      expect.objectContaining({ executionId: 'e1' })
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
