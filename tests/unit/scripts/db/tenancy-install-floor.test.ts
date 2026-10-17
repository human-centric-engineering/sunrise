/**
 * Tests: scripts/db/tenancy-install-floor.ts — the backfill's CLI shell (t-835).
 *
 * The backfill itself (`backfillInstallMemberships`) is tested in
 * `tests/unit/lib/tenancy/membership.test.ts`; this pins what the script adds
 * around it: the report line, the disconnect, and the exit codes — 0 done
 * (or nothing to do), 2 could not run (refused at `multi`, or a database
 * error).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockDisconnect = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ prisma: { $disconnect: mockDisconnect } }));

const mockBackfill = vi.hoisted(() => vi.fn());
vi.mock('@/lib/tenancy/membership', () => ({ backfillInstallMemberships: mockBackfill }));

const mockInfo = vi.hoisted(() => vi.fn());
const mockError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logging', () => ({
  logger: { info: mockInfo, error: mockError, warn: vi.fn(), debug: vi.fn() },
}));

describe('scripts/db/tenancy-install-floor', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockDisconnect.mockResolvedValue(undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  async function run(): Promise<void> {
    await import('@/scripts/db/tenancy-install-floor');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it('reports how many rows it added and exits 0', async () => {
    mockBackfill.mockResolvedValue({ written: 3 });
    await run();

    expect(mockInfo).toHaveBeenCalledWith(
      'db:tenancy:install-floor: added 3 install-org membership(s)'
    );
    expect(mockDisconnect).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('reports "no change" when nobody was missing one, and exits 0', async () => {
    mockBackfill.mockResolvedValue({ written: 0 });
    await run();

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('no change'));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 2 with the reason when the backfill refuses (multi) or fails', async () => {
    mockBackfill.mockRejectedValue(new Error('Refusing to backfill ... at TENANCY_MODE=multi'));
    await run();

    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('TENANCY_MODE=multi'));
    expect(mockDisconnect).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
