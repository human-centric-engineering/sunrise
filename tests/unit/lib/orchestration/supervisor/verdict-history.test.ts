/**
 * Unit test for the shared verdict-history rule (t-925, t-951): the report a
 * writer is about to store, with the run's stored verdict archived after the
 * history the stored report carries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  STORED_VERDICT_SELECT,
  withPriorArchived,
} from '@/lib/orchestration/supervisor/verdict-history';

const NEW = { verdict: 'pass', score: 0.9, summary: 'new', triggeredBy: 'retroactive' };

const storedReport = (extra: Record<string, unknown> = {}) => ({
  verdict: 'concerns',
  score: 0.4,
  summary: 'stored',
  strengths: [],
  weaknesses: [],
  anomalies: [],
  unverifiedAreas: [],
  confidence: 'medium',
  ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe('withPriorArchived', () => {
  it('appends the stored verdict after the history it already carries', () => {
    const older = {
      verdict: 'fail',
      score: 0.1,
      reviewedAt: '2026-05-14T10:00:00.000Z',
      triggeredBy: 'in_workflow',
    };
    const out = withPriorArchived(
      NEW,
      {
        supervisorVerdict: 'concerns',
        supervisorReviewedAt: new Date('2026-05-16T10:00:00.000Z'),
        supervisorReport: storedReport({ triggeredBy: 'retroactive', previousVerdicts: [older] }),
      },
      'exec-1'
    );

    expect(out).toEqual({
      ...NEW,
      previousVerdicts: [
        older,
        {
          verdict: 'concerns',
          score: 0.4,
          reviewedAt: '2026-05-16T10:00:00.000Z',
          triggeredBy: 'retroactive',
        },
      ],
    });
  });

  it('defaults a stored verdict missing its time and origin', () => {
    const out = withPriorArchived(
      NEW,
      {
        supervisorVerdict: 'concerns',
        supervisorReviewedAt: null,
        supervisorReport: storedReport({ score: undefined }),
      },
      'exec-1'
    );

    expect(out.previousVerdicts).toEqual([
      {
        verdict: 'concerns',
        score: null,
        reviewedAt: new Date(0).toISOString(),
        triggeredBy: 'in_workflow',
      },
    ]);
  });

  it('returns the report unchanged, and a copy, when the run has no verdict', () => {
    const out = withPriorArchived(
      NEW,
      { supervisorVerdict: null, supervisorReport: null, supervisorReviewedAt: null },
      'exec-1'
    );

    expect(out).toEqual(NEW);
    expect(out).not.toBe(NEW);
  });

  it('skips the archive, and says so, when the stored report is malformed', () => {
    const out = withPriorArchived(
      NEW,
      {
        supervisorVerdict: 'concerns',
        supervisorReviewedAt: new Date(),
        supervisorReport: { verdict: 'not-a-verdict' },
      },
      'exec-1'
    );

    expect(out).toEqual(NEW);
    expect(logger.warn).toHaveBeenCalledWith(
      'Prior supervisorReport failed schema validation — archive skipped',
      expect.objectContaining({ executionId: 'exec-1' })
    );
  });
});

describe('STORED_VERDICT_SELECT', () => {
  it('selects exactly the columns the archive is built from', () => {
    expect(STORED_VERDICT_SELECT).toEqual({
      supervisorVerdict: true,
      supervisorReport: true,
      supervisorReviewedAt: true,
    });
  });
});
