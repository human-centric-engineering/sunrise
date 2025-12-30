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
6. **Update documentation**: If new patterns emerge, document in `.context/testing/`

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

**See `.context/testing/` for comprehensive documentation**:

- **overview.md** - Testing philosophy, tech stack, test types
- **patterns.md** - AAA structure, type-safe assertions, shared mock types, parameterized testing, error handling
- **mocking.md** - Mock strategies by dependency (Prisma, better-auth, Next.js, logger)
- **decisions.md** - Architectural rationale and ESLint rule decisions
- **history.md** - Key learnings and solutions (lint/type cycle prevention)

**Quick Reference**:

```typescript
// Import shared mock factories (CRITICAL - prevents lint/type cycles)
import { createMockHeaders, createMockSession, delayed } from '@/tests/types/mocks';

// Import type-safe assertion helpers
import { assertDefined, assertHasProperty, parseJSON } from '@/tests/helpers/assertions';
```

**Test Templates**: See `templates/` subdirectory for code examples by complexity:

- `simple.md` - Validation schema tests
- `medium.md` - API utility tests
- `complex.md` - Integration tests
- `component.md` - React component tests

## Related Documentation

**Context Documentation** (evergreen patterns and rationale):

- `.context/testing/overview.md` - Testing philosophy and tech stack
- `.context/testing/patterns.md` - Best practices and code patterns
- `.context/testing/mocking.md` - Dependency mocking strategies
- `.context/testing/decisions.md` - Architectural rationale
- `.context/testing/history.md` - Key learnings and solutions

**Skill Execution Files** (workflow and troubleshooting):

- `gotchas.md` - Common pitfalls and solutions
- `priority-guide.md` - Test creation order and priorities
- `success-criteria.md` - Coverage thresholds and quality gates
- `templates/` - Code examples by complexity (simple, medium, complex, component)

**Shared Code** (import in tests):

- `tests/types/mocks.ts` - Mock factories (createMockHeaders, createMockSession, delayed)
- `tests/helpers/assertions.ts` - Type guards (assertDefined, assertHasProperty, parseJSON)
