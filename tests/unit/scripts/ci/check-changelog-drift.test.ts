/**
 * Tests for the `[Unreleased]` staleness CLI.
 *
 * The rules are covered next door; what is asserted here is the git wiring —
 * base resolution, blame parsing, the pickaxe pathspec, and the reachability
 * test that separates a doomed branch SHA from a landed one.
 *
 * @see scripts/ci/check-changelog-drift.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecFileSync = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  default: { execFileSync: mockExecFileSync },
}));

const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FIRST = '1111111111111111111111111111111111111111';
const SECOND = '2222222222222222222222222222222222222222';
// Hex WITH a letter: an all-digit fixture is not a SHA candidate at all, so
// the reachability test below silently exercised nothing. It does now.
const LANDED = '9a9b9c9d99999999999999999999999999999999';

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '### Fixed',
  '',
  '- **Thing.** Reworked `lib/thing.ts` so it stops',
  '  leaking, see `useThing`.',
  '',
  '## [0.9.0] — 2026-08-17',
  '',
  '- old news',
].join('\n');

/** `git blame --line-porcelain` output for the lines a test cares about. */
function blame(byLine: Record<number, string>): string {
  return Object.entries(byLine)
    .map(([line, sha]) => `${sha} ${line} ${line} 1\nsummary whatever\n\tcontent`)
    .join('\n');
}

const REVLIST = [
  `commit ${FIRST}`,
  `${FIRST}\0first commit`,
  `commit ${SECOND}`,
  `${SECOND}\0second commit`,
].join('\n');

interface GitAnswers {
  mergeBase?: string | null;
  changelog?: string | null;
  revList?: string;
  blame?: string;
  /** identifier → SHAs the pickaxe reports. */
  pickaxe?: Record<string, string[]>;
  /** Set to make `git blame` fail outright rather than return lines. */
  blameFails?: boolean;
  /** Refs `rev-parse --verify` should fail for. */
  unknownRefs?: string[];
  /** SHAs that ARE ancestors of origin/main. */
  onMain?: string[];
}

function gitReturns(answers: GitAnswers = {}) {
  const {
    mergeBase = BASE,
    changelog = CHANGELOG,
    revList = REVLIST,
    blame: blameOut = blame({ 7: FIRST, 8: FIRST }),
    pickaxe = {},
    unknownRefs = [],
    onMain = [],
    blameFails = false,
  } = answers;

  mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
    const fail = () => {
      throw new Error('git failed');
    };
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      return onMain.includes(args[2]) ? '' : fail();
    }
    if (args[0] === 'merge-base') return mergeBase === null ? fail() : `${mergeBase}\n`;
    if (args[0] === 'rev-parse') {
      const ref = args[2].replace('^{commit}', '');
      return unknownRefs.includes(ref) ? fail() : `${ref}\n`;
    }
    if (args[0] === 'show') return changelog === null ? fail() : changelog;
    if (args[0] === 'rev-list') return revList;
    if (args[0] === 'blame') return blameFails ? fail() : blameOut;
    if (args[0] === 'log') {
      const token = args.find((arg) => arg.startsWith('-S'))?.slice(2) ?? '';
      return (pickaxe[token] ?? []).join('\n');
    }
    return '';
  });
}

describe('scripts/ci/check-changelog-drift', () => {
  let originalExitCode: typeof process.exitCode;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  function out(): string {
    return [...errorSpy.mock.calls, ...logSpy.mock.calls]
      .map((call: unknown[]) => String(call[0]))
      .join('\n');
  }

  async function run(args: string[] = []): Promise<void> {
    process.argv = ['node', 'check-changelog-drift.ts', ...args];
    vi.resetModules();
    await import('@/scripts/ci/check-changelog-drift');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = 0;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    gitReturns();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('names the bullet, the identifier and the commit that changed it', async () => {
    gitReturns({ pickaxe: { 'lib/thing.ts': [SECOND] } });

    await run();

    expect(process.exitCode).toBe(0);
    expect(out()).toContain('CHANGELOG.md:7');
    expect(out()).toContain('`lib/thing.ts`');
    expect(out()).toContain('22222222 second commit');
    expect(out()).toContain('Still accurate?');
  });

  it("files an inherited bullet behind its own heading, not in with this branch's", async () => {
    // Dogfooded on the branch that added this check: 11 flagged bullets, all 11
    // inherited from earlier PRs, none stale. Mixed in, they bury the one
    // finding that was about the branch's own entry.
    gitReturns({
      blame: blame({ 7: BASE, 8: BASE }),
      pickaxe: { 'lib/thing.ts': [FIRST] },
    });

    await run();

    expect(out()).toContain('already in [Unreleased] before this branch');
    expect(out()).toContain('0 bullet(s) this branch wrote worth re-reading, 1 inherited');
  });

  it("leaves the heading off entirely when every finding is the branch's own", async () => {
    gitReturns({ pickaxe: { 'lib/thing.ts': [SECOND] } });

    await run();

    expect(out()).not.toContain('already in [Unreleased] before this branch');
    expect(out()).toContain('1 bullet(s) this branch wrote worth re-reading, 0 inherited');
  });

  it('says blame failed rather than reporting every bullet as inherited', async () => {
    // An empty blame result and a failed one are not the same thing. Treating
    // the failure as empty stamps every line PREDATES_BRANCH, files every
    // finding under "already in [Unreleased] before this branch", and reports
    // "0 bullet(s) this branch wrote" — a confident wrong answer for a branch
    // that wrote all of them.
    gitReturns({ blameFails: true, pickaxe: { 'lib/thing.ts': [FIRST] } });

    await run();

    expect(out()).toContain('Could not run `git blame`');
    expect(out()).toContain('says nothing about who wrote what');
  });

  it('reports a doomed SHA at its own line, not the start of the entry', async () => {
    // Multi-line entries are the norm here, and the first line is usually prose
    // with no SHA in it.
    const doomed = 'd23d458';
    gitReturns({
      changelog: CHANGELOG.replace('leaking, see', `leaking, fixed in ${doomed}, see`),
    });

    await run();

    // The SHA sits on line 8; the entry starts on line 7.
    expect(out()).toContain(`CHANGELOG.md:8 — names commit ${doomed}`);
  });

  it('never gates, even with findings', async () => {
    // A heuristic that blocks a merge is the defect #608 fixes one file over.
    gitReturns({ pickaxe: { 'lib/thing.ts': [SECOND], useThing: [SECOND] } });

    await run();

    expect(process.exitCode).toBe(0);
    expect(out()).toContain('A reminder, not a gate');
  });

  it('excludes CHANGELOG.md from the pickaxe, so a bullet cannot cite itself', async () => {
    await run();

    const pickaxes = mockExecFileSync.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === 'log');

    expect(pickaxes.length).toBeGreaterThan(0);
    for (const args of pickaxes) expect(args).toContain(':!CHANGELOG.md');
  });

  it('says nothing when no identifier moved after its line was written', async () => {
    await run();

    expect(out()).toContain('No bullet names something a later commit');
  });

  it('treats a line written before the branch as open to every commit on it', async () => {
    // Blamed on something outside `base..HEAD`, so nothing on the branch can be
    // "earlier" than it. The alternative implementation — skip any line whose
    // commit is not in the branch — would drop this finding entirely, and with
    // it every pre-existing [Unreleased] bullet that THIS branch invalidated.
    gitReturns({
      blame: blame({ 7: BASE, 8: BASE }),
      pickaxe: { 'lib/thing.ts': [FIRST] },
    });

    await run();

    expect(out()).toContain('`lib/thing.ts`');
    expect(out()).toContain('11111111 first commit');
  });

  it('flags a commit reference that is not on origin/main', async () => {
    const doomed = 'd23d458';
    gitReturns({
      changelog: CHANGELOG.replace('so it stops', `so it stops, fixed in ${doomed},`),
      onMain: [],
    });

    await run();

    expect(out()).toContain(`names commit ${doomed}`);
    expect(out()).toContain('squash merge will leave it unresolvable');
  });

  it('leaves a commit reference alone once it has landed on main', async () => {
    const landed = LANDED.slice(0, 8);
    gitReturns({
      changelog: CHANGELOG.replace('so it stops', `so it stops, as of ${landed},`),
      onMain: [landed],
    });

    await run();

    expect(out()).not.toContain('names commit');
  });

  it('drops a hex-shaped word git cannot resolve, rather than reporting it', async () => {
    gitReturns({
      changelog: CHANGELOG.replace('so it stops', 'so it stops being defaced1,'),
      unknownRefs: ['defaced1'],
    });

    await run();

    expect(out()).not.toContain('defaced1');
  });

  it('says so when origin/main is unavailable instead of implying it checked', async () => {
    gitReturns({ unknownRefs: ['origin/main'] });

    await run();

    expect(out()).toContain('commit references were not checked');
  });

  it('skips quietly with no base and no flag', async () => {
    gitReturns({ mergeBase: null });

    await run();

    expect(process.exitCode).toBe(0);
    expect(out()).toContain('no base revision available');
  });

  it('fails loudly when an explicitly requested base is unreadable', async () => {
    gitReturns({ unknownRefs: ['nope'] });

    await run(['--base', 'nope']);

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('Could not resolve "nope"');
  });

  it('rejects an empty --base rather than silently falling back', async () => {
    await run(['--base']);

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('needs a revision');
  });

  it('rejects a --base that would be read as a git option', async () => {
    await run(['--base=--all']);

    expect(process.exitCode).toBe(1);
    expect(out()).toContain('must be a revision, not an option');
  });

  it('skips when CHANGELOG.md is not at HEAD', async () => {
    gitReturns({ changelog: null });

    await run();

    expect(process.exitCode).toBe(0);
    expect(out()).toContain('not present at HEAD');
  });

  it('says there is nothing to check when [Unreleased] is empty', async () => {
    gitReturns({ changelog: '# Changelog\n\n## [Unreleased]\n\n## [0.9.0] — 2026-08-17\n' });

    await run();

    expect(out()).toContain('no [Unreleased] bullets');
  });
});
