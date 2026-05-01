# Testing Gotchas & Solutions

Common pitfalls and their solutions for testing in Sunrise. These patterns have been validated across 559 tests.

---

## Critical Gotchas

### 1. ESLint Auto-Fix Removes `async` Keywords

**Problem**: ESLint auto-fix removes `async` from test functions that use helper functions with internal `await`, breaking tests with "await only valid in async function" errors.

**Solution**: ESLint rule `@typescript-eslint/require-await` is disabled for test files in `eslint.config.mjs`.

```typescript
// ✅ Safe - ESLint won't remove async
it('should handle async operations', async () => {
  const result = await someAsyncFunction();
  expect(result).toBeDefined();
});
```

**Status**: ✅ FIXED - Rule disabled in ESLint config

---

### 2. Unbound Method False Positives

**Problem**: ESLint rule `@typescript-eslint/unbound-method` flags Vitest mock assertions as unsafe, even though they follow official Vitest patterns.

**Solution**: Rule disabled for test files in `eslint.config.mjs`.

```typescript
// ✅ Safe - Standard Vitest pattern
import { vi } from 'vitest';
import { logger } from '@/lib/logging';

expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Error message', error);
expect(prisma.$queryRaw).toHaveBeenCalledWith(['SELECT 1']);
```

**Status**: ✅ FIXED - Rule disabled for test files

---

### 3. NODE_ENV Is Read-Only

**Problem**: Cannot set `process.env.NODE_ENV` directly in tests because Node.js marks it as read-only.

**Solution**: Use `Object.defineProperty()` to override the property descriptor.

```typescript
beforeEach(() => {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value: 'production',
    writable: true,
    enumerable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value: 'test',
    writable: true,
    enumerable: true,
    configurable: true,
  });
});
```

**Status**: ✅ DOCUMENTED - Use this pattern when testing environment-dependent behavior

---

### 4. Response.json() Type Safety

**Problem**: `Response.json()` returns `Promise<any>`, losing all type safety in tests.

**Solution**: Use `parseJSON()` helper from `tests/helpers/assertions.ts`.

```typescript
import { parseJSON } from '@/tests/helpers/assertions';

interface SuccessResponse {
  success: boolean;
  data: { id: string };
}

it('should return user data', async () => {
  const response = await GET();
  const body = await parseJSON<SuccessResponse>(response);

  expect(body.success).toBe(true); // Type-safe!
  expect(body.data.id).toBeDefined(); // Autocomplete works!
});
```

**Status**: ✅ IMPLEMENTED - Use `parseJSON()` helper for all response parsing

---

### 5. Mock Setup Timing

**Problem**: Environment variables must be set BEFORE module imports in `setup.ts`, otherwise modules that validate env vars at import time will fail.

**Solution**: Always set environment variables FIRST in test setup files.

```typescript
// ✅ CORRECT - tests/setup.ts

// 1. Set environment variables FIRST (before any imports)
Object.defineProperty(process.env, 'DATABASE_URL', {
  value: 'postgresql://test:test@localhost:5432/test',
  writable: true,
  enumerable: true,
  configurable: true,
});

// 2. NOW it's safe to import modules
import '@testing-library/jest-dom';
import { expect, vi } from 'vitest';
```

**Status**: ✅ DOCUMENTED - Follow this pattern in all setup files

---

### 6. Incomplete Mock Types

**Problem**: Inline mocks with incomplete type definitions cause recurring lint/type error cycles.

**Solution**: Always use shared mock factories from `tests/types/mocks.ts`.

```typescript
import { createMockHeaders, createMockSession } from '@/tests/types/mocks';

// ✅ CORRECT - Use factory functions
vi.mocked(headers).mockResolvedValue(createMockHeaders({ 'x-request-id': 'test-123' }) as any);

vi.mocked(auth.api.getSession).mockResolvedValue(
  createMockSession({ user: { id: 'user-123' } }) as any
);

// ❌ AVOID - Inline incomplete mocks
vi.mocked(headers).mockResolvedValue({
  get: vi.fn(() => null),
} as any);
```

**Status**: ✅ IMPLEMENTED - Shared factories in `tests/types/mocks.ts`

---

### 7. Type-Safe Assertions

**Problem**: Direct property access causes "possibly undefined" errors. Non-null assertions (`!`) have no runtime safety.

**Solution**: Use type guard helpers from `tests/helpers/assertions.ts`.

```typescript
import { assertDefined, assertHasProperty } from '@/tests/helpers/assertions';

// ✅ CORRECT - Use type guards
const parsed = JSON.parse(output);
assertDefined(parsed.meta);
expect(parsed.meta.userId).toBe('user-123'); // Type-safe!

assertHasProperty(response, 'error');
expect(response.error.code).toBe('VALIDATION_ERROR');

// ❌ AVOID - Direct access or non-null assertion
expect(parsed.meta.userId).toBe('user-123'); // Error: possibly undefined
expect(parsed.meta!.userId).toBe('user-123'); // Runtime risk
```

**Status**: ✅ IMPLEMENTED - Type guard helpers in `tests/helpers/assertions.ts`

---

### 8. PrismaPromise Type Compatibility

**Problem**: Prisma 7 returns `PrismaPromise<T>`, not standard `Promise<T>`, causing type mismatches in mocks.

**Solution**: Use `mockResolvedValue()` or `delayed()` helper, never manual Promise creation.

```typescript
import { delayed } from '@/tests/types/mocks';

// ✅ CORRECT - For immediate responses
vi.mocked(prisma.$queryRaw).mockResolvedValue([{ result: 1 }]);

// ✅ CORRECT - For timed async operations
vi.mocked(prisma.$queryRaw).mockImplementation(() => delayed([{ result: 1 }], 50) as any);

// ❌ AVOID - Manual Promise creation
vi.mocked(prisma.$queryRaw).mockImplementation(
  () => new Promise((resolve) => setTimeout(() => resolve([{ result: 1 }]), 50))
);
```

**Status**: ✅ IMPLEMENTED - Use `delayed()` helper from `tests/types/mocks.ts`

---

### 9. happy-dom sessionStorage Spy Cached Reference

**Problem**: `vi.spyOn(Storage.prototype, 'getItem')` (or `vi.spyOn(sessionStorage, 'getItem')`) becomes ineffective after `vi.clearAllMocks()` or between tests in happy-dom. The sessionStorage instance caches its method references at creation and ignores subsequent prototype changes, so the spy's implementation is never invoked and the test either fails confusingly or passes against unmocked real behaviour.

**Solution**: Use `Object.defineProperty()` on the `sessionStorage` instance with an explicit restore in `afterEach`. This overrides the instance method directly, bypassing the cached reference.

```typescript
let originalGetItem: typeof sessionStorage.getItem;

beforeEach(() => {
  originalGetItem = sessionStorage.getItem.bind(sessionStorage);
});

afterEach(() => {
  Object.defineProperty(sessionStorage, 'getItem', {
    value: originalGetItem,
    writable: true,
    configurable: true,
  });
});

it('handles sessionStorage read errors', () => {
  Object.defineProperty(sessionStorage, 'getItem', {
    value: vi.fn(() => {
      throw new Error('Storage locked');
    }),
    writable: true,
    configurable: true,
  });
  // ... exercise code that reads from sessionStorage
});
```

**Status**: ✅ DOCUMENTED — Discovered while rewriting `components/analytics/user-identifier.tsx` tests.

---

### 10. One-Shot useRef Guards Block Re-Run Assertions on Same Instance

**Problem**: Components that use a `useRef(false)` → `true` pattern to guard one-time initialization (e.g. `hasTrackedInitialRef.current`) will NOT re-run that logic on the same component instance, even after prop or session changes. Tests that expect "re-fires after X" against a persistent instance fail confusingly — the `.current` ref is still `true`, so the initialization effect returns early.

**Solution**: For re-run assertions, unmount and fresh-mount a new component instance. Do not rely on `rerender()` with new props on the persistent instance — the ref survives the rerender.

```typescript
// ❌ WRONG — ref is still true on rerender, effect returns early
const { rerender } = render(<UserIdentifier />);
vi.mocked(useSession).mockReturnValue({ data: { user: newUser } } as never);
rerender(<UserIdentifier />);
expect(mockIdentify).toHaveBeenCalledTimes(2); // fails: still 1

// ✅ CORRECT — fresh mount resets the ref
const { unmount } = render(<UserIdentifier />);
unmount();
vi.mocked(useSession).mockReturnValue({ data: { user: newUser } } as never);
render(<UserIdentifier />);
expect(mockIdentify).toHaveBeenCalledTimes(2);
```

**Flip side**: if the test is verifying that the guard DOES block re-runs (e.g. "should not re-identify on pathname change"), a persistent instance is the right harness. Use explicit `toHaveBeenCalledTimes(N)` counts before and after the trigger — do NOT use `vi.clearAllMocks()` mid-test.

**Status**: ✅ DOCUMENTED — Discovered while rewriting `UserIdentifier` re-identification tests.

---

### 11. React 19 ErrorBoundary Tests Still Pollute `console.error`

**Problem**: When testing that a component propagates errors to a nearest ErrorBoundary, React 19 logs the caught error to `console.error` twice per throw (one for the render error, one for the boundary's `componentDidCatch`) even when the boundary handles it correctly. The test assertion passes, but stderr fills with noisy stack traces that hide real failures in CI output and make `--reporter=verbose` unreadable.

**Solution**: Spy on `console.error` with a no-op implementation for the duration of the test, then restore. Do not globally silence — that hides legitimate warnings from other tests.

```typescript
it('should propagate hook errors to the nearest error boundary', () => {
  // Arrange — silence React's expected error logging for this test only
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(useFeature).mockImplementation(() => {
    throw new Error('Feature not initialized');
  });

  // Act
  render(
    <ErrorBoundary fallback={<div>caught</div>}>
      <ComponentUnderTest />
    </ErrorBoundary>
  );

  // Assert — boundary caught the throw; no assertion on console needed
  expect(screen.getByText('caught')).toBeInTheDocument();

  // Cleanup — restore per-test, not globally
  consoleErrorSpy.mockRestore();
});
```

**Why not `afterEach`**: If the spy lives in `afterEach`/`beforeEach`, it silences console for every test in the file, including ones where a `console.error` call would indicate a real bug. Scope the spy to the single `it` block that intentionally throws.

**Status**: ✅ DOCUMENTED — Discovered while rewriting `page-tracker.tsx` hook-throws test against a real ErrorBoundary harness.

---

### 12. useEffect Re-Fire Requires a Dep Change, Even After a Ref Reset

**Problem**: When testing components that use a `useRef` one-shot guard cleared by a _separate_ `useEffect` (e.g. a logout effect that resets `hasTrackedInitialRef`), it's tempting to write a test that goes "user A → null → user A again" and assert the side effect fires twice. It won't. The ref reset alone doesn't trigger React to re-run the first effect — at least one of its dep-array entries (`session?.user?.id`, `pathname`, `searchParams`, etc.) has to actually change between renders. Going `null → same user A` looks like a transition, but from React's perspective the dep value `session?.user?.id` ends up at the same string it started at, so the effect doesn't re-fire and the second side effect never happens. The test fails confusingly even though the ref-reset logic is correct.

**Solution**: For isolation tests of "ref reset alone enables re-fire", combine the reset with a dep change you can defend as honest. Pick a different `pathname`, `searchParams`, or whichever dep makes the scenario realistic (post-logout, the user lands on a new route). Document the mechanism in a one-line comment so the next reader doesn't try to "simplify" it back to the broken form.

```typescript
// ✅ CORRECT — pathname change makes the dep array re-fire after the ref reset
it('should re-fire page() after logout then re-login with new pathname', async () => {
  // Arrange — user A on /dashboard
  vi.mocked(useSession).mockReturnValue({ data: { user: userA } } as never);
  vi.mocked(usePathname).mockReturnValue('/dashboard');
  const { rerender } = render(<UserIdentifier />);
  await waitFor(() => expect(mockPage).toHaveBeenCalledTimes(1));

  // Act — logout (triggers second useEffect, clears hasTrackedInitialRef)
  vi.mocked(useSession).mockReturnValue({ data: null } as never);
  rerender(<UserIdentifier />);

  // Re-login as same user but on a new route — dep change re-fires first useEffect
  vi.mocked(useSession).mockReturnValue({ data: { user: userA } } as never);
  vi.mocked(usePathname).mockReturnValue('/settings');
  rerender(<UserIdentifier />);

  // Assert — second page call happened because (a) ref was reset and (b) pathname dep changed
  await waitFor(() => expect(mockPage).toHaveBeenCalledTimes(2));
});

// ❌ WRONG — same user, same pathname — dep array doesn't re-fire even though ref reset works
// rerender with userA → null → userA at same pathname will fail this assertion
```

**When to combine vs. isolate**: cross-user re-login (the L453-style test in `user-identifier.test.tsx`) naturally exercises both the `identifiedUserRef` clear AND the `hasTrackedInitialRef` clear because the `session?.user?.id` dep changes. If you want to isolate just the `hasTrackedInitialRef` reset, you have to introduce a _different_ dep change — pathname is the cheapest and most realistic.

**Status**: ✅ DOCUMENTED — Discovered during `/test-fix components/analytics` (2026-04-18) when adding a `hasTrackedInitialRef` reset isolation test for `UserIdentifier`. The test-fix prescription's first-choice phrasing ("user A → null → user A again") was structurally impossible; the agent fell back to the "+ new pathname" variant the prescription pre-authorized.

---

### 13. Importing `@/lib/auth/config` Triggers Module-Scope Side Effects

**Problem**: Any test that imports a named export from `@/lib/auth/config` (e.g. `userCreateBeforeHook`, `userCreateAfterHook`, or future hook extractions for `sendResetPassword` / `afterEmailVerification`) will execute the full `betterAuth({...})` initialization AND `validateEmailConfig()` at module load. Without the right mocks in place, the import itself throws — typically with confusing Resend initialization errors, env-validation errors, or prisma-adapter errors that have nothing to do with the hook being tested.

**Solution**: mock the full side-effect surface BEFORE importing the hook. Required mocks:

```typescript
// tests/unit/lib/auth/<whatever>.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Side-effect mocks — needed because importing @/lib/auth/config triggers betterAuth({...}) + validateEmailConfig()
vi.mock('@/lib/email/client', () => ({
  validateEmailConfig: vi.fn(),
  getResendClient: vi.fn(() => null),
  isEmailEnabled: vi.fn(() => false),
}));

vi.mock('better-auth', () => ({
  betterAuth: vi.fn(() => ({
    /* minimal shape — tests don't use `auth`, only the exported hooks */
  })),
}));

vi.mock('better-auth/adapters/prisma', () => ({
  prismaAdapter: vi.fn(() => ({})),
}));

vi.mock('better-auth/api', () => ({
  getOAuthState: vi.fn(),
  APIError: class APIError extends Error {
    /* ... */
  },
}));

// Plus the usual mocks for what the hook itself calls:
vi.mock('@/lib/db/client', () => ({ prisma: { user: { update: vi.fn() } } }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  deleteInvitationToken: vi.fn(),
  getValidInvitation: vi.fn(),
}));

// NOW safe to import
import { userCreateBeforeHook, userCreateAfterHook } from '@/lib/auth/config';
```

**Why not just mock Resend directly**: some agents reach for `vi.mock('resend')` to silence the init error. That works but is tightly coupled to the current implementation and breaks when the email client changes. Mock `@/lib/email/client` (the Sunrise wrapper) instead — it's the stable boundary.

**Status**: ✅ DOCUMENTED — Discovered during `/test-fix tests/unit/lib/auth/config-database-hook.test.ts` (2026-04-18) after extracting `userCreateBeforeHook` / `userCreateAfterHook` from the inline `betterAuth({...})` config. The previous test file never imported the config module because it used re-implementation helpers instead; the import-side-effect trap only surfaces once tests switch to calling real hook exports. Applies equally to the still-pending extractions for `sendResetPassword`, `afterEmailVerification`, and any other `@/lib/auth/config` hook.

---

### 14. Per-Test Env Toggling Requires a Closed-Over Mutable Object

**Problem**: Tests that need to toggle an env variable between cases in the same file (e.g. `REQUIRE_EMAIL_VERIFICATION=false` for one test, `=true` for the next) can't use a static `vi.mock('@/lib/env', () => ({ env: { REQUIRE_EMAIL_VERIFICATION: false } }))` — the factory runs once at module-eval time and the returned object is effectively frozen per-test. Attempting to reassign the mock with `vi.mocked(env).mockReturnValue(...)` also fails because `env` is an object, not a function. Agents commonly fall into `vi.resetModules()` + `vi.doMock()` per test (which works but is fragile and slow) or write a single-branch test and miss the other case.

**Solution**: declare a plain mutable `mockEnv` object at module scope of the test file and have `vi.mock` close over it in the factory. Reset defaults in `beforeEach`, mutate per-test.

```typescript
// Mutable object captured by the mock factory — per-test overrides happen via direct assignment.
const mockEnv = {
  REQUIRE_EMAIL_VERIFICATION: undefined as boolean | undefined,
  NODE_ENV: 'test',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  RESEND_API_KEY: 'test',
  EMAIL_FROM: 'test@example.com',
  // ... other env vars the module reads
};

vi.mock('@/lib/env', () => ({ env: mockEnv }));

beforeEach(() => {
  // Reset env to defaults — vi.clearAllMocks() does NOT touch plain objects
  mockEnv.REQUIRE_EMAIL_VERIFICATION = undefined;
  mockEnv.NODE_ENV = 'test';
});

it('sends welcome immediately when verification is disabled', async () => {
  mockEnv.REQUIRE_EMAIL_VERIFICATION = false;
  await userCreateAfterHook(user, null);
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
});

it('skips welcome when verification is enabled', async () => {
  mockEnv.REQUIRE_EMAIL_VERIFICATION = true;
  await userCreateAfterHook(user, null);
  expect(mockSendEmail).not.toHaveBeenCalled();
});
```

**Why the closure works**: `vi.mock` hoists the factory to the top of the file at transform time, but the factory _body_ runs once lazily. Inside the factory, `mockEnv` is captured by reference, so mutating properties after the factory has run is visible to every subsequent `env.X` read in the module under test. `vi.clearAllMocks()` only resets `vi.fn()` spies — it leaves plain objects alone, which is exactly the behaviour this pattern needs.

**When NOT to use this pattern**: if only one value of the env var is exercised across the whole test file, a plain static `vi.mock('@/lib/env', () => ({ env: { ... } }))` is simpler. The mutable-object pattern is the right call specifically when per-test branching is needed.

**Status**: ✅ DOCUMENTED — Discovered during `/test-fix tests/unit/lib/auth/config-database-hook.test.ts` (2026-04-18) when splitting a mock-proving test (helper hard-coded `requiresVerification=false`) into separate `requiresVerification=true` / `=false` cases against the real `userCreateAfterHook`. Applies to any test that needs to exercise multiple env-branch paths in the same file.

---

### 15. Plan Batch-Table Add Count Can Drift From the Prose Add List

**Problem**: `/test-plan` emits two representations of the work for each batch: a one-row table cell (`Add: 10`) and a prose list (`**Add** (new test cases needed):` followed by bullets). These are generated independently and can disagree — the table cell sometimes rounds up or reflects an earlier draft count. If the test-engineer agent trusts the table header and tries to write exactly that many tests, it will either invent filler tests to hit the number or genuinely overshoot the plan's prescriptions (violating the Add/Rewrite overlap guardrail).

**Solution**: count the prose Add bullets yourself before writing. The prose list — not the table cell — is the authoritative count. If the two disagree, note it in the final "Deviations from the plan" output and implement the prose list. Do NOT invent extra tests to match a higher table number.

```typescript
// Plan table says: Add: 10
// Plan prose says:
//   **Add** (new test cases needed):
//   - Test 1 — ...
//   - Test 2 — ...
//   ... (9 bullets total)
//
// ✅ CORRECT — implement 9, note the drift in Deviations
// ❌ WRONG — invent a 10th test to match the table header

// In the final output summary:
// "Plan batch-table said 10 Adds; prose Add list enumerated 9.
//  Implemented 9 per the prose list — the table cell was a minor arithmetic error."
```

**Why this happens**: the batch table is written in Step 4 of the planner (per-file work instructions) using a summary count that the planner derives before the prose bullets are finalized. Late edits to the prose list don't always propagate back to the table cell. The planner should be fixed, but the test-engineer sees the plan as-is and must treat the prose list as canonical.

**Signal for the planner**: if you're authoring `/test-plan` improvements, add a Step 6 self-check that counts prose `- ` bullets under each `**Add**` heading and asserts it matches the batch table's `Add` column before writing the file. Cheap to enforce at plan-write time; expensive (one agent round-trip) to discover downstream.

**Status**: ✅ DOCUMENTED — Discovered while executing `/test-write plan` Sprint 1 (CSP report endpoint) on `app/api/csp-report/route.ts` during the testing-commands dogfood run. Plan header said `Add: 10`; prose list had 9 distinct scenarios. Agent correctly implemented 9 and flagged the drift.

---

### 16. `/test-plan` Says UPDATE But Canonical Test File Does Not Exist

**Problem**: `/test-plan` (in `from-coverage` mode) classifies a plan item as UPDATE whenever the scoped coverage report shows non-zero coverage for a source file. But coverage attribution can come from a _sibling_ or _shared_ test file at a different path — e.g. `tests/unit/app/api/v1/admin/orchestration/schedules/schedules.route.test.ts` covering handlers in both `schedules/route.ts` AND `schedules/[scheduleId]/route.ts`. The canonical-path test file (`tests/unit/<source path>.test.ts`) may not exist at all. The test-engineer agent opens the plan expecting to `Add` to an existing file, finds nothing at the canonical location, and has to decide on the spot whether to CREATE a new file or mix tests into the shared sibling.

**Solution**: test-engineer agents should ALWAYS check for the canonical test-file location before assuming UPDATE means "file exists". If the canonical file is missing:

1. Check for sibling/shared test files that might already cover this source (grep for `import ... from '{source path}'` across `tests/`).
2. If a shared file covers the source, prefer CREATE at the canonical path (do not mix into the shared file — that's what caused the confusion in the first place).
3. Note the deviation in the final "Deviations from the plan" output: `Plan said UPDATE but test file did not exist at canonical location; created new file. Existing coverage came from {shared test path}, which was not modified.`

**Signal for the planner**: when `/test-plan` is written, add a pre-write check: for each UPDATE item, verify the canonical test file exists via `Glob`. If it doesn't, downgrade the action to CREATE and list the alternate coverage source in the plan. Cheap at plan-write time; expensive to surprise multiple agents downstream.

```
// Plan said:
// | `app/api/v1/admin/orchestration/workflows/[id]/schedules/[scheduleId]/route.ts` | UPDATE |
//
// Agent check:
// Glob: tests/unit/app/api/v1/admin/orchestration/workflows/[id]/schedules/[scheduleId]/route.test.ts
// → no match
//
// Grep: `schedules/[scheduleId]/route` in tests/
// → tests/unit/app/api/v1/admin/orchestration/schedules/schedules.route.test.ts (shared file)
//
// Action: CREATE at canonical path; do not modify shared file.
// Deviation: note in output.
```

**Status**: ✅ DOCUMENTED — Discovered while executing `/test-write plan sprint 2` and `/test-write plan sprint 3` (2026-04-22) against the `feature/completeness-and-robustness` branch. Three of four Sprint 2 batches and one Sprint 3 batch hit the same pattern: plan said UPDATE based on scoped coverage %, but the canonical test file did not exist because coverage came from shared sibling test files.

---

### 17. React Flow (`@xyflow/react`) Inner Callbacks Can't Be Invoked Under a Static Mock

**Problem**: Workflow-builder-style components that depend on `@xyflow/react` typically wire up inner callbacks — `onConnect`, `handleNodeAdd`, `handleNodeDelete`, `handleLabelChange`, `handleConfigChange`, etc. — that are only invoked by real canvas interactions (drag-drop, edge connections, node selection). When the library is mocked as a static stub (e.g. `vi.mock('@xyflow/react')` returning `useNodesState → [frozenArray, vi.fn(), vi.fn()]`), these callbacks become unreachable from tests. Function coverage for the file hits an architectural ceiling (often 50–60%) no matter how many handler-level tests you write. Agents that aggressively chase function coverage will either (a) invent contrived tests that don't exercise real behaviour, or (b) try to replace the mock architecture, which balloons scope.

**Solution**: accept the ceiling as an architectural trade-off. The plan's "assert at event-handler level, not canvas rendering" constraint is the honest boundary. Focus tests on:

- Effects and state derived from React Flow props (initial state, edit vs create mode, `initialDefinition` branch).
- Save / publish / cancel handlers that wrap or replace canvas state.
- Dialog-driven side effects (template save, history revert, dry-run, copy JSON).
- Conditional renders around the canvas (`TemplateBanner`, `WorkflowDefinitionHistoryPanel`, versions tab gate).

Set function-coverage targets for Flow-based components accordingly. The typical ceiling is `(total_functions - inner_canvas_callbacks) / total_functions`, which in practice lands at 55–65% for medium-size builders. `/test-plan` should not set function-coverage targets above that ceiling for files that import `@xyflow/react`.

**Signal for the planner**: when `/test-plan` sees a file importing `@xyflow/react` (or similar canvas libraries), clamp the function-coverage target in the plan to "branch ≥70%, functions best-effort with documented ceiling". Do not set a hard function-coverage threshold that only a real canvas harness could satisfy.

**Status**: ✅ DOCUMENTED — Discovered while executing `/test-write plan sprint 3` Batch 3.3 (2026-04-22) on `components/admin/orchestration/workflow-builder/workflow-builder.tsx`. Plan asked for function coverage ≥70%; actual ceiling under the static `@xyflow/react` mock was 58.82%. Branch coverage hit the 70% target exactly; inner callback functions remained unreachable. Applies to any component that uses `useNodesState` / `useEdgesState` / `useReactFlow` with a mocked Flow runtime.

---

### 18. Global Setup Mocks Block Tests of the Real Module

**Problem**: `tests/setup.ts` globally mocks several internal modules so that unrelated tests don't have to wire up their dependencies. `@/lib/api/context` is one such module — every test in the suite gets a stub `getRouteLogger` automatically. When you write a dedicated test for one of these globally-mocked modules, the global mock wins: assertions on the real module's behaviour silently exercise the stub instead. Tests appear to pass (or fail mysteriously) because every spy registers zero calls regardless of what the test arranges.

**Solution**: explicitly `vi.unmock(...)` the module under test at the top of the test file, BEFORE the dependency mocks and module imports. This bypasses the global mock so the real implementation runs.

```typescript
// tests/unit/lib/api/context.test.ts
import { vi } from 'vitest';

// Bypass the global mock from tests/setup.ts so we exercise the real module.
vi.unmock('@/lib/api/context');

vi.mock('@/lib/logging', () => ({ ... }));
vi.mock('@/lib/logging/context', () => ({ ... }));

// Now the import resolves to the real implementation.
const { getRouteLogger } = await import('@/lib/api/context');
```

**How to spot it**: if your spies all register zero calls and the return value never matches what the real module would produce, check whether `tests/setup.ts` mocks the module under test. `grep -n "vi.mock" tests/setup.ts` is the fast check.

**Status**: ✅ DOCUMENTED — Discovered while executing `/test-write plan sprint 1` (2026-05-01) on `lib/api/context.ts`. Without `vi.unmock`, every assertion ran against the setup.ts stub (`getRouteLogger` pre-baked to return a fake logger), so the real `getFullContext` / `logger.withContext` orchestration was never exercised. Same risk applies to any module mocked in `tests/setup.ts`.

---

### 19. better-auth Catch-All Routes Need `vi.hoisted()` and a Config Mock

**Problem**: `app/api/auth/[...all]/route.ts` (and any route using `toNextJsHandler(auth)`) calls `toNextJsHandler` at module scope — the handler bindings are evaluated when the route file is imported. A naïve `vi.mock('better-auth/next-js', () => ({ toNextJsHandler: () => ({ GET, POST }) }))` factory cannot reference closure variables (e.g. `mockBetterAuthGET = vi.fn()`) because those variables aren't initialized when the factory runs. Compounding this, importing the route also pulls in `@/lib/auth/config`, which calls `betterAuth({...})` at module scope — instantiating the Prisma adapter and validating the email client. In a unit test this triggers real side effects (DB connection attempts, env-var validation failures) that have nothing to do with the route's contract.

**Solution**: two parts.

1. Use `vi.hoisted()` so the mock fns exist before module factories run:

```typescript
const { mockBetterAuthGET, mockBetterAuthPOST, mockLog } = vi.hoisted(() => ({
  mockBetterAuthGET: vi.fn(),
  mockBetterAuthPOST: vi.fn(),
  mockLog: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('better-auth/next-js', () => ({
  toNextJsHandler: () => ({ GET: mockBetterAuthGET, POST: mockBetterAuthPOST }),
}));
```

2. Mock `@/lib/auth/config` to short-circuit the `betterAuth({...})` call:

```typescript
vi.mock('@/lib/auth/config', () => ({ auth: {} }));
```

`vi.mock` calls are hoisted by Vitest's plugin, but their _factories_ run in module-load order; only `vi.hoisted()` guarantees referenced values exist at factory-execution time. Without the config mock, the route file's transitive import chain still reaches `betterAuth(...)`.

**Status**: ✅ DOCUMENTED — Discovered while executing `/test-write plan sprint 1` (2026-05-01) on `app/api/auth/[...all]/route.ts`. Same pattern applies to any catch-all auth route, and to any module that calls a third-party initializer at top level.

---

### 20. `userEvent.type` Interprets `{` and `}` as Keyboard Descriptors

**Problem**: `userEvent.type(input, '{"key": "value"}')` doesn't type the literal JSON — `{` and `}` are reserved keyboard-descriptor delimiters in `@testing-library/user-event` (`{Enter}`, `{Backspace}`, `{Shift>}foo{/Shift}`, etc.). The library either throws "unknown key" for the descriptor it tries to parse or types something unexpected. Tests that exercise JSON / array / object input fields (filter configs, query params, structured payloads) will fail in confusing ways even though the field accepts the input fine in the real browser.

**Solution**: For inputs that take literal `{` / `}` characters, use `fireEvent.change` instead of `userEvent.type`. `fireEvent.change` is a direct DOM event dispatch and treats the value as an opaque string — no descriptor parsing.

```typescript
import { fireEvent } from '@testing-library/react';

it('parses filter JSON and forwards via onChange', async () => {
  // Arrange
  render(<RagRetrieveEditor config={config} onChange={mockOnChange} />);
  const filterInput = screen.getByTestId('rag-filter');

  // Act — fireEvent.change for JSON; userEvent.type would mangle the braces
  fireEvent.change(filterInput, { target: { value: '{"category":"docs"}' } });

  // Assert
  expect(mockOnChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ filter: { category: 'docs' } })
  );
});
```

**When to keep using `userEvent.type`**: anything that's natural typing — text fields, numeric inputs, search boxes, prompts. The `{`/`}` issue is narrow: JSON strings, regex literals containing braces, code snippets. Document the swap with a one-line comment so the next reader doesn't "simplify" it back to `userEvent.type`.

**Escape syntax exists** (`'{{'` for a literal `{`), but it makes the test value visibly different from the assertion and from any debug log that prints the typed string. `fireEvent.change` is cleaner.

**Status**: ✅ DOCUMENTED — Discovered while executing Sprint 2 Batch 2.1 (2026-05-01) on `components/admin/orchestration/workflow-builder/block-editors/rag-retrieve-editor.tsx`. Plan asked for filter-branch coverage (try/catch around `JSON.parse`); attempts to use `userEvent.type` to enter JSON failed because of the descriptor parsing. Applies to any test for a UI field that accepts JSON or other structured strings.

---

### 21. Admin Layout Holds the Auth Guard, Not Each Page

**Problem**: Pages under `app/admin/` typically do NOT call `withAuth()` / `withAdminAuth()` themselves — auth is enforced once at the route-group layout (`app/admin/layout.tsx` and similar). Same for `app/(protected)/`. Plans driven by `/test-coverage` will repeatedly suggest "auth guard redirects unauthenticated users" as an Add scenario for these pages because the page's coverage report doesn't show a guard branch. Writing that test against the page directly will fail (or pass trivially against a stubbed wrapper that doesn't exist) because the page has no guard logic to exercise.

**Solution**: Before writing an "auth guard redirects" test for any page under `app/admin/` or `app/(protected)/`, **read the page's source and confirm the guard is in the page itself**. Most aren't.

- If the page has no guard: drop the auth-redirect Add scenario from the plan and note the deviation. Coverage of the auth path lives in the layout's tests, not the page's.
- If the page has its own guard (some override the group layout): write the auth-redirect test as planned.
- For "page renders without crashing", just mock the data dependencies (Prisma, `serverFetch`, etc.) and the layout's session is irrelevant — you're rendering the page in isolation, not the route tree.

```typescript
// ❌ WRONG — page has no guard; this test will be a no-op
it('redirects unauthenticated users', async () => {
  vi.mocked(auth.api.getSession).mockResolvedValue(null);
  await AgentDetailPage({ params: { id: '123' } });
  expect(redirect).toHaveBeenCalledWith('/login');
});

// ✅ CORRECT — assert what the page actually does on missing data
it('calls notFound() when serverFetch returns 404', async () => {
  vi.mocked(serverFetch).mockResolvedValue(new Response(null, { status: 404 }));
  await AgentDetailPage({ params: { id: 'missing' } });
  expect(notFound).toHaveBeenCalled();
});
```

**Signal for `/test-plan`**: when emitting a unit-test plan for a page under `app/admin/**` or `app/(protected)/**`, do not auto-add "auth guard redirect" scenarios unless the source actually imports a guard. The pattern is the layout's responsibility.

**Status**: ✅ DOCUMENTED — Discovered while executing Sprint 2 Batch 2.2 (2026-05-01) on `app/admin/orchestration/agents/[id]/page.tsx`. Plan listed "auth guard redirects unauthenticated users" as the first Add scenario; source had no `withAuth()` / `withAdminAuth()` call — auth lives in the admin layout. Three `notFound()` paths covered the equivalent territory for the page.

---

## Best Practices Summary

**Before Writing Tests**:

1. Import shared mock factories: `createMockHeaders()`, `createMockSession()`, `delayed()`
2. Import type guards: `assertDefined()`, `assertHasProperty()`, `parseJSON()`
3. Read `.context/testing/patterns.md` for AAA structure and code patterns
4. Check `.context/testing/mocking.md` for dependency-specific mocking strategies

**During Test Development**:

1. Use AAA (Arrange-Act-Assert) pattern with comments
2. Define response type interfaces for type-safe assertions
3. Mock at boundaries (database, auth, external APIs), not internal logic
4. Reset mocks in `beforeEach()` with `vi.clearAllMocks()`
5. Restore mocks in `afterEach()` with `vi.restoreAllMocks()`

**Before Committing**:

1. Run `npm test` - All tests must pass
2. Run `npm run lint` - Zero errors, zero warnings in test files
3. Run `npm run type-check` - Zero type errors
4. Run `npm run format:check` - Clean (if it fails, `npx prettier --write` the edited paths and re-verify)
5. Check coverage with `npm run test:coverage`
6. Run `npm run validate` - Runs type-check + lint + format:check in one command

---

## ESLint Configuration

Test files have specific ESLint overrides in `eslint.config.mjs`:

```javascript
{
  files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/tests/**/*.{ts,tsx}'],
  rules: {
    '@typescript-eslint/require-await': 'off',        // Prevents async removal
    '@typescript-eslint/unbound-method': 'off',       // Allows Vitest mocks
    '@typescript-eslint/no-explicit-any': 'off',      // Allows strategic any in mocks
    '@typescript-eslint/no-unsafe-*': 'off',          // Allows test workarounds
    'no-console': 'off',                              // Allows debugging
  },
}
```

**Why**: Test code has different patterns than application code. These overrides prevent false positives while maintaining type safety where it matters.

---

## Related Documentation

**For implementation patterns and best practices**:

- `.context/testing/patterns.md` - AAA structure, shared mocks, type-safe assertions
- `.context/testing/mocking.md` - Dependency mocking strategies (Prisma, better-auth, Next.js, logger)
- `.context/testing/decisions.md` - Architectural rationale and ESLint rule decisions
- `.context/testing/history.md` - Key learnings and solutions (lint/type cycle prevention)
