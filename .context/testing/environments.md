# Test environments

`vitest.config.ts` runs tests on **`node`** by default. A file that needs
browser APIs opts in, on its first line:

```ts
// @vitest-environment happy-dom
```

682 of 1087 test files run on node; 405 carry the docblock.

## When you need the docblock

Add it when the test touches anything the browser provides — `document`,
`window`, `localStorage`, `matchMedia`, an `IntersectionObserver` — or when it
renders anything:

- **every component test** (`@testing-library/react`, `render`, `renderHook`)
- **hooks** that read or write browser state (`lib/hooks/use-timeout`,
  `use-voice-recording`, the URL-tab hooks)
- **browser SDK wrappers** — `lib/analytics/providers/*` attach to `window`
- **anything asserting on `typeof window`** in either direction

You do not need it for route handlers, Zod schemas, Prisma-mocked services,
orchestration engine code, or the CI scripts. Those are the majority.

**One direction of getting it wrong fails loudly; the other does not.**

A test that needs a DOM and does not declare one dies with
`ReferenceError: document is not defined`, naming the line. Nothing needed for
that case.

A test that should run on node but ends up on happy-dom **still passes** —
happy-dom provides everything node does and more — so it quietly rejoins the
class of test this whole change exists to escape, with `lib/env.ts` validating
only the client schema.

`tests/unit/vitest-environment-directives.test.ts` (in
[`ALWAYS_RUN_TESTS`](./scoped-runs.md), so it runs on every scoped run) guards
the **mechanical** half of that: the directive is on line 1, a file never
carries two different values, and the value names an environment this repo
installs. Be clear about what it cannot do — **it cannot tell you a file did not
need the DOM it asked for.** Only running the file without one answers that, and
that is how 69 over-declared files were found and moved back to node during this
change; a review found 7 more. Treat a green run of that guard as "the
directives are well-formed", never as "the split is right".

**Never write the directive out in prose inside a test file.** Vitest matches
`@(?:vitest|jest)-environment\s+([\w-]+)` against the **whole file**, not just
the header, so a comment explaining the docblock applies it. This is not
theoretical — it happened twice while writing this change: once in a comment
describing the mechanism (which moved a node test onto happy-dom, caught only by
a deliberate `expect(typeof window).toBe('undefined')` tripwire), and once in a
`describe` title, which made vitest try to load an environment called
`directives`. Say "the environment docblock" instead. The guard test above
enforces it.

**Over-declaring is not harmless**, which is why there is no "when in doubt, add
it" advice here. It costs ~0.15s of environment construction, and — the part
that matters — it puts the file back under a DOM where `lib/env.ts` hands it the
client schema. If you are unsure, delete the directive and run the file: node is
the answer unless something fails.

## Why node is the default

**Speed.** Vitest builds a fresh environment per test file, and constructing a
happy-dom Window means building the whole browser API surface. Measured
back-to-back on `tests/unit/lib` (434 files) under identical load:

|                           | wall  | user CPU | in-worker `environment` |
| ------------------------- | ----- | -------- | ----------------------- |
| node default (this split) | 49.3s | 141s     | 11.4s                   |
| happy-dom everywhere      | 58.1s | 191s     | 79.5s                   |

Read the CPU and environment columns rather than the wall clock. Wall time moves
with whatever else the machine is doing — the same pair measured ~25% apart under
lighter load and ~15% here — while aggregate work is stable, and it is the thing
in short supply when two suites overlap.

**Correctness, which is the better half of the argument.** happy-dom defines
`window`, so `lib/env.ts`'s `typeof window !== 'undefined'` check selected the
**client** schema and every server variable read as `undefined`. Any test
branching on `TENANCY_MODE`, `CAPABILITY_BINDING_MODE` or `MCP_SESSION_MODE` was
silently exercising the undefined path — a downstream MCP change once had 40
tests pass against a stateless branch none of them entered. 44 of the 47 test
files that import `@/lib/env` now run under node and see the real server schema.
Three still opt into happy-dom, and all three are deliberate: two component
tests, plus `env.test.ts`, which asserts on `typeof window` in both directions.

`tests/unit/lib/env-server-vars.test.ts` pins this and asserts it, and keeps its
own `// @vitest-environment node` directive so a future flip of the default
breaks there loudly rather than making its assertions vacuous.

### A real bug this surfaced

`successResponse` always builds a body, and 204/205/304 must not have one.
Node's `Response` (undici — what Next actually runs on) rejects it; happy-dom's
is lenient and accepted it. A test asserting `successResponse(null, undefined,
{ status: 204 }).status === 204` therefore passed while describing behaviour
production cannot produce. Nothing calls it that way — every 204 in `app/` is
built as `new Response(null, { status: 204 })` — so the test now pins the real
constraint instead.

## Why a docblock and not a glob

`environmentMatchGlobs` was removed in vitest 3 and is absent from 4. Its
replacement is `test.projects`, which would work — except that a projects config
makes `vitest list --filesOnly` prefix every line with `[name] `, and
`scripts/ci/run-scoped-tests.ts` (the `npm run test:changed` gate) resolves its
selection from exactly that output and refuses a line it cannot resolve to a
file. Adopting projects here would have broken the gate.

A directory rule would not have worked either: 51 files under `tests/unit/lib/`
need a DOM, so where a test lives never predicted what it needs.

## The network guard

`tests/setup.ts` refuses real network requests so a component that fetches on
mount cannot spend the run connecting to a dev server that isn't there (#597).
That guard was installed through **happy-dom's own fetch interceptor**, because
happy-dom ships its own fetch over `node:http` and never consults
`globalThis.fetch`.

Moving the default to node therefore removed it from 605 files — not loudly;
it simply was not there. There is now a second implementation for the node
environment that patches `globalThis.fetch`, rejecting with the same
`DOMException` named `NetworkError`, letting `data:`/`blob:` through, and
respecting an aborted signal so `AbortError` branches still work. Both halves
have tests (`tests/unit/setup/network-guard-*.test.ts`); neither did before.

`vi.stubGlobal('fetch', …)` remains the escape hatch in both.

## For forks

The docblock is per file, so this merges cleanly — a fork's own tests carry
their own directives and nothing upstream rewrites them. If you add a component
test and it dies on `document is not defined`, add the line.

## See also

- [`overview.md`](./overview.md) — philosophy and test types
- [`scoped-runs.md`](./scoped-runs.md) — running only the tests a branch needs
- [`mocking.md`](./mocking.md) — the happy-dom network interceptor in `tests/setup.ts`
- `vitest.config.ts` — the setting and the full reasoning
