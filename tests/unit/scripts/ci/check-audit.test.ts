/**
 * Tests for the scheduled audit CLI.
 *
 * The rules are covered in `audit-advisories.test.ts`; this covers the wiring —
 * what fails the job, what refuses to claim a clean tree, and what is written
 * where.
 *
 * @see scripts/ci/check-audit.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockAppendFileSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('node:fs', () => ({
  appendFileSync: mockAppendFileSync,
  default: { appendFileSync: mockAppendFileSync },
}));
vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  default: { execFileSync: mockExecFileSync },
}));

type CliModule = typeof import('@/scripts/ci/check-audit');

/** npm's `auditReportVersion: 2` envelope. */
const report = (vulnerabilities: Record<string, unknown> = {}): string =>
  JSON.stringify({ auditReportVersion: 2, vulnerabilities });

const FIXABLE_HIGH = report({
  next: {
    name: 'next',
    severity: 'high',
    isDirect: true,
    fixAvailable: { name: 'next', version: '16.3.0', isSemVerMajor: false },
    via: [{ title: 'Next.js SSRF' }],
  },
});

const UNFIXABLE_HIGH = report({
  'adm-zip': { name: 'adm-zip', severity: 'high', isDirect: false, fixAvailable: false },
});

describe('scripts/ci/check-audit', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function out(): string {
    return [...errorSpy.mock.calls, ...logSpy.mock.calls]
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
  }

  async function load(): Promise<CliModule> {
    vi.resetModules();
    return import('@/scripts/ci/check-audit');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Armed to fail: importing the module must not shell out to npm.
    mockExecFileSync.mockImplementation(() => {
      throw new Error('npm should not be spawned on import');
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  describe('parseFloor', () => {
    it('defaults to high', async () => {
      const { parseFloor } = await load();
      expect(parseFloor([])).toEqual({ ok: true, floor: 'high' });
    });

    it('accepts a named severity', async () => {
      const { parseFloor } = await load();
      expect(parseFloor(['--floor=critical'])).toEqual({ ok: true, floor: 'critical' });
    });

    it('rejects an unknown severity instead of silently defaulting', async () => {
      // Silently falling back to `high` on a typo would run a different check
      // than the one asked for, and report success for it.
      const { parseFloor } = await load();
      expect(parseFloor(['--floor=severe'])).toEqual({ ok: false, bad: 'severe' });
    });
  });

  describe('isDirectRun', () => {
    it.each([
      ['scripts/ci/check-audit.ts'],
      ['/abs/path/scripts/ci/check-audit.ts'],
      ['C:\\repo\\scripts\\ci\\check-audit.js'],
    ])('recognises %s', async (argv1) => {
      const { isDirectRun } = await load();
      expect(isDirectRun(argv1)).toBe(true);
    });

    it.each([
      ['undefined', undefined],
      ['a module importing this one', '/abs/path/scripts/ci/check-lockfile.ts'],
      ['the vitest runner', '/abs/path/node_modules/vitest/vitest.mjs'],
    ])('does not fire for %s', async (_label, argv1) => {
      const { isDirectRun } = await load();
      expect(isDirectRun(argv1)).toBe(false);
    });

    it('does not spawn npm when merely imported', async () => {
      process.argv = ['node', '/abs/path/some-other-script.ts'];
      await load();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('npmEntry', () => {
    it('uses npm_execpath when npm set it', async () => {
      const { npmEntry } = await load();
      expect(npmEntry({ npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' })).toBe(
        '/usr/lib/node_modules/npm/bin/npm-cli.js'
      );
    });

    it('refuses a non-JS npm_execpath rather than handing node a .cmd', async () => {
      // On Windows npm_execpath can point at npm.cmd, which `node` cannot run
      // — and spawning it needs a shell (CVE-2024-27980).
      const { npmEntry } = await load();
      expect(() => npmEntry({ npm_execpath: 'C:\\Program Files\\nodejs\\npm.cmd' })).toThrow(
        'npm run check:audit'
      );
    });

    it('says how to run it when the env says nothing', async () => {
      // npm is the ambient tool, not a dependency, so there is nothing to
      // resolve from node_modules — an earlier fallback threw a bare
      // `Cannot find module` here instead of explaining anything.
      const { npmEntry } = await load();
      expect(() => npmEntry({})).toThrow('npm run check:audit');
    });
  });

  describe('main', () => {
    it('fails on a fixable high finding', async () => {
      const { main } = await load();
      expect(main([], () => FIXABLE_HIGH, {})).toBe(1);
      expect(out()).toContain('next');
      expect(out()).toContain('fix available: next@16.3.0');
    });

    it('does not fail on an unfixable high finding', async () => {
      // The measured reason the job gates on fixability: two of this repo's
      // high advisories had no fix, and failing on them forever trains people
      // to ignore the job.
      const { main } = await load();
      expect(main([], () => UNFIXABLE_HIGH, {})).toBe(0);
      expect(out()).toContain('adm-zip');
      expect(out()).toContain('no fix published');
    });

    it('reports a major-only fix without failing on it', async () => {
      const majorOnly = report({
        big: {
          name: 'big',
          severity: 'high',
          isDirect: true,
          fixAvailable: { name: 'big', version: '2.0.0', isSemVerMajor: true },
        },
      });
      const { main } = await load();

      expect(main([], () => majorOnly, {})).toBe(0);
      expect(out()).toContain('big');
      expect(out()).toContain('fix needs a major bump');
    });

    it('does not report an unfixable finding as a clean tree', async () => {
      const { main } = await load();
      main([], () => UNFIXABLE_HIGH, {});
      expect(out()).toContain('No fixable high+ advisories');
      expect(out()).toContain('remain, reported above');
    });

    it('says nothing extra when the tree really is clean', async () => {
      const { main } = await load();
      expect(main([], () => report(), {})).toBe(0);
      expect(out()).toContain('No fixable high+ advisories');
      expect(out()).not.toContain('remain, reported above');
    });

    it('fails on an unreadable report rather than calling it clean', async () => {
      // A shape change in npm's output parses to zero advisories, which is
      // indistinguishable from a clean tree. Green-and-blind is the failure to
      // avoid at all costs here.
      const { main } = await load();
      expect(
        main([], () => JSON.stringify({ auditReportVersion: 1, vulnerabilities: {} }), {})
      ).toBe(1);
      expect(out()).toContain('unrecognised report shape');
    });

    it('reports a registry failure as such, not as an npm format change', async () => {
      // npm emits {"error":{...}} as valid JSON when it cannot reach the
      // registry. That parses, then fails the shape check — so lumping the two
      // together told an operator whose network was down that npm had changed
      // its output format, and printed none of the payload to contradict it.
      const { main } = await load();
      const networkError = JSON.stringify({
        error: { code: 'ENETUNREACH', summary: 'request to registry failed' },
      });

      expect(main([], () => networkError, {})).toBe(1);
      expect(out()).toContain('could not complete');
      expect(out()).toContain('ENETUNREACH');
      expect(out()).toContain('not a clean tree');
      expect(out()).not.toContain('unrecognised report shape');
    });

    it('prints the payload when the shape really is unrecognised', async () => {
      const { main } = await load();
      expect(main([], () => JSON.stringify({ auditReportVersion: 1, somethingElse: {} }), {})).toBe(
        1
      );
      expect(out()).toContain('unrecognised report shape');
      expect(out()).toContain('auditReportVersion');
    });

    it('--report still fails when the audit could not be run at all', async () => {
      // "never fail" was the documented claim and it was wrong: --report is
      // only consulted after the early returns. A fork wiring this into an
      // informational job would get a red on the first registry blip.
      const { main } = await load();
      expect(
        main(
          ['--report'],
          () => {
            throw new Error('spawn ENOENT');
          },
          {}
        )
      ).toBe(1);
    });

    it('fails when npm returns something that is not JSON', async () => {
      const { main } = await load();
      expect(main([], () => 'npm ERR! code ENETUNREACH', {})).toBe(1);
      expect(out()).toContain('did not return JSON');
    });

    it('fails when npm could not be run at all', async () => {
      const { main } = await load();
      expect(
        main(
          [],
          () => {
            throw new Error('spawn ENOENT');
          },
          {}
        )
      ).toBe(1);
      expect(out()).toContain('Could not run `npm audit`');
    });

    it('rejects a bad --floor without running the audit', async () => {
      const run = vi.fn(() => report());
      const { main } = await load();
      expect(main(['--floor=severe'], run, {})).toBe(1);
      expect(run).not.toHaveBeenCalled();
    });

    it('honours a raised floor', async () => {
      const { main } = await load();
      expect(main(['--floor=critical'], () => FIXABLE_HIGH, {})).toBe(0);
    });

    it('--report prints the finding but does not fail', async () => {
      const { main } = await load();
      expect(main(['--report'], () => FIXABLE_HIGH, {})).toBe(0);
      expect(out()).toContain('not failing');
      expect(out()).toContain('next');
    });

    it('writes the markdown summary to the GitHub step summary', async () => {
      const { main } = await load();
      main([], () => FIXABLE_HIGH, { GITHUB_STEP_SUMMARY: '/tmp/summary.md' });

      expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
      const [path, body] = mockAppendFileSync.mock.calls[0] as [string, string];
      expect(path).toBe('/tmp/summary.md');
      expect(body).toContain('# Dependency audit');
      expect(body).toContain('`next`');
    });

    it('writes no summary outside GitHub Actions', async () => {
      const { main } = await load();
      main([], () => FIXABLE_HIGH, {});
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });

    it('still fails on findings when the summary cannot be written', async () => {
      // The summary is cosmetic; the exit code is the security signal.
      mockAppendFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });
      const { main } = await load();
      expect(main([], () => FIXABLE_HIGH, { GITHUB_STEP_SUMMARY: '/tmp/summary.md' })).toBe(1);
      expect(out()).toContain('could not write the step summary');
    });
  });

  describe('runNpmAudit', () => {
    const ENV = { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' };

    it('keeps the JSON npm prints when it exits 1 for finding something', async () => {
      // `npm audit` exits non-zero whenever it finds anything, so treating a
      // non-zero exit as failure would discard the report on exactly the runs
      // that matter.
      const err = Object.assign(new Error('Command failed'), { stdout: FIXABLE_HIGH });
      mockExecFileSync.mockImplementation(() => {
        throw err;
      });
      const { runNpmAudit } = await load();
      expect(runNpmAudit(ENV)).toBe(FIXABLE_HIGH);
    });

    it('rethrows when npm produced no output at all', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw Object.assign(new Error('spawn ENOENT'), { stdout: '' });
      });
      const { runNpmAudit } = await load();
      expect(() => runNpmAudit(ENV)).toThrow('spawn ENOENT');
    });

    it('returns stdout on a clean exit', async () => {
      mockExecFileSync.mockReturnValue(report());
      const { runNpmAudit } = await load();
      expect(runNpmAudit(ENV)).toBe(report());
    });
  });
});
