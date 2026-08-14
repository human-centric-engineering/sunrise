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

/**
 * Give a repo a deterministic committer, whether it was created by `init` or by
 * `clone`.
 *
 * Both paths need it and only the init path had it, which passed locally and
 * would have failed on every GitHub runner: a hosted runner sets no global git
 * identity, and the address git derives from the hostname
 * (`runner@fv-az…(none)`) is one it refuses to commit with. `commit.gpgsign`
 * is off for the same class of reason — a developer with global signing and no
 * usable key in this shell would otherwise fail here for a reason that has
 * nothing to do with the test.
 */
function configureRepo(dir: string): void {
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Three tests create tags, and a global `tag.gpgSign = true` with no usable
  // key in this shell fails them with `fatal: no tag message?` — the same
  // environment leakage the commit setting above exists to stop.
  git(dir, 'config', 'tag.gpgSign', 'false');
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main', '.');
  configureRepo(dir);
}

/** Clone, then configure — the step the clone-based tests were missing. */
function cloneRepo(from: string, to: string, parent: string, ...extra: string[]): void {
  git(parent, 'clone', '-q', ...extra, from, to);
  configureRepo(to);
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
    // Commits AFTER the tag, so a `--depth 1` clone's HEAD is not the tagged
    // commit. Without them the shallow fixture cannot exhibit the problem the
    // shallow branch exists for, and its "control experiment" would be vacuous.
    writeFileSync(join(upstream, 'post.txt'), 'work after the release\n');
    commitAll(upstream, 'post-release work');

    fork = join(root, 'fork');
    mkdirSync(fork);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes when the sync was a real merge — the tag is an ancestor', () => {
    cloneRepo(upstream, fork, root);
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
    //
    // It must merge an explicit REF, never the bare tag name: a fork holding
    // its own `v0.8.0` makes `git fetch upstream --tags` exit 1 with "would
    // clobber existing tag", leaving the name pointing at the fork's own
    // commit — so `git merge -s ours v0.8.0` would record a claim that is
    // false. Verified: the plain fetch is rejected and the tag is unchanged.
    expect(result.output).toMatch(/merge -s ours refs\/sunrise-upstream\/v0\.8\.0/);
    expect(result.output).toMatch(/refs\/tags\/v0\.8\.0:refs\/sunrise-upstream\/v0\.8\.0/);
    expect(result.output).not.toMatch(/git fetch upstream --tags\n/);
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
    cloneRepo(upstream, fork, root);
    writeVersion(fork, '0.99.0');
    commitAll(fork, 'chore(release): 0.99.0');

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/not fetchable from upstream/);
  });

  it('SKIPS when there is no version file to make a claim', () => {
    initRepo(fork);
    writeFileSync(join(fork, 'app.txt'), 'no sunrise here\n');
    commitAll(fork, 'unrelated repo');

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/no SUNRISE_VERSION found/);
  });

  it('SKIPS — never passes — when upstream is unreachable AND a colliding local tag exists', () => {
    // The combination the first version of these tests avoided, and the one
    // that mattered. An earlier revision fell back to `refs/tags/$TAG` when the
    // fetch failed, which reinstated exactly the collision the private ref was
    // introduced to prevent: a squash-merged fork holding its own `v0.8.0`
    // reported "sync history intact" and exited 0.
    //
    // The mirror case is worse than a missed detection: with a healthy fork
    // whose own `v0.8.0` sits on a side branch, the fallback FAILED and told
    // the operator to `git merge -s ours v0.8.0` — merging an unrelated release
    // branch into main and recording a claim that is false.
    //
    // There is no fallback now. Unreachable upstream means we could not look.
    initRepo(fork);
    writeVersion(fork, '0.7.0');
    commitAll(fork, 'fork base at 0.7.0');
    writeVersion(fork, '0.8.0');
    commitAll(fork, 'chore: sync Sunrise v0.8.0 (squashed)');
    git(fork, 'tag', 'v0.8.0'); // the fork's own release, an ancestor of its main

    const result = runGuard(fork, join(root, 'does-not-exist'));

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/not fetchable from upstream/);
    // The specific wrong answer this guards against.
    expect(result.output).not.toMatch(/sync history intact/);
  });

  it('emits a ::warning:: annotation on a skip, so it is not an invisible green tick', () => {
    // Every skip path ends in exit 0. A bare `echo` renders the check fully
    // green with no annotation, which for a guard whose premise is
    // time-to-discovery would be the original failure mode one level up.
    initRepo(fork);
    writeFileSync(join(fork, 'app.txt'), 'no sunrise here\n');
    commitAll(fork, 'unrelated repo');

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/^::warning title=Sunrise ancestry check skipped::/m);
  });

  it('encodes the repair into the ::error:: annotation, not just the log', () => {
    // Workflow commands are line-scoped, so an un-encoded multi-line body would
    // put the diagnosis in the annotation and leave the repair in log output
    // the operator has to expand the job to reach.
    initRepo(fork);
    writeVersion(fork, '0.7.0');
    commitAll(fork, 'fork base at 0.7.0');
    writeVersion(fork, '0.8.0');
    commitAll(fork, 'chore: sync Sunrise v0.8.0 (squashed)');

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(1);
    const annotation = result.output.split('\n').find((l) => l.startsWith('::error'));
    expect(annotation).toBeDefined();
    expect(annotation).toMatch(/%0A/);
    expect(annotation).toMatch(/merge -s ours refs\/sunrise-upstream\/v0\.8\.0/);
  });

  it('SKIPS on a shallow clone rather than reporting a loss that did not happen', () => {
    cloneRepo(`file://${upstream}`, fork, root, '--depth', '1');

    // Control: without the shallow branch this fixture false-FAILS. The
    // ancestry is genuinely intact upstream; the clone simply cannot see far
    // enough back to prove it. (This assertion is the point of the post-release
    // commits in the fixture — with HEAD sitting on the tag, the naive check
    // would trivially succeed and prove nothing.)
    git(fork, 'fetch', '-q', '--no-tags', '--force', upstream, 'refs/tags/v0.8.0:refs/probe');
    expect(() => git(fork, 'merge-base', '--is-ancestor', 'refs/probe', 'HEAD')).toThrow();

    const result = runGuard(fork, upstream);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/shallow clone/);
  });

  it("SKIPS when the upstream tag is a DIFFERENT project's release of the same name", () => {
    // The collision one level up from the private ref. `CUSTOMIZATION.md` tells
    // a leaf fork of a framework-tier fork to point UPSTREAM_URL at that
    // intermediate — which versions itself independently, so its own `v0.8.0`
    // is an unrelated release that IS an ancestor of the leaf fork's main.
    // Fetching into a private ref does not help when the ref is fetched from
    // the wrong repository.
    const intermediate = join(root, 'intermediate');
    mkdirSync(intermediate);
    initRepo(intermediate);
    writeVersion(intermediate, '0.7.0'); // on Sunrise 0.7.0...
    commitAll(intermediate, 'framework fork at Sunrise 0.7.0');
    git(intermediate, 'tag', 'v0.8.0'); // ...but cutting ITS OWN 0.8.0

    initRepo(fork);
    writeVersion(fork, '0.8.0');
    commitAll(fork, 'leaf fork claiming Sunrise 0.8.0');

    const result = runGuard(fork, intermediate);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/not Sunrise's release tag/);
    expect(result.output).not.toMatch(/sync history intact/);
  });

  it('SKIPS when a leftover private ref survives a killed run', () => {
    // Gating on ref EXISTENCE rather than fetch success made a stale
    // `refs/sunrise-ancestry/*` into the silent fallback this script says it
    // removed. Reachable from a killed run or two concurrent hand-runs in one
    // working copy — and the script is explicitly meant for manual use.
    initRepo(fork);
    writeVersion(fork, '0.7.0');
    commitAll(fork, 'fork base at 0.7.0');
    writeVersion(fork, '0.8.0');
    commitAll(fork, 'chore: sync Sunrise v0.8.0 (squashed)');
    git(fork, 'update-ref', 'refs/sunrise-ancestry/v0.8.0', 'HEAD');

    const result = runGuard(fork, join(root, 'does-not-exist'));

    expect(result.status).toBe(0);
    expect(result.output).not.toMatch(/sync history intact/);
  });

  it("reports git's own reason when the fetch fails, so a bad URL is diagnosable", () => {
    // Without this a fork that mistypes SUNRISE_UPSTREAM_URL gets the same
    // opaque skip forever, indistinguishable from Sunrise's mid-release skip.
    initRepo(fork);
    writeVersion(fork, '0.8.0');
    commitAll(fork, 'fork at 0.8.0');

    const result = runGuard(fork, join(root, 'does-not-exist'));

    expect(result.output).toMatch(/git: .*does not appear to be a git repository/);
  });

  it('SKIPS when upstream is unreachable and no local tag exists', () => {
    // A private upstream with no token behaves like this. It must not fail the
    // build — the guard cannot distinguish "ancestry lost" from "cannot look".
    initRepo(fork);
    writeVersion(fork, '0.8.0');
    commitAll(fork, 'fork at 0.8.0');

    const result = runGuard(fork, join(root, 'does-not-exist'));

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/not fetchable from upstream/);
  });
});
