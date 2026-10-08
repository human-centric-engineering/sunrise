/**
 * Delivery destination: reduction, keyed fingerprint, and the column-write
 * decision for an attempt (§109 t-739).
 *
 * @see lib/orchestration/webhooks/destination.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  BETTER_AUTH_SECRET: 'secret-one-at-least-thirty-two-characters-long',
}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  describeDestination,
  destinationUpdate,
  fingerprintDestination,
  subscriptionDestination,
} from '@/lib/orchestration/webhooks/destination';

const TOKEN = 'Ab3dEf6hIj9kLm2nOp5qRs8t';

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.BETTER_AUTH_SECRET = 'secret-one-at-least-thirty-two-characters-long';
});

describe('describeDestination', () => {
  it('drops query, userinfo, fragment and a token-like path segment from both columns', () => {
    const raw = `https://user:pa55word@hooks.example.com/services/${TOKEN}/send?key=QSECRET#FSECRET`;

    const result = describeDestination('webhook', raw);

    // Population first: the reduced form is a real URL on the right host, so
    // the absence checks below are not vacuous.
    expect(result.destination).toBe('https://hooks.example.com/services/[param]/send');
    for (const secret of [TOKEN, 'QSECRET', 'FSECRET', 'pa55word', 'user:']) {
      expect(result.destination).not.toContain(secret);
      expect(result.destinationFingerprint).not.toContain(secret);
    }
  });

  it('keeps an email address verbatim', () => {
    const result = describeDestination('email', 'Alerts@Example.com');

    expect(result.destination).toBe('Alerts@Example.com');
    expect(result.destinationFingerprint).toMatch(/^v1:/);
  });

  it('prefixes the fingerprint with v1: followed by a base64url MAC', () => {
    const { destinationFingerprint } = describeDestination('webhook', 'https://example.com/a');

    expect(destinationFingerprint).toMatch(/^v1:[A-Za-z0-9_-]{43}$/);
  });

  it('gives two URLs with the same reduced form different fingerprints', () => {
    const a = describeDestination('webhook', `https://hooks.slack.com/services/${TOKEN}`);
    const b = describeDestination(
      'webhook',
      'https://hooks.slack.com/services/Zy9xWv8uTs7rQp6oNm5lKj4i'
    );

    expect(a.destination).toBe('https://hooks.slack.com/services/[param]');
    expect(b.destination).toBe(a.destination);
    expect(a.destinationFingerprint).not.toBe(b.destinationFingerprint);
  });
});

describe('fingerprintDestination', () => {
  it('is deterministic for the same channel and raw value', () => {
    const raw = `https://hooks.slack.com/services/${TOKEN}`;

    expect(fingerprintDestination('webhook', raw)).toBe(fingerprintDestination('webhook', raw));
  });

  it('includes the channel in the input', () => {
    expect(fingerprintDestination('webhook', 'same-string')).not.toBe(
      fingerprintDestination('email', 'same-string')
    );
  });

  it('is keyed: changing BETTER_AUTH_SECRET changes it', () => {
    const before = fingerprintDestination('webhook', 'https://example.com/a');
    mockEnv.BETTER_AUTH_SECRET = 'secret-two-at-least-thirty-two-characters-long';

    const after = fingerprintDestination('webhook', 'https://example.com/a');

    expect(after).not.toBe(before);
    expect(after).toMatch(/^v1:/);
  });
});

describe('subscriptionDestination', () => {
  it('uses the url for a webhook subscription, ignoring the email address', () => {
    const result = subscriptionDestination({
      channel: 'webhook',
      url: 'https://example.com/hook',
      emailAddress: 'a@example.com',
    });

    expect(result).toEqual(describeDestination('webhook', 'https://example.com/hook'));
  });

  it('uses the email address for an email subscription, ignoring the url', () => {
    const result = subscriptionDestination({
      channel: 'email',
      url: 'https://example.com/hook',
      emailAddress: 'a@example.com',
    });

    expect(result).toEqual(describeDestination('email', 'a@example.com'));
  });

  it('returns null for a webhook with no url', () => {
    expect(
      subscriptionDestination({ channel: 'webhook', url: null, emailAddress: 'a@example.com' })
    ).toBeNull();
  });

  it('returns null for an email subscription with no address', () => {
    expect(
      subscriptionDestination({
        channel: 'email',
        url: 'https://example.com/h',
        emailAddress: null,
      })
    ).toBeNull();
  });
});

describe('destinationUpdate', () => {
  const NOW = new Date('2026-10-08T12:00:00.000Z');
  const oldPair = describeDestination('webhook', 'https://old.example.com/hook');
  const newPair = describeDestination('webhook', 'https://new.example.com/hook');

  it('writes nothing when there is no target', () => {
    expect(destinationUpdate({ ...oldPair, previousDestinations: null }, null, NOW)).toEqual({});
  });

  it('writes nothing when the target fingerprint is already recorded', () => {
    expect(destinationUpdate({ ...oldPair, previousDestinations: null }, oldPair, NOW)).toEqual({});
  });

  it('records the target only, with no previousDestinations key, when nothing is recorded', () => {
    const result = destinationUpdate(
      { destination: null, destinationFingerprint: null, previousDestinations: null },
      newPair,
      NOW
    );

    expect(result).toEqual(newPair);
    expect(result).not.toHaveProperty('previousDestinations');
  });

  it('moves the old pair into previousDestinations, stamped with now, on a different target', () => {
    const result = destinationUpdate({ ...oldPair, previousDestinations: null }, newPair, NOW);

    expect(result).toEqual({
      ...newPair,
      previousDestinations: [{ ...oldPair, until: NOW.toISOString() }],
    });
  });

  it('appends to existing history in order, preserving earlier entries', () => {
    const first = {
      destination: 'https://first.example.com/hook',
      destinationFingerprint: 'v1:first',
      until: '2026-01-01T00:00:00.000Z',
    };

    const result = destinationUpdate({ ...oldPair, previousDestinations: [first] }, newPair, NOW);

    expect(result.previousDestinations).toEqual([first, { ...oldPair, until: NOW.toISOString() }]);
  });

  it('logs an error and restarts history with only the old pair when the stored JSON is malformed', () => {
    const result = destinationUpdate(
      { ...oldPair, previousDestinations: { not: 'an array' } },
      newPair,
      NOW
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('previousDestinations is malformed'),
      expect.any(Object)
    );
    expect(result.previousDestinations).toEqual([{ ...oldPair, until: NOW.toISOString() }]);
  });

  it('does not log when the stored history is valid', () => {
    destinationUpdate({ ...oldPair, previousDestinations: [] }, newPair, NOW);

    expect(logger.error).not.toHaveBeenCalled();
  });
});
