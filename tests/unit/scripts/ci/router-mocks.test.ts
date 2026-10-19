/**
 * Router-mock scanner tests: the rules.
 *
 * This file is the artefact behind an instruction the old scanner only asserted:
 * "re-test it against those shapes before trusting a CLEAN." Each shape that
 * ever defeated a version of this check has a named case below, so changing the
 * scanner cannot quietly re-open one of them.
 *
 * ## Every violating shape here lives in a template literal, on purpose
 *
 * The real checker walks `tests/`, which includes this file. A parser sees a
 * template literal as one token and emits no `ObjectLiteralExpression` inside
 * it, so these shapes are invisible to it and the checker needs no exemption
 * for its own tests, pinned by the last case in this file.
 *
 * **Never write a bare six-member router literal, or a `useRouter` cast, in
 * this file's own TypeScript.** It would be a real violation, and the checker
 * would be right to flag it.
 *
 * @see scripts/ci/router-mocks.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

import { scanRouterMocks, formatViolation } from '@/scripts/ci/router-mocks';

/** Scans as a `.tsx` file unless a case needs otherwise. */
function scan(source: string, file = 'tests/unit/example.test.tsx') {
  return scanRouterMocks(source, file);
}

const literals = (source: string, file?: string) =>
  scan(source, file).filter((violation) => violation.rule === 'literal');

const casts = (source: string, file?: string) =>
  scan(source, file).filter((violation) => violation.rule === 'cast');

describe('scanRouterMocks: complete-literal rule', () => {
  describe('the five shapes that have defeated a version of this check', () => {
    it('flags shape 1: useRouter: vi.fn(() => ({ ... }))', () => {
      const source = `
        vi.mock('next/navigation', () => ({
          useRouter: vi.fn(() => ({
            push: vi.fn(),
            replace: vi.fn(),
            refresh: vi.fn(),
            back: vi.fn(),
            forward: vi.fn(),
            prefetch: vi.fn(),
          })),
        }));
      `;
      expect(literals(source)).toHaveLength(1);
    });

    it('flags shape 2: useRouter: () => ({ ... })', () => {
      const source = `
        vi.mock('next/navigation', () => ({
          useRouter: () => ({
            push: vi.fn(),
            replace: vi.fn(),
            refresh: vi.fn(),
            back: vi.fn(),
            forward: vi.fn(),
            prefetch: vi.fn(),
          }),
        }));
      `;
      expect(literals(source)).toHaveLength(1);
    });

    it('flags shape 3: a single-line six-member literal', () => {
      // A line-anchored version of this check reported CLEAN here, and
      // Prettier at printWidth 100 will never reflow it into view.
      const source = `const r = { push: a, replace: b, refresh: c, back: d, forward: e, prefetch: f };`;
      expect(literals(source)).toHaveLength(1);
    });

    it('flags shape 4: a hoisted literal referenced by the factory', () => {
      // Anchoring on `useRouter` rather than on the members misses this
      // entirely: the literal and the mock factory are different statements.
      const source = `
        const mockRouter = {
          push: vi.fn(),
          replace: vi.fn(),
          refresh: vi.fn(),
          back: vi.fn(),
          forward: vi.fn(),
          prefetch: vi.fn(),
        };
        vi.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
      `;
      expect(literals(source)).toHaveLength(1);
    });

    it('flags shape 5: shorthand members, the shape that shipped 16 violations', () => {
      // The previous scanner collected keys with /([A-Za-z_$][\w$]*)\s*:/,
      // so `refresh` here was never counted and the literal read as five of six.
      const source = `
        mockedRouter.mockReturnValue({
          push,
          replace: vi.fn(),
          refresh,
          back: vi.fn(),
          forward: vi.fn(),
          prefetch: vi.fn(),
        });
      `;
      expect(literals(source)).toHaveLength(1);
    });

    it('flags shape 5b: a shorthand `prefetch`, which the old anchor could not even locate', () => {
      const source = `
        mockedRouter.mockReturnValue({
          push: vi.fn(),
          replace: vi.fn(),
          refresh: vi.fn(),
          back: vi.fn(),
          forward: vi.fn(),
          prefetch,
        });
      `;
      expect(literals(source)).toHaveLength(1);
    });

    it('flags shape 5c: the exact shape all 16 repo files carried', () => {
      const source = `
        const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
        const refresh = vi.fn();
        beforeEach(() => {
          mockedRouter.mockReturnValue({
            push: vi.fn(),
            replace: vi.fn(),
            refresh,
            back: vi.fn(),
            forward: vi.fn(),
            prefetch: vi.fn(),
          });
        });
      `;
      expect(literals(source)).toHaveLength(1);
    });
  });

  describe('minimal stubs stay legal', () => {
    it('does not flag a two-member stub', () => {
      const source = `vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));`;
      expect(literals(source)).toEqual([]);
    });

    it('does not flag a four-member stub', () => {
      // The largest real stub in the suite. A component that reads nothing else
      // has no reason to build a whole router.
      const source = `
        const router = { refresh: vi.fn(), push: vi.fn(), back: vi.fn(), replace: vi.fn() };
      `;
      expect(literals(source)).toEqual([]);
    });

    it('does not flag five of six', () => {
      const source = `
        const router = {
          push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(),
        };
      `;
      expect(literals(source)).toEqual([]);
    });
  });

  describe('the factory', () => {
    it('does not flag a literal built by createMockRouter', () => {
      const source = `vi.mocked(useRouter).mockReturnValue(createMockRouter({ refresh }));`;
      expect(literals(source)).toEqual([]);
    });

    it('does not flag a literal that spreads the factory and overrides a member', () => {
      const source = `
        const router = {
          ...createMockRouter(),
          push: mockPush,
          replace: vi.fn(),
          refresh: vi.fn(),
          back: vi.fn(),
          forward: vi.fn(),
          prefetch: vi.fn(),
        };
      `;
      expect(literals(source)).toEqual([]);
    });

    it('does not flag all six spies passed to the factory as overrides', () => {
      // What the CLI tells a test asserting on all six methods to write.
      const source = `vi.mocked(useRouter).mockReturnValue(createMockRouter({ push, replace, refresh, back, forward, prefetch }));`;
      expect(literals(source)).toEqual([]);
    });

    it('recognises the factory through a namespace import', () => {
      const source = `
        const router = { ...mocks.createMockRouter(), push, replace, refresh, back, forward, prefetch };
        const cast = mocks.createMockRouter() as MockRouter;
      `;
      expect(scan(source)).toEqual([]);
    });

    it('still flags a literal that only uses the factory for one member', () => {
      const source = `
        const router = {
          push, replace, refresh, back, forward,
          prefetch: createMockRouter().prefetch,
        };
      `;
      expect(literals(source)).toHaveLength(1);
    });
  });

  describe('member collection', () => {
    it('flags quoted keys', () => {
      const source = `
        const router = {
          'push': a, 'replace': b, 'refresh': c, 'back': d, 'forward': e, 'prefetch': f,
        };
      `;
      expect(literals(source)).toHaveLength(1);
    });

    it('flags method-shorthand members', () => {
      const source = `
        const router = {
          push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {},
        };
      `;
      expect(literals(source)).toHaveLength(1);
    });

    it('counts direct members only, so a nested literal cannot make up the six', () => {
      // Brace-depth tracking is what the previous scanner needed a hand-rolled
      // loop for. `properties` is direct members by construction.
      const source = `
        const outer = {
          push: vi.fn(),
          nested: { replace: 1, refresh: 2, back: 3, forward: 4, prefetch: 5 },
        };
      `;
      expect(literals(source)).toEqual([]);
    });
  });

  describe('a literal that is not code', () => {
    it('does not flag one inside a line comment', () => {
      const source = `
        // { push: a, replace: b, refresh: c, back: d, forward: e, prefetch: f }
        const x = 1;
      `;
      expect(scan(source)).toEqual([]);
    });

    it('does not flag one inside a block comment', () => {
      const source = `
        /* const r = { push: a, replace: b, refresh: c, back: d, forward: e, prefetch: f }; */
        const x = 1;
      `;
      expect(scan(source)).toEqual([]);
    });

    it('does not flag one inside a string', () => {
      const source = `const doc = '{ push: a, replace: b, refresh: c, back: d, forward: e, prefetch: f }';`;
      expect(scan(source)).toEqual([]);
    });

    it('does not flag one inside a template literal', () => {
      // This is the property the whole test file depends on.
      const source =
        'const doc = `{ push: a, replace: b, refresh: c, back: d, forward: e, prefetch: f }`;';
      expect(scan(source)).toEqual([]);
    });
  });
});

describe('scanRouterMocks: cast rule', () => {
  it('flags the documented form, a cast to the router type', () => {
    const source = `const router = useRouter as unknown as ReturnType<typeof useRouter>;`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags the form every real violation used, a cast to ReturnType<typeof vi.fn>', () => {
    // The previous rule was a grep for the literal string of the form above, so
    // this (which defeats the type check just as thoroughly) went unseen in
    // all 17 files that used it (#936).
    const source = `const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags a cast to the router type from something other than useRouter', () => {
    const source = `const router = {} as unknown as ReturnType<typeof useRouter>;`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags a namespaced useRouter', () => {
    const source = `const mocked = navigation.useRouter as unknown as Mock;`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags a cast to AppRouterInstance', () => {
    const source = `const router = stub as unknown as AppRouterInstance;`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags a cast to the router type through a namespace import', () => {
    const source = `const router = {} as unknown as ReturnType<typeof navigation.useRouter>;`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags a cast to an inline-imported AppRouterInstance', () => {
    const source = `const router = stub as unknown as import('next/navigation').AppRouterInstance;`;
    expect(casts(source)).toHaveLength(1);
  });

  it("flags a cast to the repo's own MockRouter alias", () => {
    // `MockRouter` is `ReturnType<typeof useRouter> & ...`, so a cast to it
    // hides a missing member exactly as a cast to the Next type does.
    const source = `const router = { push } as unknown as MockRouter;`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags a partial router cast as it is handed to a mocked useRouter', () => {
    // The target is `never` and the operand an object literal, so neither the
    // operand nor the target names the router. Where the value goes does.
    const source = `vi.mocked(useRouter).mockReturnValue({ push, refresh } as never);`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags a partial router cast returned from mockImplementation', () => {
    const source = `vi.mocked(useRouter).mockImplementation(() => ({ push }) as never);`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags one returned from a block-bodied implementation', () => {
    const source = `vi.mocked(useRouter).mockImplementationOnce(() => { return { push } as never; });`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags one handed to vi.spyOn(navigation, "useRouter")', () => {
    const source = `vi.spyOn(navigation, 'useRouter').mockReturnValue({ push } as never);`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags one handed to a deep vi.mocked(useRouter, true)', () => {
    const source = `vi.mocked(useRouter, true).mockReturnValue({ push } as never);`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags one handed to vi.mocked with an explicit type argument', () => {
    const source = `vi.mocked<typeof useRouter>(useRouter).mockReturnValue({ push } as never);`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags one returned from inside a block in the implementation', () => {
    const source = `vi.mocked(useRouter).mockImplementation(() => { if (x) { return { push } as never; } return createMockRouter(); });`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags one returned as a branch of a conditional or a ?? operand', () => {
    const source = `
      vi.mocked(useRouter).mockImplementation(() => { return x ? ({ push } as never) : createMockRouter(); });
      vi.mocked(useRouter).mockImplementation(() => x ? ({ push } as never) : createMockRouter());
      vi.mocked(useRouter).mockReturnValue(stub ?? ({ push } as never));
    `;
    expect(casts(source)).toHaveLength(3);
  });

  it('does not flag a cast in a conditional that is not the returned value', () => {
    const source = `vi.mocked(useRouter).mockImplementation(() => { const n = x ? (1 as never) : 2; return createMockRouter(); });`;
    expect(casts(source)).toEqual([]);
  });

  it('stops at the nearest function, not the outermost one', () => {
    // A `return` inside a nested function's block returns from that function,
    // not from the implementation, so it is not the router handed out.
    const source = `vi.mocked(useRouter).mockImplementation(() => { const f = () => { if (y) { return 1 as never; } }; return createMockRouter(); });`;
    expect(casts(source)).toEqual([]);
  });

  it('does not flag a cast returned by a function nested inside the implementation', () => {
    const source = `vi.mocked(useRouter).mockImplementation(() => { const f = () => { return 1 as never; }; return createMockRouter(); });`;
    expect(casts(source)).toEqual([]);
  });

  it('does not flag a cast inside an implementation that is not its return value', () => {
    const source = `vi.mocked(useRouter).mockImplementation(() => { const n = 1 as never; return createMockRouter(); });`;
    expect(casts(source)).toEqual([]);
  });

  it('flags the same through mockReturnValueOnce', () => {
    const source = `vi.mocked(useRouter).mockReturnValueOnce({ push } as never);`;
    expect(casts(source)).toHaveLength(1);
  });

  it('flags a router cast that is the inner link of an unflagged chain', () => {
    const source = `const r = { push } as MockRouter as unknown as ReturnType<typeof vi.fn>;`;
    expect(casts(source)).toHaveLength(1);
  });

  it('reports a parenthesized chained cast once, not twice', () => {
    const source = `const m = (useRouter as unknown) as ReturnType<typeof vi.fn>;`;
    expect(casts(source)).toHaveLength(1);
  });

  it("does not flag a cast of the factory's own result", () => {
    const source = `const router = createMockRouter() as MockRouter;`;
    expect(casts(source)).toEqual([]);
  });

  it('reports a chained cast once, not twice', () => {
    // `X as unknown as T` is two nested AsExpressions.
    const source = `const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;`;
    expect(casts(source)).toHaveLength(1);
  });

  describe('scoped to the router, because a blanket ban would flag hundreds of innocent casts', () => {
    it('does not flag an apiClient cast', () => {
      const source = `const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;`;
      expect(casts(source)).toEqual([]);
    });

    it('does not flag a useSearchParams cast', () => {
      const source = `const mocked = useSearchParams as unknown as ReturnType<typeof vi.fn>;`;
      expect(casts(source)).toEqual([]);
    });

    it('does not flag a type alias that names the router type', () => {
      const source = `export type MockRouter = ReturnType<typeof useRouter> & { push: Mock };`;
      expect(casts(source)).toEqual([]);
    });

    it('does not flag a cast handed to some other mocked hook', () => {
      const source = `vi.mocked(useSearchParams).mockReturnValue(params as never);`;
      expect(casts(source)).toEqual([]);
    });

    it('does not flag vi.mocked(useRouter)', () => {
      const source = `vi.mocked(useRouter).mockReturnValue(createMockRouter());`;
      expect(casts(source)).toEqual([]);
    });

    it('does not flag a JSDoc line mentioning the cast', () => {
      // The previous grep needed a `grep -vE ':[[:space:]]*\\*'` filter for
      // exactly this. A comment is not a node, so no filter is needed.
      const source = `
        /**
         * Never write \`useRouter as unknown as ReturnType<typeof useRouter>\`.
         */
        export const x = 1;
      `;
      expect(scan(source)).toEqual([]);
    });
  });
});

describe('scanRouterMocks: wiring', () => {
  it('parses .tsx as TSX, so JSX does not mangle the tree', () => {
    // Read as ScriptKind.TS, `<Thing />` is a type assertion and everything
    // after it is nonsense, silently. Fifteen of the sixteen files this check
    // was written to catch (#936) are .tsx.
    const source = `
      function Harness() {
        return <div className="x">{'hi'}</div>;
      }
      const router = {
        push: vi.fn(), replace: vi.fn(), refresh: vi.fn(),
        back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(),
      };
    `;
    expect(literals(source, 'tests/unit/thing.test.tsx')).toHaveLength(1);
  });

  it('allowCompleteLiteral suppresses the literal rule but not the cast rule', () => {
    const source = `
      const router = {
        push: vi.fn(), replace: vi.fn(), refresh: vi.fn(),
        back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(),
      };
      const mocked = useRouter as unknown as ReturnType<typeof vi.fn>;
    `;
    const found = scanRouterMocks(source, 'tests/types/mocks.ts', { allowCompleteLiteral: true });
    expect(found.map((violation) => violation.rule)).toEqual(['cast']);
  });

  it('reports 1-based line and column pointing at the offending node', () => {
    const source = [
      'const a = 1;',
      'const router = {',
      '  push: p, replace: r, refresh: f, back: b, forward: w, prefetch: q,',
      '};',
    ].join('\n');
    expect(literals(source)[0]).toMatchObject({ line: 2, column: 16 });
  });

  it('echoes the file it was given, so the report can name it', () => {
    const source = `const mocked = useRouter as unknown as Mock;`;
    expect(casts(source, 'tests/helpers/thing.ts')[0]?.file).toBe('tests/helpers/thing.ts');
  });

  it('returns findings in source order', () => {
    const source = `
      const mocked = useRouter as unknown as Mock;
      const router = {
        push: vi.fn(), replace: vi.fn(), refresh: vi.fn(),
        back: vi.fn(), forward: vi.fn(), prefetch: vi.fn(),
      };
    `;
    expect(scan(source).map((violation) => violation.rule)).toEqual(['cast', 'literal']);
  });

  it('returns nothing for a file with no router mock in it', () => {
    expect(scan(`export const sum = (a: number, b: number) => a + b;`)).toEqual([]);
  });
});

describe('scanRouterMocks: false positives have a way out', () => {
  const SIX =
    'push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn()';

  it('does not flag a pages-router mock, which createMockRouter cannot build', () => {
    const source = `
      import { useRouter } from 'next/router';
      vi.mock('next/router', () => ({ useRouter: () => ({ ${SIX} }) }));
      const mocked = useRouter as unknown as ReturnType<typeof vi.fn>;
    `;
    expect(scan(source)).toEqual([]);
  });

  it('still flags a file that mocks both routers', () => {
    const source = `
      vi.mock('next/router', () => ({}));
      vi.mock('next/navigation', () => ({ useRouter: () => ({ ${SIX} }) }));
    `;
    expect(literals(source)).toHaveLength(1);
  });

  it('does not count a module name quoted in a template literal', () => {
    const source = ['const fixture = `next/router`;', `const router = { ${SIX} };`].join('\n');
    expect(literals(source)).toHaveLength(1);
  });

  it('still scans a file whose next/navigation mock names the module in a template literal', () => {
    const source = [
      "const pagesFixture = 'next/router';",
      'vi.mock(`next/navigation`, () => ({ useRouter: () => ({ ' + SIX + ' }) }));',
    ].join('\n');
    expect(literals(source)).toHaveLength(1);
  });

  it('skips a literal under an ignore directive that gives a reason', () => {
    const source = `
      // router-mocks-ignore: an it.each row keyed by method name, not a router
      const row = { ${SIX} };
    `;
    expect(literals(source)).toEqual([]);
  });

  it('skips a cast under an ignore directive that gives a reason', () => {
    const source = `
      // router-mocks-ignore: asserting the checker's own message
      const mocked = useRouter as unknown as ReturnType<typeof vi.fn>;
    `;
    expect(casts(source)).toEqual([]);
  });

  it('honours a directive above the statement, not only above the node', () => {
    const source = `
      // router-mocks-ignore: a table of method names
      it.each([{ ${SIX} }])('row', () => {});
    `;
    expect(literals(source)).toEqual([]);
  });

  it('ignores a block-comment directive whose only "reason" is the comment closing', () => {
    const source = `
      /* router-mocks-ignore:
       */
      const row = { ${SIX} };
    `;
    expect(literals(source)).toHaveLength(1);
  });

  it('accepts a reason that starts with a slash or an asterisk', () => {
    const source = `
      // router-mocks-ignore: /api/route keyed table, not a router
      const a = { ${SIX} };
      // router-mocks-ignore: *not* a router
      const b = { ${SIX} };
      /* router-mocks-ignore: a reason in a block comment */
      const c = { ${SIX} };
    `;
    expect(literals(source)).toEqual([]);
  });

  it('ignores a directive with no reason', () => {
    const source = `
      // router-mocks-ignore:
      const row = { ${SIX} };
    `;
    expect(literals(source)).toHaveLength(1);
  });

  it('does not let a directive above a multi-line factory reach a literal further down it', () => {
    const source = `
      // router-mocks-ignore: the factory's first member is a false positive
      vi.mock('next/navigation', () => ({
        useRouter: () => ({ ${SIX} }),
      }));
    `;
    expect(literals(source)).toHaveLength(1);
  });

  it('does not count a directive two lines above', () => {
    const source = `
      // router-mocks-ignore: too far away

      const row = { ${SIX} };
    `;
    expect(literals(source)).toHaveLength(1);
  });

  it('does not let a directive reach past the statement it sits on', () => {
    const source = `
      // router-mocks-ignore: only the first statement
      const first = 1;
      const row = { ${SIX} };
    `;
    expect(literals(source)).toHaveLength(1);
  });
});

describe('formatViolation', () => {
  it('renders path:line:col with the rule and message', () => {
    const source = `const mocked = useRouter as unknown as Mock;`;
    const [violation] = casts(source, 'tests/unit/thing.test.tsx');
    expect(formatViolation(violation)).toMatch(/^tests\/unit\/thing\.test\.tsx:1:16 {2}\[cast] /);
  });
});

describe('the checker does not need to exempt its own tests', () => {
  it('finds nothing in this file, whose every violating shape is a template literal', () => {
    // If this ever fails, someone has written a real router mock in this file
    // rather than a quoted one, or the immunity the docblock relies on has
    // been lost, which would mean the checker now needs a self-exemption. A
    // checker that exempts itself is the same shape as the bug it was fixing.
    const self = readFileSync('tests/unit/scripts/ci/router-mocks.test.ts', 'utf8');
    expect(scanRouterMocks(self, 'tests/unit/scripts/ci/router-mocks.test.ts')).toEqual([]);
  });
});
