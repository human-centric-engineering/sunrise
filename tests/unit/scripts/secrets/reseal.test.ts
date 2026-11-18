/**
 * Tests: scripts/secrets/reseal.ts — the reseal walk's CLI shell (t-1043).
 *
 * The walk itself (`resealSealedStores`) is tested in
 * `tests/unit/lib/security/sealed-stores.test.ts`. This pins what the script
 * adds: the exit codes an operator decides on (0 safe to remove old keys,
 * 1 not yet, 2 could not start) and the summary line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SealedStoresResealReport } from '@/lib/security/sealed-stores';

const mockReseal = vi.hoisted(() => vi.fn());
vi.mock('@/lib/security/sealed-stores', () => ({ resealSealedStores: mockReseal }));

const mockInfo = vi.hoisted(() => vi.fn());
const mockError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging', () => ({
  logger: { info: mockInfo, error: mockError, warn: vi.fn(), debug: vi.fn() },
}));

function report(overrides: Partial<SealedStoresResealReport> = {}): SealedStoresResealReport {
  return { dryRun: false, activeKeyId: 'k2026', stores: [], ok: true, ...overrides };
}

const STORE = {
  store: 'crm',
  scanned: 2,
  alreadyCurrent: 0,
  resealed: 2,
  changedMeanwhile: 0,
  failed: [],
};

describe('scripts/secrets/reseal', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const argv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.argv = ['node', 'reseal.ts'];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.argv = argv;
  });

  async function run(): Promise<void> {
    await import('@/scripts/secrets/reseal');
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
  }

  it('exits 0 and says every value is on the active key after a clean run', async () => {
    mockReseal.mockResolvedValue(report({ stores: [STORE] }));
    await run();

    expect(mockReseal).toHaveBeenCalledWith({ dryRun: false });
    expect(mockInfo).toHaveBeenCalledWith(
      'secrets:reseal crm',
      expect.objectContaining({ scanned: 2, resealed: 2, failed: [] })
    );
    expect(mockInfo).toHaveBeenCalledWith(
      'secrets:reseal done: every value is on key "k2026".',
      expect.anything()
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('passes --dry-run through and reports what would move', async () => {
    process.argv = ['node', 'reseal.ts', '--dry-run'];
    mockReseal.mockResolvedValue(report({ dryRun: true, stores: [STORE] }));
    await run();

    expect(mockReseal).toHaveBeenCalledWith({ dryRun: true });
    expect(mockInfo).toHaveBeenCalledWith(
      'secrets:reseal crm',
      expect.objectContaining({ wouldReseal: 2 })
    );
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('dry run: every value can move onto key "k2026"'),
      expect.anything()
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('says there was nothing to move when no store is registered', async () => {
    mockReseal.mockResolvedValue(report());
    await run();

    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('no sealed stores are registered'),
      expect.anything()
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 and warns against removing a key when a value did not move', async () => {
    mockReseal.mockResolvedValue(
      report({
        ok: false,
        stores: [{ ...STORE, resealed: 1, failed: [{ id: 'row-9', reason: 'mismatch' }] }],
      })
    );
    await run();

    expect(mockInfo).toHaveBeenCalledWith(
      'secrets:reseal crm',
      expect.objectContaining({ failed: [{ id: 'row-9', reason: 'mismatch' }] })
    );
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('Do not remove an old key'),
      expect.anything()
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(0);
  });

  it('includes a store error in that store’s line', async () => {
    mockReseal.mockResolvedValue(
      report({ ok: false, stores: [{ ...STORE, scanned: 0, resealed: 0, error: 'db down' }] })
    );
    await run();

    expect(mockInfo).toHaveBeenCalledWith(
      'secrets:reseal crm',
      expect.objectContaining({ error: 'db down' })
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 2 with the reason when the walk refuses to start', async () => {
    mockReseal.mockRejectedValue(new Error('No sealed-secret keyring is configured'));
    await run();

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('could not start'));
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('No sealed-secret keyring'));
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('exits 2, not 1, when the environment refuses to load', async () => {
    // Stands in for lib/env.ts throwing at import on a malformed keyring.
    vi.doMock('@/lib/security/sealed-stores', () => {
      throw new Error('Environment validation failed');
    });
    await run();
    vi.doUnmock('@/lib/security/sealed-stores');

    expect(mockReseal).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});
