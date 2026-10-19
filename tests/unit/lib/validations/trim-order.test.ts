/**
 * Guard: a Zod string chain trims before it checks.
 *
 * Zod 4 runs a string chain's checks in the order they are written, and
 * `.trim()` is one of them — it rewrites the value at the point it appears.
 * So `z.string().min(1).trim()` measures the raw input, accepts `"   "`, and
 * then stores `""`: a required field saved blank (#713). Sixty-seven chains
 * had that shape when the issue was fixed, from sign-up's `name` to most of
 * the orchestration admin forms, and another twenty-one ran `.max()` on the
 * untrimmed value. `nonEmptyStringSchema` in `lib/validations/common.ts`
 * already had the right order; nothing made code use it, so the drift came
 * back one field at a time.
 *
 * The rule here: in any `z.string()…` chain that calls `.trim()`, no length,
 * pattern or format check — and no refinement — comes before it.
 *
 * In `ALWAYS_RUN_TESTS` because the change it exists to catch is a new
 * schema in a file no import chain connects to this test.
 *
 * ## What this does NOT cover
 *
 * It reads chains rooted at `z.string()`. A check applied to a schema held in
 * a variable (`const s = z.string().min(1); s.trim()`) is not seen. None
 * exists today; the inline shape is the one every validation file uses.
 *
 * @see lib/validations/common.ts — `nonEmptyStringSchema`
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = process.cwd();
const ROOTS = ['app', 'lib', 'components'];
const NOT_SOURCE = new Set(['node_modules', '.next']);

/** Checks whose result depends on whether surrounding whitespace is still there. */
const ORDER_SENSITIVE = new Set([
  'min',
  'max',
  'length',
  'nonempty',
  'regex',
  'startsWith',
  'endsWith',
  'includes',
  'email',
  'url',
  'uuid',
  'refine',
  'superRefine',
  'check',
]);

interface Chain {
  line: number;
  methods: string[];
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (NOT_SOURCE.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full) && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Every outermost `z.string()…` method chain in a source file. */
function stringChains(fileName: string, source: string): Chain[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const chains: Chain[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      !ts.isPropertyAccessExpression(node.parent)
    ) {
      const methods: string[] = [];
      let cur: ts.Expression = node;
      while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
        methods.unshift(cur.expression.name.text);
        cur = cur.expression.expression;
      }
      if (ts.isIdentifier(cur) && cur.text === 'z' && methods[0] === 'string') {
        chains.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, methods });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return chains;
}

/** The order-sensitive checks a chain runs before its `.trim()`. */
function checksBeforeTrim(methods: string[]): string[] {
  const trimAt = methods.indexOf('trim');
  if (trimAt === -1) return [];
  return methods.slice(1, trimAt).filter((m) => ORDER_SENSITIVE.has(m));
}

describe('Zod string chains trim before they check', () => {
  it('detects a check written before .trim(), and accepts one written after', () => {
    const [bad, good, untrimmed] = stringChains(
      'sample.ts',
      `const a = z.string().min(1).max(10).trim().optional();
       const b = z.string().trim().min(1).max(10).optional();
       const c = z.string().min(1);`
    ).map((c) => checksBeforeTrim(c.methods));
    expect(bad).toEqual(['min', 'max']);
    expect(good).toEqual([]);
    expect(untrimmed).toEqual([]);
  });

  it('finds no chain in app/, lib/ or components/ that checks before trimming', () => {
    const offenders: string[] = [];
    let trimmedChains = 0;
    for (const root of ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        const source = readFileSync(file, 'utf8');
        if (!source.includes('.trim()')) continue;
        for (const chain of stringChains(file, source)) {
          if (!chain.methods.includes('trim')) continue;
          trimmedChains++;
          const early = checksBeforeTrim(chain.methods);
          if (early.length > 0) {
            offenders.push(
              `${relative(REPO_ROOT, file)}:${chain.line} — .${early.join('/.')}() runs before .trim()`
            );
          }
        }
      }
    }
    // The scan must have something to judge, or an empty result proves nothing.
    expect(trimmedChains).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
