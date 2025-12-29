# Test Creation Pre-Commit Checklist

**Purpose**: Ensure all test files meet quality standards before committing.

**When to Use**: After creating or modifying any test file, verify ALL items before committing.

---

## Required Checks

Run these commands and verify they pass:

- [ ] **Tests Pass**: `npm test` - All tests pass with zero failures
- [ ] **Linting Clean**: `npm run lint` - No ESLint errors or warnings
- [ ] **Type-Check Pass**: `npm run type-check` - No TypeScript errors
- [ ] **Coverage Target**: Coverage meets project thresholds (80%+ overall, 90%+ critical paths)

**Shortcut**: Run all checks at once:

```bash
npm run validate  # Runs type-check + lint + format:check
npm test         # Runs all tests
```

---

## Code Quality Standards

### Type Safety

- [ ] **No `any` types**: Use `unknown` or define proper interfaces
- [ ] **Response Type Interfaces**: Define types for `Response.json()` return values
- [ ] **Type Guards**: Use `instanceof` for type narrowing in catch blocks
- [ ] **Mock Type Safety**: Use `vi.mocked()` or proper type casts

**Example**:

```typescript
// ✅ GOOD
interface ErrorResponse {
  success: false;
  error: { message: string; code?: string };
}

async function parseResponse(response: Response): Promise<ErrorResponse> {
  return (await response.json()) as ErrorResponse;
}

// ❌ BAD
const body = await response.json(); // Type: any
```

### Test Structure

- [ ] **AAA Pattern**: Arrange-Act-Assert with inline comments
- [ ] **Descriptive Names**: Test names explain scenario and expected outcome (use "should ... when ...")
- [ ] **One Behavior Per Test**: Each test verifies a single behavior
- [ ] **Independent Tests**: No shared state between tests

**Example**:

```typescript
// ✅ GOOD
it('should return 400 when request body is invalid', async () => {
  // Arrange: Create invalid request
  const request = new NextRequest('http://test.com', {
    method: 'POST',
    body: JSON.stringify({ invalid: 'data' }),
  });

  // Act: Validate request
  const result = await validateRequest(request);

  // Assert: Validation fails with correct error
  expect(result.success).toBe(false);
  expect(result.error.code).toBe('VALIDATION_ERROR');
});

// ❌ BAD
it('should work', async () => {
  const req = new NextRequest('http://test.com', {
    method: 'POST',
    body: JSON.stringify({ invalid: 'data' }),
  });
  const result = await validateRequest(req);
  expect(result.success).toBe(false);
});
```

### Mock Management

- [ ] **Mock Cleanup**: Use `afterEach(() => vi.restoreAllMocks())`
- [ ] **Mock Placement**: Mocks defined at top of file or in `beforeEach`
- [ ] **Mock Clarity**: Clear what's mocked and why
- [ ] **Mock Assertions**: Verify mocks were called with correct arguments

**Example**:

```typescript
// ✅ GOOD
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logger } from '@/lib/logging';

vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe('Feature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should log error on failure', () => {
    // Test implementation
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Error', expect.any(Error));
  });
});
```

---

## Known Gotchas

Review these items from `.claude/skills/testing/gotchas.md`:

### ESLint Auto-Fix (FIXED)

- [ ] **Async Functions**: ESLint will NOT remove `async` keyword (config prevents it)
  - Rule `@typescript-eslint/require-await` is disabled for test files
  - Safe to use `async` even when await is in helper functions

### Unbound Method Rule (FIXED)

- [ ] **Mock Assertions**: Using `vi.mocked()` directly is safe
  - Rule `@typescript-eslint/unbound-method` is disabled for test files
  - This is the standard Vitest pattern

**Example**:

```typescript
// ✅ SAFE - Both patterns work
expect(vi.mocked(logger.error)).toHaveBeenCalledWith(...);

const mockError = vi.mocked(logger.error);
expect(mockError).toHaveBeenCalledWith(...);
```

### NODE_ENV Changes

- [ ] **Environment Variables**: Use `Object.defineProperty()` to change NODE_ENV
  - Cannot set `process.env.NODE_ENV` directly (read-only)
  - See gotchas.md for pattern

### Mock Timing

- [ ] **Setup Order**: Environment variables set BEFORE imports in `tests/setup.ts`
  - Modules like `lib/env.ts` validate at import time
  - Env vars must be ready before any imports

---

## Validation Commands

Run these exact commands before committing:

```bash
# 1. Run all tests
npm test

# 2. Run linter (should show ZERO errors)
npm run lint

# 3. Run type-checker (should show ZERO errors)
npm run type-check

# 4. Check test coverage (optional but recommended)
npm run test:coverage
```

**Expected Output**:

- ✅ All tests passing
- ✅ ESLint: No errors, no warnings (except known acceptable warnings in source code)
- ✅ TypeScript: No errors
- ✅ Coverage: Meets thresholds (80%+ overall, 90%+ critical)

---

## If Checks Fail

### Tests Fail

1. Fix the test logic
2. Ensure mocks are set up correctly
3. Check test isolation (no shared state)
4. Verify imports and paths are correct

### Linting Errors

1. **DO NOT disable rules** unless documented in gotchas.md
2. Fix the code to comply with ESLint rules
3. Use proper types instead of `any`
4. If rule is genuinely wrong, document in LINTING-ANALYSIS.md first

### Type-Check Errors

1. Define proper interfaces for all types
2. Use type guards (`instanceof`, type predicates)
3. Avoid `any` - use `unknown` and narrow types
4. Check for missing imports or incorrect paths

### Coverage Below Target

1. Identify uncovered lines with `npm run test:coverage`
2. Add tests for critical paths first
3. Focus on behavior, not lines (quality over quantity)
4. Document if intentionally skipping coverage

---

## Ready to Commit

If ALL checks pass ✅:

1. Stage test files: `git add tests/`
2. Commit with descriptive message:
   ```bash
   git commit -m "test: add comprehensive tests for [feature]"
   ```
3. Push to remote

**Note**: Pre-commit hooks will run `lint-staged`, which formats and lints staged files. This should pass cleanly if you've followed this checklist.

---

## Summary

**Minimum Requirements**:

- ✅ Tests pass
- ✅ Lint clean
- ✅ Type-check clean
- ✅ Code quality standards met

**Best Practices**:

- ✅ AAA pattern with comments
- ✅ Descriptive test names
- ✅ Type-safe assertions
- ✅ Mock cleanup
- ✅ Coverage targets met

**Documentation**:

- See `.claude/skills/testing/gotchas.md` for common pitfalls
- See `.claude/skills/testing/LINTING-ANALYSIS.md` for systemic issues and solutions
- See `.claude/skills/testing/SKILL.md` for overall testing workflow

---

**Last Updated**: 2025-12-29
**Status**: Active - Use this checklist for all test creation
