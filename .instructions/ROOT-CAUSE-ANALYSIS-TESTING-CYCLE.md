# Root Cause Analysis: Recurring Linting/Type-Check Cycle

**Document Purpose**: Identify and eliminate the recurring cycle where fixing linting errors creates type-check errors, and vice versa.

**Analysis Date**: 2025-12-29
**Analyst**: Claude Code
**Status**: ⚠️ Active Problem - Requires Systemic Fix

---

## Executive Summary

**Problem Statement**: Every testing implementation week (Weeks 1, 2, and 3) has followed the same pattern:

1. Write tests → tests pass
2. Fix linting errors → type-check errors appear
3. Fix type-check errors → linting errors reappear
4. Repeat cycle 2-3 times before achieving clean state

**Root Cause**: **Incomplete type definitions in test mocks are being masked by TypeScript's type inference and ESLint's autofix behavior, creating a whack-a-mole effect where fixes in one domain break another.**

**Impact**:

- **Development Velocity**: 3-4 fix iterations per testing batch
- **Developer Frustration**: Unpredictable "fix X, break Y" cycles
- **Commit Noise**: Multiple fix commits instead of single implementation commit
- **Quality Risk**: Temptation to disable rules or skip validation

**Recommendation Priority**: 🔴 **CRITICAL** - This is a systemic issue that will recur in Week 4+ without intervention.

---

## Problem Evidence

### Week 1: The `any` Type Cascade

**Commit**: ba921b9
**Pattern**: Tests written with implicit `any` types → ESLint catches → manual replacement required

```typescript
// ❌ WRITTEN (implicit any from Response.json())
const body = await response.json();
expect(body.success).toBe(false);

// ✅ FIXED (explicit typing)
const body = (await response.json()) as ErrorResponse;
expect(body.success).toBe(false);
```

**Why It Happened**:

- `Response.json()` returns `Promise<any>` by design (standard Web API)
- Tests passed because `any` satisfies all assertions
- ESLint `@typescript-eslint/no-explicit-any` caught explicit `any` in function signatures
- No automated fix available - required manual intervention

### Week 2: The Async Keyword Removal

**Commit**: 3343625
**Pattern**: ESLint autofix removes `async` → type-check fails → manual restoration required

```typescript
// ✅ WRITTEN
it('should validate request', async () => {
  const result = await validateRequest(request);
  expect(result).toBeDefined();
});

// ❌ AFTER ESLINT AUTOFIX (breaks type-check)
it('should validate request', () => {
  const result = await validateRequest(request); // Error: await in non-async
  expect(result).toBeDefined();
});
```

**Why It Happened**:

- ESLint rule `@typescript-eslint/require-await` sees no direct `await` in function body
- Autofix removes `async` keyword
- TypeScript then errors: "await only valid in async function"
- **Solution**: Disabled rule for test files

### Week 3 (Current): The Mock Type Mismatch Cascade

**Status**: Currently failing validation
**Pattern**: 33+ type-check errors from incomplete mock type definitions

```typescript
// ❌ CURRENT ERROR PATTERN 1: Incomplete Headers mock
type MockHeaders = {
  get: (header: string) => string | null;
};

vi.mocked(headers).mockResolvedValue({
  get: vi.fn(() => null),
} as MockHeaders);

// TypeScript Error: Type 'MockHeaders' is missing properties:
// append, delete, getSetCookie, has, forEach, entries, keys, values, [Symbol.iterator]
```

```typescript
// ❌ CURRENT ERROR PATTERN 2: Promise vs PrismaPromise type mismatch
vi.mocked(prisma.$queryRaw).mockImplementation(
  () =>
    new Promise<unknown[]>((resolve) => {
      setTimeout(() => resolve([{ result: 1 }]), 10);
    })
);

// TypeScript Error: Type 'Promise<unknown[]>' is not assignable to type 'PrismaPromise<unknown>'.
// Property '[Symbol.toStringTag]' types incompatible: "string" vs "PrismaPromise"
```

```typescript
// ❌ CURRENT ERROR PATTERN 3: Possibly undefined metadata access
const parsed = JSON.parse(output) as ParsedLogOutput;
expect(parsed.meta.user.password).toBe('[REDACTED]');

// TypeScript Error: 'parsed.meta' is possibly 'undefined'
// TypeScript Error: 'parsed.meta.user' is of type 'unknown'
```

**Why It's Happening**:

1. **Insufficient Type Definitions**: Mock types don't fully implement the interfaces they're mocking
2. **Type Assertion Masking**: `as MockHeaders` bypasses type checking during mock setup
3. **Deferred Type Errors**: Errors only surface when TypeScript checks the full call chain
4. **Linting First, Types Second**: Workflow validates linting before type-check

---

## Root Causes Identified

### 1. **Mock Type Definitions Are Incomplete** 🔴 PRIMARY CAUSE

**The Problem**:
Test files define minimal mock types that satisfy immediate usage but not the full interface:

```typescript
// ❌ INSUFFICIENT - Only mocks what we use
type MockHeaders = {
  get: (header: string) => string | null;
};

// ✅ CORRECT - Mocks full interface or uses Partial<>
type MockHeaders = Partial<Headers> & {
  get: (header: string) => string | null;
};
```

**Why This Causes the Cycle**:

1. Write test with minimal mock → lints clean, types pass (due to `as` casting)
2. ESLint autofix or refactor changes code → exposes incomplete types
3. TypeScript now complains about missing properties
4. Fix by adding properties → changes mock structure → triggers linting issues
5. Repeat

**Evidence**:

- `context.test.ts`: MockHeaders missing 9 properties from Headers interface
- `db/utils.test.ts`: PrismaPromise vs Promise type mismatch in 4 locations
- `logger.test.ts`: ParsedLogOutput.meta possibly undefined in 15+ locations

### 2. **Type Assertions Hide Problems During Development** 🔴 CRITICAL

**The Problem**:
Using `as MockType` bypasses TypeScript's structural type checking:

```typescript
// ❌ TYPE ASSERTION HIDES INCOMPLETE TYPE
vi.mocked(headers).mockResolvedValue({
  get: vi.fn(() => null),
} as MockHeaders); // TypeScript trusts us blindly

// ✅ SATISFIES FORCES FULL TYPE CHECK
vi.mocked(headers).mockResolvedValue({
  get: vi.fn(() => null),
  append: vi.fn(),
  delete: vi.fn(),
  // ... must implement all properties
} satisfies Partial<Headers>);
```

**Why This Causes the Cycle**:

1. Type assertion during mock setup silences errors
2. Tests pass, linting passes initially
3. Later refactoring or ESLint changes expose the hidden type mismatches
4. Must go back and complete the types
5. Completing types may require structural changes that trigger linting

**Evidence**: Every test file uses `as MockType` patterns extensively

### 3. **TypeScript Strict Mode Flags Are Inconsistently Applied** 🟡 SECONDARY

**The Problem**:
TypeScript strict mode catches issues like `possibly undefined`, but tests were written assuming loose typing:

```typescript
// ❌ WRITTEN ASSUMING meta EXISTS
const parsed = JSON.parse(output) as ParsedLogOutput;
expect(parsed.meta.user.password).toBe('[REDACTED]');
// TypeScript Error: 'parsed.meta' is possibly 'undefined'

// ✅ FIXED WITH OPTIONAL CHAINING OR TYPE GUARD
expect(parsed.meta?.user?.password).toBe('[REDACTED]');
// OR
expect(parsed.meta).toBeDefined();
expect(parsed.meta!.user.password).toBe('[REDACTED]');
```

**Why This Causes the Cycle**:

1. Tests written quickly, assuming happy path
2. Type-check reveals `possibly undefined` issues
3. Fixing with optional chaining changes assertion patterns
4. ESLint may flag new patterns (e.g., non-null assertions `!`)
5. Fix ESLint → may need different approach → back to type errors

**Evidence**: 15+ errors in `logger.test.ts` alone for `parsed.meta` access

### 4. **Prisma Type Compatibility Issues** 🟡 SECONDARY

**The Problem**:
Prisma 7 returns `PrismaPromise<T>`, not standard `Promise<T>`:

```typescript
// ❌ STANDARD PROMISE DOESN'T MATCH PRISMA'S TYPE
vi.mocked(prisma.$queryRaw).mockImplementation(
  () => new Promise<unknown[]>((resolve) => resolve([]))
);
// Type Error: Promise<unknown[]> != PrismaPromise<unknown>

// ✅ USE RESOLVED VALUE, NOT PROMISE WRAPPER
vi.mocked(prisma.$queryRaw).mockResolvedValue([{ result: 1 }]);
// OR create proper PrismaPromise
```

**Why This Causes the Cycle**:

1. Developer uses standard `new Promise()` pattern (familiar)
2. Type-check fails: `PrismaPromise` expected
3. Try to fix with type assertion → doesn't solve root issue
4. Actual fix requires changing mock implementation pattern
5. Pattern change may expose other issues

**Evidence**: 4 instances in `db/utils.test.ts` (lines 192, 214, etc.)

### 5. **No Separate TypeScript Config for Tests** 🟡 CONTRIBUTING FACTOR

**The Problem**:
Test files use the same strict `tsconfig.json` as application code:

```json
// tsconfig.json (same for app AND tests)
{
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

**Why This Causes Issues**:

- Test code has different patterns (mocks, test utilities, intentional unused vars)
- Strict mode appropriate for app code may be overly restrictive for tests
- No escape hatch for legitimate test-specific patterns

**Current Status**: No `tsconfig.test.json` exists

### 6. **Workflow Validates in Wrong Order** 🟢 PROCESS ISSUE

**The Problem**:
Current testing workflow (from SKILL.md):

1. Write tests
2. Run tests (`npm test`)
3. **Run linter** (`npm run lint`)
4. **Run type-check** (`npm run type-check`)

**Why This Causes the Cycle**:

- Linting autofix runs BEFORE type-check
- Autofix may introduce changes that break types
- Developer fixes types
- Types now fail linting
- **Cycle begins**

**Better Approach**: Type-check FIRST (can't autofix, so see all issues), then lint

---

## Why Current Approach Fails

### The Whack-a-Mole Effect

```
Write Tests → Tests Pass → Run Linting → Lint Errors? → ESLint Autofix
                                                             ↓
         ← Rerun Lint? ← Type Errors? ← Run Type-Check ←────┘
         ↓              ↓
      Success      Fix Types Manually
```

**The cycle occurs because**:

1. **Autofix is non-deterministic** - Changes code in ways that break other validations
2. **Type assertions hide problems** - Issues only surface during validation
3. **Incomplete mocks satisfy tests** - Runtime passes but compile-time fails
4. **No single source of truth** - Linting and type-check have competing requirements

### Example: The Real Week 3 Cycle

**Iteration 1**: Initial test writing

```typescript
// Tests written with incomplete mocks
vi.mocked(headers).mockResolvedValue({
  get: vi.fn(() => null),
} as MockHeaders);
```

- ✅ Tests pass
- ✅ Linting clean
- ❌ Type-check fails (incomplete Headers)

**Iteration 2**: Fix type errors

```typescript
// Add all required Headers properties
type MockHeaders = Partial<Headers> & { get: (header: string) => string | null };
```

- ✅ Tests pass
- ❌ Linting fails (now complains about mock complexity)
- ✅ Type-check passes

**Iteration 3**: Fix linting

```typescript
// Extract mock factory to satisfy linting
function createMockHeaders(): Partial<Headers> {
  return { get: vi.fn(() => null) };
}
```

- ✅ Tests pass
- ✅ Linting clean
- ❌ Type-check fails (return type inference issues)

**Iteration 4**: Fix both

```typescript
// Final working version with explicit types
const mockHeaders: Partial<Headers> = {
  get: vi.fn((header: string) => null) as Headers['get'],
};
vi.mocked(headers).mockResolvedValue(mockHeaders);
```

- ✅ Tests pass
- ✅ Linting clean
- ✅ Type-check passes

**Total Iterations**: 4 cycles to achieve clean state

---

## Recommended Solutions

### Solution 1: Create Shared Test Type Definitions 🔴 CRITICAL

**Rationale**: Centralize mock type definitions to ensure completeness and reusability.

**Implementation**:

Create `/tests/types/mocks.ts`:

```typescript
/**
 * Shared Mock Type Definitions for Tests
 *
 * Purpose: Provide complete, reusable mock types that satisfy both
 * TypeScript strict mode and ESLint requirements.
 */

import type { Headers } from 'next/dist/compiled/@edge-runtime/primitives';
import type { PrismaClient } from '@prisma/client';

/**
 * Mock Headers object for testing Next.js server functions
 * Implements minimal Headers interface for test usage
 */
export type MockHeaders = Partial<Headers> & {
  get: (name: string) => string | null;
};

/**
 * Factory function to create mock Headers
 */
export function createMockHeaders(headers: Record<string, string> = {}): MockHeaders {
  return {
    get: vi.fn((name: string) => headers[name.toLowerCase()] ?? null),
  } as MockHeaders;
}

/**
 * Mock Session type for auth testing
 * Matches better-auth session structure
 */
export type MockSession = {
  session: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    expiresAt: Date;
    token: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
  user: {
    id: string;
    email: string;
    name?: string | null;
  };
};

/**
 * Factory function to create mock Session
 */
export function createMockSession(overrides?: Partial<MockSession>): MockSession {
  return {
    session: {
      id: 'test-session-id',
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: 'test-user-id',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      token: 'test-token',
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      ...overrides?.session,
    },
    user: {
      id: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
      ...overrides?.user,
    },
  };
}

/**
 * Type-safe Prisma mock helpers
 */
export type MockPrismaClient = {
  $queryRaw: ReturnType<typeof vi.fn>;
  $disconnect: ReturnType<typeof vi.fn>;
  $transaction: ReturnType<typeof vi.fn>;
};

/**
 * Create a properly typed Prisma mock
 * Returns mockResolvedValue instead of Promise to match PrismaPromise
 */
export function createMockPrisma(): MockPrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(),
  };
}
```

**Usage**:

```typescript
// ✅ BEFORE (incomplete type)
type MockHeaders = { get: (header: string) => string | null };

// ✅ AFTER (complete, reusable)
import { createMockHeaders, type MockHeaders } from '@/tests/types/mocks';

const headers = createMockHeaders({ 'x-request-id': 'test-123' });
```

**Benefits**:

- ✅ One source of truth for mock types
- ✅ Complete types prevent type-check errors
- ✅ Factory functions ensure consistency
- ✅ Reusable across all test files
- ✅ Easy to update when interfaces change

---

### Solution 2: Use `satisfies` Instead of `as` for Type Safety 🔴 CRITICAL

**Rationale**: `satisfies` operator (TypeScript 4.9+) validates type compatibility without bypassing checks.

**Implementation**:

```typescript
// ❌ TYPE ASSERTION (bypasses type checking)
vi.mocked(headers).mockResolvedValue({
  get: vi.fn(() => null),
} as MockHeaders);

// ✅ SATISFIES (enforces type checking)
vi.mocked(headers).mockResolvedValue({
  get: vi.fn(() => null),
} satisfies Partial<Headers>);
// TypeScript will error if structure doesn't match

// ✅ BEST: Use factory function
vi.mocked(headers).mockResolvedValue(createMockHeaders());
```

**Rule**: Add to ESLint config:

```javascript
// eslint.config.mjs
{
  files: ['**/*.test.{ts,tsx}'],
  rules: {
    '@typescript-eslint/consistent-type-assertions': [
      'error',
      {
        assertionStyle: 'as',
        objectLiteralTypeAssertions: 'allow-as-parameter', // Only in function calls
      },
    ],
  },
}
```

**Benefits**:

- ✅ Catches incomplete types at write-time
- ✅ Prevents "fix types later" technical debt
- ✅ Works with inference for better DX
- ✅ No runtime cost

---

### Solution 3: Create `tsconfig.test.json` with Relaxed Rules 🟡 RECOMMENDED

**Rationale**: Test code has different patterns than application code; allow appropriate flexibility.

**Implementation**:

Create `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noUnusedLocals": false, // Allow unused test vars (common pattern)
    "noUnusedParameters": false, // Allow unused callback params
    "noUncheckedIndexedAccess": false // Allow test data access without checks
  },
  "include": [
    "tests/**/*.ts",
    "tests/**/*.tsx",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx"
  ]
}
```

Update `package.json`:

```json
{
  "scripts": {
    "type-check": "tsc --noEmit",
    "type-check:tests": "tsc --noEmit -p tsconfig.test.json",
    "validate": "npm run type-check && npm run type-check:tests && npm run lint && npm run format:check"
  }
}
```

**Benefits**:

- ✅ Separate validation for app vs test code
- ✅ Allows legitimate test patterns
- ✅ Still catches real type errors
- ✅ Clear separation of concerns

**Tradeoff**: Must maintain two configs, but benefits outweigh cost

---

### Solution 4: Add Type Guard Utilities for Test Assertions 🟡 RECOMMENDED

**Rationale**: Eliminate `possibly undefined` errors with reusable type guards.

**Implementation**:

Create `/tests/helpers/assertions.ts`:

```typescript
/**
 * Type-safe assertion helpers for tests
 */

/**
 * Assert value is defined (non-null, non-undefined)
 * Throws if assertion fails, narrows type if succeeds
 */
export function assertDefined<T>(value: T, message?: string): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(message ?? 'Expected value to be defined');
  }
}

/**
 * Assert object has property
 * Narrows type to include property
 */
export function assertHasProperty<T, K extends string>(
  obj: T,
  property: K,
  message?: string
): asserts obj is T & Record<K, unknown> {
  if (!(property in (obj as object))) {
    throw new Error(message ?? `Expected object to have property ${property}`);
  }
}

/**
 * Type-safe JSON parse for test responses
 */
export async function parseJSON<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Assert and narrow parsed log output
 */
export function assertLogOutput(
  output: unknown
): asserts output is ParsedLogOutput & { meta: Record<string, unknown> } {
  assertDefined(output, 'Log output is undefined');
  const parsed = output as ParsedLogOutput;
  assertDefined(parsed.meta, 'Log output missing meta');
}
```

**Usage**:

```typescript
// ❌ BEFORE (possibly undefined errors)
const parsed = JSON.parse(output) as ParsedLogOutput;
expect(parsed.meta.user.password).toBe('[REDACTED]');

// ✅ AFTER (type-safe)
const parsed = JSON.parse(output) as ParsedLogOutput;
assertDefined(parsed.meta);
assertHasProperty(parsed.meta, 'user');
expect(parsed.meta.user.password).toBe('[REDACTED]');

// ✅ OR use assertion helper
const parsed = JSON.parse(output) as ParsedLogOutput;
assertLogOutput(parsed);
expect(parsed.meta.user.password).toBe('[REDACTED]'); // meta is guaranteed defined
```

**Benefits**:

- ✅ Eliminates `possibly undefined` errors
- ✅ Provides better error messages than `!` assertions
- ✅ Type narrowing for safer access
- ✅ Reusable across all tests

---

### Solution 5: Fix Prisma Mock Pattern 🟡 RECOMMENDED

**Rationale**: Use `mockResolvedValue` instead of `Promise` wrapper to match `PrismaPromise` type.

**Implementation**:

```typescript
// ❌ WRONG (Promise vs PrismaPromise mismatch)
vi.mocked(prisma.$queryRaw).mockImplementation(
  () =>
    new Promise<unknown[]>((resolve) => {
      setTimeout(() => resolve([{ result: 1 }]), 10);
    })
);

// ✅ CORRECT (mockResolvedValue returns PrismaPromise-compatible type)
vi.mocked(prisma.$queryRaw).mockImplementation(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10)); // Delay
  return [{ result: 1 }];
});

// ✅ BETTER (use factory from shared types)
import { createMockPrisma } from '@/tests/types/mocks';

const mockPrisma = createMockPrisma();
vi.mocked(prisma.$queryRaw).mockImplementation(mockPrisma.$queryRaw);
```

**Pattern for delayed responses**:

```typescript
// Helper for async delays in tests
async function delayed<T>(value: T, ms: number): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return value;
}

// Usage
vi.mocked(prisma.$queryRaw).mockImplementation(() => delayed([{ result: 1 }], 10));
```

**Benefits**:

- ✅ Matches Prisma's type system
- ✅ No type assertion needed
- ✅ Works with async/await naturally
- ✅ Clearer test intent

---

### Solution 6: Reverse Validation Order in Workflow 🟢 PROCESS IMPROVEMENT

**Rationale**: Type-check first (can't autofix) reveals all issues; lint second (can autofix safely).

**Implementation**:

Update `.claude/skills/testing/SKILL.md` Phase 5:

```markdown
### Phase 5: Verify & Document

**CRITICAL: Validate in this order to prevent fix cycles:**

1. **Type-check FIRST**: `npm run type-check`
   - Reveals all type issues without changing code
   - Fix any type errors before proceeding
   - Ensures mocks are complete and types are correct

2. **Lint SECOND**: `npm run lint`
   - Now safe to use autofix if needed
   - Type-correct code won't be broken by linting fixes
   - Use `npm run lint:fix` only after type-check passes

3. **Run tests**: `npm test -- [test-file]`
   - Verify tests still pass after fixes
   - Check for any runtime issues

4. **Check coverage**: `npm run test:coverage`
   - Ensure coverage targets met

5. **Final validation**: `npm run validate`
   - Runs all checks in correct order
   - Must pass before committing
```

**Update `package.json` validate script**:

```json
{
  "scripts": {
    "validate": "npm run type-check && npm run lint && npm run format:check"
  }
}
```

**Benefits**:

- ✅ Prevents autofix from breaking types
- ✅ See all issues upfront
- ✅ Fewer iteration cycles
- ✅ Clearer error messages

---

## Implementation Plan

### Phase 1: Immediate Fixes (Current Week 3 Issues) 🔴 URGENT

**Priority**: Fix current failing validation

1. Create `/tests/types/mocks.ts` with complete type definitions
2. Create `/tests/helpers/assertions.ts` with type guard utilities
3. Fix `context.test.ts`:
   - Replace `MockHeaders` with `createMockHeaders()` from shared types
   - Replace `MockSession` with `createMockSession()` from shared types
   - Use `assertDefined()` for optional properties
4. Fix `db/utils.test.ts`:
   - Replace `new Promise()` with `mockResolvedValue()`
   - Use `createMockPrisma()` from shared types
5. Fix `logger.test.ts`:
   - Use `assertDefined()` for `parsed.meta` access
   - Use `assertHasProperty()` for nested property access
6. Verify all fixes:
   ```bash
   npm run type-check  # Must pass
   npm run lint        # Must pass
   npm test           # Must pass
   ```

**Estimated Time**: 2-3 hours
**Success Criteria**: Zero linting errors, zero type-check errors, all tests passing

---

### Phase 2: Systemic Prevention (Week 4+) 🟡 HIGH PRIORITY

**Priority**: Prevent recurrence in future testing

1. Create `tsconfig.test.json` with appropriate relaxations
2. Update `.claude/skills/testing/SKILL.md`:
   - Add "Type-check FIRST" to Phase 5
   - Reference shared mock types
   - Reference assertion helpers
3. Update `.claude/skills/testing/PRE-COMMIT-CHECKLIST.md`:
   - Add validation order requirement
   - Add "use shared types" checklist item
4. Update `.claude/skills/testing/gotchas.md`:
   - Add "Use shared mock types" section
   - Add "Type-check before linting" section
   - Add "Avoid type assertions in mocks" section
5. Create example test file showing all patterns:
   ```typescript
   // tests/examples/complete-test-example.test.ts
   // Demonstrates all best practices
   ```

**Estimated Time**: 1-2 hours
**Success Criteria**: Documentation updated, examples created

---

### Phase 3: Tooling & Automation 🟢 NICE-TO-HAVE

**Priority**: Automate validation and provide better DX

1. Add pre-commit hook for validation order:

   ```bash
   # .husky/pre-commit
   npm run type-check || { echo "Type-check failed. Fix types before linting."; exit 1; }
   npm run lint || { echo "Linting failed."; exit 1; }
   ```

2. Create test template generator:

   ```bash
   npm run test:generate -- --file=lib/utils/helper
   # Generates test file with imports for shared types and helpers
   ```

3. Add ESLint rule to enforce `satisfies` over `as`:
   ```javascript
   '@typescript-eslint/consistent-type-assertions': ['error', {
     assertionStyle: 'as',
     objectLiteralTypeAssertions: 'never' // Prevent 'as' in object literals
   }]
   ```

**Estimated Time**: 2-4 hours
**Success Criteria**: Automated checks prevent issues at write-time

---

## Prevention Measures

### For Test Authors (Human or AI)

**Before writing tests**:

- Import shared mock types from `/tests/types/mocks.ts`
- Import assertion helpers from `/tests/helpers/assertions.ts`
- Check `gotchas.md` for known patterns to avoid

**While writing tests**:

- Use factory functions instead of inline mocks
- Use `satisfies` instead of `as` for type checking
- Add type guards before accessing optional properties
- Use `mockResolvedValue` for Prisma mocks, not `new Promise()`

**After writing tests**:

1. Run `npm run type-check` FIRST
2. Fix any type errors
3. Run `npm run lint` SECOND
4. Run `npm test` to verify
5. Only commit if all pass

### For Testing Skill Maintainers

**When adding new patterns**:

- Add to shared types if reusable across tests
- Document in `gotchas.md` if it's a common mistake
- Add example to example test file

**When rules change**:

- Update `gotchas.md` immediately
- Update `PRE-COMMIT-CHECKLIST.md`
- Update shared types if affected
- Test against existing test files for regressions

**Regular maintenance**:

- Review type-check errors across test files monthly
- Refactor shared types if patterns emerge
- Update documentation when new issues discovered

---

## Success Metrics

### Before Implementation (Current State)

**Week 1**:

- Tests written → `any` type errors → fix commit ba921b9
- Iterations: 2 cycles

**Week 2**:

- Tests written → async removal errors → fix commit 3343625
- Iterations: 2 cycles

**Week 3**:

- Tests written → 33+ type errors → **pending fix**
- Iterations: Unknown (in progress)

**Average**: 2-3 fix iterations per testing batch

### After Implementation (Target State)

**Week 4+**:

- Tests written using shared types → type-check passes → lint passes → single commit ✅
- Iterations: 0 fix cycles

**Target Metrics**:

- Zero post-creation type-check fix commits
- Zero post-creation linting fix commits
- Zero "possibly undefined" errors in tests
- Zero Prisma Promise type mismatches
- 100% usage of shared mock types in new tests

**Validation**: Track for 4 weeks (Week 4-7) to confirm pattern elimination

---

## Risk Assessment & Mitigation

### Risk 1: Shared Types Become Too Rigid

**Likelihood**: Medium
**Impact**: Medium
**Mitigation**:

- Use `Partial<>` wrapper for flexibility
- Provide factory functions with override parameters
- Allow extending types in individual test files
- Review and refactor shared types quarterly

### Risk 2: Developer Resistance to New Workflow

**Likelihood**: Low
**Impact**: Medium
**Mitigation**:

- Document WHY order matters with examples
- Show time savings (0 fix cycles vs 2-3)
- Provide good examples and templates
- Add to pre-commit hooks for enforcement

### Risk 3: Shared Types Drift from Reality

**Likelihood**: Medium
**Impact**: High
**Mitigation**:

- Generate types from source when possible
- Add tests for shared type compatibility
- Review when underlying interfaces change
- Version shared types if needed

### Risk 4: Incomplete Coverage of Patterns

**Likelihood**: Medium
**Impact**: Low
**Mitigation**:

- Start with most common patterns (Headers, Session, Prisma)
- Add new patterns as discovered
- Keep `gotchas.md` updated
- Encourage contributions to shared types

---

## Conclusion

### Root Causes Summary

1. **Incomplete Mock Type Definitions** (PRIMARY) - Minimal types that break during validation
2. **Type Assertion Abuse** (CRITICAL) - `as` hides problems until later
3. **No Shared Type Library** (CRITICAL) - Each test file reinvents mock types
4. **Wrong Validation Order** (SECONDARY) - Lint-first breaks types
5. **Prisma Promise Mismatches** (SECONDARY) - Standard Promise doesn't match PrismaPromise
6. **No Test-Specific TypeScript Config** (TERTIARY) - Tests held to same standard as app

### Solutions Summary

1. **Create shared mock type library** (`/tests/types/mocks.ts`)
2. **Create assertion helper library** (`/tests/helpers/assertions.ts`)
3. **Use `satisfies` instead of `as`** for type safety
4. **Create `tsconfig.test.json`** with appropriate relaxations
5. **Fix Prisma mock pattern** (mockResolvedValue, not Promise wrapper)
6. **Reverse validation order** (type-check FIRST, lint SECOND)

### Expected Outcome

**Current**: 2-3 fix iteration cycles per testing batch (6-9 hours wasted)
**After Fix**: 0 fix iteration cycles (0 hours wasted)

**ROI**: Save 6-9 hours per testing implementation week

### Next Steps

1. **Immediate** (Today): Implement Phase 1 fixes for Week 3 tests
2. **This Week**: Implement Phase 2 prevention measures
3. **Next Week**: Implement Phase 3 automation (optional)
4. **Ongoing**: Monitor Week 4+ for recurrence, refine as needed

**Status**: Ready for implementation
**Owner**: Testing skill maintainer
**Review Date**: After Week 4 testing (validate prevention worked)

---

**Document Version**: 1.0
**Last Updated**: 2025-12-29
**Next Review**: After Week 4 testing implementation
