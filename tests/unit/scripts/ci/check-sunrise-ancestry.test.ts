/**
 * Tests for the fork-sync ancestry guard (#539).
 *
 * This one is executed rather than unit-tested around, because the thing under
 * test IS the git behaviour: whether a release tag is reachable from HEAD. A
 * mocked `git` would only assert that the script calls the commands it calls.
 *
 * Each case builds a throwaway repository and runs the real script against it,
 * with `UPSTREAM_URL` pointed at a local bare repo standing in for Sunrise.
 *
 * **Two of these cases exist because the obvious implementation is silently
 * wrong**, and both were confirmed by control experiment before the guards were
 * written:
 *
 *  - `refs/tags/$TAG` cannot be trusted. A fork versions its own app
 *    independently, so it may carry its OWN `v0.8.0` pointing at its own
 *    history — which IS an ancestor of its main, so a tag-based check reports
 *    success on precisely the broken repository it exists to protect. Verified:
 *    `git merge-base --is-ancestor refs/tags/v0.8.0 HEAD` succeeds in the
 *    collision case below.
 *  - A shallow clone cannot answer the question at all. Without an explicit
 *    skip it reports a loss that has not happened. Verified: the same check on
 *    a `--depth 1` clone fails spuriously.
 *
 * @see scripts/ci/check-sunrise-ancestry.sh
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const SCRIPT = resolve(process.cwd(), 'scripts/ci/check-sunrise-ancestry.sh');

interface RunResult {
  status: number;
  output: string;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Initialise a repo with deterministic identity — CI has no global git config. */
function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main', '.');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function writeVersion(dir: string, version: string): void {
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(
    join(dir, 'lib/sunrise-version.ts'),
    `export const SUNRISE_VERSION = '${version}';\n`
  );
}

function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

function runGuard(cwd: string, upstreamUrl: string, ref = 'HEAD'): RunResult {
  try {
    const output = execFileSync('bash', [SCRIPT, ref], {
      cwd,
      env: { ...process.env, UPSTREAM_URL: upstreamUrl },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('scripts/ci/check-sunrise-ancestry', () => {
  let root: string;
  let upstream: string;
  let fork: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sunrise-ancestry-'));

    // Stand-in for Sunrise: two tagged releases on a linear main.
    upstream = join(root, 'upstream');
    mkdirSync(upstream);
    initRepo(upstream);
    writeVersion(upstream, '0.7.0');
    commitAll(upstream, 'release 0.7.0');
    git(upstream, 'tag', 'v0.7.0');
    writeVersion(upstream, '0.8.0');
    commitAll(upstream, 'release 0.8.0');
    git(upstream, 'tag', 'v0.8.0');

    fork = join(root, 'fork');
    mkdirSync(fork);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes when the sync was a real merge — the tag is an ancestor', () => {
    git(root, 'clone', '-q', upstream, fork);
    git(fork, 'config', 'user.email', 'test@example.com');
    git(fork, 'config', 'user.name', 'Test');
    // Diverge from v0.7.0, then bring v0.8.0 in as a real merge — the supported
    // sync flow, and the case that must NOT fire.
    git(fork, 'checkout', '-q', '-B', 'main', 'v0.7.0');
    writeFileSync(join(fork, 'app.txt'), 'fork work\n');
    commitAll(fork, 'fork feature');
    git(fork, 'merge', '-q', '--no-edit', 'v0.8.0');

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/sync history intact/);
  });

  it('FAILS when the sync PR was squash-merged — content kept, ancestry lost', () => {
    // The #539 scenario. The tree claims 0.8.0 and every file matches, but the
    // second parent is gone, so the merge base silently reverts to v0.7.0.
    initRepo(fork);
    writeVersion(fork, '0.7.0');
    writeFileSync(join(fork, 'app.txt'), 'fork work\n');
    commitAll(fork, 'fork base at 0.7.0');
    writeVersion(fork, '0.8.0');
    commitAll(fork, 'chore: sync Sunrise v0.8.0 (squashed)');

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/NOT an ancestor/);
    // The message has to carry the repair, because the reader is an operator
    // who has just been told something they did not know was possible.
    expect(result.output).toMatch(/merge -s ours v0\.8\.0/);
  });

  it('FAILS even when the fork has its OWN tag of the same name', () => {
    // The silent-false-negative guard. A fork versions its app independently,
    // so `v0.8.0` may exist locally pointing at the fork's own history — and
    // being an ancestor of the fork's main, it would satisfy a naive
    // `refs/tags/`-based check on a repository that is genuinely broken.
    initRepo(fork);
    writeVersion(fork, '0.7.0');
    commitAll(fork, 'fork base at 0.7.0');
    writeVersion(fork, '0.8.0');
    commitAll(fork, 'chore: sync Sunrise v0.8.0 (squashed)');
    git(fork, 'tag', 'v0.8.0'); // the fork's own release, same name

    // Control: the naive check the guard deliberately avoids would pass here.
    expect(() =>
      git(fork, 'merge-base', '--is-ancestor', 'refs/tags/v0.8.0', 'HEAD')
    ).not.toThrow();

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(1);
    expect(result.output).toMatch(/NOT an ancestor/);
  });

  it('SKIPS when the version is bumped but the tag is not pushed yet', () => {
    // Protects Sunrise's own release process: the commit bumping
    // SUNRISE_VERSION lands before the tag is pushed, and a hard failure there
    // would red-line every release at the moment of cutting it.
    git(root, 'clone', '-q', upstream, fork);
    writeVersion(fork, '0.99.0');
    commitAll(fork, 'chore(release): 0.99.0');

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/not resolvable — skipping/);
  });

  it('SKIPS when there is no version file to make a claim', () => {
    initRepo(fork);
    writeFileSync(join(fork, 'app.txt'), 'no sunrise here\n');
    commitAll(fork, 'unrelated repo');

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/no SUNRISE_VERSION found/);
  });

  it('SKIPS on a shallow clone rather than reporting a loss that did not happen', () => {
    git(root, 'clone', '-q', '--depth', '1', `file://${upstream}`, fork);

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/shallow clone/);
  });

  it('SKIPS when upstream is unreachable and no local tag exists', () => {
    // A private upstream with no token behaves like this. It must not fail the
    // build — the guard cannot distinguish "ancestry lost" from "cannot look".
    initRepo(fork);
    writeVersion(fork, '0.8.0');
    commitAll(fork, 'fork at 0.8.0');

    const result = runGuard(fork, join(root, 'does-not-exist'));

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/not resolvable — skipping/);
  });
});
