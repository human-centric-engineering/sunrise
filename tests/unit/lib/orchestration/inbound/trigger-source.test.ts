/**
 * Tests: the inbound route's run marker (t-770).
 *
 * `send_message_to_channel` trusts a run's `triggerMeta.conversationId` only
 * when this says the inbound route started the run, so a false positive would
 * let a model-chosen `run_workflow` input steer an outbound message.
 *
 * @see lib/orchestration/inbound/trigger-source.ts
 */
import { describe, expect, it } from 'vitest';

import {
  inboundTriggerSource,
  isInboundTriggerSource,
} from '@/lib/orchestration/inbound/trigger-source';

describe('inbound trigger source', () => {
  it('recognises the marker the inbound route stamps, for every channel', () => {
    for (const channel of ['sms', 'whatsapp', 'email', 'slack']) {
      expect(isInboundTriggerSource(inboundTriggerSource(channel))).toBe(true);
    }
  });

  it('does not recognise any other way a run starts', () => {
    expect(isInboundTriggerSource('schedule')).toBe(false);
    expect(isInboundTriggerSource('webhook')).toBe(false);
    expect(isInboundTriggerSource('chat')).toBe(false);
    expect(isInboundTriggerSource(null)).toBe(false);
    expect(isInboundTriggerSource(undefined)).toBe(false);
    // A prefix test, not a substring one.
    expect(isInboundTriggerSource('webhook:inbound:sms')).toBe(false);
  });
});
