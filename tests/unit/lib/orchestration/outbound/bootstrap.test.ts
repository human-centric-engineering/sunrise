/**
 * Tests: outbound adapter bootstrap — env-var-driven enablement matrix.
 *
 * @see lib/orchestration/outbound/bootstrap.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/orchestration/outbound/registry', () => ({
  registerOutboundAdapter: vi.fn(),
  getOutboundAdapter: vi.fn(),
  listOutboundProviders: vi.fn(() => []),
  resetOutboundAdapters: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerOutboundAdapter } from '@/lib/orchestration/outbound/registry';
import { TwilioOutboundAdapter } from '@/lib/orchestration/outbound/adapters/twilio';
import { MetaWhatsAppOutboundAdapter } from '@/lib/orchestration/outbound/adapters/whatsapp-cloud';
import {
  bootstrapOutboundAdapters,
  resetOutboundBootstrapState,
} from '@/lib/orchestration/outbound/bootstrap';

beforeEach(() => {
  resetOutboundBootstrapState();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('bootstrapOutboundAdapters — TwilioOutboundAdapter', () => {
  it('registers when TWILIO_AUTH_TOKEN is set', () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'twilio-token');
    bootstrapOutboundAdapters();
    expect(vi.mocked(registerOutboundAdapter)).toHaveBeenCalledWith(
      expect.any(TwilioOutboundAdapter)
    );
  });

  it('does NOT register when env var is missing', () => {
    bootstrapOutboundAdapters();
    const calls = vi.mocked(registerOutboundAdapter).mock.calls;
    expect(calls.some((args) => args[0] instanceof TwilioOutboundAdapter)).toBe(false);
  });

  it('does NOT register when env var is empty string', () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    bootstrapOutboundAdapters();
    const calls = vi.mocked(registerOutboundAdapter).mock.calls;
    expect(calls.some((args) => args[0] instanceof TwilioOutboundAdapter)).toBe(false);
  });
});

describe('bootstrapOutboundAdapters — MetaWhatsAppOutboundAdapter', () => {
  it('registers when BOTH WhatsApp env vars are set', () => {
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'wa-verify');
    vi.stubEnv('WHATSAPP_APP_SECRET', 'wa-secret');
    bootstrapOutboundAdapters();
    expect(vi.mocked(registerOutboundAdapter)).toHaveBeenCalledWith(
      expect.any(MetaWhatsAppOutboundAdapter)
    );
  });

  it('does NOT register when only verify token is set', () => {
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'wa-verify');
    bootstrapOutboundAdapters();
    const calls = vi.mocked(registerOutboundAdapter).mock.calls;
    expect(calls.some((args) => args[0] instanceof MetaWhatsAppOutboundAdapter)).toBe(false);
  });

  it('does NOT register when only app secret is set', () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', 'wa-secret');
    bootstrapOutboundAdapters();
    const calls = vi.mocked(registerOutboundAdapter).mock.calls;
    expect(calls.some((args) => args[0] instanceof MetaWhatsAppOutboundAdapter)).toBe(false);
  });
});

describe('bootstrapOutboundAdapters — idempotency', () => {
  it('no extra registrations on the second call', () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'twilio-token');
    vi.stubEnv('WHATSAPP_VERIFY_TOKEN', 'wa-verify');
    vi.stubEnv('WHATSAPP_APP_SECRET', 'wa-secret');

    bootstrapOutboundAdapters();
    const first = vi.mocked(registerOutboundAdapter).mock.calls.length;
    bootstrapOutboundAdapters();
    const second = vi.mocked(registerOutboundAdapter).mock.calls.length;

    expect(first).toBe(2);
    expect(second).toBe(2);
  });
});
