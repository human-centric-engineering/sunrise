# Testing Patterns for Sunrise

Best practices and proven patterns for writing tests in the Sunrise project.

## Quick Navigation

| Topic             | File                                   | Description                               |
| ----------------- | -------------------------------------- | ----------------------------------------- |
| **Overview**      | This file                              | Test structure, AAA pattern, organization |
| **Mocking**       | [mocking.md](./mocking.md)             | Mock strategies by dependency             |
| **Async Testing** | [async-testing.md](./async-testing.md) | Async functions, fake timers              |
| **Type Safety**   | [type-safety.md](./type-safety.md)     | Response types, assertion helpers         |
| **Edge Cases**    | [edge-cases.md](./edge-cases.md)       | Error testing, parameterized tests        |

---

## Test File Structure

### Standard Template

Every test file should follow this structure:

```typescript
/**
 * [Module Name] Tests
 *
 * Brief description of what's being tested
 *
 * Test Coverage:
 * - Feature 1
 * - Feature 2
 * - Edge cases and error handling
 *
 * @see [path to source file]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { functionToTest } from '@/lib/module';

/**
 * Mock dependencies (if needed)
 */
vi.mock('@/lib/dependency', () => ({
  dependency: vi.fn(),
}));

/**
 * Test Suite: [High-Level Feature]
 *
 * Description of what this suite covers
 */
describe('[Module/Function Name]', () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore mocks after each test
    vi.restoreAllMocks();
  });

  describe('[specific feature]', () => {
    it('should [expected behavior] when [condition]', () => {
      // Arrange: Set up test data
      const input = createTestData();

      // Act: Execute the function
      const result = functionToTest(input);

      // Assert: Verify outcome
      expect(result).toEqual(expectedOutput);
    });
  });
});
```

---

## Arrange-Act-Assert Pattern

### Always Use AAA Comments

```typescript
// EXCELLENT - Clear sections
it('should parse pagination parameters correctly', () => {
  // Arrange: Create URLSearchParams with custom values
  const searchParams = new URLSearchParams('page=3&limit=50');

  // Act: Parse the parameters
  const result = parsePaginationParams(searchParams);

  // Assert: Verify correct calculation
  expect(result).toEqual({
    page: 3,
    limit: 50,
    skip: 100, // (3-1) * 50
  });
});

// GOOD - Inline comments for simple tests
it('should default to page 1', () => {
  const searchParams = new URLSearchParams(''); // Arrange
  const result = parsePaginationParams(searchParams); // Act
  expect(result.page).toBe(1); // Assert
});

// AVOID - No structure (hard to understand)
it('should work', () => {
  const searchParams = new URLSearchParams('page=0');
  const result = parsePaginationParams(searchParams);
  expect(result.page).toBe(1);
});
```

---

## Test Organization

### Grouping by Feature

```typescript
describe('handleAPIError', () => {
  describe('APIError handling', () => {
    it('should handle APIError with all properties', async () => { ... });
    it('should handle ValidationError', async () => { ... });
    it('should handle UnauthorizedError', async () => { ... });
  });

  describe('Zod validation error handling', () => {
    it('should transform Zod error with single field error', async () => { ... });
    it('should transform Zod error with multiple field errors', async () => { ... });
  });

  describe('Prisma error handling', () => {
    describe('P2002 - Unique constraint violation', () => {
      it('should handle unique constraint on email field', async () => { ... });
      it('should handle unique constraint on username field', async () => { ... });
    });

    describe('P2025 - Record not found', () => {
      it('should handle record not found error', async () => { ... });
    });
  });
});
```

### Descriptive Test Names

```typescript
// EXCELLENT - Explains scenario and outcome
it('should return 400 status code for validation errors', async () => { ... });
it('should include field-specific errors in response details', async () => { ... });
it('should log error with correct context in production mode', () => { ... });

// GOOD - Clear and specific
it('should validate email format', () => { ... });
it('should reject password without uppercase', () => { ... });

// AVOID - Vague or unclear
it('works', () => { ... });
it('handles errors', () => { ... });
it('test validation', () => { ... });
```

---

## Setup and Teardown

### beforeEach and afterEach

```typescript
describe('API Error Handling', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Set default environment
    (env as { NODE_ENV: string }).NODE_ENV = 'development';
  });

  afterEach(() => {
    // Restore all mocks after each test
    vi.restoreAllMocks();

    // CRITICAL for fake timer tests
    vi.useRealTimers();
  });

  it('should log error', () => {
    // Test runs with fresh mocks
  });
});
```

### Test-Specific Setup

```typescript
describe('environment-aware behavior', () => {
  it('should include details in development', async () => {
    // Arrange: Override default environment for this test
    (env as { NODE_ENV: string }).NODE_ENV = 'development';

    // Act
    const response = handleAPIError(error);
    const body = await parseErrorResponse(response);

    // Assert
    expect(body.error.details).toBeDefined();
  });

  it('should exclude details in production', async () => {
    // Arrange: Set production for this test
    (env as { NODE_ENV: string }).NODE_ENV = 'production';

    // Act
    const response = handleAPIError(error);
    const body = await parseErrorResponse(response);

    // Assert
    expect(body.error.details).toBeUndefined();
  });
});
```

---

## Summary

**Key Testing Patterns**:

1. **Structure**: Use consistent file structure with documentation headers
2. **AAA**: Always include Arrange-Act-Assert comments
3. **Shared Mocks**: Use factories from `tests/types/mocks.ts`
4. **Type Guards**: Use helpers from `tests/helpers/assertions.ts`
5. **Organization**: Group related tests with nested `describe` blocks
6. **Descriptive Names**: Test names should explain scenario and expected outcome

**Test Quality Metrics**:

- Every test should be independent (no shared state)
- Every test should be deterministic (same input = same output)
- Every test should be fast (< 100ms for unit tests)
- Every test should have a clear purpose (test one behavior)

**Before Writing Tests**:

1. Read `.context/testing/` documentation for comprehensive guidance
2. Import shared mock factories from `tests/types/mocks.ts`
3. Import assertion helpers from `tests/helpers/assertions.ts`
4. Review `.claude/skills/testing/gotchas.md` for critical issues to avoid
5. Set up proper mocks in `beforeEach`
6. Use AAA pattern with comments

**Related Documentation**:

- [Testing Overview](./overview.md) - Testing philosophy and tech stack
- [Mocking Strategies](./mocking.md) - Dependency mocking strategies
- [Async Testing](./async-testing.md) - Async functions and fake timers
- [Type Safety](./type-safety.md) - Type-safe testing patterns
- [Edge Cases](./edge-cases.md) - Error testing and parameterized tests
- [Testing Decisions](./decisions.md) - Architectural rationale
- [Testing History](./history.md) - Key learnings and solutions
- `.claude/skills/testing/gotchas.md` - Common pitfalls and solutions
