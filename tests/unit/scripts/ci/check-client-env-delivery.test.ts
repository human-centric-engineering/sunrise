/**
 * Tests for the client-env delivery CLI.
 *
 * The scan rules are covered in `client-env-delivery.test.ts`; this covers the
 * WIRING — which files are fed to the scan, which exit code each outcome
 * produces, and what the operator is told.
 *
 * This file is the gap issue #671 found: `scripts/ci/` is tested by
 * convention, 23 of its 24 modules had a mirrored test, and this was the one
 * exception. It shipped in the same release (#662/#669) as
 * `npm run check:missing-tests`, which flags exactly this shape — and it was a
 * fork's sync merge, not upstream, that surfaced it, because nothing imports
 * this module so it is absent from a full coverage run altogether.
 *
 * The wiring is where the original defect lived, too: the check reported "all
 * vars have a build-time delivery path" while missing `proxy.ts` and
 * `instrumentation.ts`, whose reads are inlined by the compiler and were
 * exactly #662. That file selection is asserted here.
 *
 * @see scripts/ci/check-client-env-delivery.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Absolute-path -> file contents. Directories are keys ending in `/`. */
let tree: Record<string, string>;
let logged: string[];
let errored: string[];

const ROOT = process.cwd();
const abs = (rel: string) => `${ROOT}/${rel}`;

vi.mock('node:fs', () => ({
  existsSync: (p: string) => p in tree || `${p}/` in tree,
  readFileSync: (p: string) => {
    if (!(p in tree)) throw new Error(`ENOENT: ${p}`);
    return tree[p];
  },
  readdirSync: (p: string) =>
    Object.keys(tree)
      .filter((k) => k.startsWith(`${p}/`) && k !== `${p}/`)
      .map((k) => k.slice(p.length + 1).split('/')[0])
      // A directory marker (`.../app/`) yields an empty name; letting it
      // through makes `sourceFiles` recurse into its own directory forever.
      .filter((name) => name !== '')
      .filter((v, i, a) => a.indexOf(v) === i),
  statSync: (p: string) => ({ isDirectory: () => `${p}/` in tree }),
}));

/**
 * Build a tree. Keys are repo-relative; a key ending in `/` is a directory,
 * which `sourceFiles` needs in order to recurse.
 */
function setTree(files: Record<string, string>): void {
  tree = {};
  for (const [rel, content] of Object.entries(files)) {
    tree[abs(rel)] = content;
    // Register every ancestor directory.
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      tree[`${abs(parts.slice(0, i).join('/'))}/`] = '';
    }
  }
}

/** Import the CLI fresh so its top-level `process.exitCode = main()` re-runs. */
async function run(): Promise<number | undefined> {
  vi.resetModules();
  process.exitCode = undefined;
  await import('@/scripts/ci/check-client-env-delivery');
  return process.exitCode;
}

const DOCKERFILE_WITH = 'ARG NEXT_PUBLIC_A\nENV NEXT_PUBLIC_A=$NEXT_PUBLIC_A\n';
const COMPOSE_WITH =
  'services:\n  web:\n    environment:\n      - NEXT_PUBLIC_A=${NEXT_PUBLIC_A}\n';

beforeEach(() => {
  logged = [];
  errored = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void logged.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void errored.push(a.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('check-client-env-delivery CLI', () => {
  it('exits 2 when it finds no source files — a failure to look, not a clean result', async () => {
    // The distinction .context/architecture/checks.md exists for: an empty
    // scan reporting 0 gaps would be indistinguishable from a passing one.
    setTree({ Dockerfile: DOCKERFILE_WITH });
    expect(await run()).toBe(2);
    expect(errored.join('\n')).toContain('Could not run');
    expect(logged.join('\n')).not.toContain('have a build-time delivery path');
  });

  it('exits 0 and reports the counts when every var is delivered', async () => {
    setTree({
      'app/page.tsx': 'const a = process.env.NEXT_PUBLIC_A;',
      Dockerfile: DOCKERFILE_WITH,
      'docker-compose.prod.yml': COMPOSE_WITH,
    });
    expect(await run()).toBe(0);
    expect(logged.join('\n')).toContain('All 1 NEXT_PUBLIC_* vars have a build-time delivery path');
  });

  it('exits 1 and names each variable that cannot reach a container build', async () => {
    setTree({
      'app/page.tsx': 'const a = process.env.NEXT_PUBLIC_ORPHAN;',
      Dockerfile: DOCKERFILE_WITH,
      'docker-compose.prod.yml': COMPOSE_WITH,
    });
    expect(await run()).toBe(1);
    const out = errored.join('\n');
    expect(out).toContain('NEXT_PUBLIC_ORPHAN');
    expect(out).toContain('missing:');
  });

  it('scans proxy.ts and instrumentation.ts, which a directory walk alone misses', async () => {
    // The regression #662 actually was: both are compiled by Next, neither is
    // under a SOURCE_DIR, and the first version of this check reported clean.
    for (const rootFile of ['proxy.ts', 'instrumentation.ts']) {
      setTree({
        'app/page.tsx': 'export const x = 1;',
        [rootFile]: 'const v = process.env.NEXT_PUBLIC_ONLY_HERE;',
        Dockerfile: DOCKERFILE_WITH,
        'docker-compose.prod.yml': COMPOSE_WITH,
      });
      expect(await run(), `${rootFile} was not scanned`).toBe(1);
      expect(errored.join('\n'), `${rootFile} was not scanned`).toContain('NEXT_PUBLIC_ONLY_HERE');
    }
  });

  it('reports bracket-access reads even with no delivery targets at all', async () => {
    // A bracket read is a defect in the source, not the plumbing, so it does
    // not stop mattering because a fork deploys somewhere without a Dockerfile.
    setTree({ 'lib/x.ts': "const v = process.env['NEXT_PUBLIC_BRACKET'];" });
    expect(await run()).toBe(1);
    const out = errored.join('\n');
    expect(out).toContain('NEXT_PUBLIC_BRACKET');
    expect(out).toContain('bracket access');
    expect(logged.join('\n')).toContain('no delivery path to check');
  });

  it('exits 0 when there are no delivery targets and nothing is wrong with the source', async () => {
    setTree({ 'lib/x.ts': 'const v = process.env.NEXT_PUBLIC_A;' });
    expect(await run()).toBe(0);
    expect(logged.join('\n')).toContain('no delivery path to check');
  });

  it('does not scan test files, which are never shipped', async () => {
    setTree({
      'app/page.tsx': 'export const x = 1;',
      'app/page.test.tsx': 'const v = process.env.NEXT_PUBLIC_TEST_ONLY;',
      Dockerfile: DOCKERFILE_WITH,
      'docker-compose.prod.yml': COMPOSE_WITH,
    });
    expect(await run()).toBe(0);
    expect(errored.join('\n')).not.toContain('NEXT_PUBLIC_TEST_ONLY');
  });
});
