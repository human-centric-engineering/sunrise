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

## Extending the list

When `/test-review` surfaces a new brittle pattern:

1. Add a numbered entry here with a one-line description, reasoning, and the "Instead" fix.
2. If it's a plan-time-catchable pattern (like Add/Rewrite overlap), also update `.claude/commands/test-plan.md` Step 4's self-check bullet.
3. The list embedded in every plan file is regenerated per-plan from this doc — no separate update needed there, but confirm `/test-plan` copies the updated bullets into the next plan.
