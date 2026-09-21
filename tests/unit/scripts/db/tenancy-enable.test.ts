/**
 * Tests: scripts/db/tenancy-enable.ts — the switch's CLI shell (§107 t-707).
 *
 * The switch itself (`runTenancySwitch`) is tested in
 * `tests/unit/lib/tenancy/isolation.test.ts`; this pins what the script adds
 * around it: the flag → mode, the DSN preference (`MIGRATE_DATABASE_URL`
 * over `DATABASE_URL`), one transaction around the run with ROLLBACK on
 * failure, the per-table / summary output, and the exit codes — 0 done, 1
 * the database did not reach the requested state, 2 could not run.
 *
 * `pg`'s Client and the switch are mocked; the script is driven by dynamic
 * import the way `rechunk-doc.test.ts` does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn());
const mockEnd = vi.hoisted(() => vi.fn());
vi.mock('pg', () => ({
  Client: vi.fn(function (this: { query: unknown; connect: unknown; end: unknown }) {
    this.query = mockQuery;
    this.connect = mockConnect;
    this.end = mockEnd;
  }),
}));

const mockRun = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/isolation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/isolation')>()),
  runTenancySwitch: mockRun,
}));

vi.mock('@/lib/db/client', () => ({ prisma: { __type: 'app-client' } }));
const mockRoster = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/classification', () => ({ tenantOwnedModels: mockRoster }));

const mockInfo = vi.hoisted(() => vi.fn());
const mockError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging', () => ({
  logger: { info: mockInfo, error: mockError, warn: vi.fn(), debug: vi.fn() },
}));

import { Client } from 'pg';

const report = (mode: 'enable' | 'disable', statements: string[][], backfilled = [0, 0]) => ({
  mode,
  entries: ['ai_agent', 'ai_api_key'].map((table, i) => ({
    table,
    before: { table, enabled: false, forced: false },
    after: { table, enabled: true, forced: true },
    statements: statements[i],
    backfilled: backfilled[i],
  })),
  noop: statements.every((s) => s.length === 0),
});

describe('scripts/db/tenancy-enable', () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const env = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    originalArgv = [...process.argv];
    process.env.DATABASE_URL = 'postgresql://app:pw@localhost:5432/db';
    delete process.env.MIGRATE_DATABASE_URL;
    mockRoster.mockReturnValue(
      new Map([
        ['AiAgent', 'ai_agent'],
        ['AiApiKey', 'ai_api_key'],
      ])
    );
    mockQuery.mockResolvedValue({ rows: [], rowCount: null });
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = { ...env };
    exitSpy.mockRestore();
  });

  async function run(...args: string[]): Promise<void> {
    process.argv = ['node', 'scripts/db/tenancy-enable.ts', ...args];
    await import('@/scripts/db/tenancy-enable');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it('--enable: connects with the owner DSN, runs the switch in one transaction, reports, exits 0', async () => {
    process.env.MIGRATE_DATABASE_URL = 'postgresql://owner:pw@localhost:5432/db';
    mockRun.mockResolvedValue(
      report(
        'enable',
        [
          [
            'ALTER TABLE "ai_agent" ENABLE ROW LEVEL SECURITY',
            'ALTER TABLE "ai_agent" FORCE ROW LEVEL SECURITY',
          ],
          [],
        ],
        [2, 0]
      )
    );
    await run('--enable');

    expect(vi.mocked(Client)).toHaveBeenCalledWith({
      connectionString: 'postgresql://owner:pw@localhost:5432/db',
    });
    expect(mockQuery.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT']);
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ query: mockQuery }),
      ['ai_agent', 'ai_api_key'],
      'enable',
      'install'
    );
    expect(mockRoster).toHaveBeenCalledWith({ __type: 'app-client' });
    expect(mockInfo).toHaveBeenCalledWith(
      '  ai_agent: ENABLE ROW LEVEL SECURITY + FORCE ROW LEVEL SECURITY (backfilled 2 NULL orgId)'
    );
    expect(mockInfo.mock.calls.some((c) => String(c[0]).includes('ai_api_key'))).toBe(false);
    expect(mockInfo).toHaveBeenCalledWith('db:tenancy:enable: 1 of 2 tables changed');
    expect(mockEnd).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('--disable passes the mode through; no flag means enable', async () => {
    mockRun.mockResolvedValue(report('disable', [[], []]));
    await run('--disable');
    expect(mockRun.mock.calls[0][2]).toBe('disable');
    expect(vi.mocked(Client)).toHaveBeenCalledWith({
      connectionString: 'postgresql://app:pw@localhost:5432/db',
    });

    vi.resetModules();
    mockRun.mockClear();
    mockRun.mockResolvedValue(report('enable', [[], []]));
    await run();
    expect(mockRun.mock.calls[0][2]).toBe('enable');
  });

  it('a no-op run says so in one line, and still exits 0', async () => {
    mockRun.mockResolvedValue(report('enable', [[], []]));
    await run('--enable');
    expect(mockInfo).toHaveBeenCalledWith(
      'db:tenancy:enable: no change — all 2 tables were already enabled'
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 when the switch reports the database did not reach the requested state, after ROLLBACK', async () => {
    mockRun.mockRejectedValue(
      new Error('After enable, ai_agent did not reach the requested state')
    );
    await run('--enable');
    expect(mockQuery.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('did not reach'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 2 when it could not run — no DSN, a bad flag, a connection failure', async () => {
    delete process.env.DATABASE_URL;
    await run('--enable');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockConnect).not.toHaveBeenCalled();

    vi.resetModules();
    exitSpy.mockClear();
    process.env.DATABASE_URL = 'postgresql://app:pw@localhost:5432/db';
    await run('--sideways');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('--sideways'));

    vi.resetModules();
    exitSpy.mockClear();
    mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await run('--enable');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
