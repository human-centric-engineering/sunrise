# Sunrise Test Suite

Quick reference for running tests. For comprehensive documentation, see [`.context/testing/`](../.context/testing/).

## Commands

```bash
npm test                 # Run all tests
npm run test:watch       # Watch mode (recommended during development)
npm run test:coverage    # Generate coverage report
npm run test:ui          # Run with Vitest UI
npm run validate         # Type-check + lint + tests (before committing)
```

## Directory Structure

```
tests/
├── setup.ts                 # Global test setup
├── helpers/                 # Shared test utilities
│   └── assertions.ts        # Type-safe assertion helpers
├── types/                   # Mock type definitions
│   └── mocks.ts             # Mock factories (createMockHeaders, createMockSession)
├── unit/                    # Unit tests
│   ├── auth/                # Authentication
│   ├── validations/         # Zod schemas
│   ├── api/                 # API responses
│   └── ...
└── integration/             # Integration tests
    └── api/                 # API endpoint tests
```

## Quick Patterns

```typescript
// Always import shared mocks
import { createMockHeaders, createMockSession } from '@/tests/types/mocks';
import { assertDefined, parseJSON } from '@/tests/helpers/assertions';

// AAA pattern
it('should do something', () => {
  // Arrange
  const input = { name: 'Test' };

  // Act
  const result = functionUnderTest(input);

  // Assert
  expect(result).toEqual({ success: true });
});
```

## Further Reading

- [Testing Overview](../.context/testing/overview.md) — Philosophy, tech stack
- [Patterns](../.context/testing/patterns.md) — Best practices, examples
- [Mocking](../.context/testing/mocking.md) — Dependency mocking strategies
- [Gotchas](../.claude/skills/testing/gotchas.md) — Common problems and solutions
