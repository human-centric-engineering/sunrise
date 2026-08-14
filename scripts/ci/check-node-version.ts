/**
 * Node major-version consistency check — CLI.
 *
 * The rules, and why this is needed at all, live in
 * `scripts/ci/node-version.ts`. This file only reads the files and hands their
 * contents over, so importing the rules never touches the filesystem. Four
 * files, five sources — `package.json` states the major twice, once for npm
 * (`engines.node`) and once for `tsc` (`@types/node`).
 *
 * Usage:
 *   npm run check:node-version
 */

import { readFileSync } from 'fs';

import {
  checkNodeVersion,
  formatResult,
  parseDockerfileMajor,
  parseEnginesMajor,
  parseNvmrc,
  parseTypesNodeMajor,
  type NodeVersionSource,
} from '@/scripts/ci/node-version';

/**
 * Reads a file, distinguishing "absent" from "present but unreadable".
 *
 * The distinction reaches the operator: collapsing a missing file into `''`
 * makes it parse as unparseable, and the failure then points at a `FROM` line
 * in a file that does not exist. A fork that drops `Dockerfile.dev` or renames
 * either Dockerfile hits exactly that, and cannot run `npm run validate` until
 * it works out the message is lying.
 */
function read(path: string): { text: string; missing: boolean } {
  try {
    return { text: readFileSync(path, 'utf8'), missing: false };
  } catch {
    return { text: '', missing: true };
  }
}

/** The `raw` evidence string for a Dockerfile source. */
function dockerfileEvidence(file: { text: string; missing: boolean }, path: string): string {
  if (file.missing) return `(${path} not found)`;
  return (
    file.text
      .split('\n')
      .find((l) => /^\s*FROM\s+node:/i.test(l))
      ?.trim() ?? '(no FROM node: line)'
  );
}

const pkg = read('package.json');
let enginesNode: string | undefined;
let typesNode: string | undefined;
// Tracked separately from `pkg.missing`: "absent", "unreadable" and "present
// but does not name it" are three different things to an operator, and only
// the third is about the dependency. Collapsing the middle one produced "not
// named in package.json" for a file that named it on the line above the error.
let pkgUnparseable = false;
try {
  const parsed = JSON.parse(pkg.text) as {
    engines?: { node?: string };
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  enginesNode = parsed.engines?.node;
  // `devDependencies` is where it belongs and where it is, but a fork that
  // moved it to `dependencies` still ships the same mismatch — read both
  // rather than reporting "absent" for a package that is plainly present.
  typesNode = parsed.devDependencies?.['@types/node'] ?? parsed.dependencies?.['@types/node'];
} catch {
  enginesNode = undefined;
  typesNode = undefined;
  pkgUnparseable = true;
}

// The RESOLVED version, which is what `tsc` loads. The range in `package.json`
// is read only to show the operator what they wrote — `>=24` resolves to 26,
// so a range cannot answer "what is tsc checking against?".
const lockfile = read('package-lock.json');

/**
 * Where the `@types/node` major came from, in the operator's terms.
 *
 * Distinguishes "package.json unreadable" from "not declared directly" from
 * "declared as X, resolved to Y" — the same distinction {@link read} exists to
 * preserve. Collapsing them produced "not a direct dependency" for a
 * `package.json` nobody could parse.
 */
function typesNodeEvidence(): string {
  if (pkg.missing) return '(package.json not found)';
  if (pkgUnparseable) return '(package.json could not be parsed)';
  if (lockfile.missing) return '(package-lock.json not found)';
  const resolved = resolvedTypesNode(lockfile.text) ?? '(no lockfile entry)';
  return typesNode === undefined
    ? `(not named in package.json; a transitive copy resolves to ${resolved})`
    : `${typesNode} → ${resolved}`;
}

/** The resolved version, for the evidence string — parsing lives in the rules. */
function resolvedTypesNode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { packages?: Record<string, { version?: string }> };
    return parsed.packages?.['node_modules/@types/node']?.version;
  } catch {
    return undefined;
  }
}

const nvmrc = read('.nvmrc');
const dockerfile = read('Dockerfile');
const dockerfileDev = read('Dockerfile.dev');

const sources: NodeVersionSource[] = [
  {
    label: '.nvmrc',
    major: parseNvmrc(nvmrc.text),
    raw: nvmrc.missing ? '(.nvmrc not found)' : nvmrc.text.trim(),
  },
  {
    label: 'Dockerfile',
    major: parseDockerfileMajor(dockerfile.text),
    raw: dockerfileEvidence(dockerfile, 'Dockerfile'),
  },
  {
    label: 'Dockerfile.dev',
    major: parseDockerfileMajor(dockerfileDev.text),
    raw: dockerfileEvidence(dockerfileDev, 'Dockerfile.dev'),
  },
  {
    label: 'package.json engines.node',
    major: parseEnginesMajor(enginesNode),
    raw: pkg.missing
      ? '(package.json not found)'
      : pkgUnparseable
        ? '(package.json could not be parsed)'
        : (enginesNode ?? '(engines.node absent)'),
  },
];

// Only when there IS an npm lockfile. `parseTypesNodeMajor` returns null for a
// missing one, and `checkNodeVersion` treats null as unreadable — a hard
// failure — which would break any fork that uses pnpm or yarn, or gitignores
// the lockfile, with nothing it could edit to satisfy the check. A lockfile
// that EXISTS but cannot be read, or has no entry, still fails: that is a
// broken tree rather than a different package manager.
//
// Checked even when `package.json` does not name `@types/node` directly, since
// `tsc` loads whatever copy resolves and a transitive one carries the same
// risk. An earlier version skipped that case by handing this source a `null`
// major, which — same trap — was a hard failure rather than a skip.
if (!lockfile.missing) {
  sources.push({
    // What `tsc` type-checks against. Ahead of the runtime, it accepts APIs
    // that throw in the production image and reports nothing (#584).
    label: '@types/node (resolved)',
    major: parseTypesNodeMajor(lockfile.text),
    raw: typesNodeEvidence(),
  });
}

const result = checkNodeVersion(sources);
const agreed = sources.find((s) => s.major !== null)?.major ?? null;

// `process.exitCode`, not `process.exit()` — stderr is asynchronous when it is
// a pipe, which it is under both `npm run` and GitHub Actions, and exiting
// discards whatever is still queued.
process.exitCode = formatResult(result, agreed, sources);
