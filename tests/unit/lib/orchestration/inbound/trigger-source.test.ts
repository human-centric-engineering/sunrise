/**
 * Tests: the inbound route's run marker (t-770).
 *
 * `send_message_to_channel` trusts a run's `triggerMeta.conversationId` only on
 * a run whose `triggerSource` starts with this prefix, so the marker and the
 * prefix the capability matches must agree.
 *
 * @see lib/orchestration/inbound/trigger-source.ts
 */
import { describe, expect, it } from 'vitest';

import {
  INBOUND_TRIGGER_SOURCE_PREFIX,
  inboundTriggerSource,
} from '@/lib/orchestration/inbound/trigger-source';

describe('inbound trigger source', () => {
  it('stamps inbound:<channel>, which the capability’s prefix matches', () => {
    expect(inboundTriggerSource('sms')).toBe('inbound:sms');
    for (const channel of ['sms', 'whatsapp', 'email', 'slack']) {
      expect(inboundTriggerSource(channel).startsWith(INBOUND_TRIGGER_SOURCE_PREFIX)).toBe(true);
    }
  });

  it('is a prefix no other run source shares', () => {
    for (const source of ['schedule', 'webhook', 'chat']) {
      expect(source.startsWith(INBOUND_TRIGGER_SOURCE_PREFIX)).toBe(false);
    }
  });
});
