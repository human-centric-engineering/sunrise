/**
 * Unit Test: Event factory helpers
 *
 * @see lib/orchestration/engine/events.ts
 *
 * Coverage targets:
 * - All 8 factory functions return correct event shapes
 * - workflowFailed fires webhook dispatch
 * - .catch() branch: webhook errors are logged, not thrown
 * - approvalRequired webhook dispatch is handled by the engine (pauseForApproval)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  workflowStarted,
  stepStarted,
  stepCompleted,
  stepFailed,
  approvalRequired,
  budgetWarning,
  workflowCompleted,
  workflowFailed,
} from '@/lib/orchestration/engine/events';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { logger } from '@/lib/logging';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Event factory helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('workflowStarted', () => {
    it('returns a workflow_started event', () => {
      const event = workflowStarted('exec-1', 'wf-1');
      expect(event).toEqual({
        type: 'workflow_started',
        executionId: 'exec-1',
        workflowId: 'wf-1',
      });
    });
  });

  describe('stepStarted', () => {
    it('returns a step_started event', () => {
      const event = stepStarted('step-1', 'llm_call', 'Generate text');
      expect(event).toEqual({
        type: 'step_started',
        stepId: 'step-1',
        stepType: 'llm_call',
        label: 'Generate text',
      });
    });
  });

  describe('stepCompleted', () => {
    it('returns a step_completed event with metrics', () => {
      const event = stepCompleted('step-1', { result: 'done' }, 500, 0.01, 1200);
      expect(event).toEqual({
        type: 'step_completed',
        stepId: 'step-1',
        output: { result: 'done' },
        tokensUsed: 500,
        costUsd: 0.01,
        durationMs: 1200,
      });
    });
  });

  describe('stepFailed', () => {
    it('returns a step_failed event with willRetry flag', () => {
      const event = stepFailed('step-1', 'LLM timeout', true);
      expect(event).toEqual({
        type: 'step_failed',
        stepId: 'step-1',
        error: 'LLM timeout',
        willRetry: true,
      });
    });

    it('returns willRetry: false when retries exhausted', () => {
      const event = stepFailed('step-1', 'Budget exceeded', false);
      expect(event).toHaveProperty('willRetry', false);
    });
  });

  describe('approvalRequired', () => {
    it('returns an approval_required event', () => {
      const payload = { prompt: 'Please review', context: 'step output' };
      const event = approvalRequired('step-1', payload);

      expect(event).toEqual({
        type: 'approval_required',
        stepId: 'step-1',
        payload,
      });
    });

    it('does not dispatch webhook (engine pauseForApproval handles that)', () => {
      approvalRequired('step-2', { prompt: 'review' });
      expect(dispatchWebhookEvent).not.toHaveBeenCalledWith('approval_required', expect.anything());
    });
  });

  describe('budgetWarning', () => {
    it('returns a budget_warning event', () => {
      const event = budgetWarning(0.42, 0.5);
      expect(event).toEqual({
        type: 'budget_warning',
        usedUsd: 0.42,
        limitUsd: 0.5,
      });
    });
  });

  describe('workflowCompleted', () => {
    it('returns a workflow_completed event', () => {
      const event = workflowCompleted({ summary: 'done' }, 2000, 0.15);
      expect(event).toEqual({
        type: 'workflow_completed',
        output: { summary: 'done' },
        totalTokensUsed: 2000,
        totalCostUsd: 0.15,
      });
    });
  });

  describe('workflowFailed', () => {
    it('returns a workflow_failed event and dispatches webhook', () => {
      const event = workflowFailed('Budget exceeded', 'step-4');

      expect(event).toEqual({
        type: 'workflow_failed',
        error: 'Budget exceeded',
        failedStepId: 'step-4',
      });
      expect(dispatchWebhookEvent).toHaveBeenCalledWith('workflow_failed', {
        error: 'Budget exceeded',
        failedStepId: 'step-4',
      });
    });

    it('omits failedStepId when not provided', () => {
      const event = workflowFailed('Unknown error');
      expect(event).toHaveProperty('failedStepId', undefined);
    });

    it('logs a warning when webhook dispatch rejects (does not throw)', async () => {
      vi.mocked(dispatchWebhookEvent).mockRejectedValueOnce(new Error('Timeout'));

      const event = workflowFailed('step exploded', 'step-5');
      expect(event.type).toBe('workflow_failed');

      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalledWith(
          'Webhook dispatch failed for workflow_failed',
          expect.objectContaining({
            failedStepId: 'step-5',
            error: 'Timeout',
          })
        );
      });
    });

    it('logs stringified error when webhook rejects with non-Error value', async () => {
      vi.mocked(dispatchWebhookEvent).mockRejectedValueOnce('raw string error');

      workflowFailed('step exploded', 'step-6');

      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalledWith(
          'Webhook dispatch failed for workflow_failed',
          expect.objectContaining({
            failedStepId: 'step-6',
            error: 'raw string error',
          })
        );
      });
    });
  });
});
