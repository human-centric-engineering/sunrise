---
name: testing
version: 1.0.0
description: |
  Expert testing skill for Sunrise. Implements comprehensive testing patterns
  including unit tests, integration tests, and component tests. Uses hybrid
  autonomy to handle simple tests autonomously while consulting the user for
  complex architectural decisions. Use this skill when the user asks to add tests,
  write tests, implement testing, test code, or work on Phase 2.4.

triggers:
  - 'add tests'
  - 'write tests for'
  - 'test this code'
  - 'implement testing'
  - 'phase 2.4'

contexts:
  - '.claude/skills/testing/templates/*.md'
  - '.claude/skills/testing/mocking/*.md'
  - '.claude/skills/testing/priority-guide.md'
  - '.claude/skills/testing/success-criteria.md'
  - '.context/testing/*.md'
  - 'vitest.config.ts'
  - '__tests__/**/*.test.ts'
  - 'lib/test-utils/**/*'

mcp_integrations:
  context7:
    libraries:
      - vitest: '/vitejs/vitest'
      - react-testing-library: '/testing-library/react-testing-library'
      - testcontainers: '/testcontainers/testcontainers-node'
  next_devtools: true

parameters:
  autonomy_level: hybrid
  complexity_threshold: medium
  test_coverage_goal: 80
---

# Testing Expert Skill - Overview

## Mission

You are a testing expert for the Sunrise project. Your role is to create high-quality, maintainable tests using Vitest, React Testing Library, and Testcontainers. You use **hybrid autonomy**: handle simple tests automatically while consulting the user for complex architectural decisions.

## Technology Stack

- **Testing Framework**: Vitest (configured in package.json)
- **Component Testing**: React Testing Library
- **Integration Testing**: Hybrid approach
  - Unit tests: Mocked dependencies (fast)
  - API integration tests: Testcontainers + real PostgreSQL (production-parity)
- **Mocking**: Vitest `vi.mock()`
- **Coverage**: Target 80%+ overall, 90%+ for critical paths

## 5-Phase Workflow

### Phase 1: Analyze Code

1. **Read the target file** to understand what needs testing
2. **Parse structure**:
   - Count functions and their complexity
   - Identify dependencies (Prisma, better-auth, Next.js, logger)
   - Detect side effects (database, API calls, file I/O)
   - Note existing patterns (error handling, validation)
3. **Determine test type**:
   - Unit test: Pure functions, utilities, validators
   - Integration test: API routes, database operations
   - Component test: React components, forms

### Phase 2: Determine Complexity & Autonomy

Use this decision tree to classify code complexity:

**Simple (Full Autonomy)**:

- Pure functions with no side effects
- Zod schema validation
- Utility functions without external dependencies
- < 3 functions, cyclomatic complexity < 5
- **Action**: Generate tests immediately

**Medium (Hybrid)**:

- Functions with mockable dependencies
- Async operations (non-database)
- 3-5 functions with moderate branching
- Error handling utilities
- **Action**: Generate structure, ask about edge cases

**Complex (Interactive)**:

- Database operations (Prisma)
- Authentication calls (better-auth)
- External API calls
- File I/O or cryptography
- > 5 functions or high complexity
- **Action**: Ask about mock strategy, database setup, test data

**Complexity Calculation**:

```typescript
function calculateComplexity(code: CodeAnalysis): Complexity {
  let score = 0;

  // Function count
  score += code.functionCount * 2;

  // Dependencies
  if (code.usesPrisma) score += 10;
  if (code.usesBetterAuth) score += 8;
  if (code.usesExternalAPI) score += 8;
  if (code.usesFileSystem) score += 5;

  // Side effects
  score += code.sideEffects * 3;

  // Branching
  score += code.branchingFactor * 2;

  // Determine level
  if (score < 10) return 'simple';
  if (score < 25) return 'medium';
  return 'complex';
}
```

### Phase 3: Fetch Documentation

**ALWAYS use Context7 MCP** to get up-to-date testing patterns before generating tests.

**For Unit Tests (Vitest)**:

```typescript
mcp__context7__get -
  library -
  docs({
    context7CompatibleLibraryID: '/vitejs/vitest',
    topic: 'mocking async functions expect matchers',
    mode: 'code',
  });
```

**For Component Tests (React Testing Library)**:

```typescript
mcp__context7__get -
  library -
  docs({
    context7CompatibleLibraryID: '/testing-library/react-testing-library',
    topic: 'testing forms user events queries',
    mode: 'code',
  });
```

**For Integration Tests (Testcontainers)**:

```typescript
mcp__context7__get -
  library -
  docs({
    context7CompatibleLibraryID: '/testcontainers/testcontainers-node',
    topic: 'postgresql container setup migrations',
    mode: 'code',
  });
```

**For Next.js-specific patterns**:
Use the Next.js DevTools MCP server to fetch testing patterns for App Router, Server Components, and Route Handlers.

### Phase 4: Generate Test Files

**File Naming Convention**:

```
Source file                          → Test file
lib/validations/auth.ts             → __tests__/lib/validations/auth.test.ts
app/api/v1/users/route.ts           → __tests__/app/api/v1/users/route.test.ts
components/forms/login-form.tsx     → __tests__/components/forms/login-form.test.tsx
```

**Test Structure (Arrange-Act-Assert)**:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('[Module Name]', () => {
  // Setup
  beforeEach(() => {
    // Reset mocks, initialize test data
  });

  afterEach(() => {
    // Cleanup, restore mocks
    vi.restoreAllMocks();
  });

  describe('[Feature/Function Name]', () => {
    it('should [expected behavior] when [condition]', async () => {
      // Arrange: Set up test data and mocks
      const input = createTestData();
      const mockDependency = vi.fn().mockResolvedValue(expected);

      // Act: Execute the function under test
      const result = await functionUnderTest(input);

      // Assert: Verify the outcome
      expect(result).toMatchObject({ ... });
      expect(mockDependency).toHaveBeenCalledWith(...);
    });

    it('should [error behavior] when [error condition]', async () => {
      // Test error paths
      const mockDependency = vi.fn().mockRejectedValue(new Error('Test error'));

      await expect(functionUnderTest()).rejects.toThrow('Test error');
    });
  });
});
```

### Phase 5: Verify & Document

**CRITICAL**: All validation steps must pass before marking tests as complete.

1. **Run tests**: `npm test -- [test-file]`
2. **Run linter**: `npm run lint` - MUST pass with zero errors
3. **Run type-check**: `npm run type-check` - MUST pass with zero errors
4. **Check coverage**: `npm run test:coverage`
5. **Verify all checks pass**: Tests + lint + types all green
6. **Review checklist**: See `PRE-COMMIT-CHECKLIST.md` for full validation
7. **Update documentation**: If new patterns emerge, document in `.context/testing/`

**Shortcut**: Run `npm run validate && npm test` to check everything at once.

**DO NOT mark tests as complete unless**:

- ✅ All tests pass
- ✅ Linting clean (0 errors, 0 warnings in test files)
- ✅ Type-check clean (0 errors)
- ✅ Coverage meets targets

## Autonomy Decision Examples

### Autonomous (Simple)

```
User: "Add tests for lib/utils/password-strength.ts"

Analysis:
- Pure function ✓
- No dependencies ✓
- < 3 functions ✓
- No side effects ✓

Action: Generate 12 tests immediately
✓ All tests passing
✓ Coverage: 100%
```

### Hybrid (Medium)

```
User: "Add tests for lib/api/validation.ts"

Analysis:
- 3 functions (validateRequestBody, validateQueryParams, parsePaginationParams)
- Async operations ✓
- Mockable dependencies (NextRequest) ✓

Action: Generate structure, ask about edge cases
"Generated test structure with 15 tests. Should I add edge case tests for:
- Malformed JSON errors?
- Array query parameters?
- Negative pagination values?
[Y/n]"
```

### Interactive (Complex)

```
User: "Add integration tests for app/api/v1/users/route.ts"

Analysis:
- Database operations (Prisma) ✓
- Authentication (better-auth) ✓
- 2 HTTP methods (GET, POST) ✓
- Complex business logic ✓

Action: Ask about implementation strategy
"This requires integration testing decisions:

1. Database strategy?
   [A] Testcontainers (real PostgreSQL) ← Recommended
   [B] Mock Prisma client

2. Auth mocking?
   [A] Mock getSession() ← Faster
   [B] Real better-auth sessions

3. Test data volume?
   [A] Minimal (2-3 users)
   [B] Realistic (10-20 users)

Choose [A/B]:"
```

## Common Patterns

### Shared Mock Types and Assertion Helpers (Week 3)

**CRITICAL**: Use shared mock types to prevent recurring lint/type error cycles.

**Import from `tests/types/mocks.ts`**:

```typescript
import {
  createMockHeaders,
  createMockSession,
  delayed,
  type MockHeaders,
  type MockSession,
} from '@/tests/types/mocks';
```

**Import from `tests/helpers/assertions.ts`**:

```typescript
import { assertDefined, assertHasProperty, parseJSON } from '@/tests/helpers/assertions';
```

**Complete Mock Creation** (prevents type errors):

```typescript
// ✅ CORRECT - Use factory functions
vi.mocked(headers).mockResolvedValue(createMockHeaders({ 'x-request-id': 'test-123' }) as any);

vi.mocked(getSession).mockResolvedValue(createMockSession({ userId: 'user-123' }) as any);

// ❌ INCORRECT - Inline mocks (incomplete types)
vi.mocked(headers).mockResolvedValue({
  get: vi.fn(() => 'test-123'),
} as any);
```

**Type-Safe Assertions** (eliminates "possibly undefined" errors):

```typescript
// ✅ CORRECT - Use assertDefined for type narrowing
const parsed = JSON.parse(output);
assertDefined(parsed.meta);
expect(parsed.meta.userId).toBe('user-123'); // Type-safe!

// ✅ CORRECT - Use assertHasProperty for property checks
assertHasProperty(parsed, 'error');
expect(parsed.error.code).toBe('VALIDATION_ERROR');

// ❌ INCORRECT - Direct access (type error)
expect(parsed.meta.userId).toBe('user-123'); // Error: meta possibly undefined
```

**Async Timing with delayed()** (fixes PrismaPromise issues):

```typescript
import { delayed } from '@/tests/types/mocks';

// ✅ CORRECT - Use delayed() for timed async operations
vi.mocked(prisma.$queryRaw).mockImplementation(() => delayed([{ result: 1 }], 50) as any);

// ❌ INCORRECT - Manual Promise (type mismatch)
vi.mocked(prisma.$queryRaw).mockImplementation(
  () => new Promise((resolve) => setTimeout(() => resolve([{ result: 1 }]), 50))
);
```

**Why This Matters**:

- Prevents the recurring lint/type error cycle
- Complete types eliminate need for workarounds
- Centralized patterns reduce code duplication
- Type guards provide better error messages than non-null assertions

**See Also**: `gotchas.md` Section 5 for root cause analysis and prevention details.

### Test Data Factories

Use factories from `lib/test-utils/factories.ts`:

```typescript
const user = createMockUser({ role: 'ADMIN' });
const session = createMockSession(user);
const request = createMockRequest({
  method: 'POST',
  body: { name: 'Test' },
});
```

### Async Testing

```typescript
it('should handle async operations', async () => {
  const promise = asyncFunction();

  await expect(promise).resolves.toBe(expected);
  // or
  await expect(promise).rejects.toThrow('error');
});
```

### Parameterized Tests

```typescript
describe.each([
  { input: 'test@example.com', valid: true },
  { input: 'invalid', valid: false },
  { input: '', valid: false },
])('email validation with $input', ({ input, valid }) => {
  it(`should ${valid ? 'accept' : 'reject'}`, () => {
    const result = emailSchema.safeParse(input);
    expect(result.success).toBe(valid);
  });
});
```

### Testing Error Boundaries

```typescript
it('should catch and display errors', () => {
  const ThrowError = () => {
    throw new Error('Test error');
  };

  render(
    <ErrorBoundary>
      <ThrowError />
    </ErrorBoundary>
  );

  expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
});
```

## Related Files

- **Root Cause Analysis**: `../../.instructions/ROOT-CAUSE-ANALYSIS-TESTING-CYCLE.md` - **MUST READ**
  - Comprehensive analysis of recurring lint/type error cycle
  - 6 root causes identified (incomplete mocks, type assertions, config issues)
  - Phase 1 & 2 solutions implemented (shared types, assertions, ESLint config)
  - Prevention strategies and success metrics
  - **Week 3 breakthrough**: Solved systemic issue saving 6-9 hours per week

- **Shared Mock Types**: `../../tests/types/mocks.ts` - **USE FOR ALL MOCKS**
  - Complete mock type definitions (MockHeaders, MockSession)
  - Factory functions (createMockHeaders, createMockSession)
  - Async helpers (delayed() for PrismaPromise compatibility)
  - Prevents incomplete type definitions that trigger lint/type cycles

- **Assertion Helpers**: `../../tests/helpers/assertions.ts` - **USE FOR TYPE GUARDS**
  - Type-safe assertion functions (assertDefined, assertHasProperty)
  - parseJSON for type-safe response parsing
  - Eliminates "possibly undefined" errors
  - Better error messages than non-null assertions

- **Linting Analysis**: `LINTING-ANALYSIS.md` - **READ FOR SYSTEMIC ISSUES**
  - Root cause analysis of recurring linting problems
  - ESLint rule decisions and rationale
  - Week 1, 2, 3 issue patterns
  - Systemic prevention measures
  - Success metrics and validation requirements

- **Pre-Commit Checklist**: `PRE-COMMIT-CHECKLIST.md` - **USE BEFORE COMMITTING**
  - Required validation steps
  - Code quality standards
  - Exact commands to run
  - Known gotchas reference
  - Ready-to-commit criteria

- **Gotchas & Best Practices**: `gotchas.md` - **READ THIS FIRST!**
  - Critical issues from Week 1, 2, 3 (545 tests)
  - ESLint auto-fix problems with async tests (FIXED)
  - Unbound method rule issues (FIXED)
  - **NEW**: Recurring lint/type cycle (SOLVED - Week 3)
  - NODE_ENV read-only workarounds
  - Type safety patterns for Response objects
  - Mock setup timing requirements
  - Proven patterns from production implementation

- **Test Templates**: See `templates/` folder for detailed examples
  - `simple.md` - Validation schema tests
  - `medium.md` - API utility tests
  - `complex.md` - Integration tests
  - `component.md` - React component tests

- **Mock Strategies**: See `mocking/` folder for dependency mocking
  - `better-auth.md` - Authentication mocking
  - `prisma.md` - Database mocking
  - `nextjs.md` - Next.js mocking
  - `logger.md` - Logger mocking

- **Implementation Guides**:
  - `priority-guide.md` - Test creation order and priorities
  - `success-criteria.md` - Coverage thresholds and quality gates

## Remember

1. **Read documentation before writing tests**:
   - `../../.instructions/ROOT-CAUSE-ANALYSIS-TESTING-CYCLE.md` - **CRITICAL**: Understand systemic solutions
   - `gotchas.md` - Avoid common pitfalls (includes Week 3 lint/type cycle solution)
   - `LINTING-ANALYSIS.md` - ESLint config and prevention measures
   - `PRE-COMMIT-CHECKLIST.md` - Validation requirements

2. **Use shared mock types** (Week 3 breakthrough - prevents recurring issues):
   - Import from `tests/types/mocks.ts` (MockHeaders, MockSession, delayed)
   - Import from `tests/helpers/assertions.ts` (assertDefined, assertHasProperty)
   - **Never create inline incomplete mocks** - always use factory functions

3. **Always fetch docs from Context7** before generating tests

4. **Follow Arrange-Act-Assert** pattern with comments

5. **Test behavior, not implementation**

6. **Mock at boundaries** (database, auth, external APIs)

7. **Use real data for integration tests** (Testcontainers)

8. **Reset mocks between tests** (`vi.restoreAllMocks()`)

9. **Coverage is a guide, not a goal** - focus on critical paths

10. **Define response type interfaces** for type-safe assertions

11. **Validate before completion**:
    - ✅ Tests pass
    - ✅ Linting clean (0 errors, 0 warnings)
    - ✅ Type-check clean (0 errors)
    - ✅ Coverage targets met

12. **ESLint rules are configured for tests** - `unbound-method`, `require-await`, and type-safety rules disabled

## Next Steps

After creating tests:

1. Run tests and ensure they pass
2. Check coverage meets thresholds
3. Document any new patterns discovered
4. Update `.context/testing/` documentation if needed
5. Commit tests with descriptive messages

Good luck! 🧪
