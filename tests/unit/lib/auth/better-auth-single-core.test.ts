/**
 * One `@better-auth/core` in the tree, at the version `better-auth` runs on.
 *
 * `lib/auth/pending-signup.ts` imports `defineRequestState` / `hasRequestState`
 * from `@better-auth/core/context`, resolved from the root. better-auth's hooks
 * read request state through whichever core better-auth itself resolves. Every
 * better-auth 1.7.x release depends on its own core at exactly its own version,
 * so when `better-auth` moves past the root core, npm nests a second copy under
 * `node_modules/better-auth/node_modules/@better-auth/core`. That copy has its
 * own AsyncLocalStorage store. `hasRequestState()` then answers false inside
 * the hooks, the pending signup reads back `null` with no error, and an invited
 * user's membership is decided without their invitation: wrong org, wrong role,
 * and only a log line to show for it (t-1081).
 *
 * `npm ls` reports the skew as invalid, but nothing gated on it, and
 * `legacy-peer-deps` hides it at install. Four ways in: a lock refresh,
 * `npm update better-auth`, an npm `overrides` entry, or Dependabot moving one
 * package without the other. Sunrise's grouping moves version-update minors
 * and patches together, but a major arrives on its own, and a security update
 * ignores `groups` and bumps only the package its advisory names. When a
 * better-auth security PR fails here, bump `@better-auth/core` to the same
 * version in that PR.
 *
 * So this holds three things over the real `package.json` and
 * `package-lock.json`:
 *
 * 1. `package.json` declares both packages at the same exact version, so they
 *    move together by construction, and no `overrides` entry names either.
 * 2. The lockfile has `@better-auth/core` only at the root.
 * 3. The root core is the version `better-auth` is locked at, and the version
 *    better-auth's own dependency on core asks for.
 *
 * Its input is two files at the repo root, which no module imports, so it is
 * listed in `ALWAYS_RUN_TESTS` (`scripts/ci/scoped-tests.ts`).
 *
 * @see lib/auth/pending-signup.ts — the import that has to share better-auth's copy
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const CORE = '@better-auth/core';
const BETTER_AUTH = 'better-auth';
const ROOT_CORE = `node_modules/${CORE}`;
const ROOT_BETTER_AUTH = `node_modules/${BETTER_AUTH}`;

/** A plain version, no range operator: `1.7.27`, `1.8.0-beta.2`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const lockEntrySchema = z.looseObject({
  version: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
});

const lockfileSchema = z.looseObject({ packages: z.record(z.string(), lockEntrySchema) });

const manifestSchema = z.looseObject({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
});

type Lockfile = z.infer<typeof lockfileSchema>;
type Manifest = z.infer<typeof manifestSchema>;

/**
 * The paths in an npm `overrides` tree whose key is `better-auth` or
 * `@better-auth/core`, at any depth (`"some-pkg": { "@better-auth/core": … }`
 * forces a version as surely as a top-level entry).
 */
function overridePaths(tree: Record<string, unknown>, prefix: string[] = []): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = [...prefix, key];
    const name = key.replace(/@[^@/]*$/, '') || key;
    if (name === BETTER_AUTH || name === CORE) found.push(path.join(' > '));
    const nested = z.record(z.string(), z.unknown()).safeParse(value);
    if (nested.success) found.push(...overridePaths(nested.data, path));
  }
  return found;
}

/** Each way the manifest lets the two packages drift apart. Empty is in step. */
function manifestProblems(manifest: Manifest): string[] {
  const declared = { ...manifest.devDependencies, ...manifest.dependencies };
  const core = declared[CORE];
  const betterAuth = declared[BETTER_AUTH];
  const problems: string[] = [];
  for (const path of overridePaths(manifest.overrides ?? {})) {
    problems.push(`package.json overrides ${path}; pin it in dependencies instead`);
  }
  if (betterAuth === undefined) problems.push(`package.json does not declare ${BETTER_AUTH}`);
  if (core === undefined) problems.push(`package.json does not declare ${CORE}`);
  if (problems.length > 0) return problems;
  for (const [name, spec] of [
    [BETTER_AUTH, betterAuth],
    [CORE, core],
  ] as const) {
    if (!EXACT_VERSION.test(spec)) {
      problems.push(`${name} is declared as "${spec}", not an exact version`);
    }
  }
  if (betterAuth !== core) {
    problems.push(`${BETTER_AUTH} is declared as "${betterAuth}" but ${CORE} as "${core}"`);
  }
  return problems;
}

/** Each way the lockfile installs a core better-auth does not share. Empty is sound. */
function lockfileProblems(lock: Lockfile): string[] {
  const problems: string[] = [];
  const nested = Object.keys(lock.packages).filter(
    (key) => key !== ROOT_CORE && key.endsWith(`/${ROOT_CORE}`)
  );
  for (const key of nested) {
    problems.push(`a second ${CORE} is installed at ${key}`);
  }
  const core = lock.packages[ROOT_CORE];
  const betterAuth = lock.packages[ROOT_BETTER_AUTH];
  if (core?.version === undefined) problems.push(`no ${CORE} is locked at the root`);
  if (betterAuth?.version === undefined) problems.push(`no ${BETTER_AUTH} is locked at the root`);
  if (core?.version === undefined || betterAuth?.version === undefined) return problems;
  if (core.version !== betterAuth.version) {
    problems.push(
      `${BETTER_AUTH} is locked at ${betterAuth.version} but the root ${CORE} at ${core.version}`
    );
  }
  // An exact ask must equal the root core. A range the root core falls outside
  // makes npm nest a second copy, which the nested check above reports.
  const wanted = betterAuth.dependencies?.[CORE];
  if (wanted !== undefined && EXACT_VERSION.test(wanted) && wanted !== core.version) {
    problems.push(
      `${BETTER_AUTH} ${betterAuth.version} depends on ${CORE} "${wanted}", ` +
        `but the root ${CORE} is ${core.version}`
    );
  }
  return problems;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
}

/**
 * A lockfile shaped like the real one: better-auth at `betterAuth`, depending
 * on core at that same version, and the root core at `core`.
 */
function lockAt(betterAuth: string, core: string, extra: Lockfile['packages'] = {}): Lockfile {
  return {
    packages: {
      '': { version: '0.0.0' },
      [ROOT_BETTER_AUTH]: { version: betterAuth, dependencies: { [CORE]: betterAuth } },
      [ROOT_CORE]: { version: core },
      ...extra,
    },
  };
}

describe('the real tree', () => {
  it('declares better-auth and @better-auth/core at the same exact version', () => {
    const manifest = manifestSchema.parse(readJson('package.json'));
    expect(manifestProblems(manifest)).toEqual([]);
  });

  it('locks one @better-auth/core, at the version better-auth runs on', () => {
    const lock = lockfileSchema.parse(readJson('package-lock.json'));
    expect(lockfileProblems(lock)).toEqual([]);
  });
});

describe('manifestProblems', () => {
  it('passes two equal exact pins', () => {
    expect(
      manifestProblems({ dependencies: { [BETTER_AUTH]: '1.7.27', [CORE]: '1.7.27' } })
    ).toEqual([]);
  });

  it('fails a caret range on better-auth, the shape main had before t-1081', () => {
    expect(
      manifestProblems({ dependencies: { [BETTER_AUTH]: '^1.7.27', [CORE]: '1.7.27' } })
    ).toEqual([
      'better-auth is declared as "^1.7.27", not an exact version',
      'better-auth is declared as "^1.7.27" but @better-auth/core as "1.7.27"',
    ]);
  });

  it('fails two exact pins at different versions', () => {
    expect(
      manifestProblems({ dependencies: { [BETTER_AUTH]: '1.7.28', [CORE]: '1.7.27' } })
    ).toEqual(['better-auth is declared as "1.7.28" but @better-auth/core as "1.7.27"']);
  });

  it('fails an override on the core, at any depth', () => {
    expect(
      manifestProblems({
        dependencies: { [BETTER_AUTH]: '1.7.27', [CORE]: '1.7.27' },
        overrides: { [CORE]: '1.7.26', 'some-pkg': { [`${BETTER_AUTH}@1`]: '1.7.28' } },
      })
    ).toEqual([
      'package.json overrides @better-auth/core; pin it in dependencies instead',
      'package.json overrides some-pkg > better-auth@1; pin it in dependencies instead',
    ]);
  });

  it('passes overrides that name neither package', () => {
    expect(
      manifestProblems({
        dependencies: { [BETTER_AUTH]: '1.7.27', [CORE]: '1.7.27' },
        overrides: { '@prisma/config': { effect: '^3.22.1' } },
      })
    ).toEqual([]);
  });

  it('fails when the core is not declared, since lib/auth imports it from the root', () => {
    expect(manifestProblems({ dependencies: { [BETTER_AUTH]: '1.7.27' } })).toEqual([
      'package.json does not declare @better-auth/core',
    ]);
  });
});

describe('lockfileProblems', () => {
  it('passes one core at the root, equal to better-auth', () => {
    expect(lockfileProblems(lockAt('1.7.27', '1.7.27'))).toEqual([]);
  });

  it('fails a better-auth that has moved past the root core', () => {
    expect(lockfileProblems(lockAt('1.7.28', '1.7.27'))).toEqual([
      'better-auth is locked at 1.7.28 but the root @better-auth/core at 1.7.27',
      'better-auth 1.7.28 depends on @better-auth/core "1.7.28", but the root @better-auth/core is 1.7.27',
    ]);
  });

  it('fails a nested core even when the root versions agree', () => {
    const lock = lockAt('1.7.27', '1.7.27', {
      'node_modules/better-auth/node_modules/@better-auth/core': { version: '1.7.26' },
    });
    expect(lockfileProblems(lock)).toEqual([
      'a second @better-auth/core is installed at node_modules/better-auth/node_modules/@better-auth/core',
    ]);
  });

  it('fails a nested core under any package, not only better-auth', () => {
    const lock = lockAt('1.7.27', '1.7.27', {
      'node_modules/@better-auth/prisma-adapter/node_modules/@better-auth/core': {
        version: '1.7.28',
      },
    });
    expect(lockfileProblems(lock)).toEqual([
      'a second @better-auth/core is installed at node_modules/@better-auth/prisma-adapter/node_modules/@better-auth/core',
    ]);
  });

  it('fails when better-auth asks for a core other than the root one', () => {
    const lock = lockAt('1.7.27', '1.7.27');
    lock.packages[ROOT_BETTER_AUTH] = {
      version: '1.7.27',
      dependencies: { [CORE]: '1.7.26' },
    };
    expect(lockfileProblems(lock)).toEqual([
      'better-auth 1.7.27 depends on @better-auth/core "1.7.26", but the root @better-auth/core is 1.7.27',
    ]);
  });

  it('passes a range ask the single root core satisfies', () => {
    const lock = lockAt('1.8.0', '1.8.0');
    lock.packages[ROOT_BETTER_AUTH] = { version: '1.8.0', dependencies: { [CORE]: '^1.8.0' } };
    expect(lockfileProblems(lock)).toEqual([]);
  });

  it('fails a lock with no root core', () => {
    const lock = lockAt('1.7.27', '1.7.27');
    delete lock.packages[ROOT_CORE];
    expect(lockfileProblems(lock)).toEqual(['no @better-auth/core is locked at the root']);
  });
});
