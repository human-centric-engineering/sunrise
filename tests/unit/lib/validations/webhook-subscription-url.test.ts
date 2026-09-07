/**
 * Webhook subscription URL guard — the write-time SSRF check.
 *
 * This is the control the whole "write time is sufficient" argument rests on
 * (see the docblock in `lib/orchestration/http/allowlist.ts`), and it had no
 * test anywhere. The sibling control on the event-hook action URL is covered by
 * `tests/unit/lib/orchestration/hooks/types.test.ts`; this one was not.
 *
 * Why the argument needs it: `webhooks/dispatcher.ts` deliberately does NOT
 * re-check the destination per dispatch, because `checkSafeProviderUrl` does no
 * DNS resolution and would reach the same verdict on the same string. That is
 * only sound while the write-time refine actually holds — so it is asserted
 * here rather than assumed.
 *
 * These call the REAL `isSafeProviderUrl`. Mocking it would leave the test
 * asserting that a Zod refine calls a stub, which is not the property anyone
 * cares about — the failure mode `tests/unit/lib/orchestration/hooks/types.test.ts`
 * has for the event-hook sibling, which is why that file is NOT cited as
 * evidence the event-hook destination is guarded against real addresses.
 */

import { describe, it, expect } from 'vitest';

import { createWebhookSchema, updateWebhookSchema } from '@/lib/validations/orchestration';

const BASE = {
  events: ['budget_exceeded'],
  secret: 'test-secret-key-1234567890',
};

/** Addresses that must never be accepted as a webhook destination. */
const BLOCKED: Array<[string, string]> = [
  ['IMDS (AWS/GCP/Azure)', 'http://169.254.169.254/latest/meta-data/'],
  ['ECS task metadata', 'http://169.254.170.2/v2/credentials'],
  ['loopback', 'http://127.0.0.1:8080/hook'],
  ['RFC1918 private', 'http://192.168.1.10/hook'],
  ['RFC1918 private (10/8)', 'http://10.0.0.5/hook'],
  ['CGNAT / Tailscale range', 'http://100.64.0.1/hook'],
];

describe('createWebhookSchema — destination guard', () => {
  it.each(BLOCKED)('rejects %s', (_label, url) => {
    const result = createWebhookSchema.safeParse({ ...BASE, channel: 'webhook', url });
    expect(result.success).toBe(false);
  });

  it('CONTROL — accepts an ordinary public https destination', () => {
    // Without this, every rejection above would also pass if the fixture were
    // malformed in some way that had nothing to do with the URL.
    const result = createWebhookSchema.safeParse({
      ...BASE,
      channel: 'webhook',
      url: 'https://hooks.example.com/sunrise',
    });
    expect(result.success).toBe(true);
  });
});

describe('updateWebhookSchema — destination guard', () => {
  it.each(BLOCKED)('rejects %s when the patch carries a url', (_label, url) => {
    const result = updateWebhookSchema.safeParse({ channel: 'webhook', url });
    expect(result.success).toBe(false);
  });

  it('CONTROL — accepts an ordinary public https destination', () => {
    const result = updateWebhookSchema.safeParse({
      channel: 'webhook',
      url: 'https://hooks.example.com/sunrise',
    });
    expect(result.success).toBe(true);
  });

  it('does NOT validate the stored url when the patch omits it — the route must', () => {
    // The re-enable flow. `url` is `.optional()`, so a patch that only flips
    // `isActive` and sets a secret never reaches the refine above. An earlier
    // draft of this file claimed this schema was "what stops an imported private
    // URL ever being delivered to" — it is not, and asserting the limitation is
    // how the claim stays honest if someone later assumes otherwise.
    //
    // The destination is guarded in two other places instead: the backup import
    // schema refuses to persist an unsafe url, and the PATCH route revalidates
    // `existing.url` before activating. See
    // `tests/unit/app/api/v1/admin/orchestration/webhooks/id-route.test.ts`.
    const result = updateWebhookSchema.safeParse({
      isActive: true,
      secret: 'test-secret-key-1234567890',
    });

    expect(result.success).toBe(true);
  });
});
