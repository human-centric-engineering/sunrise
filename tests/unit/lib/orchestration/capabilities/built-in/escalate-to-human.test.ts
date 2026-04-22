/**
 * Tests for the EscalateToHumanCapability built-in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { dispatchWebhookEvent } = await import('@/lib/orchestration/webhooks/dispatcher');
const { EscalateToHumanCapability } =
  await import('@/lib/orchestration/capabilities/built-in/escalate-to-human');
const { CapabilityValidationError } =
  await import('@/lib/orchestration/capabilities/base-capability');

const context = { userId: 'u1', agentId: 'a1', conversationId: 'conv-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EscalateToHumanCapability', () => {
  it('dispatches a conversation_escalated webhook event with correct payload', async () => {
    const cap = new EscalateToHumanCapability();

    const result = await cap.execute(
      { reason: 'User needs billing help', priority: 'high' },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      escalated: true,
      reason: 'User needs billing help',
      priority: 'high',
    });

    expect(dispatchWebhookEvent).toHaveBeenCalledWith('conversation_escalated', {
      agentId: 'a1',
      userId: 'u1',
      conversationId: 'conv-1',
      reason: 'User needs billing help',
      priority: 'high',
      metadata: null,
    });
  });

  it('defaults priority to medium when not specified', async () => {
    const cap = new EscalateToHumanCapability();

    const result = await cap.execute({ reason: 'Complex question' }, context);

    expect(result.data).toMatchObject({ priority: 'medium' });
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      'conversation_escalated',
      expect.objectContaining({ priority: 'medium' })
    );
  });

  it('passes metadata through to the webhook payload', async () => {
    const cap = new EscalateToHumanCapability();

    await cap.execute(
      {
        reason: 'Needs specialist',
        priority: 'low',
        metadata: { ticketType: 'refund', amount: 99.99 },
      },
      context
    );

    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      'conversation_escalated',
      expect.objectContaining({
        metadata: { ticketType: 'refund', amount: 99.99 },
      })
    );
  });

  it('handles missing conversationId gracefully', async () => {
    const cap = new EscalateToHumanCapability();
    const noConvContext = { userId: 'u1', agentId: 'a1' };

    const result = await cap.execute({ reason: 'Need help' }, noConvContext);

    expect(result.success).toBe(true);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      'conversation_escalated',
      expect.objectContaining({ conversationId: null })
    );
  });

  it('rejects empty reason via validate()', () => {
    const cap = new EscalateToHumanCapability();
    expect(() => cap.validate({ reason: '' })).toThrow(CapabilityValidationError);
  });

  it('rejects reason longer than 1000 chars via validate()', () => {
    const cap = new EscalateToHumanCapability();
    expect(() => cap.validate({ reason: 'a'.repeat(1001) })).toThrow(CapabilityValidationError);
  });

  it('rejects invalid priority via validate()', () => {
    const cap = new EscalateToHumanCapability();
    expect(() => cap.validate({ reason: 'help', priority: 'critical' })).toThrow(
      CapabilityValidationError
    );
  });
});
