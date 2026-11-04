/**
 * Unit tests: the waitlist config (§125 t-974)
 *
 * An invalid config switches the waitlist off — it must never half-work — and
 * says why. A valid one fills its defaults.
 *
 * @see lib/waitlist/config.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WaitlistConfig } from '@/lib/waitlist/config';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

import { resolveWaitlistConfig } from '@/lib/waitlist/config';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveWaitlistConfig', () => {
  it('null is no waitlist, silently', () => {
    expect(resolveWaitlistConfig(null)).toBeNull();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('fills the defaults: no fields, one open default list, no screen, the spec’s windows', () => {
    expect(resolveWaitlistConfig({ consentVersion: 'v1' })).toEqual({
      consentVersion: 'v1',
      fields: [],
      lists: [{ key: 'default' }],
      screen: null,
      retention: { removedDays: 90, closedListMonths: 12 },
    });
  });

  it('keeps the default for a window the fork sets to undefined', () => {
    // `removedDays: env.X ? Number(env.X) : undefined` — a spread would let
    // the undefined win and make every cut-off an Invalid Date.
    expect(
      resolveWaitlistConfig({ consentVersion: 'v1', retention: { removedDays: undefined } })
        ?.retention
    ).toEqual({ removedDays: 90, closedListMonths: 12 });
  });

  it('takes a retention window the fork sets and keeps the default for the other', () => {
    expect(
      resolveWaitlistConfig({ consentVersion: 'v1', retention: { removedDays: 30 } })?.retention
    ).toEqual({ removedDays: 30, closedListMonths: 12 });
  });

  it('keeps the fork’s own screen function', () => {
    const screen = () => ({ action: 'accept' as const });
    expect(resolveWaitlistConfig({ consentVersion: 'v1', screen })?.screen).toBe(screen);
  });

  const invalid: Array<[string, unknown]> = [
    ['no consent version', { consentVersion: '  ' }],
    ['a zero retention window', { consentVersion: 'v1', retention: { removedDays: 0 } }],
    ['an unknown retention key', { consentVersion: 'v1', retention: { unconfirmedDays: 30 } }],
    [
      'a select with no options',
      { consentVersion: 'v1', fields: [{ key: 'r', label: 'R', kind: 'select' }] },
    ],
    [
      'options on a text field',
      {
        consentVersion: 'v1',
        fields: [{ key: 'r', label: 'R', kind: 'text', options: [{ value: 'a', label: 'A' }] }],
      },
    ],
    [
      'duplicate field keys',
      {
        consentVersion: 'v1',
        fields: [
          { key: 'r', label: 'R', kind: 'text' },
          { key: 'r', label: 'R2', kind: 'text' },
        ],
      },
    ],
    [
      'a field key that is a body name',
      { consentVersion: 'v1', fields: [{ key: 'Email', label: 'E', kind: 'text' }] },
    ],
    [
      'the honeypot as a field key',
      { consentVersion: 'v1', fields: [{ key: 'website', label: 'W', kind: 'text' }] },
    ],
    [
      'a field key with a dot',
      { consentVersion: 'v1', fields: [{ key: 'a.b', label: 'A', kind: 'text' }] },
    ],
    [
      'a field key that names an Object member',
      { consentVersion: 'v1', fields: [{ key: 'constructor', label: 'C', kind: 'text' }] },
    ],
    ['duplicate list keys', { consentVersion: 'v1', lists: [{ key: 'a' }, { key: 'a' }] }],
    ['an empty list array', { consentVersion: 'v1', lists: [] }],
    ['a screen that is not a function', { consentVersion: 'v1', screen: 'reject-all' }],
  ];

  it.each(invalid)('%s switches the waitlist off and logs the problem', (_name, config) => {
    // Act
    const resolved = resolveWaitlistConfig(config as WaitlistConfig);

    // Assert
    expect(resolved).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Waitlist config is invalid; the waitlist is off until it is fixed',
      { issues: expect.arrayContaining([expect.objectContaining({ message: expect.any(String) })]) }
    );
  });
});

describe('getWaitlistConfig', () => {
  it('reads the seam once and caches the answer', async () => {
    // Arrange
    vi.resetModules();
    vi.doMock('@/lib/app/waitlist-config', () => ({ waitlistConfig: { consentVersion: 'v9' } }));
    const mod = await import('@/lib/waitlist/config');
    mod.__resetWaitlistConfigForTests();

    // Act
    const first = mod.getWaitlistConfig();
    const second = mod.getWaitlistConfig();

    // Assert
    expect(first?.consentVersion).toBe('v9');
    expect(second).toBe(first);
    expect(mod.isWaitlistEnabled()).toBe(true);

    // Restore the suite-wide pin (never doUnmock — see tests/setup.ts)
    vi.doMock('@/lib/app/waitlist-config', () => ({ waitlistConfig: null }));
  });

  it('with the pinned (shipped) seam the waitlist is off', async () => {
    vi.resetModules();
    const mod = await import('@/lib/waitlist/config');
    mod.__resetWaitlistConfigForTests();
    expect(mod.getWaitlistConfig()).toBeNull();
    expect(mod.isWaitlistEnabled()).toBe(false);
  });
});
