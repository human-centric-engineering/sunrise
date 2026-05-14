---
name: testing
description: |
  Testing lens and quick patterns reference for Sunrise. Apply this skill whenever
  you create, modify, or audit Vitest tests — unit, integration, or component.
  Its purpose is to enforce an anti-green-bar mindset (tests must verify what the
  code *does*, not what mocks return) and route work into the right tool:
  `/test-plan` → `/test-write` → `/test-review` → `/test-fix` for branch- or
  module-scoped work, the `test-engineer` agent for spawn-based writing, or
  hands-on patterns for one-off tests. Use when the user asks to add, write,
  audit, fix, or review tests.
---

# Testing Skill

A lens, not a workflow. This skill exists to make every test you touch — whether you write it yourself, spawn a test-engineer agent to write it, or run it through `/test-review` — answer one question: **does this test prove the code works, or does it prove the mock works?**

The structured workflows (`/test-plan`, `/test-write`, `/test-review`, `/test-fix`, `/test-coverage`, `/test-triage`) live in `.claude/commands/`. The agent that physically writes tests (`test-engineer`) lives in `.claude/agents/`. This skill is the shared mindset they all draw from.

---

## The anti-green-bar lens

A green-bar test passes but verifies nothing. It's worse than no test, because it gives false confidence. **Apply this checklist to every test before moving on.**

### Per-test self-check

1. **Would this test still pass if the function body were deleted (returned `undefined`/`null`/empty)?** If yes — for example, the only assertion is `toBeDefined()` or `toBeTruthy()` — the assertion is too weak. Assert specific values, structures, or side effects.

2. **Am I asserting something the code computed, or something the mock returned?** If your assertion checks a value that was set via `mockResolvedValue(x)` with no transformation, filtering, mapping, or enrichment by the code under test, the test proves the mock works — not the code. Either:
   - Assert a **transformed** value (the code filtered, mapped, enriched, or restructured the mock data)
   - Assert a **side effect** (the code called another dependency with specific arguments derived from inputs)
   - Assert **structural wrapping** (the code wrapped the data in a response envelope, added metadata, etc.)

3. **Does this test verify at least one thing the code DOES, not just what it RETURNS?** Good tests check: was the right query made, were the right arguments passed, was the error logged, was the response shaped correctly? A test that only checks `data === mockData` checks nothing the code did.

### When you catch yourself green-barring

Do not ship the test. Instead:

- If the code genuinely transforms the data → fix the assertion to check the transformation.
- If the code passes data through with no transformation → keep the assertion but **add a side-effect assertion** (e.g. the right Prisma `where` clause was used, the right log line was emitted).
- If the code does nothing testable → **don't write a vacuous test**. Report it as a finding so the source can be refactored or removed.

### When tests fail: code bug vs test bug

When a test you wrote fails, **do not automatically edit the test to make it pass**. First determine which side is wrong.

**Evidence the CODE is wrong:**

- Behavior contradicts the function's name, docstring, or comment
- Behavior violates a documented contract (CLAUDE.md, `.context/`)
- The code silently swallows errors that should propagate
- Obvious logic error (wrong operator, missing null check, off-by-one)
- The code doesn't match the Zod schema it claims to validate against

**Action**: do not silently fix the source. Write the test with the _correct_ expected behavior so it fails, flag it inline with `// BUG:`, and report:

```
⚠️ SUSPECTED CODE BUG
File: lib/auth/guards.ts:42
Expected: 401 for missing session (per API contract)
Actual: returns 403
Evidence: CLAUDE.md documents withAuth() returns 401 for unauthenticated
```

**Evidence the TEST is wrong:**

- You assumed a return shape the code doesn't use
- You mocked a dependency incorrectly (wrong type, missing fields)
- You're asserting an implementation detail that changed, not a contract
- The behavior is intentional and your expectation was based on assumption

**Action**: fix the test.

**Default when ambiguous**: treat the code as correct, fix the test, add a `// AMBIGUOUS:` comment so `/test-review` can flag it. **Exception**: if the only way to make the test pass is to assert the exact mock return value with no transformation, that's not ambiguity — it's a mock-proving test. Report it as a suspected code bug; the code should be _doing_ something with the data.

---

## When to use which tool

| Situation                                   | Tool                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Adding tests for current branch changes     | `/test-plan` → `/test-write plan` → `/test-review` → `/test-fix --all`               |
| Building out coverage for a critical module | `/test-coverage <path>` → `/test-plan coverage <path>` → `/test-write plan` → review |
| Auditing test quality on a PR               | `/test-review pr` (posts comment) or `/test-review` (local report)                   |
| Quick test for 1–2 files                    | `/test-write <file>` (inline plan + execute)                                         |
| Codebase-wide legacy cleanup                | `/test-triage scan <folder>` → `worklist` → `/test-triage fix <file>`                |
| One-off ad-hoc test by hand                 | This skill's patterns + the lens above                                               |

The `test-engineer` agent is spawned automatically by `/test-write`. Don't invoke it directly except when explicitly told to (e.g. "spawn a test-engineer subagent to investigate X").

---

## Stack and conventions

- **Framework**: Vitest
- **Components**: React Testing Library
- **API integration**: Vitest with mocked Prisma + auth (`tests/integration/...`)
- **DB integration**: Testcontainers + real PostgreSQL when production-parity matters
- **Path alias**: always `@/` — never relative imports (enforced by ESLint)
- **Test location**: `tests/unit/`, `tests/integration/`, `tests/helpers/`, `tests/types/`
- **Naming**: `tests/<unit|integration>/<mirror-of-source-path>.test.ts`

```
Source                                  → Test
lib/validations/auth.ts                 → tests/unit/lib/validations/auth.test.ts
app/api/v1/users/route.ts               → tests/integration/api/v1/users/route.test.ts
components/forms/login-form.tsx         → tests/unit/components/forms/login-form.test.tsx
```

---

## Quick patterns

### AAA structure with type-safe assertions

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseJSON, assertDefined } from '@/tests/helpers/assertions';

describe('ModuleName', () => {
  beforeEach(() => {
    /* reset mocks, build inputs */
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('transforms valid input into the response envelope', async () => {
    // Arrange
    const input = makeInput();

    // Act
    const result = await fnUnderTest(input);

    // Assert: prove the function did something — not that the mock returned what it returned
    expect(result).toMatchObject({ success: true, data: { id: input.id, normalised: true } });
  });
});
```

### Shared mocks and assertions (always use these — they prevent lint/type cycles)

```typescript
import { createMockHeaders, createMockSession, delayed } from '@/tests/types/mocks';
import { assertDefined, assertHasProperty, parseJSON } from '@/tests/helpers/assertions';
```

### API route — mocking Prisma + auth guards

```typescript
import { GET } from '@/app/api/v1/resource/route';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/guards', () => ({
  withAuth: (handler: unknown) => handler,
  withAdminAuth: (handler: unknown) => handler,
}));
vi.mock('@/lib/db/client', () => ({
  prisma: { resource: { findMany: vi.fn(), count: vi.fn() } },
}));

it('strips sensitive fields and returns the envelope', async () => {
  const { prisma } = await import('@/lib/db/client');
  vi.mocked(prisma.resource.findMany).mockResolvedValue([
    { id: '1', name: 'A', secret: 'redacted-source' },
  ]);
  vi.mocked(prisma.resource.count).mockResolvedValue(1);

  const req = new NextRequest('http://localhost/api/v1/resource');
  const res = await GET(req, mockSession);
  const body = await parseJSON<{ success: true; data: Array<{ id: string }> }>(res);

  // Anti-green-bar: assert a TRANSFORMATION the route applied, not the raw mock
  expect(body.data[0]).not.toHaveProperty('secret');
  expect(body.data[0]).toMatchObject({ id: '1', name: 'A' });
});
```

The codebase wraps routes with `withAuth` / `withAdminAuth` from `lib/auth/guards.ts`. Mocking these to identity functions lets you call the handler directly with a stubbed session.

### Component test — assert behaviour, not styling

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

it('calls onSubmit with form values', async () => {
  const onSubmit = vi.fn();
  const user = userEvent.setup();

  render(<MyForm onSubmit={onSubmit} />);
  await user.type(screen.getByLabelText('Email'), 'a@b.com');
  await user.click(screen.getByRole('button', { name: /submit/i }));

  expect(onSubmit).toHaveBeenCalledWith({ email: 'a@b.com' });
});
```

Templates with fuller examples: `templates/simple.md`, `templates/medium.md`, `templates/complex.md`, `templates/component.md`.

---

## Validation before "done"

A test isn't done until all four pass:

```bash
npm test               # tests pass
npm run validate       # lint + type-check + format
npm run test:coverage  # coverage targets met (see .context/testing/overview.md)
```

If any fail, fix the underlying issue — never bypass with `--no-verify`, `as any`, or `eslint-disable` without a comment justifying it.

---

## Related material

**Patterns and rationale** (evergreen):

- `.context/testing/overview.md` — philosophy, stack, test types, thresholds
- `.context/testing/patterns.md` — AAA, type-safe assertions, parameterised tests
- `.context/testing/mocking.md` — strategies by dependency (Prisma, better-auth, Next.js, logger)
- `.context/testing/edge-cases.md` — boundary conditions, error paths
- `.context/testing/async-testing.md` — promises, timers, streams
- `.context/testing/type-safety.md` — Response.json, type guards
- `.context/testing/decisions.md` — architectural rationale
- `.context/testing/history.md` — past learnings

**Brittle patterns to avoid** (anti-patterns):

- `.claude/docs/test-brittle-patterns.md` — general + integration-specific anti-patterns; read both sections before writing integration tests

**Skill files**:

- `gotchas.md` — common pitfalls (ESLint cycles, NODE_ENV, Response.json typing) — verified across 559+ tests
- `templates/` — code templates by complexity

**Shared test code**:

- `tests/types/mocks.ts` — mock factories
- `tests/helpers/assertions.ts` — type-safe assertion helpers
