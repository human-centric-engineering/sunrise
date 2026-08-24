/**
 * CLI: every `NEXT_PUBLIC_*` the code reads has a build-time delivery path.
 *
 * Exit 0 = no gaps (or nothing to check). Exit 1 = gaps, listed per variable.
 * Exit 2 = could not run, which is reported as a failure to look rather than a
 * clean result — see .context/architecture/checks.md.
 *
 * @see scripts/ci/client-env-delivery.ts for why the scan is sound
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  scanClientEnvVars,
  scanUninlinableReads,
  findDeliveryGaps,
} from '@/scripts/ci/client-env-delivery';

const ROOT = process.cwd();

/**
 * Everything Next compiles. Tests and build scripts are not shipped, so they are
 * out — but nothing Next touches may be, or the check's soundness claim fails at
 * its own file selection rather than at its regex.
 *
 * The root files are the ones a directory list forgets: `proxy.ts` is Next 16's
 * middleware and `instrumentation.ts` runs on every boot. A
 * `process.env.NEXT_PUBLIC_FOO` in either is inlined by the compiler and
 * undeliverable without an ARG — exactly #662 — and the first version of this
 * check reported "all vars have a build-time delivery path" regardless.
 */
const SOURCE_DIRS = ['app', 'components', 'lib', 'hooks', 'emails'];
const SOURCE_FILES = ['proxy.ts', 'instrumentation.ts', 'next.config.ts', 'middleware.ts'];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs)) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) sourceFiles(rel, acc);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry) && !/\.(test|spec)\./.test(entry)) acc.push(rel);
  }
  return acc;
}

function main(): number {
  const files = [
    ...SOURCE_DIRS.flatMap((d) => sourceFiles(d)),
    ...SOURCE_FILES.filter((f) => existsSync(join(ROOT, f))),
  ];
  if (files.length === 0) {
    console.error('Could not run: found no source files under ' + SOURCE_DIRS.join(', '));
    return 2;
  }

  const sources = files.map((f) => readFileSync(join(ROOT, f), 'utf8'));
  const variables = scanClientEnvVars(sources);
  const uninlinable = scanUninlinableReads(sources);

  const dockerfilePath = join(ROOT, 'Dockerfile');
  const composePath = join(ROOT, 'docker-compose.prod.yml');
  const targets = {
    dockerfile: existsSync(dockerfilePath) ? readFileSync(dockerfilePath, 'utf8') : null,
    compose: existsSync(composePath) ? readFileSync(composePath, 'utf8') : null,
  };

  const noTargets = targets.dockerfile === null && targets.compose === null;
  const gaps = noTargets ? [] : findDeliveryGaps(variables, targets);

  // Reported even with no delivery targets: a bracket-access read is a defect in
  // the source, not in the plumbing, so it does not stop mattering because a
  // fork deploys somewhere without a Dockerfile.
  if (uninlinable.length > 0) {
    console.error(
      `\nThese are read with bracket access, which Next does NOT inline:\n` +
        uninlinable.map((v) => `  ${v}  ->  rewrite as process.env.${v}`).join('\n') +
        `\nA build arg will not help: the value is never substituted, so the read has to ` +
        `change to the static form the compiler can see.\n`
    );
  }

  if (noTargets) {
    console.log(
      `No Dockerfile or docker-compose.prod.yml — no delivery path to check. ` +
        `(${variables.length} client vars found in ${files.length} files.)`
    );
    return uninlinable.length > 0 ? 1 : 0;
  }

  if (gaps.length === 0) {
    console.log(
      `All ${variables.length} NEXT_PUBLIC_* vars have a build-time delivery path ` +
        `(${files.length} source files scanned).`
    );
    return uninlinable.length > 0 ? 1 : 0;
  }

  console.error(
    `\n${gaps.length} NEXT_PUBLIC_* variable(s) cannot reach a container build:\n\n` +
      gaps.map((g) => `  ${g.variable}\n    missing: ${g.missing.join(', ')}`).join('\n') +
      `\n\nNEXT_PUBLIC_* is inlined at BUILD time and .dockerignore excludes .env*, so a ` +
      `build arg is the only channel. Absence is silent — that is how analytics and error ` +
      `reporting ended up off on every self-hosted deploy (#662).\n\n` +
      `Add to Dockerfile:            ARG <VAR>  and  ENV <VAR>=$<VAR>\n` +
      `Add to docker-compose.prod:   - <VAR>=\${<VAR>}\n`
  );
  return 1;
}

// `process.exitCode`, not `process.exit()`. stderr is asynchronous when it is a
// pipe — which it is under both `npm run` and GitHub Actions — and
// `process.exit()` discards whatever is still queued, so the gap report can be
// truncated or vanish entirely. A red gate naming no variables is worse than no
// gate. Matches check-changelog.ts and check-node-version.ts.
process.exitCode = main();
