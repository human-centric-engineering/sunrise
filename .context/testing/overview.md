# Testing Overview

Comprehensive testing documentation for the Sunrise project. This guide provides the philosophy, tech stack rationale, and test types for AI developers contributing to the codebase.

## Testing Philosophy

1. **Example-Driven**: Tests serve as examples of best practices, not exhaustive coverage
2. **Quality over Quantity**: Well-crafted tests that demonstrate patterns
3. **Independence**: Each test is independent and can run in any order
4. **Clarity**: Test names explain what is being tested and why
5. **Pragmatism**: Mock external dependencies, test real logic

## Tech Stack

### Vitest

**Chosen for**:

- **Performance**: Native ESM support, parallel execution, instant HMR
- **Vite Integration**: Seamless integration with Vite/Next.js build pipeline
- **Modern API**: Compatible with Jest API but faster and lighter
- **TypeScript**: First-class TypeScript support without additional config

### React Testing Library

**Chosen for**:

- **User-Centric**: Tests components from user perspective
- **Best Practices**: Encourages accessible, semantic HTML
- **Framework Agnostic**: Works with any React framework (Next.js, Remix, etc.)
- **Query Priorities**: Promotes accessible queries (byRole, byLabelText)

### Testcontainers (Future)

**Chosen for**:

- **Production Parity**: Real PostgreSQL in tests, not SQLite or mocks
- **Isolation**: Each test suite gets fresh database container
- **Portability**: Works locally and in CI without external dependencies
- **Confidence**: Integration tests match production behavior

Currently, integration tests use mocked database dependencies for speed. Testcontainers will be added for critical integration test scenarios.

## Test Types

### Unit Tests (`tests/unit/`)

Tests for individual functions and modules in isolation. External dependencies are mocked.

**When to write unit tests**:

- Pure functions (validation schemas, utilities, formatters)
- Complex algorithms (password strength, scoring, calculations)
- API utilities (response formatting, error handling, pagination)
- Authentication logic (session management, role checking)
- Business logic (rules, transformations, validators)

**Example**:

```typescript
describe('passwordSchema', () => {
  it('should accept valid password', () => {
    const result = passwordSchema.parse('Test@123');
    expect(result).toBe('Test@123');
  });

  it('should reject password without uppercase', () => {
    expect(() => passwordSchema.parse('test@123')).toThrow(
      'must contain at least one uppercase letter'
    );
  });
});
```

### Integration Tests (`tests/integration/`)

Tests that verify multiple components working together. Use real implementations where practical, mock external boundaries (database, APIs).

**When to write integration tests**:

- API endpoints (request → validation → business logic → response)
- Database operations (queries, transactions, migrations)
- Authentication flows (login → session → protected route)
- Multi-component interactions

**Example**:

```typescript
describe('GET /api/health', () => {
  it('should return healthy status with database connection', async () => {
    // Mock database health check
    vi.mocked(getDatabaseHealth).mockResolvedValue({
      connected: true,
      latency: 5,
    });

    const response = await GET();
    const body = await parseResponse<HealthResponse>(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.database.connected).toBe(true);
  });
});
```

### Component Tests (`tests/components/` - future)

Tests for React components using React Testing Library. Verify user interactions, rendering, and accessibility.

**When to write component tests**:

- Forms with validation
- Interactive UI components
- Error boundaries
- Conditional rendering logic

**Example**:

```typescript
describe('LoginForm', () => {
  it('should show error message on invalid email', async () => {
    render(<LoginForm />);

    const emailInput = screen.getByLabelText(/email/i);
    await userEvent.type(emailInput, 'invalid-email');

    const submitButton = screen.getByRole('button', { name: /sign in/i });
    await userEvent.click(submitButton);

    expect(screen.getByText(/invalid email/i)).toBeInTheDocument();
  });
});
```

## Coverage Philosophy

- **80%+ overall coverage**: Aim for meaningful coverage, not 100%
- **90%+ for critical paths**: Authentication, validation, security functions must be well-tested
- **Focus on behavior**: Coverage is a guide, not a goal
- **Test what matters**: Don't test framework code, focus on business logic

**Coverage is meaningful when**:

- Tests verify real-world scenarios
- Edge cases are covered
- Error handling is tested
- Tests would catch regressions

**Coverage is not meaningful when**:

- Tests exist just to hit percentage targets
- Tests mock everything and verify nothing
- Tests are brittle and break on refactors

## Quick Reference

**See also**:

- [`patterns.md`](./patterns.md) - Best practices and patterns (AAA, type safety, async, mocking)
- [`mocking.md`](./mocking.md) - Mock strategies by dependency (Prisma, better-auth, Next.js, logger)
- [`decisions.md`](./decisions.md) - Architectural decisions and rationale
- [`history.md`](./history.md) - Key learnings and solutions (lint/type cycle prevention)

**Commands**:

```bash
npm test                  # Run all tests
npm run test:watch        # Watch mode for development
npm run test:coverage     # Run with coverage report
npm run validate          # Type-check + lint + format check
```

**Directories**:

- `tests/unit/` - Unit tests (majority of tests)
- `tests/integration/` - Integration tests (API route tests)
- `tests/helpers/` - Test utilities (assertions, mocks, factories)
- `tests/types/` - Shared type definitions (MockHeaders, MockSession)

**For detailed testing workflows, see** [`.claude/skills/testing/`](../../.claude/skills/testing/).
