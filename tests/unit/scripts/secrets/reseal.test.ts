/**
 * Tests: scripts/secrets/reseal.ts — the reseal walk's CLI shell (t-1043).
 *
 * The walk itself (`resealSealedStores`) is tested in
 * `tests/unit/lib/security/sealed-stores.test.ts`. This pins what the script
 * adds: the exit codes an operator decides on (0 safe to remove old keys,
 * 1 not yet, 2 could not start), that the report is printed rather than
 * logged (so `LOG_LEVEL` cannot hide it), and that a mistyped or swallowed
 * `--dry-run` never turns into a writing run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SealedStoresResealReport } from '@/lib/security/sealed-stores';

const mockReseal = vi.hoisted(() => vi.fn());
vi.mock('@/lib/security/sealed-stores', () => ({ resealSealedStores: mockReseal }));

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
  let stdout: string[];
  let stderr: string[];
  const argv = process.argv;
  const npmDryRun = process.env.npm_config_dry_run;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.argv = ['node', 'reseal.ts'];
    delete process.env.npm_config_dry_run;
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.argv = argv;
    if (npmDryRun === undefined) delete process.env.npm_config_dry_run;
    else process.env.npm_config_dry_run = npmDryRun;
  });

  async function run(...args: string[]): Promise<void> {
    process.argv = ['node', 'reseal.ts', ...args];
    await import('@/scripts/secrets/reseal');
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
  }

  function storeLines(): Array<Record<string, unknown>> {
    return stdout
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('prints each store and a clean summary, and exits 0', async () => {
    mockReseal.mockResolvedValue(report({ stores: [STORE] }));
    await run();

    expect(mockReseal).toHaveBeenCalledWith({ dryRun: false });
    expect(storeLines()).toEqual([
      expect.objectContaining({ store: 'crm', scanned: 2, resealed: 2, failed: [] }),
    ]);
    expect(stdout.at(-1)).toBe('secrets:reseal done: every value is on key "k2026".\n');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('reports what a dry run would move', async () => {
    mockReseal.mockResolvedValue(report({ dryRun: true, stores: [STORE] }));
    await run('--dry-run');

    expect(mockReseal).toHaveBeenCalledWith({ dryRun: true });
    expect(storeLines()[0]).toMatchObject({ wouldReseal: 2 });
    expect(stdout.at(-1)).toContain('dry run: every value can move onto key "k2026"');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('treats --dry-run that npm swallowed (no "--") as the dry run it was meant to be', async () => {
    process.env.npm_config_dry_run = 'true';
    mockReseal.mockResolvedValue(report({ dryRun: true, stores: [STORE] }));
    await run();

    expect(mockReseal).toHaveBeenCalledWith({ dryRun: true });
  });

  it.each([['--dryrun'], ['-n'], ['--dry-run', '--force']])(
    'refuses an argument it does not know (%s) without running anything',
    async (...args) => {
      await run(...args);

      expect(mockReseal).not.toHaveBeenCalled();
      expect(stderr.join('')).toContain('unknown argument');
      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(exitSpy).toHaveBeenCalledTimes(1);
    }
  );

  it('says there was nothing to move when no store is registered', async () => {
    mockReseal.mockResolvedValue(report());
    await run();

    expect(stdout.at(-1)).toContain('no sealed stores are registered');
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

    expect(storeLines()[0]).toMatchObject({ failed: [{ id: 'row-9', reason: 'mismatch' }] });
    expect(stdout.at(-1)).toContain('Do not remove an old key');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(exitSpy).not.toHaveBeenCalledWith(0);
  });

  it('exits 1 and says to run it again when values only changed under it', async () => {
    mockReseal.mockResolvedValue(
      report({ ok: false, stores: [{ ...STORE, resealed: 1, changedMeanwhile: 1 }] })
    );
    await run();

    expect(stdout.at(-1)).toContain('1 value(s) changed during the run');
    expect(stdout.at(-1)).toContain('Run it again');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('includes a store error in that store’s line', async () => {
    mockReseal.mockResolvedValue(
      report({ ok: false, stores: [{ ...STORE, scanned: 0, resealed: 0, error: 'db down' }] })
    );
    await run();

    expect(storeLines()[0]).toMatchObject({ error: 'db down' });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 2 with the reason when the walk refuses to start', async () => {
    mockReseal.mockRejectedValue(new Error('No sealed-secret keyring is configured'));
    await run();

    expect(stderr.join('')).toContain('could not start: No sealed-secret keyring');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('exits 2, not 1, naming the cause, when a module refuses to load', async () => {
    // Stands in for lib/env.ts throwing at import, or a fork's store module
    // failing to load.
    vi.doMock('@/lib/security/sealed-stores', () => {
      throw new Error('Environment validation failed');
    });
    await run();
    vi.doUnmock('@/lib/security/sealed-stores');

    expect(mockReseal).not.toHaveBeenCalled();
    // The cause is named (vitest wraps a throwing factory in its own message,
    // so assert the shape: the error's name, then its message).
    expect(stderr.join('')).toMatch(/could not start: \w*Error: .+/);
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});
