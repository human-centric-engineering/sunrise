/**
 * Unit Test: Notification channel dispatcher
 *
 * @see lib/orchestration/notifications/dispatcher.ts
 *
 * Coverage targets:
 * - normalizeChannel: string → { type }, object → passthrough, null → undefined
 * - dispatchApprovalNotification: logs dispatch with channel info
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  normalizeChannel,
  dispatchApprovalNotification,
} from '@/lib/orchestration/notifications/dispatcher';
import { logger } from '@/lib/logging';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('normalizeChannel', () => {
  it('converts string to { type } object', () => {
    expect(normalizeChannel('slack')).toEqual({ type: 'slack' });
  });

  it('converts "email" string to { type: "email" }', () => {
    expect(normalizeChannel('email')).toEqual({ type: 'email' });
  });

  it('passes through structured object', () => {
    const channel = {
      type: 'slack',
      target: '#approvals',
      metadata: { urgency: 'high' },
    };
    expect(normalizeChannel(channel)).toEqual(channel);
  });

  it('returns undefined for null', () => {
    expect(normalizeChannel(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(normalizeChannel(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(normalizeChannel('')).toBeUndefined();
  });

  it('handles object without optional fields', () => {
    expect(normalizeChannel({ type: 'whatsapp' })).toEqual({
      type: 'whatsapp',
      target: undefined,
      metadata: undefined,
    });
  });
});

describe('dispatchApprovalNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs dispatch with string channel', () => {
    const channel = dispatchApprovalNotification({
      executionId: 'exec-1',
      workflowId: 'wf-1',
      stepId: 'gate',
      prompt: 'Approve?',
      notificationChannel: 'slack',
      approveUrl: 'https://app.example.com/approve',
      rejectUrl: 'https://app.example.com/reject',
      tokenExpiresAt: '2026-05-06T12:00:00Z',
    });

    expect(channel).toEqual({ type: 'slack' });
    expect(logger.info).toHaveBeenCalledWith(
      'approval notification dispatched',
      expect.objectContaining({
        executionId: 'exec-1',
        channelType: 'slack',
        hasApproveUrl: true,
        hasRejectUrl: true,
      })
    );
  });

  it('logs dispatch with structured channel', () => {
    const channel = dispatchApprovalNotification({
      executionId: 'exec-2',
      workflowId: 'wf-2',
      stepId: 'gate',
      notificationChannel: {
        type: 'email',
        target: 'admin@example.com',
        metadata: { priority: 'urgent' },
      },
      approveUrl: 'https://app.example.com/approve',
      rejectUrl: 'https://app.example.com/reject',
      tokenExpiresAt: '2026-05-06T12:00:00Z',
    });

    expect(channel).toEqual({
      type: 'email',
      target: 'admin@example.com',
      metadata: { priority: 'urgent' },
    });
    expect(logger.info).toHaveBeenCalledWith(
      'approval notification dispatched',
      expect.objectContaining({
        channelType: 'email',
        channelTarget: 'admin@example.com',
      })
    );
  });

  it('logs "none" when no channel configured', () => {
    const channel = dispatchApprovalNotification({
      executionId: 'exec-3',
      workflowId: 'wf-3',
      stepId: 'gate',
      approveUrl: 'https://app.example.com/approve',
      rejectUrl: 'https://app.example.com/reject',
      tokenExpiresAt: '2026-05-06T12:00:00Z',
    });

    expect(channel).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      'approval notification dispatched',
      expect.objectContaining({ channelType: 'none' })
    );
  });
});
