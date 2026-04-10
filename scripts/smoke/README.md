# Smoke Scripts

Standalone scripts that exercise a production code path **end-to-end against the real dev database**, with external dependencies (LLM APIs, email providers, third-party services) stubbed in-process. They fill the gap between unit tests (fast, everything mocked) and integration tests (slower, still inside vitest) — proving that a slice actually wires up correctly across the import boundary, module cache, and Prisma client.

**When to write one:** after landing a non-trivial slice that crosses multiple layers (service → Prisma → external SDK), especially if the live wire-up is hard to cover in vitest. Unit tests prove the logic; smoke scripts prove the plumbing.

**When NOT to write one:** for pure functions, single-file utilities, or anything already fully covered by unit + integration tests. These scripts exist to catch integration drift, not to replace the test pyramid.

## Running

Each script has an `npm run smoke:<slice>` entry in `package.json`:

```bash
npm run smoke:chat       # Phase 2c streaming chat handler
```

Or directly:

```bash
npx tsx --env-file=.env.local scripts/smoke/<slice>.ts
```

Scripts read `.env.local` for `DATABASE_URL` and any live credentials they need. They should **never** require env vars beyond what's already documented in `.context/environment/`.

## Safety rules

These are the non-negotiables. Break one and you risk trashing the dev database.

1. **Scope every row by a unique prefix.** Use `smoke-test-<slice>-<field>` (e.g. `smoke-test-agent` slug, `smoke-test-provider` name). Never use generic slugs like `test` or `demo` that might collide with real seed data.

2. **Clean up in both directions.** Before seeding, delete any stale rows from a previous run (`findUnique → delete`). After running, delete only the rows the script created — scoped by the prefix or by the id returned from the create call. **Never use `deleteMany({})` or truncate anything.**

3. **Never run destructive DB commands.** No `prisma migrate reset`, no `db push --force-reset`, no `TRUNCATE`. The dev DB contains data the user cares about.

4. **Stub external services in-process.** LLM calls, email sends, S3 uploads — anything that costs money, sends real messages, or has side effects outside Postgres must be stubbed. Each orchestration slice exposes an injection seam for this (e.g. `registerProviderInstance` in `lib/orchestration/llm/provider-manager.ts`). If a slice doesn't have one, add it before writing the smoke script.

5. **Fail loudly, exit non-zero.** On any unexpected state, log the reason and `process.exit(1)`. A smoke script is only useful if it's obvious when it's broken.

6. **Idempotent.** Running the same script twice in a row should succeed both times. A stale-row cleanup step at the top is the usual way.

## Structure

Every smoke script follows the same shape:

```typescript
/**
 * <Slice name> smoke script (`lib/<path>`)
 *
 * <One paragraph: what code path this exercises, what it stubs.>
 *
 * Flow:
 *   1. Stub external dependencies
 *   2. Seed scoped rows
 *   3. Run the code under test
 *   4. Verify observable outputs (events, persisted rows, side effects)
 *   5. Clean up
 *
 * Safety: <which rows are scoped, what stays untouched>
 *
 * Run with: npm run smoke:<slice>
 */

import { prisma } from '@/lib/db/client';
// ... imports from the code under test

async function main(): Promise<void> {
  // 1. Resolve any required real rows (user, etc.)
  // 2. Clean up stale smoke-test rows from previous runs
  // 3. Seed scoped rows
  // 4. Stub externals
  // 5. Execute
  // 6. Verify by re-querying
  // 7. Clean up
}

main().catch(async (err) => {
  console.error('\n✗ smoke script failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
```

Prefer numbered `[n] description` stdout markers over ad-hoc logging — it makes the script readable as a living run-book.

## Current scripts

| Script    | Exercises                              | Stubs                                        | Notes                                                                                                                                            |
| --------- | -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat.ts` | `streamChat` → tool loop → persistence | `LlmProvider` via `registerProviderInstance` | Verifies event sequence, `AiMessage` + `AiCostLog` writes, and budget check. Doesn't exercise the tool loop live (needs seeded capability rows). |

## Adding a new smoke script

1. Create `scripts/smoke/<slice>.ts` following the template above.
2. Add an `npm run smoke:<slice>` entry to `package.json`.
3. Add a row to the **Current scripts** table above.
4. Run it locally twice in a row to prove idempotency.
5. Mention it in the slice's `.context/` documentation under a **Smoke testing** heading so future readers know to run it when touching that code.

## Relationship to other test layers

| Layer                  | Lives in             | Runs in | DB           | External services  |
| ---------------------- | -------------------- | ------- | ------------ | ------------------ |
| Unit tests             | `tests/unit/`        | vitest  | mocked       | mocked             |
| Integration tests      | `tests/integration/` | vitest  | mocked       | mocked             |
| **Smoke scripts**      | `scripts/smoke/`     | tsx     | **real dev** | stubbed in-process |
| Manual QA / end-to-end | (none yet)           | browser | real dev     | real               |

Smoke scripts are the first layer that touches real Postgres, which is why the safety rules matter. CI does not run them — they're a developer-facing sanity check.
