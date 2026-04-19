# Brittle Patterns to Avoid

Authoritative list of test-writing anti-patterns captured from past `/test-review` findings. Both the planner (`/test-plan`) and the test-engineer agent should read this before producing or executing plans. Embedded into every generated plan file (`.claude/tmp/test-plan.md`) in the `## Brittle Patterns to Avoid` section, and referenced from `.claude/agents/test-engineer.md`.

Each pattern is a concrete failure mode, not a style preference. The list grows when `/test-review` surfaces a new pattern that the plan or agent should have caught.

## Patterns

### 1. Multi-render `toHaveBeenNthCalledWith` in a single `it` block

Asserting `toHaveBeenNthCalledWith(1, ...)`, `toHaveBeenNthCalledWith(2, ...)`, etc. across multiple renders inside one test creates index-dependent assertions. If an earlier render's assertion fails, every subsequent assertion's index shifts — producing misleading failure messages that look like "arg mismatch at call 3" when the real issue was call 1.

**Instead**: split into separate `it` blocks, each with one render and one focused assertion. Each test owns one behaviour.

### 2. Add/Rewrite overlap

An Add item for a new test case is redundant if a Rewrite on the same file already asserts the same thing. Example: rewriting `should call X with no options` to assert `toHaveBeenCalledWith({...})` already proves the call happened, so a separate `should call X exactly once on mount` Add is duplicative — the rewrite implies single-fire via its exact-args assertion.

**Planner**: sanity-check every Add against the Rewrite list in the same file. Drop redundant Adds before forwarding to the plan.
**Test-engineer**: if an assignment still contains an Add that duplicates a Rewrite's implication, flag in your final output and merge the two rather than writing both tests.

### 3. `.not.toThrow()` on empty arrow functions

`expect(() => {}).not.toThrow()` always passes — it asserts that an empty function does not throw, which is tautological. This often sneaks in as scaffolding during rewrite and gets forgotten.

**Instead**: if you need a graceful-handling assertion, assert the observable post-error state: `logger.error` was called with the right arguments, the next step in the flow ran (or didn't), the UI did not unmount, etc.

### 4. Mid-test `vi.clearAllMocks()` before a `not.toHaveBeenCalled()` assertion

Calling `vi.clearAllMocks()` in the middle of a test wipes call history. A subsequent `expect(mockX).not.toHaveBeenCalled()` is then trivially true regardless of what happened before the clear — the test proves nothing about the pre-clear behaviour it's supposed to guard.

**Instead**: use explicit counts on both sides of the action. `expect(mockX).toHaveBeenCalledTimes(1)` before the action, `expect(mockX).toHaveBeenCalledTimes(1)` (same count) after, to prove the action did not re-fire.

### 5. Dead `vi.mock(...)` blocks

Mocking a module the source no longer imports misleads future readers about the component's real dependencies. A comment like `// mocks from prior version — unused` is not a fix; delete the mock.

**Instead**: when rewriting a test file whose source has dropped a dependency, delete the `vi.mock(...)` block for that dependency. If the test still imports something from the module, check whether it should.

### 6. `.toBeDefined()` after `.find()`

`Array.find(...)` returns `undefined` when no element matches. Asserting `expect(found).toBeDefined()` produces an unhelpful failure message (`"expected undefined to be defined"`) without telling the reader which array was searched or what was expected.

**Instead**: assert the specific element, property, or shape you expect (`expect(found).toMatchObject({ ... })`, `expect(found?.attr).toBe(...)`), or query by a direct selector (`screen.getByTestId(...)`) that throws a descriptive error when the element is missing.

## Integration Patterns

Additional pitfalls specific to integration tests (files under `tests/integration/**`). These mirror the `/test-triage` integration block-pattern set (`abm`/`scm`/`dsu`/`erm`) but framed as writing rules. Applies in addition to the general patterns above.

### 7. Asserting body shape without status code

A 200-shaped success body and a 500 error envelope can both set `body.success` to a boolean — if you only check `body.success === true`, a handler that returned 500 with `{ success: true, data: ... }` (wrong status for the envelope) slips through. The HTTP status is part of the contract.

**Instead**: every handler invocation gets `expect(response.status).toBe(N)` for the expected code. Status comes before body shape in the assertion order.

### 8. Persistence asserted only through the response body

For POST/PATCH/DELETE, assertions like `expect(body.data.user.email).toBe(requestBody.email)` prove the handler echoed the input — they don't prove the write landed or that derived fields were populated correctly.

**Instead**: after a mutation, read the DB state back (via Prisma `findUnique`/`findFirst` even under mock) and assert on handler-derived fields (`id`, `createdAt`, computed defaults, normalized strings). Echoed input fields are not evidence of persistence.

### 9. Error response shape drift from the `errorResponse()` contract

Sunrise's error envelope is `{ success: false, error: { code, message, details? } }`. Tests asserting `{ error: 'Something failed' }`, or just `body.error.code` without checking `body.success === false`, let shape drift ship silently — a later refactor can change the envelope without breaking the test.

**Instead**: assert the full envelope shape — `body.success` AND `body.error.code` AND (where relevant) `body.error.message`. Consider a shared `parseErrorResponse()` helper that enforces the contract at the assertion boundary.

### 10. Missing 401/403 coverage on guarded routes

If the route uses `withAuth()` / `withAdminAuth()` or manual session checks, the auth boundary IS public contract. Tests covering only the authenticated-success path let regressions to the guard (e.g. a refactor that no-ops the role check) ship silently.

**Instead**: for every guarded route, write an unauthenticated test asserting 401 with the full error envelope AND (if role-based) a wrong-role test asserting 403. Public routes are exempt — and worth a comment saying so.

### 11. Module-level state not reset between tests

`vi.clearAllMocks()` clears mock call history. It does NOT reset module-scoped state: rate-limiter counters, in-memory caches, singleton Prisma client instances, or counters inside the source module. Tests depending on clean state fail non-deterministically based on run order.

**Instead**: in `beforeEach`, explicitly `.mockReturnValue(...)` / `.mockResolvedValue(...)` on every accessor whose default state matters (rate limiters, env accessors, session accessors). If a module genuinely needs a reset helper, export one and call it — don't rely on `clearAllMocks` to do it.

### 12. Serial test dependency

"should create X" followed by "should update X" sharing the created record couples test order. A single failure cascades; parallelisation breaks; test names lie about what they verify (the "update" test also verifies "create"). Often done to save setup cost.

**Instead**: each `it()` arranges its own fixtures from scratch. Extract shared helpers (`makeUser()`, `seedPosts()`) to keep setup cheap without the coupling. If an operation genuinely needs a prior state, build that state inline in the test, not across `it()` blocks.

### 13. Real `DATABASE_URL` leaking into integration test setup

If the integration test reads `process.env.DATABASE_URL` directly (via a Prisma client init that bypasses the testcontainer), a misconfigured local run can write against the dev database — or worse. Testcontainers exist specifically to make this impossible.

**Instead**: integration tests take their DB URL from the testcontainer setup (typically in `tests/integration/setup.ts` or a `beforeAll` hook). The vitest setup file should fail loudly if `DATABASE_URL` doesn't point to a testcontainer-provisioned instance. Never write tests that call `new PrismaClient()` without going through the testcontainer-aware factory.

## Extending the list

When `/test-review` surfaces a new brittle pattern:

1. Add a numbered entry to the appropriate section — general patterns in `## Patterns`, integration-only in `## Integration Patterns`.
2. If it's a plan-time-catchable pattern (like Add/Rewrite overlap), also update `.claude/commands/test-plan.md` Step 4's self-check bullet.
3. Commands that embed bullets inline (`/test-fix`, `/test-plan`) copy the relevant section based on the test type of their target files — no manual sync needed per plan, but confirm the next run picks up the new bullet.
