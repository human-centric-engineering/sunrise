/**
 * Tests: monitoring validation schemas
 *
 * The `healthCheckResponseSchema` is the runtime guard at the
 * `/api/health` fetch boundary in `components/status/use-health-check.ts`.
 * These tests defend the properties the hook depends on:
 *
 *  1. A well-formed `/api/health` payload parses successfully, with the
 *     contract-bearing fields preserved rather than silently stripped.
 *  2. A payload missing a required field, or carrying a wrong-typed one,
 *     fails the parse and names the offending field — the regression the bare
 *     `as HealthCheckResponse` cast used to allow.
 *  3. `sunrise` is **no longer part of the contract** (#531). The schema must
 *     neither require it nor break on a payload that still carries one: a fork
 *     is free to keep the field on its own health route, and this hook must
 *     keep working against it.
 *
 * @see lib/validations/monitoring.ts
 * @see components/status/use-health-check.ts
 */

import { describe, it, expect } from 'vitest';
import { healthCheckResponseSchema } from '@/lib/validations/monitoring';

const validPayload = {
  status: 'ok' as const,
  version: '0.0.0',
  uptime: 1234,
  timestamp: '2026-05-28T10:00:00.000Z',
  services: {
    database: {
      status: 'operational' as const,
      connected: true,
      latency: 5,
    },
  },
};

describe('healthCheckResponseSchema', () => {
  it('accepts a well-formed /api/health success payload', () => {
    const result = healthCheckResponseSchema.safeParse(validPayload);

    expect(result.success).toBe(true);
    if (result.success) {
      // Confirm the parse preserves the contract-bearing fields exactly
      // (not just "doesn't throw") — a schema that silently strips fields
      // would also pass `success: true` here.
      expect(result.data.version).toBe('0.0.0');
      expect(result.data.services.database.status).toBe('operational');
    }
  });

  it('accepts a payload with no sunrise field — it is no longer part of the contract', () => {
    // The inverse of what this file used to assert. `sunrise` was removed from
    // the public health payload in #531 because the endpoint is unauthenticated;
    // requiring it here would make the hook reject every current deployment.
    expect(validPayload).not.toHaveProperty('sunrise');

    const result = healthCheckResponseSchema.safeParse(validPayload);

    expect(result.success).toBe(true);
  });

  it('accepts — and strips — a payload that still carries sunrise', () => {
    // A fork may keep the field on its own health route, and an old deployment
    // behind a rolling upgrade still emits it. Neither may break the hook. Zod's
    // default object behaviour strips unknown keys rather than failing, which is
    // the tolerant direction; this pins that it stays tolerant.
    const legacyPayload = { ...validPayload, sunrise: '0.9.0' };

    const result = healthCheckResponseSchema.safeParse(legacyPayload);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('sunrise');
      expect(result.data.version).toBe('0.0.0');
    }
  });

  it('rejects a payload missing the version field', () => {
    // `version` is still required. This is the assertion `sunrise` used to
    // carry: without one required-field case the suite would no longer prove
    // the schema rejects anything at all.
    const { version: _, ...payloadWithoutVersion } = validPayload;
    void _;

    const result = healthCheckResponseSchema.safeParse(payloadWithoutVersion);

    expect(result.success).toBe(false);
    if (!result.success) {
      // The Zod error should name the missing field — operators reading
      // the runtime error want to know what's wrong, not just that
      // "something" failed.
      expect(JSON.stringify(result.error.issues)).toContain('version');
    }
  });

  it('rejects a payload with a wrong-type field', () => {
    const malformed = { ...validPayload, uptime: 'not a number' };

    const result = healthCheckResponseSchema.safeParse(malformed);

    expect(result.success).toBe(false);
    if (!result.success) {
      // Pin the specific field that failed — distinguishes "uptime is wrong"
      // from "some other field is malformed" (mirrors the pattern at L51-65).
      expect(JSON.stringify(result.error.issues)).toContain('uptime');
    }
  });

  it('accepts the optional memory and error fields when present', () => {
    const withOptionals = {
      ...validPayload,
      memory: { heapUsed: 100, heapTotal: 200, rss: 300, percentage: 50 },
      error: 'something',
    };

    const result = healthCheckResponseSchema.safeParse(withOptionals);

    expect(result.success).toBe(true);
    if (result.success) {
      // Confirm optional fields are preserved in the parsed output — a schema
      // that silently strips optional fields would also pass `success: true`.
      expect(result.data.memory?.heapUsed).toBe(100);
      expect(result.data.error).toBe('something');
    }
  });
});
