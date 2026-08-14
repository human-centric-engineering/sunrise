/**
 * Tests for the Node version-consistency CLI.
 *
 * The rules are covered in `node-version.test.ts`; this covers the WIRING —
 * which files are read, which source each becomes, and what the operator is
 * told when one of them cannot be read.
 *
 * This file exists because that gap let a real defect through: the evidence
 * string branched on "package.json missing" but not on "package.json
 * unparseable", so a manifest that plainly declared `@types/node` and merely
 * failed to parse was reported as not naming it — the exact confusion the
 * helper's own docblock said it existed to prevent.
 *
 * @see scripts/ci/check-node-version.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadFileSync = vi.fn();

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  default: { readFileSync: mockReadFileSync },
}));

const NVMRC = '24\n';
const DOCKERFILE = 'FROM node:24-alpine AS base\n';
const MANIFEST = JSON.stringify({
  engines: { node: '>=24' },
  devDependencies: { '@types/node': '^24.13.3' },
});
const LOCKFILE = JSON.stringify({
  packages: { '': { version: '0.8.1' }, 'node_modules/@types/node': { version: '24.13.3' } },
});

/**
 * Answers the four files the CLI reads. `null` makes that read throw, which is
 * how `read()` distinguishes absent from present.
 */
function files({
  nvmrc = NVMRC,
  dockerfile = DOCKERFILE,
  manifest = MANIFEST,
  lockfile = LOCKFILE,
}: {
  nvmrc?: string | null;
  dockerfile?: string | null;
  manifest?: string | null;
  lockfile?: string | null;
} = {}) {
  return (path: string): string => {
    const target = String(path);
    const pick = target.endsWith('.nvmrc')
      ? nvmrc
      : target.endsWith('package-lock.json')
        ? lockfile
        : target.endsWith('package.json')
          ? manifest
          : dockerfile;
    if (pick === null) throw new Error(`ENOENT: ${target}`);
    return pick;
  };
}

describe('scripts/ci/check-node-version', () => {
  let originalExitCode: typeof process.exitCode;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function out(): string {
    return [...errorSpy.mock.calls, ...logSpy.mock.calls]
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
  }

  async function run(): Promise<void> {
    vi.resetModules();
    await import('@/scripts/ci/check-node-version');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = 0;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockReadFileSync.mockImplementation(files());
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('passes when all five declarations agree', async () => {
    await run();

    expect(process.exitCode).toBe(0);
    expect(out()).toContain('@types/node');
    expect(out()).toContain('(24)');
  });

  it('fails when the resolved @types/node runs ahead of the runtime', async () => {
    // The #584 drift: `tsc` type-checking against a stdlib two majors ahead of
    // every runtime, accepting APIs that throw in the production image.
    mockReadFileSync.mockImplementation(
      files({
        lockfile: JSON.stringify({
          packages: { 'node_modules/@types/node': { version: '26.2.0' } },
        }),
      })
    );

    await run();

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('@types/node (resolved)=26');
  });

  it('judges @types/node on the RESOLVED version, not the declared range', async () => {
    // `>=24` does not pin a major — npm resolves it to 26.2.0. A range-based
    // reading reported "consistent" for exactly the drift being checked.
    mockReadFileSync.mockImplementation(
      files({
        manifest: JSON.stringify({
          engines: { node: '>=24' },
          devDependencies: { '@types/node': '>=24' },
        }),
        lockfile: JSON.stringify({
          packages: { 'node_modules/@types/node': { version: '26.2.0' } },
        }),
      })
    );

    await run();

    expect(process.exitCode).toBe(1);
  });

  it('says a manifest could not be PARSED rather than blaming the dependency', async () => {
    // The defect this file was added for. `@types/node` is declared right
    // there; the file merely fails to parse. Reporting "not named in
    // package.json" sends the reader to fix a line that is already correct.
    mockReadFileSync.mockImplementation(files({ manifest: '{ "devDependencies": { , }' }));

    await run();

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('could not be parsed');
    expect(out()).not.toContain('not named in package.json');
  });

  it('distinguishes an ABSENT manifest from an unparseable one', async () => {
    mockReadFileSync.mockImplementation(files({ manifest: null }));

    await run();

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('package.json not found');
  });

  it('checks a transitive @types/node, and says where it came from', async () => {
    // `tsc` loads whatever copy resolves, so a transitive one carries the same
    // risk — skipping it would leave a blind spot a fork could reach by
    // deleting one line. The evidence string is shown on failure, so drive it
    // with a transitive copy at the WRONG major.
    mockReadFileSync.mockImplementation(
      files({
        manifest: JSON.stringify({ engines: { node: '>=24' } }),
        lockfile: JSON.stringify({
          packages: { 'node_modules/@types/node': { version: '26.2.0' } },
        }),
      })
    );

    await run();

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('not named in package.json');
    expect(out()).toContain('transitive copy resolves to 26.2.0');
  });

  it('SKIPS the @types/node source entirely when there is no npm lockfile', async () => {
    // A fork on pnpm or yarn has no `package-lock.json`. Failing there would
    // break `npm run validate` with nothing the fork could edit to satisfy it.
    mockReadFileSync.mockImplementation(files({ lockfile: null }));

    await run();

    expect(process.exitCode).toBe(0);
    // And the all-clear must not claim it checked something it skipped.
    expect(out()).not.toContain('@types/node');
  });

  it('still fails when the lockfile EXISTS but has no @types/node entry', async () => {
    // Present-but-broken is a broken tree, not a different package manager.
    mockReadFileSync.mockImplementation(
      files({ lockfile: JSON.stringify({ packages: { '': { version: '0.8.1' } } }) })
    );

    await run();

    expect(process.exitCode).toBe(1);
  });

  it('fails when a Dockerfile lags a bumped .nvmrc — the motivating drift', async () => {
    mockReadFileSync.mockImplementation(files({ nvmrc: '26\n' }));

    await run();

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('.nvmrc=26');
  });
});
