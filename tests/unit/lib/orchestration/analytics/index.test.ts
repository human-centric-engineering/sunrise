/**
 * Analytics barrel re-export smoke test
 *
 * Verifies that all named function exports from `lib/orchestration/analytics/index.ts`
 * are correctly re-exported from the underlying analytics-service module.
 *
 * Strategy: import real module (no mocks of the barrel itself). If prisma or
 * other heavy deps cause load failures, the prisma mock below covers them.
 */

import { vi, describe, it, expect } from 'vitest';

// Mock downstream dependencies so the real analytics-service can load in a unit env
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiMessage: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    aiConversation: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
    },
    aiFeedback: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
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

// Import AFTER mocks are registered
import {
  getPopularTopics,
  getUnansweredQuestions,
  getEngagementMetrics,
  getContentGaps,
  getFeedbackSummary,
} from '@/lib/orchestration/analytics';

describe('lib/orchestration/analytics/index (barrel re-export)', () => {
  it('getPopularTopics is exported and is a function', () => {
    // Assert — the re-export chain is live; a missing export would be undefined here
    expect(typeof getPopularTopics).toBe('function');
  });

  it('getUnansweredQuestions is exported and is a function', () => {
    expect(typeof getUnansweredQuestions).toBe('function');
  });

  it('getEngagementMetrics is exported and is a function', () => {
    expect(typeof getEngagementMetrics).toBe('function');
  });

  it('getContentGaps is exported and is a function', () => {
    expect(typeof getContentGaps).toBe('function');
  });

  it('getFeedbackSummary is exported and is a function', () => {
    expect(typeof getFeedbackSummary).toBe('function');
  });
});
