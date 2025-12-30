# Testing Architectural Decisions

Key architectural decisions and rationale for the Sunrise testing infrastructure.

## Technology Choices

### Vitest over Jest

**Decision**: Use Vitest as the primary testing framework.

**Rationale**: Vitest provides native ESM support with instant hot module replacement, seamless integration with Vite/Next.js build pipeline, and superior performance through parallel test execution. The API is compatible with Jest for easy migration, but significantly faster and lighter weight. First-class TypeScript support eliminates additional configuration overhead.

### React Testing Library

**Decision**: Use React Testing Library for component testing.

**Rationale**: Encourages testing from the user's perspective rather than implementation details, promoting accessible and semantic HTML. Framework-agnostic design works seamlessly with Next.js App Router and Server Components. Query priorities (byRole, byLabelText) naturally guide developers toward accessible component design.

### Testcontainers for Integration Tests

**Decision**: Use Testcontainers with real PostgreSQL for integration tests (not currently implemented, reserved for future critical scenarios).

**Rationale**: Real database containers ensure production parity, eliminating SQLite compatibility issues and mock-related false positives. Each test suite gets an isolated container with automatic cleanup, ensuring tests remain portable across local development and CI environments without external dependencies.

**Current State**: Integration tests use mocked database dependencies for speed. Testcontainers will be added selectively for critical integration test scenarios requiring database-level behavior validation.

---

## Code Quality Decisions

### Shared Mock Type Factories

**Decision**: All mock type definitions (Headers, Session, PrismaPromise) must use centralized factory functions from `tests/types/mocks.ts`.

**Rationale**: Incomplete inline mock type definitions create a recurring lint/type error cycle where fixing linting issues breaks type-checking and vice versa. Centralized factories (`createMockHeaders()`, `createMockSession()`, `delayed()`) provide complete type implementations, eliminating the whack-a-mole effect between linting and type-checking. This solved a systemic issue that recurred across multiple testing phases.

**Implementation**: Import from `@/tests/types/mocks` instead of creating inline mocks. See `.context/testing/history.md` for problem summary.

### Type-Safe Assertion Helpers

**Decision**: Use type guard assertion helpers from `tests/helpers/assertions.ts` instead of non-null assertions or direct property access.

**Rationale**: Helper functions like `assertDefined()` and `assertHasProperty()` provide TypeScript type narrowing with better error messages than `!` non-null assertions. This eliminates "possibly undefined" errors while maintaining type safety and debuggability.

**Examples**:

- `assertDefined(value)` - Type guard for optional properties
- `assertHasProperty(obj, 'prop')` - Type guard for property existence
- `parseJSON<T>(response)` - Type-safe response parsing

---

## ESLint Configuration Decisions

All test-specific ESLint rules are configured in `eslint.config.mjs` under the test file overrides section.

### Disable `@typescript-eslint/require-await`

**Decision**: Disabled for all test files (`**/*.test.{ts,tsx}`, `**/*.spec.{ts,tsx}`, `**/tests/**/*.{ts,tsx}`).

**Rationale**: Vitest test functions often use helper functions that internally `await`, or matchers like `expect().rejects.toThrow()` where the `async` keyword appears "unused" to ESLint. Auto-fix removing `async` breaks tests with "await only valid in async function" errors. Disabling this rule prevents silent test breakage during linting.

### Disable `@typescript-eslint/unbound-method`

**Decision**: Disabled for all test files.

**Rationale**: This rule flags Vitest mock assertions as unsafe (e.g., `expect(vi.mocked(logger.error)).toHaveBeenCalled()`), even though they are perfectly safe and match the official Vitest documentation patterns. Vitest mocks don't require `this` binding. This is a false positive that would force verbose workarounds for standard testing patterns.

### Allow `any` and Unsafe Type Operations

**Decision**: Disabled `@typescript-eslint/no-explicit-any`, `no-unsafe-argument`, `no-unsafe-assignment`, `no-unsafe-call`, `no-unsafe-member-access`, and `no-unsafe-return` for test files.

**Rationale**: Type workarounds are necessary for complex mock types (Headers, Session, PrismaPromise) that don't have perfect TypeScript representations in test contexts. Tests prioritize runtime behavior validation over strict compile-time type checking. Strategic use of `any` in mocks (e.g., `as any`) is documented and confined to test files only.

**Balance**: While these rules are disabled for tests, production code maintains strict type checking. Use shared mock type factories to minimize `any` usage even in tests.

### Allow Console in Tests

**Decision**: Disabled `no-console` for test files.

**Rationale**: Console output is useful for local debugging and test development. Test output is not part of production bundles, so console statements have no runtime impact.

---

## TypeScript Configuration

### Strict Mode Enabled

**Decision**: TypeScript strict mode enabled in tests (`tsconfig.json`), matching production code standards.

**Rationale**: Tests should maintain the same type safety as production code to catch type errors early. Strict mode ensures proper null/undefined handling, type inference, and binding checks. ESLint overrides handle test-specific patterns that would be too strict (like `any` in mocks), but core type safety remains intact.

---

## Test Directory Structure

### Organized by Test Type

**Decision**: Tests are organized in `tests/unit/`, `tests/integration/`, `tests/helpers/` directories, mirroring source code structure within each.

**Rationale**: Clear separation by test type makes it easy to run specific test suites (unit vs integration) and understand test scope at a glance. Mirroring source structure within each directory (e.g., `tests/unit/lib/db/utils.test.ts` mirrors `lib/db/utils.ts`) simplifies navigation and makes test location predictable.

**Structure**:

```
tests/
├── unit/                    # Fast, isolated tests with mocked dependencies
│   ├── lib/                 # Mirrors lib/ structure
│   ├── app/api/             # Mirrors app/api/ structure
│   └── components/          # Mirrors components/ structure
├── integration/             # Tests with real implementations at boundaries
│   └── api/                 # API endpoint integration tests
├── helpers/                 # Shared test utilities
│   └── assertions.ts        # Type-safe assertion helpers
└── types/                   # Shared test type definitions
    └── mocks.ts             # Mock type factories
```

### Future: Component Tests

**Decision**: Component tests will be added to `tests/components/` when UI testing is implemented.

**Rationale**: Separate directory for React Testing Library component tests keeps them distinct from unit and integration tests. Component tests have different execution patterns (JSDOM, rendering, user events) and benefit from isolation.

---

## Coverage Strategy

### Target 80%+ Overall, 90%+ Critical Paths

**Decision**: Aim for 80%+ overall code coverage, with 90%+ coverage for critical paths (authentication, validation, security functions).

**Rationale**: Coverage is a guide, not a goal. Meaningful coverage comes from testing real-world scenarios, edge cases, and error handling. 100% coverage often includes diminishing returns (testing framework code, trivial getters). Focus coverage efforts on high-risk areas where bugs have the most impact.

**What to Prioritize**:

- Authentication and authorization logic (session management, role checks)
- Input validation and sanitization (Zod schemas, XSS prevention)
- Security functions (password hashing, token generation)
- Business logic with complex branching
- Error handling paths

**What to Skip**:

- Framework boilerplate (Next.js route handlers)
- Simple getters/setters
- Type definitions and interfaces
- Third-party library code

---

## Related Documentation

- **History**: See `.context/testing/history.md` for brief summary of key learnings
- **Patterns**: See `.context/testing/patterns.md` for implementation best practices
- **Mocking**: See `.context/testing/mocking.md` for dependency mocking strategies
- **ESLint Config**: See `eslint.config.mjs` for complete test file overrides
