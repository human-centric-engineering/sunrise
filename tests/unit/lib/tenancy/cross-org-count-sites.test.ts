/**
 * Tests: `runAsCrossOrgCount` has one caller (§107 t-752). The whole checkout
 * is read — root files like `proxy.ts` too — and a re-export counts as a use.
 *
 * The scope is the audited bypass, logged at debug instead of info because
 * the admin pages enter it on every load. That trade is only safe while every
 * entry is a read-only count that returns another org's rows as numbers,
 * which is what `lib/orchestration/admin/global-config-usage.ts` does. A new
 * caller anywhere else is a bypass nobody would see in the info log. If this
 * fails naming your file: count through that module, or use `runAsSystem`.
 *
 * Whole-tree: declared in `ALWAYS_RUN_TESTS`, because a new caller is a file
 * no import chain connects to this test.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED = new Set([
  'lib/tenancy/context.ts', // the definition
  'lib/orchestration/admin/global-config-usage.ts', // the one caller
]);

/** Every source file in the checkout — root files like `proxy.ts` included — but tests. */
function sourceFiles(): string[] {
  return execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
    .split('\n')
    .filter(
      (p) =>
        /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(p) &&
        !p.startsWith('tests/') &&
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
    );
}

/** An import of it, or a call — not a mention in prose (an always-run reason names it). */
const USES =
  /\b(?:import|export)\s*(?:type\s*)?\{[^}]*\brunAsCrossOrgCount\b[^}]*\}\s*from\b|\brunAsCrossOrgCount\s*(?:<[^>]*>)?\(/;

function callersIn(
  files: readonly string[],
  text = (p: string) => readFileSync(p, 'utf8')
): string[] {
  return files.filter((p) => !ALLOWED.has(p) && USES.test(text(p)));
}

describe('runAsCrossOrgCount', () => {
  it('is entered only by the global-config usage module', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toEqual(expect.arrayContaining([...ALLOWED, 'proxy.ts']));
    expect(callersIn(files)).toEqual([]);
  });

  it('names a caller anywhere else', () => {
    // A real file that does not mention it, judged as if it did: the check
    // reads the text, so prove it can report rather than trust a clean run.
    const files = sourceFiles();
    const unrelated = 'lib/tenancy/constants.ts';
    expect(files).toContain(unrelated);
    expect(readFileSync(unrelated, 'utf8')).not.toContain('runAsCrossOrgCount');
    expect(
      callersIn([unrelated], () => "import { runAsCrossOrgCount } from '@/lib/tenancy/context';")
    ).toEqual([unrelated]);
    expect(callersIn([unrelated], () => "await runAsCrossOrgCount('r', fn);")).toEqual([unrelated]);
    // A re-export lets anything call it through a barrel.
    expect(
      callersIn([unrelated], () => "export { runAsCrossOrgCount } from '@/lib/tenancy/context';")
    ).toEqual([unrelated]);
    expect(callersIn([unrelated], () => '// see `runAsCrossOrgCount`, the debug bypass')).toEqual(
      []
    );
  });
});
