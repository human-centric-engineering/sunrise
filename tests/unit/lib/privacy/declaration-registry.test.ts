/**
 * Tests: lib/privacy/declaration-registry.ts (t-787)
 *
 * The shared rules are exercised through both seams' own suites
 * (`subject-source-registry.test.ts`, `org-source-registry.test.ts`), which
 * pin each seam's public behaviour. This file covers what only the factory
 * can show: that the per-seam options really change the outcome, and that
 * the snapshot the init gate restores includes the rejection state.
 *
 * @see lib/privacy/declaration-registry.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

import {
  createDeclarationRegistry,
  type DeclarationRegistryOptions,
  type DeclaredSource,
} from '@/lib/privacy/declaration-registry';

const VALID: DeclaredSource = {
  model: 'AppInvoice',
  section: 'invoices',
  disposition: 'export',
  description: 'Invoices raised against the account.',
};

function build(overrides: Partial<DeclarationRegistryOptions<DeclaredSource>> = {}) {
  return createDeclarationRegistry<DeclaredSource>({
    logPrefix: 'test-sources',
    minDescription: 10,
    checkSection: (section) => (section === '' ? 'section is empty' : null),
    rejectionsLatch: false,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rejectionsLatch', () => {
  it.each([
    [true, true],
    [false, false],
  ])('when %s, a rejected source leaves failed() %s', (latch, expected) => {
    const registry = build({ rejectionsLatch: latch });

    registry.register({ tier: 'app', sources: [{ ...VALID, description: 'short' }] });

    expect(registry.sources()).toEqual([]);
    expect(registry.failed()).toBe(expected);
  });

  it('a thrown init fails the registry whatever the latch setting', () => {
    const registry = build({ rejectionsLatch: false });

    registry.markInitFailed();

    expect(registry.failed()).toBe(true);
  });
});

describe('per-seam checks', () => {
  it('logs the reason checkSection returns, under the seam’s prefix', () => {
    const registry = build({ checkSection: () => 'no sections today' });

    registry.register({ tier: 'app', sources: [VALID] });

    expect(registry.sources()).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalledWith('test-sources: declaration rejected', {
      tier: 'app',
      model: 'AppInvoice',
      reason: 'no sections today',
    });
  });

  it('runs checkSource only after the shared checks pass', () => {
    const checkSource = vi.fn(() => 'refused by the seam');
    const registry = build({ checkSource });

    registry.register({
      tier: 'app',
      sources: [{ ...VALID, model: 'AppShort', description: 'x' }, VALID],
    });

    // The short description is refused by the shared floor; only the valid row
    // reaches the seam's own check.
    expect(checkSource).toHaveBeenCalledTimes(1);
    expect(checkSource).toHaveBeenCalledWith(VALID);
    expect(registry.sources()).toEqual([]);
  });
});

describe('snapshot and restore', () => {
  it('puts the rejection state back, so a rolled-back rejection no longer fails the export', () => {
    const registry = build({ rejectionsLatch: true });
    const before = registry.snapshot();

    registry.register({ tier: 'app', sources: [{ ...VALID, model: '' }] });
    expect(registry.failed()).toBe(true);

    registry.restore(before);

    expect(registry.failed()).toBe(false);
    expect(registry.accounted().size).toBe(0);
  });

  it('copies rather than aliases, so later registrations do not change a snapshot', () => {
    const registry = build();
    const before = registry.snapshot();

    registry.register({ tier: 'app', sources: [VALID] });

    expect(before.sources.size).toBe(0);
    expect(before.owners.size).toBe(0);
  });
});

describe('reset', () => {
  it('clears declarations, rejections and a latched init failure', () => {
    const registry = build({ rejectionsLatch: true });
    registry.register({ tier: 'app', sources: [VALID, { ...VALID, model: '' }] });
    registry.markInitFailed();

    registry.reset();

    expect(registry.sources()).toEqual([]);
    expect(registry.failed()).toBe(false);
  });
});

describe('a malformed contribution', () => {
  type Contribution = Parameters<ReturnType<typeof build>['register']>[0];

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'app'],
  ])('rejects %s without throwing, and latches when latching', (_label, value) => {
    const registry = build({ rejectionsLatch: true });

    expect(() => registry.register(value as unknown as Contribution)).not.toThrow();
    expect(registry.failed()).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'test-sources: declaration rejected',
      expect.objectContaining({ reason: 'contribution is not an object' })
    );
  });

  it('rejects a non-array sources list without throwing, and keeps the valid exclusions', () => {
    const registry = build({ rejectionsLatch: true });

    expect(() =>
      registry.register({
        tier: 'app',
        sources: VALID as unknown as DeclaredSource[],
        excluded: [{ model: 'AppAudit', reason: 'Operator audit trail, not subject data.' }],
      })
    ).not.toThrow();

    expect(registry.sources()).toEqual([]);
    expect(registry.excluded()).toEqual([
      { model: 'AppAudit', reason: 'Operator audit trail, not subject data.' },
    ]);
    expect(registry.failed()).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'test-sources: declaration rejected',
      expect.objectContaining({ reason: 'source list is not an array' })
    );
  });

  it('rejects a non-array exclusion list without throwing', () => {
    const registry = build({ rejectionsLatch: true });

    registry.register({
      tier: 'app',
      sources: [VALID],
      excluded: { model: 'AppAudit' } as unknown as [],
    });

    expect(registry.sources().map((s) => s.model)).toEqual(['AppInvoice']);
    expect(registry.failed()).toBe(true);
  });

  it('rejects a non-string tier, so it cannot claim a model another tier owns', () => {
    const registry = build();
    registry.register({ tier: 'framework', sources: [VALID] });

    registry.register({
      tier: undefined as unknown as string,
      sources: [{ ...VALID, section: 'invoicesAgain' }],
    });
    // Before the check, an `undefined` owner read back as "no owner", so this
    // second tier's duplicate was accepted and took the model over.
    registry.register({
      tier: 'leaf',
      sources: [{ ...VALID, section: 'invoicesLeaf' }],
    });

    expect(registry.sources()).toEqual([VALID]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'test-sources: declaration rejected',
      expect.objectContaining({ reason: 'tier is not a string' })
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      'test-sources: declaration rejected',
      expect.objectContaining({ tier: 'leaf', reason: "already declared by tier 'framework'" })
    );
  });
});

describe('stored values', () => {
  it('stores the description trimmed, as it was checked', () => {
    const registry = build();

    registry.register({
      tier: 'app',
      sources: [{ ...VALID, description: `  ${VALID.description}\n` }],
    });

    expect(registry.sources()).toEqual([VALID]);
  });
});
