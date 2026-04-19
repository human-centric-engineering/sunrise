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

**Environment**: Uses `happy-dom` for fast DOM testing (configured in `vitest.config.ts`). Happy-dom is a lightweight alternative to jsdom with better performance for most testing scenarios.

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

### Smoke Scripts (`scripts/smoke/`)

Standalone `tsx` scripts that exercise a production code path end-to-end against the **real dev Postgres database**, with external services (LLM APIs, email, third-party SDKs) stubbed in-process. They sit between unit tests (everything mocked) and manual QA (everything real), catching plumbing failures that slip past vitest — stale module caches, import paths, fire-and-forget side effects, Prisma FK chains.

**When to write one**:

- After landing a slice that crosses service → Prisma → external SDK layers
- When the live wire-up (module cache, import bindings) is hard to cover inside vitest
- When you need to demonstrate persistence actually lands in Postgres, not just that `prisma.foo.create` was called

**Safety rules** (non-negotiable — the dev DB has data the user cares about):

- Scope every row by a `smoke-test-*` prefix
- Clean up stale rows before seeding AND after running
- Never use `deleteMany({})`, `TRUNCATE`, or `prisma migrate reset`
- Stub external services via an in-process injection seam (e.g. `registerProviderInstance`)

**Examples**:

- `scripts/smoke/chat.ts` — streaming chat handler, stubs `LlmProvider` via `registerProviderInstance`. Runs in-process (no dev server required).
- `scripts/smoke/orchestration.ts` — Phase 3 admin orchestration HTTP surface. Spins up an in-process mock OpenAI-compatible server (`/v1/chat/completions` JSON + SSE, `/v1/embeddings`), signs up a throwaway admin, exercises providers / agents / capabilities / workflows / chat stream / knowledge upload + search / evaluations / conversations / costs end-to-end against the **running dev server** and real Postgres.

```bash
npm run smoke:chat           # no dev server needed
npm run smoke:orchestration  # requires `npm run dev` running
```

Full guide and template: [`scripts/smoke/README.md`](../../scripts/smoke/README.md).

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

## Global Test Setup

The global test setup file (`tests/setup.ts`) runs before all tests and configures:

1. **Environment Variables**: Sets required env vars (`DATABASE_URL`, `BETTER_AUTH_SECRET`, etc.) before any imports to satisfy validation
2. **Next.js Mocks**: Pre-mocks `next/navigation` and `next/headers` for component testing
3. **Analytics Mocks**: Mocks analytics hooks to allow component testing without providers
4. **Cleanup**: Restores all mocks in `afterEach` to prevent test pollution

**Key setup features**:

```typescript
// Environment variables set BEFORE imports (critical for lib/env.ts validation)
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
// ... other required vars

// Global mocks for Next.js
vi.mock('next/navigation', () => ({ useRouter: vi.fn(() => ({ push: vi.fn(), ... })) }));
vi.mock('next/headers', () => ({ cookies: vi.fn(), headers: vi.fn() }));

// Cleanup after each test
afterEach(() => { vi.restoreAllMocks(); });
```

Tests can override these mocks per-file using `vi.mock()` at the top of the test file.

## Testing Workflow Commands

Use these commands to plan, write, review, and verify tests. All default to branch diff mode but accept file/folder paths.

The commands break down into three jobs — pick the one that matches the situation:

- **Floor** (ongoing): `/test-triage` graders + `/test-fix from-rescan` for legacy green-bar cleanup.
- **Ceiling** (one-shot, critical modules): `/test-coverage` → `/test-plan coverage` → `/test-write plan` → `/test-review` → `/test-fix`.
- **Gate** (every PR): `/test-review` (branch diff) or `/test-review pr` (posts GitHub comment).

| Command          | Purpose                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `/test-plan`     | Analyze code and produce a phased, prioritized test plan with agent batching                                                |
| `/test-write`    | Execute a plan by spawning test-engineer subagents (create, add, rewrite tests)                                             |
| `/test-review`   | Confidence-scored quality report (filter ≥80). Writes `.reviews/tests-{slug}.md`. `pr` mode posts a GitHub PR comment.      |
| `/test-fix`      | Apply findings from a `.reviews/tests-{slug}.md` report (`--all` or `--findings=N,N,N`). Second mode: `from-rescan <file>`. |
| `/test-coverage` | Find coverage gaps, untested files, and below-threshold modules                                                             |
| `/test-triage`   | Grade test files (Clean/Minor/Bad/Rotten) against a persistent ledger                                                       |

### Example Flows

**PR gate** (most common — every branch before merge):

```bash
/test-review               # Branch diff → .reviews/tests-branch-{name}.md
/test-fix --all            # Apply every finding ≥80 from the latest report
# Or: /test-fix --findings=1,3,5  # Pick specific findings
# Or: /test-review pr              # Post a PR comment (silent if no findings ≥80)
```

`/test-review` is diagnostic — the human (or PR reviewer) judges what to action. `/test-fix` does not re-audit after applying; rerun `/test-review` only if the source changed or on the next PR.

**Add tests for branch changes** (no existing tests yet):

```bash
/test-plan           # Analyze branch diff → phased plan
/test-write plan     # Execute Sprint 1
/test-review         # Audit quality
/test-fix --all      # Apply findings ≥80
```

**Ceiling pass** (one-shot on a critical module):

```bash
/test-coverage lib/auth        # Scoped scan → categorized gaps
/test-plan coverage lib/auth   # Produce phased plan
/test-write plan all           # Execute all sprints
/test-review lib/auth          # Audit quality
/test-fix --all                # Apply findings ≥80
```

**Fill repo-wide coverage gaps**:

```bash
/test-coverage              # Full repo scan → categorized gaps
/test-plan coverage         # Multi-sprint plan from coverage findings
/test-write plan            # Execute Sprint 1 (security-critical)
/test-write plan sprint 2   # Execute Sprint 2 (business logic)
```

**Codebase-wide remediation (Floor)** — legacy green-bar cleanup:

```bash
/test-triage scan <folder>        # Grade files, write to ledger (--all to re-scan reviewed files)
/test-triage worklist             # See prioritised queue (Rotten first)
/test-triage fix <file>           # Print fix paths (Path 0: annotate, A: rescan, B: full review)
/test-fix from-rescan <file>      # Path A: apply ledger NOTES directly (Minor/Bad files)
/test-triage rescan <file>        # Re-grade after fix
```

Both `scan` and `worklist` accept `--type=unit|integration` to filter by test type.

For Rotten files or vague NOTES, escalate to `/test-review <file>` → `/test-fix --all`.

**Quick test for 1-2 files** (skips planning):

```bash
/test-write lib/auth/guards.ts   # Inline plan + execute
```

### How Commands Chain

`/test-review` writes a **confidence-scored report** to `.reviews/tests-{slug}.md`: 5 parallel Sonnet agents score findings 0–100, filter ≥80, and the user picks what to action with `/test-fix`. There is no auto-loop.

```
# Gate (PR / branch review)
/test-review [scope|pr]      → .reviews/tests-{slug}.md  → /test-fix --all | --findings=N,N,N

# Ceiling (build out a critical module)
/test-coverage <scope>       → /test-plan coverage       → /test-write plan  → /test-review → /test-fix

# Floor (codebase-wide remediation)
/test-triage scan / rescan   → ledger NOTES              → /test-fix from-rescan <file>
```

**Always pass the same scope to `/test-review` as you passed to `/test-coverage` at the start.** Without a scope, `/test-review` defaults to branch diff mode, which will find nothing if no source files changed on the branch.

`/test-plan` is the planning hub for coverage-driven work. `/test-write` is purely an executor. `/test-review` and `/test-coverage` are analysis tools; `/test-fix` consumes review reports directly (no plan step needed for branch-scoped quality fixes).

### Command Definitions

Commands are defined in `.claude/commands/`:

- `test-plan.md` — full planning logic, priority system, sprint design
- `test-write.md` — plan execution, agent batching, progress tracking
- `test-review.md` — confidence-scored quality report (5 parallel Sonnet agents, ≥80 filter, `pr` mode)
- `test-fix.md` — review applier (`--all` / `--findings=N,N,N`) + `from-rescan` mode for ledger NOTES
- `test-coverage.md` — gap analysis, module-specific thresholds, categorization
- `test-triage.md` — ledger-driven grading for codebase-wide remediation

The test-engineer agent (`.claude/agents/test-engineer.md`) is spawned by `/test-write` — don't invoke it directly.

## Quick Reference

**See also**:

- [`patterns.md`](./patterns.md) - Best practices and patterns (AAA, type safety, async, mocking)
- [`mocking.md`](./mocking.md) - Mock strategies by dependency (Prisma, better-auth, Next.js, logger)
- [`decisions.md`](./decisions.md) - Architectural decisions and rationale
- [`history.md`](./history.md) - Key learnings and solutions (lint/type cycle prevention)

**npm Commands**:

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

**For testing skill patterns, see** [`.claude/skills/testing/`](../../.claude/skills/testing/).
