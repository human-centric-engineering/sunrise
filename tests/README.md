# Sunrise Test Suite

Quick reference for running tests. For comprehensive documentation, see [`.context/testing/`](../.context/testing/).

## Commands

```bash
npm run test:changed          # Tests this branch affects + whole-tree guards
npm run test:changed:coverage # ...and gate coverage per changed file (≥80% each)
npm test                      # Full suite
npm run test:watch            # Watch mode (recommended during development)
npm run test:coverage         # Full suite with a whole-repo coverage report
npm run test:ui               # Run with Vitest UI
npm run validate              # all local gates (before committing)
```

The scoped pair is the everyday one and what `/pre-pr` runs; reach for the full
suite after merging `main`, before a release, or when you want the whole
picture. See [`.context/testing/scoped-runs.md`](../.context/testing/scoped-runs.md).

## Directory Structure

```
tests/
├── setup.ts                 # Global test setup
├── helpers/                 # Shared test utilities
│   ├── auth.ts              # Session mocks (the most-used helper, 214 importers)
│   ├── api.ts               # Request builders
│   ├── assertions.ts        # Type-safe assertion helpers
│   ├── email.ts             # sendEmail mock configuration
│   ├── no-binary-persistence.ts   # Shared "bytes must not be persisted" core
│   ├── no-attachment-persistence.ts
│   ├── no-audio-persistence.ts
│   └── ...                  # epub-fixture, mock-tracer, seed-capabilities, mocks
├── types/                   # Mock type definitions
│   └── mocks.ts             # Mock factories (createMockRouter, createMockUser, …)
├── mocks/                   # Module-level stubs
├── unit/                    # Mirrors the source tree one-for-one
│   ├── app/                 # Route handlers, pages
│   ├── components/          # Component tests
│   ├── lib/                 # Library/utility tests
│   ├── emails/              # React Email templates
│   ├── prisma/              # Schema and seed-unit tests
│   ├── scripts/             # CI and tooling scripts
│   ├── helpers/             # Tests for the helpers above
│   ├── setup/               # Tests for setup.ts itself
│   └── types/
└── integration/             # Handler + collaborators, mocked at the module edge
    ├── api/                 # API endpoint tests
    ├── app/                 # Server component / page integration
    ├── orchestration/       # Engine, workflows, capabilities
    └── storage/             # Upload and storage flows
```

There is no test database. "Integration" means the handler runs end to end with
its collaborators mocked at the module edge — 124 of the 175 files under
`integration/` mock `@/lib/db/client`.

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
