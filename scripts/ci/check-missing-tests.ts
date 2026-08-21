/**
 * Changed files without a test — CLI for `/pre-pr` step 4f.
 *
 * Lists what the branch added or modified, applies the rules in
 * `scripts/ci/missing-tests.ts`, and prints a verdict per file. It **reports**;
 * it never gates on a finding. A page can legitimately have no test and the
 * person writing the PR is the one who can say so — the point is that the
 * question gets asked from the same rules every time, instead of from whatever
 * scanner the agent invented this run (#641).
 *
 * Exit codes say only whether the check could run:
 *   0 — ran (findings or not)
 *   1 — could not run: self-test failed, no base, no test tree, git failed
 *
 * That asymmetry is the whole design. #641's instance was a `compgen` loop in a
 * zsh shell that printed nothing and was nearly banked as a clean tree, so
 * every way the *scan* can fail to look is a loud non-zero exit with a sentence
 * saying what it could not see; the secondary uncommitted-work check says so in
 * the report rather than exiting, since the scan itself still ran. **There is no
 * path here that prints a clean result without having demonstrated it can print
 * a dirty one, and none that stays quiet about something it could not measure.**
 *
 * Usage:
 *   npm run check:missing-tests
 *   npx tsx scripts/ci/check-missing-tests.ts --base origin/main
 *   npx tsx scripts/ci/check-missing-tests.ts --self-test
 *   npx tsx scripts/ci/check-missing-tests.ts --verbose   # why each file landed where it did
 *
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  classify,
  selfTestFailure,
  type ChangedFile,
  type ClassifyContext,
  type Verdict,
} from '@/scripts/ci/missing-tests';

let lastGitError = '';

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error ? error.stderr : undefined;
    lastGitError = (
      typeof stderr === 'string' && stderr.trim() !== ''
        ? stderr
        : error instanceof Error
          ? error.message
          : String(error)
    )
      .split('\n')[0]
      .trim();
    return null;
  }
}

/** `--base <ref>` or `--base=<ref>`; presence tracked so an empty value fails. */
export function parseBaseRef(argv: string[]): { present: boolean; ref: string } {
  const index = argv.indexOf('--base');
  if (index !== -1) return { present: true, ref: argv[index + 1] ?? '' };
  const inline = argv.find((arg) => arg.startsWith('--base='));
  if (inline !== undefined) return { present: true, ref: inline.slice('--base='.length) };
  return { present: false, ref: '' };
}

/**
 * Parses `git diff --name-status` output.
 *
 * A rename arrives as `R100\told\tnew` — the destination is what needs a test,
 * and it is reported as `R` rather than folded into `M` so the summary can say
 * so. Statuses this check does not ask about (`D`elete, `T`ype change) are
 * dropped, as are non-TypeScript paths.
 */
export function parseNameStatus(output: string): {
  files: ChangedFile[];
  /** Paths git still C-quoted, which cannot be matched against the tree. */
  unreadable: string[];
} {
  const files: ChangedFile[] = [];
  const unreadable: string[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.split('\t');
    const code = fields[0] ?? '';
    const letter = code.charAt(0);
    // `C` is a copy — `diff.renames = copies` in a user's gitconfig turns it
    // on, and the destination is a brand-new file needing a test. It used to
    // fall out here with no word, which is the silent drop this check is
    // against. `D`elete and `T`ype-change are deliberate: a deleted file cannot
    // be missing a test.
    if (letter !== 'A' && letter !== 'M' && letter !== 'R' && letter !== 'C') continue;
    const path = letter === 'R' || letter === 'C' ? fields[2] : fields[1];
    // A truncated rename line (`R100\told` with no destination) leaves this
    // undefined, and the extension test below would throw on it. An `=== ''`
    // clause used to sit here too; the extension test already drops an empty
    // path, so nothing could distinguish it and its test could not fail.
    if (path === undefined) continue;
    // `core.quotePath` is on by default, so `café.ts` arrives as
    // `"caf\303\251.ts"`. The caller passes `-c core.quotePath=false`, which
    // handles the non-ASCII case — but a tab, newline or quote in the name is
    // still C-quoted, and such a path ends in `"` rather than `.ts`. Dropping
    // it on the extension test would delete a changed file from the scan and
    // still print CLEAN: exactly the silent failure this check exists to stop.
    if (path.startsWith('"')) {
      // Only fatal if it is TypeScript. A quoted path keeps its extension
      // before the closing quote, so this still tests it — the first version
      // aborted the whole scan for a `docs/notes "draft".md`, a file 4f was
      // never going to look at.
      if (path.endsWith('.ts"') || path.endsWith('.tsx"')) unreadable.push(path);
      continue;
    }
    if (!path.endsWith('.ts') && !path.endsWith('.tsx')) continue;
    files.push({ path, status: letter === 'C' ? 'A' : letter });
  }
  return { files, unreadable };
}

/** Every test file under `tests/`, read from the working tree. */
export function listTestFiles(root = process.cwd()): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(resolve(root, 'tests'), { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  return entries
    .map((entry) => entry.split(sep).join('/'))
    .filter((entry) => entry.endsWith('.test.ts') || entry.endsWith('.test.tsx'))
    .map((entry) => `tests/${entry}`)
    .sort();
}

/**
 * Reads a repo-relative path, clamped to the repo root.
 *
 * Only verdicts reach the output, so nothing here leaks a file's contents — but
 * a changed path arrives from git and `/pre-pr` asks for the result to be pasted
 * into a PR summary, so a `../` escape reading a sibling checkout is not a
 * surface this needs. Exported for its test; nothing else calls it.
 */
export function makeReader(root: string): (path: string) => string | null {
  const rootPrefix = resolve(root) + sep;
  return (path: string): string | null => {
    const full = resolve(root, path);
    if (full !== resolve(root) && !full.startsWith(rootPrefix)) return null;
    try {
      return readFileSync(full, 'utf8');
    } catch {
      return null;
    }
  };
}

/**
 * Finds test files whose text names one of a module's `@/` specifiers.
 *
 * The lookahead stops `@/lib/security` from matching `@/lib/security/sanitize`
 * — without it a barrel would claim every test of every module beneath it.
 * Test sources are read once, on first use, so a run where nothing reaches this
 * tier reads nothing.
 */
export function makeReferenceFinder(
  testFiles: readonly string[],
  read: (path: string) => string | null
): (specifiers: readonly string[]) => string[] {
  let sources: Array<{ path: string; text: string }> | null = null;

  return (specifiers: readonly string[]): string[] => {
    if (sources === null) {
      sources = testFiles
        .map((path) => ({ path, text: read(path) }))
        .filter((entry): entry is { path: string; text: string } => entry.text !== null);
    }
    const patterns = specifiers.map(
      (specifier) => new RegExp(`${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/\\-.])`)
    );
    return sources
      .filter((entry) => patterns.some((pattern) => pattern.test(entry.text)))
      .map((entry) => entry.path);
  };
}

/**
 * Uncommitted `.ts`/`.tsx` paths — reported as a blind spot, not scanned.
 * `null` when git could not be asked, which is a different answer from none.
 *
 * Exported for its test: the report prints a **count**, deliberately — local
 * filenames are not something `/pre-pr` should paste into a PR summary — and a
 * count cannot distinguish a rename parsed correctly from one parsed whole.
 */
export function uncommittedSources(): string[] | null {
  // Same `core.quotePath=false` as the diff. Without it an uncommitted
  // `lib/café.ts` arrives as `?? "caf\303\251.ts"`, fails the suffix test and
  // is dropped — the note undercounting, or vanishing, about the one thing it
  // exists to say.
  const status = git([
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (status === null) return null;
  return status
    .split('\n')
    .map((line) => {
      const entry = line.slice(3).trim();
      // A staged rename prints `R  old -> new`. Taking the whole string made
      // one "path" of both halves, and a move to a non-`.ts` destination was
      // dropped although a TypeScript file had left the tree.
      const arrow = entry.indexOf(' -> ');
      return arrow === -1 ? entry : entry.slice(arrow + ' -> '.length);
    })
    .filter((path) => path !== '' && (path.endsWith('.ts') || path.endsWith('.tsx')))
    .filter((path) => !path.startsWith('tests/'));
}

/**
 * The path, marked when git called it a rename.
 *
 * A renamed module whose test did not move with it is an ordinary gap, and it
 * reads very differently from a brand-new file that never had one — so the
 * report says which it is rather than recording the status and never using it.
 */
export function label(verdict: Verdict): string {
  return verdict.status === 'R' ? `${verdict.path} (renamed)` : verdict.path;
}

/** One line per verdict, for `--verbose`: why this file landed where it did. */
export function describe(verdict: Verdict): string {
  const { outcome } = verdict;
  switch (outcome.kind) {
    case 'exempt':
      return `${label(verdict)} — exempt: ${outcome.reason}`;
    case 'covered':
      return `${label(verdict)} — covered by ${outcome.testPath} (${outcome.via})`;
    case 'referenced':
      return `${label(verdict)} — referenced only, by ${outcome.referencedBy.length} test file(s)`;
    case 'missing':
      return `${label(verdict)} — MISSING`;
  }
}

/**
 * Says out loud what this run did not look at.
 *
 * Changed files come from `base...HEAD`, matching step 4f's own wording, so
 * work that is written but not committed is invisible to the scan — and that is
 * the most likely state to be in when running a pre-PR check. Test files, by
 * contrast, are read from the working tree, so a test you have just written
 * does count as coverage; the asymmetry is deliberate and this note is what
 * keeps it from being a surprise.
 */
function reportBlindSpot(): void {
  const uncommitted = uncommittedSources();
  if (uncommitted === null) {
    // "Could not look" is not "nothing to see". Returning `[]` on a failed
    // `git status` printed no note at all, which reads as "everything on disk
    // was committed and scanned" — the silence this whole check is against.
    console.log('');
    console.log('Note: could not check for uncommitted work (`git status` failed).');
    return;
  }
  if (uncommitted.length === 0) return;
  console.log('');
  console.log(
    `Note: ${uncommitted.length} uncommitted .ts/.tsx file(s) were NOT scanned — ` +
      'step 4f reads committed work. Commit and re-run to include them.'
  );
}

/** Renders the per-file findings. Returns the lines so tests can read them. */
export function formatReport(verdicts: readonly Verdict[], verbose = false): string[] {
  const lines: string[] = [];

  if (verbose) {
    lines.push('Every changed file and why it landed where it did:');
    for (const verdict of verdicts) lines.push(`  ${describe(verdict)}`);
    lines.push('');
  }
  const missing = verdicts.filter((v) => v.outcome.kind === 'missing');
  const referenced = verdicts.filter((v) => v.outcome.kind === 'referenced');
  const scanned = verdicts.filter((v) => v.outcome.kind !== 'exempt');

  if (missing.length > 0) {
    lines.push('No test file, and no test mentions the module:');
    for (const verdict of missing) {
      if (verdict.outcome.kind !== 'missing') continue;
      lines.push(`  ${label(verdict)}`);
      lines.push(`    expected e.g. ${verdict.outcome.expected[0]}`);
    }
    lines.push('');
  }

  if (referenced.length > 0) {
    lines.push('No mirrored test, but a test names the module — check it is exercised,');
    lines.push('not just mocked as somebody else’s dependency:');
    for (const verdict of referenced) {
      if (verdict.outcome.kind !== 'referenced') continue;
      const shown = verdict.outcome.referencedBy.slice(0, 3);
      const extra = verdict.outcome.referencedBy.length - shown.length;
      lines.push(`  ${label(verdict)}`);
      lines.push(`    named by ${shown.join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`);
    }
    lines.push('');
  }

  const exempt = verdicts.length - scanned.length;
  const tail = exempt > 0 ? ` (${exempt} exempt)` : '';

  if (scanned.length === 0) {
    lines.push(`4f: no files in scope — ${verdicts.length} changed file(s) all exempt.`);
  } else if (missing.length === 0 && referenced.length === 0) {
    lines.push(`4f: CLEAN — ${scanned.length} file(s) scanned, every one has a test${tail}.`);
  } else {
    lines.push(
      `4f: ${missing.length} missing, ${referenced.length} referenced-only — ` +
        `${scanned.length} file(s) scanned${tail}.`
    );
  }
  return lines;
}

/** Returns the process exit code so every path out is a plain `return`. */
export function main(argv: string[]): number {
  // The sentinel runs first, always, before anything can print a verdict.
  const broken = selfTestFailure();
  if (broken !== null) {
    console.error('Self-test failed — this scanner cannot be trusted to report:');
    console.error(`  ${broken}`);
    console.error('Fix `scripts/ci/missing-tests.ts` before reading any result from it.');
    return 1;
  }

  if (argv.includes('--self-test')) {
    console.log('Self-test passed: the classifier reports missing, referenced and exempt files.');
    return 0;
  }

  const requested = parseBaseRef(argv);
  if (requested.present && requested.ref === '') {
    console.error('`--base` needs a revision — got an empty value.');
    return 1;
  }
  if (requested.present && requested.ref.startsWith('-')) {
    console.error(`\`--base\` must be a revision, not an option: "${requested.ref}".`);
    return 1;
  }

  // An explicit `--base` is not resolved here — a ref that does not exist fails
  // at the `git diff` below, which reports it with git's own message. An
  // earlier version had a branch for it anyway; `requested.ref` is non-empty by
  // this point, so `!base` could never be true with `--base` present and the
  // branch was unreachable. The test written for it is what said so.
  const base = requested.present
    ? requested.ref
    : git(['merge-base', 'origin/main', 'HEAD'])?.trim();
  if (!base) {
    // Not "skipped": a run that could not establish what changed has no
    // opinion about this branch, and printing one on stdout is how a blind
    // check gets copied into a summary as a pass.
    console.error('4f: could not run — no base revision available.');
    console.error('Run `git fetch origin main` and re-run, or pass `--base <ref>`.');
    return 1;
  }

  const diff = git(['-c', 'core.quotePath=false', 'diff', '--name-status', `${base}...HEAD`]);
  if (diff === null) {
    console.error(`Could not list changed files against "${base}".`);
    console.error(`git: ${lastGitError}`);
    return 1;
  }

  const testFiles = listTestFiles();
  // An empty index is "could not look", not "nothing to find" — and it is the
  // shape #641 is about, because every file would then read as missing. The
  // sibling checks fail loudly in the same situation; so does this one.
  if (testFiles.length === 0) {
    console.error('Found no test files under `tests/` — is this the repo root?');
    console.error(`Looked under ${process.cwd()}.`);
    return 1;
  }

  const { files, unreadable } = parseNameStatus(diff);
  if (unreadable.length > 0) {
    // Exit 1, not a warning alongside a verdict. The contract here is that the
    // exit code says whether the check could *look*, and it could not look at
    // these — so there is no honest summary line to print next to them.
    console.error(`Could not read ${unreadable.length} changed path(s); git returned them quoted:`);
    for (const path of unreadable) console.error(`  ${path}`);
    console.error('A tab, newline or quote in a filename does this. Nothing was scanned.');
    return 1;
  }

  if (files.length === 0) {
    console.log(`4f: no TypeScript files added or modified vs ${base}.`);
    reportBlindSpot();
    return 0;
  }

  const read = makeReader(process.cwd());
  const context: ClassifyContext = {
    testFiles,
    readSource: read,
    referencesOf: makeReferenceFinder(testFiles, read),
  };

  const verbose = argv.includes('--verbose');
  for (const line of formatReport(classify(files, context), verbose)) console.log(line);
  reportBlindSpot();
  return 0;
}

// Only when run as a CLI. The four sibling `check:*` scripts call `main` at
// module scope unconditionally, which means importing one for a helper runs its
// whole check — this file exports six helpers and that fired on every ad-hoc
// script written against it, printing a stray verdict before the caller's own
// output. Worth the one deviation; the siblings have the same shape and could
// take the same line.
if (process.argv[1] !== undefined && process.argv[1].endsWith('check-missing-tests.ts')) {
  process.exitCode = main(process.argv.slice(2));
}
