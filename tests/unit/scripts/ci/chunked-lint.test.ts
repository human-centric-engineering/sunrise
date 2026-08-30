/**
 * Tests: scripts/ci/chunked-lint.mjs
 *
 * The thing under test is a chunk PLAN, and a bad plan does not fail — it
 * passes, faster, having linted less. Every assertion here exists because that
 * failure mode is silent:
 *
 *  - An earlier draft of this change split the tree by directory name and
 *    dropped 139 files (`emails/`, `hooks/`, `types/`, `prisma/`, `proxy.ts`,
 *    every root config). CI stayed green.
 *  - A chunk plan that duplicates files is only slow, but one that loses them is
 *    a hole, so the partition property is asserted in both directions: nothing
 *    lost, nothing repeated, order-independent.
 *
 * `lintTargets` takes its collaborators by injection (`listFiles`, an
 * ESLint-shaped object, `exists`) so the enumeration logic is testable without
 * spawning a real lint — which on this repo costs GBs and minutes. One test
 * deliberately runs it UNINJECTED against the real tree, because the injected
 * ones can only prove the filtering logic, never that the two real collaborators
 * are wired up the way it assumes.
 *
 * @see scripts/ci/chunked-lint.mjs
 * @see .context/architecture/ci.md § Knob 4: CI_LINT_CHUNKS
 */

import { describe, it, expect, vi } from 'vitest';

// Plain .mjs with no type declarations, by design: it must run from
// `npm run lint:ci` in a fresh checkout, before anything is compiled. TS
// resolves it via allowJs, so the named imports below are inferred, not `any`.
import {
  chunk,
  parseChunks,
  lintTargets,
  runChunk,
  adaptiveGroups,
  groupKey,
  resolveEslintCommand,
  withHeapCap,
  main,
  DEFAULT_CHUNKS,
  DEFAULT_HEAP_MB,
  LINTABLE,
} from '@/scripts/ci/chunked-lint.mjs';

const files = (n: number): string[] => Array.from({ length: n }, (_, i) => `f${i}.ts`);

describe('chunk', () => {
  it('partitions exactly — every item once, none lost', () => {
    const input = files(101);
    const flat = chunk(input, 4).flat();

    expect(flat).toHaveLength(input.length);
    expect(new Set(flat).size).toBe(input.length);
    expect([...flat].sort()).toEqual([...input].sort());
  });

  it.each([1, 2, 3, 7, 64])('partitions exactly at %i chunks', (n) => {
    const input = files(50);
    const flat = chunk(input, n).flat();
    expect([...flat].sort()).toEqual([...input].sort());
  });

  it('partitions a realistically-shaped tree, not just a flat list', () => {
    // The flat lists above cannot exercise the adaptive-deepening path, which is
    // where a file would actually go missing: buckets are rebuilt at a new depth
    // and a re-keying bug loses whatever it fails to re-file.
    const tree = [
      ...Array.from({ length: 400 }, (_, i) => `tests/unit/lib/${i % 9}/f${i}.ts`),
      ...Array.from({ length: 120 }, (_, i) => `lib/orchestration/${i % 5}/f${i}.ts`),
      ...Array.from({ length: 60 }, (_, i) => `app/api/v1/r${i}/route.ts`),
      ...Array.from({ length: 30 }, (_, i) => `components/ui/c${i}.tsx`),
      'proxy.ts',
      'eslint.config.mjs',
    ];

    const flat = chunk(tree, 4).flat();

    expect([...flat].sort()).toEqual([...tree].sort());
    expect(new Set(flat).size).toBe(tree.length);
  });

  it('keeps a directory together — locality, not balance, is what costs memory', () => {
    // The FIRST version of this function striped round-robin to balance the
    // chunks, and measured WORSE than not chunking at all (3.98GB against
    // 3.28GB): striping puts a slice of every directory in every chunk, so each
    // chunk loads nearly the whole type graph. A chunk costs its import CLOSURE,
    // not its file count — `eslint prisma` (98 files) peaks at 1.92GB while one
    // file in `lib/api` peaks at 2.64GB. So directories stay whole.
    const plan = chunk(['a/1.ts', 'a/2.ts', 'b/1.ts', 'b/2.ts'], 2);

    for (const c of plan) {
      const dirs = new Set(c.map((f: string) => f.split('/')[0]));
      expect(dirs.size, `chunk ${JSON.stringify(c)} mixes directories`).toBe(1);
    }
  });

  it('splits an oversized directory rather than letting it set the peak alone', () => {
    // At a fixed depth of 2, `tests/unit` alone was 1,649 of the measured fork's
    // 4,527 files — one indivisible group, so every plan had a chunk a third of
    // the tree wide and that chunk set the peak by itself. Oversized buckets
    // deepen.
    const big = Array.from({ length: 40 }, (_, i) => `tests/unit/${i % 4}/f${i}.ts`);
    const plan = chunk([...big, 'lib/a.ts'], 4);
    const largest = Math.max(...plan.map((c: string[]) => c.length));

    expect(largest).toBeLessThan(big.length);
  });

  it('stops deepening when a directory has no deeper segment to split on', () => {
    // 30 siblings in one flat directory cannot be divided by path, and the
    // grouping must terminate rather than loop looking for a deeper segment.
    const flat = Array.from({ length: 30 }, (_, i) => `lib/f${i}.ts`);
    const groups = adaptiveGroups(flat, 5);

    expect([...groups.values()].flat()).toHaveLength(30);
  });

  it('groups a root-level file without crashing on its missing directory', () => {
    expect(groupKey('proxy.ts')).toBe('.');
    const plan = chunk(['proxy.ts', 'lib/a.ts'], 2);
    expect(plan.flat().sort()).toEqual(['lib/a.ts', 'proxy.ts']);
  });

  it('keys a file by its directory, not its own name', () => {
    expect(groupKey('lib/api/responses.ts')).toBe('lib/api');
    expect(groupKey('lib/api/responses.ts', 1)).toBe('lib');
    // Depth is clamped so the file itself never becomes a group of one.
    expect(groupKey('lib/a.ts', 8)).toBe('lib');
  });

  it('never emits an empty chunk, even when asked for more chunks than it can make', () => {
    // An empty chunk would spawn eslint with no file arguments, and eslint with
    // no arguments lints NOTHING and exits 0 — a silent pass, which is the
    // failure mode this whole file guards against.
    //
    // Asking for 10 chunks of 3 files does NOT give 10 chunks, or even 3: these
    // three are siblings in one directory, and locality chunking keeps a
    // directory whole. Fewer, well-localised chunks is the design working, not
    // failing — the count is a ceiling, not a target.
    const plan = chunk(files(3), 10);

    expect(plan.length).toBeGreaterThan(0);
    expect(plan.length).toBeLessThanOrEqual(10);
    expect(plan.every((c: string[]) => c.length > 0)).toBe(true);
    expect(plan.flat().sort()).toEqual(files(3).sort());
  });

  it('is deterministic — the same input chunks identically every time', () => {
    // A chunk failure has to be reproducible on a second run and on another
    // runner, or "rerun chunk 3" means nothing.
    const tree = Array.from({ length: 200 }, (_, i) => `d${i % 7}/s${i % 3}/f${i}.ts`);
    expect(chunk(tree, 4)).toEqual(chunk(tree, 4));
  });

  it('survives an empty input without throwing', () => {
    expect(chunk([], 4)).toEqual([]);
  });

  it('treats a nonsensical chunk count as one chunk rather than none', () => {
    // `Math.max(1, count)` — zero bins would produce zero chunks and lint
    // nothing, silently.
    expect(chunk(['a/1.ts'], 0).flat()).toEqual(['a/1.ts']);
    expect(chunk(['a/1.ts'], -3).flat()).toEqual(['a/1.ts']);
  });
});

describe('parseChunks', () => {
  it('defaults to ONE — unchunked, exactly what base Sunrise does today', () => {
    // Differs from the fork this was ported from, which defaults to 4. Chunking
    // pays the ~2.6GB TypeScript Program once per chunk, and upstream has never
    // approached its heap ceiling, so it should not buy headroom it does not
    // need with wall-clock it would rather keep.
    expect(parseChunks(undefined)).toBe(1);
    expect(parseChunks('')).toBe(1);
    expect(DEFAULT_CHUNKS).toBe(1);
  });

  it('takes a positive integer', () => {
    expect(parseChunks('8')).toBe(8);
  });

  it.each(['0', '-1', '2.5', 'four', 'NaN'])(
    'falls back rather than failing the run on %s',
    (raw) => {
      // Refusing to lint because an unrelated variable is malformed trades a
      // small problem for a bigger one — same rule as run-capped.mjs.
      expect(parseChunks(raw, () => {})).toBe(DEFAULT_CHUNKS);
    }
  );

  it('SAYS SO when it falls back, because here the fallback is the failing case', () => {
    // The ported original fell back silently, and could afford to: its default
    // was 4, so a typo'd knob still chunked. This default is 1 — unchunked — so
    // silence would let a fork that set `CI_LINT_CHUNKS=six` believe it had
    // fixed its OOM and meet the identical failure with nothing in the log
    // connecting the two.
    const warn = vi.fn();
    parseChunks('six', warn);

    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('LINT_CHUNKS');
    expect(message).toContain('six');
    expect(message).toContain('NOT taken effect');
  });

  it('stays quiet when the value is simply absent', () => {
    // An unset knob is the normal case, not a mistake. Warning on it would
    // train the reader to ignore the warning that matters.
    const warn = vi.fn();
    parseChunks(undefined, warn);
    parseChunks('4', warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('lintTargets', () => {
  const eslintStub = (ignored: string[] = []) => ({
    isPathIgnored: (p: string) => Promise.resolve(ignored.some((i) => p.endsWith(i))),
  });

  it('keeps only lintable extensions', async () => {
    const listFiles = () =>
      ['a.ts', 'b.tsx', 'c.js', 'd.mjs', 'e.cjs', 'f.jsx', 'g.md', 'h.json', 'i.css'].join('\0');

    const out = await lintTargets({ listFiles, eslint: eslintStub(), exists: () => true });

    expect(out).toEqual(['a.ts', 'b.tsx', 'c.js', 'd.mjs', 'e.cjs', 'f.jsx'].sort());
    expect(LINTABLE).toContain('.tsx');
  });

  it("defers to ESLint's own ignore logic rather than reimplementing it", async () => {
    // The flat config's `ignores` (coverage/**, .next/**, …) must be honoured
    // without this script re-deriving them, which is where a hand-rolled
    // equivalent silently drifts from the real config.
    const listFiles = () => ['keep.ts', 'coverage/skip.js'].join('\0');

    const out = await lintTargets({
      listFiles,
      eslint: eslintStub(['coverage/skip.js']),
      exists: () => true,
    });

    expect(out).toEqual(['keep.ts']);
  });

  it('is deterministic, so the same commit chunks the same way on every runner', async () => {
    const listFiles = () => ['z.ts', 'a.ts', 'm.ts'].join('\0');
    const out = await lintTargets({ listFiles, eslint: eslintStub(), exists: () => true });
    expect(out).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });

  it('drops a file deleted from the working tree but still in the index', async () => {
    // `git ls-files` reads the INDEX. Handing eslint a path that no longer
    // exists exits 2 ("No files matching the pattern") and fails the whole chunk
    // for a reason unrelated to lint — the state a developer is in while
    // reproducing a CI failure locally.
    const listFiles = () => ['kept.ts', 'deleted.ts'].join('\0');
    const out = await lintTargets({
      listFiles,
      eslint: eslintStub(),
      exists: (p: string) => !p.endsWith('deleted.ts'),
    });

    expect(out).toEqual(['kept.ts']);
  });

  it('splits NUL-delimited git output, so a control-character path is not lost', async () => {
    // `git ls-files -z` emits NUL separators precisely so a path containing a
    // newline stays one record. Splitting on newline alone would tear it in two
    // and produce two paths that do not exist; C-quoting (what git does WITHOUT
    // `-z`) would instead wrap it in quotes so it no longer ends in `.ts` and it
    // would vanish from the plan in silence.
    const listFiles = () => 'lib/a.ts\0lib/we\nird.ts\0lib/b.ts\0';
    const out = await lintTargets({ listFiles, eslint: eslintStub(), exists: () => true });

    expect(out).toContain('lib/we\nird.ts');
    expect(out).toHaveLength(3);
  });

  it('does not trim, because a path may legitimately end in whitespace', async () => {
    // Trimming would hand eslint a path that does not exist, failing the whole
    // chunk for a reason unrelated to lint.
    const listFiles = () => ' lib/spaced .ts\0';
    const out = await lintTargets({ listFiles, eslint: eslintStub(), exists: () => true });
    expect(out).toEqual([' lib/spaced .ts']);
  });

  it('ignores the empty records NUL-delimited output ends with', async () => {
    const listFiles = () => 'a.ts\0\0b.ts\0';
    const out = await lintTargets({ listFiles, eslint: eslintStub(), exists: () => true });
    expect(out).toEqual(['a.ts', 'b.ts']);
  });
});

describe('lintTargets against the real tree', () => {
  // UNINJECTED, deliberately, and the only test here that is. Every case above
  // stubs both collaborators, so together they prove the filtering logic and
  // nothing about whether `git ls-files` and `new ESLint()` are actually wired
  // up the way the code assumes. A `-C` flag pointing at the wrong root, or an
  // ESLint constructed without `cwd`, would pass all of them and lint an empty
  // or wrong set here.
  //
  // Cheap despite the name: `isPathIgnored` consults the flat config's `ignores`
  // and never builds a TypeScript Program, so this is milliseconds, not the
  // minutes a real lint costs.
  it('finds the whole tree, and every top-level source directory in it', async () => {
    const targets = await lintTargets();

    // A floor, not a pinned count — a pinned one would fail on every PR that
    // adds a file. The 139-file bug this guards against dropped whole
    // directories, which no plausible floor would survive.
    expect(targets.length).toBeGreaterThan(1000);

    // Derived from the tree rather than rostered: every directory that HAS
    // lintable tracked files must be represented. A roster is the exact mistake
    // the original bug was made of — the dropped directories were the ones
    // nobody thought to list.
    const byTopLevel = new Set(targets.map((f: string) => f.split('/')[0]));
    for (const dir of ['app', 'lib', 'components', 'scripts', 'tests']) {
      expect(byTopLevel, `no file from ${dir}/ reached the lint plan`).toContain(dir);
    }

    // Root-level files have no directory and are the ones a directory-based
    // roster loses first. `eslint.config.mjs` is tracked, lintable and not
    // ignored, so its absence means root files are being dropped.
    expect(targets).toContain('eslint.config.mjs');

    // And the ignore logic is really being applied, not stubbed out to `false`:
    // nothing from an ignored tree should appear.
    expect(targets.filter((f: string) => f.startsWith('coverage/'))).toEqual([]);
    expect(targets.filter((f: string) => f.startsWith('.next/'))).toEqual([]);
  });

  it('covers every extension the real ESLint config actually configures', async () => {
    // LINTABLE is a roster, and this file's whole thesis is that a roster is how
    // files go missing. So it is checked against ESLint itself rather than
    // against a second hand-written list: for each candidate extension, ask
    // whether the flat config supplies rules for a file of that shape. If it
    // does and LINTABLE omits it, that file type would be dropped from every
    // plan in silence.
    //
    // Both shapes are probed because `eslint.config.mjs` configures
    // `*.config.{ts,mts,js,mjs,cjs}` — `.mts` is reachable ONLY as a config
    // filename, which a bare `probe.mts` would miss. That is exactly the case
    // this guard was written for.
    const { ESLint } = await import('eslint');
    const eslint = new ESLint();
    const candidates = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

    const configured: string[] = [];
    for (const ext of candidates) {
      for (const probe of [`probe${ext}`, `probe.config${ext}`]) {
        const config = await eslint.calculateConfigForFile(probe);
        if (Object.keys(config?.rules ?? {}).length > 0) {
          configured.push(ext);
          break;
        }
      }
    }

    // Guard the guard: if this found nothing it is proving nothing.
    expect(configured.length).toBeGreaterThan(3);
    expect(LINTABLE).toEqual(expect.arrayContaining(configured));
  });

  it('plans a real run that still partitions the real file list exactly', async () => {
    // The partition property on synthetic input above is the unit; this is the
    // same property on the actual shape of this repo, which is where an adaptive
    // deepening bug would show up and a synthetic tree might not.
    const targets = await lintTargets();
    const flat = chunk(targets, 4).flat();

    expect(flat).toHaveLength(targets.length);
    expect([...flat].sort()).toEqual([...targets].sort());
  });
});

describe('runChunk', () => {
  const fakeChild = (behaviour: (h: Record<string, (...a: never[]) => void>) => void) => {
    const handlers: Record<string, (...a: never[]) => void> = {};
    queueMicrotask(() => behaviour(handlers));
    return { on: (e: string, h: (...a: never[]) => void) => (handlers[e] = h) };
  };

  it('resolves the exit code rather than throwing', async () => {
    const spawnFn = vi.fn(() => fakeChild((h) => h.exit?.(1 as never)));
    await expect(runChunk(['a.ts'], [], { spawnFn, command: ['eslint'] })).resolves.toBe(1);
  });

  it('reports a spawn failure as a failure, not a pass', async () => {
    // `resolve(0)` here would turn "eslint is missing" into a green run.
    const spawnFn = vi.fn(() => fakeChild((h) => h.error?.(new Error('ENOENT') as never)));
    await expect(runChunk(['a.ts'], [], { spawnFn, command: ['eslint'] })).resolves.toBe(1);
  });

  it('treats a signal-killed child as a failure', async () => {
    // A chunk OOM-killed by the runner exits with a null code. Coercing that to
    // 0 would report success for the exact failure this script exists to avoid.
    const spawnFn = vi.fn(() => fakeChild((h) => h.exit?.(null as never)));
    await expect(runChunk(['a.ts'], [], { spawnFn, command: ['eslint'] })).resolves.toBe(1);
  });

  it('never spawns through a shell — the argv is filenames', async () => {
    // run-capped.mjs documents the hazard: with `shell: true` on Windows the
    // args are joined into one cmd.exe string, so a path containing `&` or `^`
    // is interpreted. Filenames must never take that path.
    const spawnFn = vi.fn(() => fakeChild((h) => h.exit?.(0 as never)));
    await runChunk(['a.ts'], ['--cache'], { spawnFn, command: ['eslint'] });

    expect(spawnFn).toHaveBeenCalledWith(
      'eslint',
      ['--cache', '--', 'a.ts'],
      expect.objectContaining({ shell: false })
    );
  });

  it('puts filenames after `--`, so a flag-shaped filename cannot become a flag', async () => {
    // `eslint .` passes one dot and has no such surface; this script passes a
    // list of paths as bare argv, so without the terminator a TRACKED file named
    // `--fix` is parsed as a flag and rewrites the tree mid-CI. Worse, `--config`
    // consumes the next argv entry as its value, and the list is sorted — so a
    // filename can be chosen to make eslint load, and execute, an
    // attacker-supplied JS config.
    //
    // Verified against eslint 9.39: `eslint -- --fix` reports *No files matching
    // the pattern "--fix"*, i.e. it is read as a path.
    const spawnFn = vi.fn((_bin: string, _args: string[]) =>
      fakeChild((h) => h.exit?.(0 as never))
    );
    await runChunk(['--fix', 'lib/a.ts'], ['--cache'], { spawnFn, command: ['eslint'] });

    const argv = spawnFn.mock.calls[0]?.[1] ?? [];
    const terminator = argv.indexOf('--');
    expect(terminator, 'no `--` terminator in the argv').toBeGreaterThan(-1);
    // Every filename lands after it; every flag before it.
    expect(argv.slice(terminator + 1)).toEqual(['--fix', 'lib/a.ts']);
    expect(argv.slice(0, terminator)).toEqual(['--cache']);
  });

  it('passes the heap cap down to the child, where the memory is actually spent', async () => {
    // The cap has to be in the CHILD's env. Applying it to this process would
    // cap the coordinator, which allocates nothing, and leave every eslint
    // process on Node's default — the exact 2GB-under-the-2.64GB-floor abort.
    // Typed signature, not a bare `vi.fn()`: without it `mock.calls` is an empty
    // tuple and indexing the options argument is a type error rather than a read.
    const spawnFn = vi.fn(
      (_bin: string, _args: string[], _options: { env: Record<string, string> }) =>
        fakeChild((h) => h.exit?.(0 as never))
    );
    await runChunk(['a.ts'], [], { spawnFn, command: ['eslint'], env: {} });

    const options = spawnFn.mock.calls[0]?.[2];
    expect(options?.env.NODE_OPTIONS).toContain(`--max-old-space-size=${DEFAULT_HEAP_MB}`);
  });
});

describe('resolveEslintCommand', () => {
  it("runs eslint's JS entry under this node, not the .bin shim", () => {
    // The shim is a `.cmd` on Windows, and since the CVE-2024-27980 fix `spawn`
    // REFUSES a `.cmd` target without `shell: true` — which this script cannot
    // use, because its argv is filenames. Going through `execPath` keeps one
    // code path on every platform instead of one that fails on Windows.
    const [bin, entry] = resolveEslintCommand() as string[];
    expect(bin).toBe(process.execPath);
    expect(entry).toMatch(/node_modules[/\\]eslint[/\\]bin[/\\]eslint\.js/);
  });
});

describe('withHeapCap', () => {
  it('applies a cap when the environment carries none', () => {
    // Without this, `lint:ci` outside CI inherits Node's default heap (~2GB on
    // an 8GB box), which is BELOW the 2.64GB floor one chunk needs — so every
    // chunk aborts with exit 134, the failure this script exists to prevent.
    expect((withHeapCap({}) as { NODE_OPTIONS: string }).NODE_OPTIONS).toBe(
      `--max-old-space-size=${DEFAULT_HEAP_MB}`
    );
  });

  it("defers to a cap already set, so CI's value always wins", () => {
    const out = withHeapCap({ NODE_OPTIONS: '--max-old-space-size=5120' }) as {
      NODE_OPTIONS: string;
    };
    expect(out.NODE_OPTIONS).toBe('--max-old-space-size=5120');
  });

  it('recognises the underscore spelling of the flag too', () => {
    // Node accepts `--max_old_space_size`. Missing it would append a second,
    // conflicting cap rather than standing down.
    const out = withHeapCap({ NODE_OPTIONS: '--max_old_space_size=5120' }) as {
      NODE_OPTIONS: string;
    };
    expect(out.NODE_OPTIONS).toBe('--max_old_space_size=5120');
  });

  it('appends rather than replacing other NODE_OPTIONS', () => {
    const out = withHeapCap({ NODE_OPTIONS: '--enable-source-maps' }) as {
      NODE_OPTIONS: string;
    };
    expect(out.NODE_OPTIONS).toBe(`--enable-source-maps --max-old-space-size=${DEFAULT_HEAP_MB}`);
  });

  it('leaves the rest of the environment alone', () => {
    const out = withHeapCap({ PATH: '/usr/bin', CI: 'true' }) as Record<string, string>;
    expect(out.PATH).toBe('/usr/bin');
    expect(out.CI).toBe('true');
  });
});

describe('main', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    log: () => {},
    warn: () => {},
    env: {},
    run: () => Promise.resolve(0),
    ...over,
  });

  it('FAILS rather than reporting a clean lint of nothing', async () => {
    // The one fallback in this file that is loud and non-zero, and the reason is
    // the whole design: `eslint` with no file arguments lints nothing and exits
    // 0, so a broken `git ls-files` or an over-broad `ignores` would print a
    // green lint of an unlinted tree. There is no tree this repo builds on with
    // zero lintable files, so this is "could not look", not "found nothing".
    const run = vi.fn();
    const warn = vi.fn();

    await expect(main([], deps({ targets: [], run, warn }))).resolves.toBe(1);

    expect(run).not.toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('no lintable files');
  });

  it('runs one eslint process per chunk', async () => {
    // Typed signature, not a bare `vi.fn()`: without it `mock.calls` is `[]` and
    // indexing a call is a type error rather than a read.
    const run = vi.fn((_files: string[], _argv: string[]) => Promise.resolve(0));
    const targets = ['a/1.ts', 'b/1.ts', 'c/1.ts', 'd/1.ts'];

    await main([], deps({ targets, chunks: 4, run }));

    expect(run).toHaveBeenCalledTimes(4);
    // Every target reached exactly one process — the partition property again,
    // this time through the real loop rather than through `chunk()` alone.
    expect(run.mock.calls.flatMap((c) => c[0]).sort()).toEqual(targets);
  });

  it('returns the WORST exit code, not the last one', async () => {
    // The loop keeps going after a failing chunk so the author sees every
    // problem in one run. That is only safe if the failure still propagates —
    // returning the last code would turn "chunk 1 failed, chunk 2 passed" into a
    // green lint.
    const run = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    await expect(
      main([], deps({ targets: ['a/1.ts', 'b/1.ts', 'c/1.ts', 'd/1.ts'], chunks: 4, run }))
    ).resolves.toBe(1);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('forwards its argv to every chunk', async () => {
    // `--cache` and friends have to reach each process; dropping them silently
    // turns every CI run cold, which is the cost this script is trying to bound.
    const run = vi.fn((_files: string[], _argv: string[]) => Promise.resolve(0));
    await main(
      ['--cache', '--max-warnings=0'],
      deps({ targets: ['a/1.ts', 'b/1.ts'], chunks: 2, run })
    );

    for (const call of run.mock.calls) {
      expect(call[1]).toEqual(['--cache', '--max-warnings=0']);
    }
  });

  it('reads the chunk count from LINT_CHUNKS', async () => {
    const run = vi.fn(() => Promise.resolve(0));
    const targets = ['a/1.ts', 'b/1.ts', 'c/1.ts', 'd/1.ts'];

    await main([], deps({ env: { LINT_CHUNKS: '2' }, run, targets }));

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs a single whole-tree process when nothing sets LINT_CHUNKS', async () => {
    // The upstream default path: identical to `eslint .` today, which is what
    // makes adopting this script cost base Sunrise nothing.
    const run = vi.fn(() => Promise.resolve(0));
    const targets = ['a/1.ts', 'b/1.ts', 'c/1.ts', 'd/1.ts'];

    await main([], deps({ run, targets }));

    expect(run).toHaveBeenCalledOnce();
  });

  it('warns, and does not chunk, when LINT_CHUNKS is nonsense', async () => {
    const run = vi.fn(() => Promise.resolve(0));
    const warn = vi.fn();
    const targets = Array.from({ length: 8 }, (_, i) => `d${i}/1.ts`);

    await main([], deps({ env: { LINT_CHUNKS: 'lots' }, run, targets, warn }));

    expect(run).toHaveBeenCalledTimes(DEFAULT_CHUNKS);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reports the plan it is about to execute', async () => {
    // A chunk that OOMs kills the process mid-run, so the log line naming the
    // chunk and its size is the only evidence of which slice died.
    const log = vi.fn();
    await main([], deps({ targets: ['a/1.ts', 'b/1.ts'], chunks: 2, log }));

    const output = log.mock.calls.map((c) => String(c[0])).join('\0');
    expect(output).toContain('2 files in 2 sequential chunk(s)');
    expect(output).toContain('chunk 1/2');
    expect(output).toContain('chunk 2/2');
  });
});
