/**
 * Scheduling barrel re-export smoke test
 *
 * Verifies that all named function exports from `lib/orchestration/scheduling/index.ts`
 * are correctly re-exported from the underlying scheduler module.
 *
 * Strategy: import real module (no mocks of the barrel itself). Mock heavy
 * deps (prisma, logger, engine) so the scheduler can load in a unit env.
 */

import { vi, describe, it, expect } from 'vitest';

// Mock downstream dependencies so the real scheduler can load in a unit env
vi.mock('@/lib/db/client', () => ({
  prisma: {
    workflowSchedule: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    workflowExecution: {
      findMany: vi.fn(),
      update: vi.fn(),
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

vi.mock('@/lib/orchestration/engine/orchestration-engine', () => ({
  OrchestrationEngine: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
  })),
}));

vi.mock('cron-parser', () => ({
  CronExpressionParser: {
    parse: vi.fn(),
  },
}));

vi.mock('@/lib/validations/orchestration', () => ({
  workflowDefinitionSchema: {
    parse: vi.fn(),
    safeParse: vi.fn(),
  },
}));

// Import AFTER mocks are registered
import {
  processDueSchedules,
  processPendingExecutions,
  getNextRunAt,
  isValidCron,
} from '@/lib/orchestration/scheduling';

describe('lib/orchestration/scheduling/index (barrel re-export)', () => {
  it('processDueSchedules is exported and is a function', () => {
    // Assert — the re-export chain is live; a missing export would be undefined here
    expect(typeof processDueSchedules).toBe('function');
  });

  it('processPendingExecutions is exported and is a function', () => {
    expect(typeof processPendingExecutions).toBe('function');
  });

  it('getNextRunAt is exported and is a function', () => {
    expect(typeof getNextRunAt).toBe('function');
  });

  it('isValidCron is exported and is a function', () => {
    expect(typeof isValidCron).toBe('function');
  });
});
