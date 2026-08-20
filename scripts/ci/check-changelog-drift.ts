/**
 * `[Unreleased]` staleness inspection — CLI.
 *
 * Answers a question step 5d does not: **is a CHANGELOG bullet still true after
 * everything else this branch did?** The rules, the measurement behind them and
 * the reason this is scoped to the CHANGELOG rather than `.context/` live in
 * `scripts/ci/changelog-drift.ts`.
 *
 * Usage:
 *   npm run check:changelog-drift                 # vs the merge base with origin/main
 *   npx tsx scripts/ci/check-changelog-drift.ts --base origin/main
 *
 * **This never gates.** It exits 0 whenever it managed to run, findings or not;
 * a non-zero exit means it could not do its job (an unreadable `--base`), never
 * that it disapproves of a bullet. The identifier correlation is a heuristic
 * and a heuristic that blocks a merge is the defect #608 fixes one file over.
 * `/pre-pr` step 5e reads the output and judges.
 *
 * It reads `CHANGELOG.md` **at HEAD**, not from the working tree, because every
 * finding is a statement about which commit wrote a line. Uncommitted changelog
 * edits are invisible here; commit first, which `/pre-pr` assumes anyway.
 *
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 */

import { execFileSync } from 'node:child_process';

import {
  extractUnreleasedBullets,
  findDrift,
  identifiersIn,
  PREDATES_BRANCH,
  shaCandidatesIn,
  summarise,
  type BranchCommit,
} from '@/scripts/ci/changelog-drift';

const CHANGELOG = 'CHANGELOG.md';
const MAIN = 'origin/main';

/** Runs git, returning `null` for any failure — missing repo, ref, or file. */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** True when git exits 0 — used for predicates that carry no output. */
function gitOk(args: string[]): boolean {
  return git(args) !== null;
}

/** `--base <ref>` or `--base=<ref>`, matching `check-lockfile.ts` exactly. */
export function parseBaseRef(argv: string[]): { present: boolean; ref: string } {
  const index = argv.indexOf('--base');
  if (index !== -1) return { present: true, ref: argv[index + 1] ?? '' };
  const inline = argv.find((arg) => arg.startsWith('--base='));
  if (inline !== undefined) return { present: true, ref: inline.slice('--base='.length) };
  return { present: false, ref: '' };
}

/** The branch's commits, oldest first, so index order is chronology. */
function branchCommits(base: string): BranchCommit[] {
  const log = git(['rev-list', '--reverse', '--format=%H%x00%s', `${base}..HEAD`]);
  if (log === null) return [];
  return log
    .split('\n')
    .filter((line) => line.includes('\0'))
    .map((line, index) => {
      const [sha, subject] = line.split('\0');
      return { index, sha, subject };
    });
}

/**
 * Which line of `CHANGELOG.md` was last written by which commit.
 *
 * `--line-porcelain` rather than the human format because its header line is a
 * fixed `<sha> <orig-line> <final-line> [<n>]`, where the short form interleaves
 * author and date and prefixes a boundary commit with `^`. Both are parseable;
 * only one is parseable without a fussy regex that has to be right about
 * columns.
 *
 * A line this cannot attribute is not dropped — the caller records it as
 * {@link PREDATES_BRANCH}, so an [Unreleased] bullet inherited from an earlier
 * PR is still checked against everything this branch did.
 */
function blameByLine(): Map<number, string> {
  const blame = git(['blame', '--line-porcelain', 'HEAD', '--', CHANGELOG]);
  const byLine = new Map<number, string>();
  if (blame === null) return byLine;
  for (const line of blame.split('\n')) {
    const match = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (match) byLine.set(Number(match[2]), match[1]);
  }
  return byLine;
}

/** Returns the process exit code so every path out is a plain `return`. */
export function main(argv: string[]): number {
  const requested = parseBaseRef(argv);
  if (requested.present && requested.ref === '') {
    console.error('`--base` needs a revision — got an empty value.');
    return 1;
  }
  if (requested.present && requested.ref.startsWith('-')) {
    console.error(`\`--base\` must be a revision, not an option: "${requested.ref}".`);
    return 1;
  }

  const base = requested.present ? requested.ref : git(['merge-base', MAIN, 'HEAD'])?.trim();
  if (!base || !gitOk(['rev-parse', '--verify', `${base}^{commit}`])) {
    if (requested.present) {
      console.error(`Could not resolve "${requested.ref}".`);
      return 1;
    }
    console.log(`${CHANGELOG}: no base revision available — skipped.`);
    return 0;
  }

  const source = git(['show', `HEAD:${CHANGELOG}`]);
  if (source === null) {
    console.log(`${CHANGELOG}: not present at HEAD — skipped.`);
    return 0;
  }

  const bullets = extractUnreleasedBullets(source);
  if (bullets.length === 0) {
    console.log(`${CHANGELOG}: no [Unreleased] bullets — nothing to check.`);
    return 0;
  }

  const commits = branchCommits(base);
  const byIndex = new Map(commits.map((commit) => [commit.sha, commit]));

  // Where each LINE was written. A line blamed on a commit outside the branch
  // predates it, and PREDATES_BRANCH makes every branch commit count as later —
  // an inherited [Unreleased] bullet that THIS branch invalidated is the same
  // defect arriving by a different route.
  const blame = blameByLine();
  const writtenAt = new Map<number, number>();
  for (const bullet of bullets) {
    for (let line = bullet.startLine; line <= bullet.endLine; line += 1) {
      const sha = blame.get(line);
      const commit = sha === undefined ? undefined : byIndex.get(sha);
      writtenAt.set(line, commit?.index ?? PREDATES_BRANCH);
    }
  }

  // One pickaxe per distinct identifier. `-S` reports commits where the COUNT
  // of the string changed, which is the closest git gets to "this commit
  // touched the thing the bullet names". CHANGELOG.md is excluded: the commit
  // that wrote the bullet necessarily contains its own identifiers, and
  // counting that would make every bullet cite itself.
  const touchedBy = new Map<string, BranchCommit[]>();
  for (const bullet of bullets) {
    for (const token of identifiersIn(bullet.text)) {
      if (touchedBy.has(token)) continue;
      const log = git([
        'log',
        '--format=%H',
        `-S${token}`,
        `${base}..HEAD`,
        '--',
        '.',
        `:!${CHANGELOG}`,
      ]);
      const hits = (log ?? '')
        .split('\n')
        .map((sha) => byIndex.get(sha.trim()))
        .filter((commit): commit is BranchCommit => commit !== undefined);
      touchedBy.set(token, hits);
    }
  }

  const drift = findDrift(bullets, writtenAt, touchedBy);

  // A SHA is a different kind of claim: it either resolves after a squash merge
  // or it does not, and reachability from origin/main answers that exactly.
  // Anything git cannot resolve at all is dropped rather than reported — it is
  // a word that happens to be hex, and a false positive costs more here than
  // the miss does.
  const mainKnown = gitOk(['rev-parse', '--verify', `${MAIN}^{commit}`]);
  const doomed: { line: number; sha: string }[] = [];
  if (mainKnown) {
    for (const bullet of bullets) {
      for (const candidate of shaCandidatesIn(bullet.text)) {
        if (!gitOk(['rev-parse', '--verify', `${candidate}^{commit}`])) continue;
        if (gitOk(['merge-base', '--is-ancestor', candidate, MAIN])) continue;
        doomed.push({ line: bullet.startLine, sha: candidate });
      }
    }
  }

  console.log(
    `${CHANGELOG}: ${bullets.length} [Unreleased] bullet(s) against ${commits.length} commit(s) since ${base}.`
  );

  if (drift.length === 0 && doomed.length === 0) {
    console.log('No bullet names something a later commit on this branch changed.');
    if (!mainKnown) console.log(`(${MAIN} unavailable — commit references were not checked.)`);
    return 0;
  }

  // Grouped by bullet, because the unit a reader judges is the entry. Ungrouped,
  // #625's four bullets printed as sixteen near-identical blocks — a wall of
  // text is its own kind of unread.
  const group = (findings: typeof drift) => {
    const byBullet = new Map<number, typeof drift>();
    for (const finding of findings) {
      const bucket = byBullet.get(finding.bullet.startLine);
      if (bucket) bucket.push(finding);
      else byBullet.set(finding.bullet.startLine, [finding]);
    }
    return byBullet;
  };

  const written = group(drift.filter((finding) => !finding.inherited));
  const inherited = group(drift.filter((finding) => finding.inherited));

  const report = (byBullet: ReturnType<typeof group>) => {
    for (const [startLine, findings] of byBullet) {
      console.log('');
      console.log(`${CHANGELOG}:${startLine} — "${summarise(findings[0].bullet)}"`);
      console.log('  Later commits on this branch changed things this entry names:');
      for (const finding of findings) {
        const commits = finding.commits.map((commit) => commit.sha.slice(0, 8)).join(', ');
        console.log(`    L${finding.line}  \`${finding.token}\`  ← ${commits}`);
      }
      console.log('  Still accurate?');
    }
  };

  report(written);

  // Second, and behind a heading that says what they are. Every branch commit
  // counts as later for an inherited bullet, so these are much noisier — on the
  // branch that added this check, all 11 flagged bullets were inherited and
  // none was stale.
  if (inherited.size > 0) {
    console.log('');
    console.log(`--- ${inherited.size} bullet(s) already in [Unreleased] before this branch ---`);
    console.log('Lower confidence: an entry this branch did not write is compared against');
    console.log('every commit on it. Worth a glance, not a rewrite.');
    report(inherited);
  }

  if (drift.length > 0) {
    console.log('');
    console.log('Commits referenced above:');
    const cited = new Map(drift.flatMap((f) => f.commits).map((c) => [c.sha, c]));
    for (const commit of cited.values()) {
      console.log(`  ${commit.sha.slice(0, 8)} ${commit.subject}`);
    }
  }

  for (const entry of doomed) {
    console.log('');
    console.log(`${CHANGELOG}:${entry.line} — names commit ${entry.sha}, which is not on ${MAIN}.`);
    console.log('  A squash merge will leave it unresolvable. Cite the PR or issue instead.');
  }

  console.log('');
  console.log(
    `${written.size} bullet(s) this branch wrote worth re-reading, ${inherited.size} inherited, ${doomed.length} doomed commit reference(s).`
  );
  console.log('A reminder, not a gate — the identifier correlation produces false positives.');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
