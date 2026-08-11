/**
 * Tests for the `libc` repair CLI.
 *
 * The rules are covered in `lockfile-libc.test.ts`; this covers the wiring —
 * what reaches the network, what gets written, and what refuses to write.
 *
 * `readFileSync` is armed to throw and `fetch` is stubbed to reject before the
 * module is ever imported, because importing it runs `main` at module scope
 * (the `check-lockfile.ts` convention). Without both, a test run would hit the
 * real registry 1,252 times.
 *
 * @see scripts/ci/fix-lockfile-libc.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  default: { readFileSync: mockReadFileSync, writeFileSync: mockWriteFileSync },
}));

const REG = 'https://registry.npmjs.org/';

/** A lockfile whose text round-trips, as the real one does. */
function lockText(packages: Record<string, unknown>): string {
  return JSON.stringify({ lockfileVersion: 3, packages }, null, 2) + '\n';
}

const ONE_BARE_PACKAGE = lockText({
  '': { version: '0.9.0' },
  'node_modules/musl-pkg': {
    version: '1.0.0',
    resolved: `${REG}musl-pkg/-/musl-pkg-1.0.0.tgz`,
    cpu: ['x64'],
    os: ['linux'],
  },
});

const packument = (version: string, libc: unknown): unknown => ({
  versions: { [version]: { name: 'musl-pkg', version, libc } },
});

type CliModule = typeof import('@/scripts/ci/fix-lockfile-libc');

describe('scripts/ci/fix-lockfile-libc', () => {
  let originalExitCode: typeof process.exitCode;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function out(): string {
    return [...errorSpy.mock.calls, ...logSpy.mock.calls]
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
  }

  async function load(): Promise<CliModule> {
    vi.resetModules();
    return import('@/scripts/ci/fix-lockfile-libc');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = 0;
    // Armed to fail: the module-scope run must not read a real file...
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    // ...nor reach a real registry.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network disabled in tests')))
    );
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.unstubAllGlobals();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  describe('packumentUrl', () => {
    it('encodes the scope separator so the registry sees one path segment', async () => {
      const { packumentUrl } = await load();
      expect(packumentUrl('@img/sharp-linux-x64')).toBe(`${REG}@img%2Fsharp-linux-x64`);
    });

    it('leaves an unscoped name alone', async () => {
      const { packumentUrl } = await load();
      expect(packumentUrl('lightningcss')).toBe(`${REG}lightningcss`);
    });
  });

  describe('libcByVersion', () => {
    it('indexes libc per version', async () => {
      const { libcByVersion } = await load();
      const index = libcByVersion({
        versions: { '1.0.0': { libc: 'musl' }, '2.0.0': { libc: ['glibc'] } },
      });
      expect([...index]).toEqual([
        ['1.0.0', 'musl'],
        ['2.0.0', ['glibc']],
      ]);
    });

    it('omits versions that declare nothing', async () => {
      const { libcByVersion } = await load();
      expect(libcByVersion({ versions: { '1.0.0': {} } }).size).toBe(0);
    });

    it.each([
      ['a 404 body', null],
      ['a non-object', 'nope'],
      ['a document with no versions', {}],
      ['a non-object versions block', { versions: 'nope' }],
      ['a null version manifest', { versions: { '1.0.0': null } }],
    ])('returns an empty index for %s', async (_label, input) => {
      const { libcByVersion } = await load();
      expect(libcByVersion(input).size).toBe(0);
    });
  });

  describe('fetchPackument', () => {
    it('returns null for a package that does not exist', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve({ ok: false, status: 404 }))
      );
      const { fetchPackument } = await load();
      await expect(fetchPackument('nope')).resolves.toBeNull();
    });

    it('retries a transient failure rather than leaving the package bare', async () => {
      const doc = { versions: {} };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(doc) });
      vi.stubGlobal('fetch', fetchMock);
      const { fetchPackument } = await load();
      await expect(fetchPackument('flaky')).resolves.toEqual(doc);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting its attempts', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(new Error('ECONNRESET')))
      );
      const { fetchPackument } = await load();
      await expect(fetchPackument('down', 2)).rejects.toThrow('registry fetch failed for down');
    });
  });

  describe('buildLookup', () => {
    it('answers per name and version', async () => {
      const { buildLookup } = await load();
      const lookup = await buildLookup(
        ['a'],
        () => Promise.resolve({ versions: { '1.0.0': { libc: 'musl' } } }),
        2
      );
      expect(lookup('a', '1.0.0')).toBe('musl');
      expect(lookup('a', '9.9.9')).toBeUndefined();
      expect(lookup('unknown', '1.0.0')).toBeUndefined();
    });

    it('fetches each name exactly once', async () => {
      const { buildLookup } = await load();
      const fetcher = vi.fn(() => Promise.resolve({ versions: {} }));
      await buildLookup(['a', 'b', 'c'], fetcher, 2);
      expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('does not deadlock when asked for zero concurrency', async () => {
      const { buildLookup } = await load();
      const lookup = await buildLookup(
        ['a'],
        () => Promise.resolve({ versions: { '1.0.0': { libc: 'musl' } } }),
        0
      );
      expect(lookup('a', '1.0.0')).toBe('musl');
    });
  });

  describe('main', () => {
    const fetcher = (): Promise<unknown> => Promise.resolve(packument('1.0.0', 'musl'));

    it('writes the restored lockfile and reports what changed', async () => {
      mockReadFileSync.mockReturnValue(ONE_BARE_PACKAGE);
      const { main } = await load();

      expect(await main([], fetcher)).toBe(0);
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);

      const written = JSON.parse(String(mockWriteFileSync.mock.calls[0][1])) as {
        packages: Record<string, { libc?: string[] }>;
      };
      expect(written.packages['node_modules/musl-pkg'].libc).toEqual(['musl']);
      expect(out()).toContain('1 libc field(s) restored');
    });

    it('writes text that round-trips, so the next run is a no-op', async () => {
      mockReadFileSync.mockReturnValue(ONE_BARE_PACKAGE);
      const { main } = await load();
      await main([], fetcher);

      const written = String(mockWriteFileSync.mock.calls[0][1]);
      expect(JSON.stringify(JSON.parse(written), null, 2) + '\n').toBe(written);
    });

    it('reports without writing under --check, and exits non-zero', async () => {
      mockReadFileSync.mockReturnValue(ONE_BARE_PACKAGE);
      const { main } = await load();

      expect(await main(['--check'], fetcher)).toBe(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(out()).toContain('npm run fix:lockfile-libc');
    });

    it('exits 0 and writes nothing when every declared libc is present', async () => {
      mockReadFileSync.mockReturnValue(
        lockText({
          'node_modules/musl-pkg': {
            version: '1.0.0',
            resolved: `${REG}musl-pkg/-/musl-pkg-1.0.0.tgz`,
            libc: ['musl'],
          },
        })
      );
      const { main } = await load();

      expect(await main(['--check'], fetcher)).toBe(0);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('refuses to write a lockfile that does not survive a round-trip', async () => {
      // Four-space indent: writing would reformat all 1,538 entries and bury
      // the libc additions in the diff.
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ packages: { '': { version: '0.9.0' } } }, null, 4) + '\n'
      );
      const { main } = await load();

      expect(await main([], fetcher)).toBe(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(out()).toContain('does not survive a JSON round-trip');
    });

    it('refuses to overwrite a value that disagrees with the registry', async () => {
      mockReadFileSync.mockReturnValue(
        lockText({
          'node_modules/musl-pkg': {
            version: '1.0.0',
            resolved: `${REG}musl-pkg/-/musl-pkg-1.0.0.tgz`,
            libc: ['glibc'],
          },
        })
      );
      const { main } = await load();

      expect(await main([], fetcher)).toBe(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(out()).toContain('registry says ["musl"]');
    });

    it('writes nothing when the registry could not be reached', async () => {
      // A partial index reads exactly like "these packages declare no libc",
      // which would bake the bug in rather than fix it.
      mockReadFileSync.mockReturnValue(ONE_BARE_PACKAGE);
      const { main } = await load();

      expect(await main([], () => Promise.reject(new Error('ECONNRESET')))).toBe(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(out()).toContain('Nothing written');
    });

    it('reports a missing lockfile', async () => {
      const { main } = await load();
      expect(await main([], fetcher)).toBe(1);
      expect(out()).toContain('Could not read package-lock.json');
    });

    it('reports an unparseable lockfile', async () => {
      mockReadFileSync.mockReturnValue('{ not json');
      const { main } = await load();
      expect(await main([], fetcher)).toBe(1);
      expect(out()).toContain('Could not parse package-lock.json');
    });
  });

  describe('module entry point', () => {
    it('sets a non-zero exit code when the run fails', async () => {
      process.argv = ['node', 'fix-lockfile-libc.ts', '--check'];
      await load();
      // The module-scope run reads through the throwing mock and bails.
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      expect(out()).toContain('Could not read package-lock.json');
    });
  });
});
