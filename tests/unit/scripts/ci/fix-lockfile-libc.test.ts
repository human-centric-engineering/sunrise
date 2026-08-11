/**
 * Tests for the `libc` repair CLI.
 *
 * The rules are covered in `lockfile-libc.test.ts`; this covers the wiring —
 * what reaches the network, what gets written, and what refuses to write.
 *
 * `readFileSync` is armed to throw and `fetch` is stubbed to reject before the
 * module is ever imported. That is belt and braces now that `isDirectRun`
 * guards the module-scope call — but the guard is the thing under test in one
 * of these cases, so the net stays up: without it, a run that regressed the
 * guard would quietly hit the real registry 1,252 times and rewrite the repo's
 * own lockfile instead of failing.
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

const manifest = (version: string, libc: unknown): unknown => ({
  name: 'musl-pkg',
  version,
  libc,
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

  describe('manifestUrl', () => {
    it('asks for one version, not the whole packument', async () => {
      // The packument form downloaded a package's entire publish history to
      // read one field — 37 MB for `vite`, which killed two full sweeps.
      const { manifestUrl } = await load();
      expect(manifestUrl('vite', '7.3.2')).toBe(`${REG}vite/7.3.2`);
    });

    it('percent-encodes the whole name, scope separator included', async () => {
      const { manifestUrl } = await load();
      // Verified 200 against the real registry for this exact form.
      expect(manifestUrl('@img/sharp-linux-x64', '0.34.5')).toBe(
        `${REG}%40img%2Fsharp-linux-x64/0.34.5`
      );
    });

    it.each([
      ['a path segment', '1.0.0/../../evil'],
      ['a query string', '1.0.0?x=1'],
      ['a non-semver string', 'latest'],
      ['an empty version', ''],
    ])('throws on %s in the version', async (_label, version) => {
      const { manifestUrl } = await load();
      expect(() => manifestUrl('pkg', version)).toThrow('malformed version');
    });

    it('accepts prerelease and build metadata', async () => {
      const { manifestUrl } = await load();
      expect(manifestUrl('vite', '7.0.0-beta.0')).toBe(`${REG}vite/7.0.0-beta.0`);
      expect(manifestUrl('pkg', '1.0.0+build.1')).toBe(`${REG}pkg/1.0.0%2Bbuild.1`);
    });

    it.each([
      ['a second slash', '@scope/a/b'],
      ['parent traversal', '../../etc/passwd'],
      ['an absolute URL', 'https://evil.com/x'],
      ['a protocol-relative host', '//evil.com/x'],
      ['CRLF header injection', 'pkg\r\nHost: evil.com'],
    ])('throws on %s rather than encoding it', async (_label, name) => {
      const { manifestUrl } = await load();
      expect(() => manifestUrl(name, '1.0.0')).toThrow('malformed package name');
    });

    it('never lets a crafted name move the host off the registry', async () => {
      // CodeQL flagged the previous `name.replace('/', '%2F')` as incomplete
      // sanitization. The name comes from a lockfile key, so the one-slash
      // assumption it was written on was never enforced anywhere.
      const { manifestUrl } = await load();
      expect(new URL(manifestUrl('@scope/pkg', '1.0.0')).host).toBe('registry.npmjs.org');
      expect(new URL(manifestUrl('pkg', '1.0.0')).host).toBe('registry.npmjs.org');
    });
  });

  describe('isDirectRun', () => {
    it.each([
      ['scripts/ci/fix-lockfile-libc.ts'],
      ['/abs/path/scripts/ci/fix-lockfile-libc.ts'],
      ['C:\\repo\\scripts\\ci\\fix-lockfile-libc.js'],
    ])('recognises %s as the script being run', async (argv1) => {
      const { isDirectRun } = await load();
      expect(isDirectRun(argv1)).toBe(true);
    });

    it.each([
      ['undefined', undefined],
      ['another script importing this module', '/abs/path/scripts/ci/check-lockfile.ts'],
      ['the vitest runner', '/abs/path/node_modules/vitest/vitest.mjs'],
      ['a lookalike suffix', '/abs/path/not-fix-lockfile-libc.ts.bak'],
    ])('does not fire for %s', async (_label, argv1) => {
      const { isDirectRun } = await load();
      expect(isDirectRun(argv1)).toBe(false);
    });

    it('does not read or write anything when merely imported', async () => {
      // Importing used to run `main` with the importer's argv and cwd — 1,252
      // registry requests and a writeFileSync over a tracked file. Every
      // helper here is exported, which invites exactly that import.
      process.argv = ['node', '/abs/path/some-other-script.ts'];
      mockReadFileSync.mockReturnValue(ONE_BARE_PACKAGE);
      await load();
      await new Promise((r) => setTimeout(r, 0));

      expect(mockReadFileSync).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe('libcOf', () => {
    it('reads libc off a version manifest', async () => {
      const { libcOf } = await load();
      expect(libcOf({ name: 'x', version: '1.0.0', libc: 'musl' })).toBe('musl');
      expect(libcOf({ name: 'x', version: '1.0.0', libc: ['glibc'] })).toEqual(['glibc']);
    });

    it.each([
      ['a manifest declaring nothing', {}],
      ['a 404 body', null],
      ['a non-object', 'nope'],
    ])('returns undefined for %s', async (_label, input) => {
      const { libcOf } = await load();
      expect(libcOf(input)).toBeUndefined();
    });
  });

  describe('fetchManifest', () => {
    it('returns null for a package that does not exist', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve({ ok: false, status: 404 }))
      );
      const { fetchManifest } = await load();
      await expect(fetchManifest('nope', '1.0.0')).resolves.toBeNull();
    });

    it('bounds every request with a timeout signal', async () => {
      // Node's fetch has no default timeout, so a stalled socket parked a
      // worker forever and the retry loop never got a turn — observed as a
      // run of this script hanging past ten minutes.
      const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
      vi.stubGlobal('fetch', fetchMock);
      const { fetchManifest } = await load();
      await fetchManifest('pkg', '1.0.0');

      const [, init] = fetchMock.mock.calls[0] as unknown as [string, { signal?: AbortSignal }];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('keeps retrying past the third attempt', async () => {
      // Three attempts at 250/500/750ms all landed inside the same ~1.5s
      // window; two consecutive real sweeps died on it, on different packages.
      const doc = { versions: {} };
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(doc) });
      vi.stubGlobal('fetch', fetchMock);
      const { fetchManifest } = await load();

      await expect(fetchManifest('flaky', '1.0.0', 5, 0)).resolves.toEqual(doc);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('does not retry a malformed name — that is the lockfile, not the network', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { fetchManifest } = await load();

      await expect(fetchManifest('@scope/a/b', '1.0.0', 5, 0)).rejects.toThrow(
        'malformed package name'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('retries a transient failure rather than leaving the package bare', async () => {
      const doc = { versions: {} };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(doc) });
      vi.stubGlobal('fetch', fetchMock);
      const { fetchManifest } = await load();
      await expect(fetchManifest('flaky', '1.0.0')).resolves.toEqual(doc);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting its attempts', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(new Error('ECONNRESET')))
      );
      const { fetchManifest } = await load();
      await expect(fetchManifest('down', '1.0.0', 2, 0)).rejects.toThrow(
        'registry fetch failed for down'
      );
    });
  });

  describe('buildLookup', () => {
    const musl = (): Promise<unknown> => Promise.resolve({ libc: 'musl' });

    it('answers per name and version', async () => {
      const { buildLookup } = await load();
      const lookup = await buildLookup([{ name: 'a', version: '1.0.0' }], musl, 2);
      expect(lookup('a', '1.0.0')).toBe('musl');
      expect(lookup('a', '9.9.9')).toBeUndefined();
      expect(lookup('unknown', '1.0.0')).toBeUndefined();
    });

    it('keys on version, so one package at two versions gets two answers', async () => {
      // Real case: @napi-rs/canvas sits at 0.1.80 and 1.0.3 in this tree, and
      // `libc` is a per-version fact.
      const { buildLookup } = await load();
      const lookup = await buildLookup(
        [
          { name: 'dual', version: '1.0.0' },
          { name: 'dual', version: '2.0.0' },
        ],
        (_name, version) => Promise.resolve({ libc: version === '1.0.0' ? 'glibc' : 'musl' }),
        2
      );
      expect(lookup('dual', '1.0.0')).toBe('glibc');
      expect(lookup('dual', '2.0.0')).toBe('musl');
    });

    it('fetches each name@version exactly once, even when listed twice', async () => {
      const { buildLookup } = await load();
      const fetcher = vi.fn(() => Promise.resolve({}));
      await buildLookup(
        [
          { name: 'a', version: '1.0.0' },
          { name: 'a', version: '1.0.0' },
          { name: 'b', version: '1.0.0' },
        ],
        fetcher,
        2
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('does not deadlock when asked for zero concurrency', async () => {
      const { buildLookup } = await load();
      const lookup = await buildLookup([{ name: 'a', version: '1.0.0' }], musl, 0);
      expect(lookup('a', '1.0.0')).toBe('musl');
    });
  });

  describe('main', () => {
    const fetcher = (): Promise<unknown> => Promise.resolve(manifest('1.0.0', 'musl'));

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

    it('does not claim "registry declares none" about packages it never queried', async () => {
      // A fork with a private-registry native package was told its lockfile
      // was complete, because linuxWithoutLibc walks entries libcCandidates
      // deliberately skips.
      mockReadFileSync.mockReturnValue(
        lockText({
          'node_modules/musl-pkg': {
            version: '1.0.0',
            resolved: `${REG}musl-pkg/-/musl-pkg-1.0.0.tgz`,
            os: ['linux'],
          },
          'node_modules/@acme/native-linux-musl': {
            version: '1.0.0',
            resolved: 'https://npm.internal.example/@acme/native-linux-musl/-/x.tgz',
            os: ['linux'],
          },
        })
      );
      const { main } = await load();
      await main([], fetcher);

      expect(out()).toContain('not checked, so unknown');
      expect(out()).toContain('@acme/native-linux-musl@1.0.0');
    });

    it('does not sign off as "complete" while holding unchecked entries', async () => {
      // Nothing to restore, so the sign-off line is reached — and it must not
      // claim completeness over a package the registry was never asked about.
      mockReadFileSync.mockReturnValue(
        lockText({
          'node_modules/musl-pkg': {
            version: '1.0.0',
            resolved: `${REG}musl-pkg/-/musl-pkg-1.0.0.tgz`,
            libc: ['musl'],
            os: ['linux'],
          },
          'node_modules/@acme/native-linux-musl': {
            version: '1.0.0',
            resolved: 'https://npm.internal.example/@acme/native-linux-musl/-/x.tgz',
            os: ['linux'],
          },
        })
      );
      const { main } = await load();

      expect(await main(['--check'], fetcher)).toBe(0);
      expect(out()).toContain('complete for everything checked');
      expect(out()).not.toContain('every registry-declared libc is present');
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
      process.argv = ['node', 'scripts/ci/fix-lockfile-libc.ts', '--check'];
      await load();
      // The guarded module-scope run reads through the throwing mock and bails.
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      expect(out()).toContain('Could not read package-lock.json');
    });
  });
});
