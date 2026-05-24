/**
 * Tests: outbound adapter registry — register/get/list/reset behaviour.
 *
 * @see lib/orchestration/outbound/registry.ts
 */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  getOutboundAdapter,
  listOutboundProviders,
  registerOutboundAdapter,
  resetOutboundAdapters,
} from '@/lib/orchestration/outbound/registry';
import type { OutboundAdapter } from '@/lib/orchestration/outbound/types';

afterEach(() => {
  resetOutboundAdapters();
});

function makeAdapter(provider: string): OutboundAdapter {
  return {
    provider,
    supportedChannels: ['sms'],
    configSchema: z.object({}),
    async send() {
      throw new Error('not implemented');
    },
  };
}

describe('outbound registry', () => {
  it('registers and retrieves an adapter by provider slug', () => {
    const a = makeAdapter('twilio');
    registerOutboundAdapter(a);
    expect(getOutboundAdapter('twilio')).toBe(a);
  });

  it('returns undefined for unregistered providers', () => {
    expect(getOutboundAdapter('vonage')).toBeUndefined();
  });

  it('lists registered providers sorted alphabetically', () => {
    registerOutboundAdapter(makeAdapter('twilio'));
    registerOutboundAdapter(makeAdapter('meta'));
    registerOutboundAdapter(makeAdapter('vonage'));
    expect(listOutboundProviders()).toEqual(['meta', 'twilio', 'vonage']);
  });

  it('replaces an existing registration for the same provider (hot-reload safe)', () => {
    const v1 = makeAdapter('twilio');
    const v2 = makeAdapter('twilio');
    registerOutboundAdapter(v1);
    registerOutboundAdapter(v2);
    expect(getOutboundAdapter('twilio')).toBe(v2);
  });

  it('resetOutboundAdapters wipes the registry', () => {
    registerOutboundAdapter(makeAdapter('twilio'));
    resetOutboundAdapters();
    expect(listOutboundProviders()).toEqual([]);
  });
});
