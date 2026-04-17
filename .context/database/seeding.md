# Seeding

How the seed runner works and how to author new seed units.

## Quick Reference

| Command                      | Purpose                                   |
| ---------------------------- | ----------------------------------------- |
| `npm run db:seed`            | Apply any new or changed seed units       |
| `npm run db:reset`           | Drop DB, re-migrate, re-seed from scratch |
| `npm run db:seed:embeddings` | Generate vector embeddings for KB chunks  |

## Operational Flows

### 1. Clean install

```bash
npm run db:migrate:deploy  # Migrations to head
npm run db:seed        # All 7 units apply, SeedHistory records each
```

### 2. Dev reset + reseed

```bash
npm run db:reset       # Drops, re-migrates, re-seeds (via prisma migrate reset --force)
```

Never wipes data silently on a regular `db:seed`. The destructive path is explicit and opt-in.

> **CI runs this too.** `.github/workflows/ci.yml` boots a pgvector Postgres service and runs `db:migrate:deploy` + `db:seed` on every PR, so a broken seed unit fails CI rather than landing on `main`.

### 3. Incremental additive seeding (team flow)

```bash
git pull               # Teammate added prisma/seeds/008-new-thing.ts
npm run db:seed        # Runs only 008; existing 001–007 skip as unchanged
```

## Guiding Principle

**Seeds express desired current state, not a replay log.** Each seed file is always authored against the current schema. `SeedHistory` tracks "have I applied _this version_ of this unit?" via content hash — if the hash changes, the unit re-runs.

Migrations alone advance schema; seeds alone populate data; neither tries to do the other.

## How the Runner Works

Source: `prisma/runner.ts`

1. Discovers files under `prisma/seeds/` matching `^\d{3}-[a-z0-9-]+\.ts$`, sorted lexicographically.
2. For each file:
   - Dynamic-imports the file to read the exported `SeedUnit`.
   - Computes sha256 of the seed file's source, then appends the contents of any files declared in `hashInputs` (in declared order) before finalising the hash. This lets a unit that wraps external data (e.g. a JSON file) re-run when that data changes.
   - Looks up `SeedHistory` by `name` (= filename sans `.ts`).
   - If stored `contentHash` matches → skip, log `⏭`.
   - Otherwise → invokes `SeedUnit.run({ prisma, logger })`, upserts `SeedHistory` with new hash and `durationMs`.
3. Errors from a unit propagate and exit non-zero. Successful earlier units remain in `SeedHistory`, so a re-run resumes at the failing unit.

## Authoring a New Seed Unit

### Filename

`prisma/seeds/NNN-slug.ts` where `NNN` is a three-digit numeric prefix (fixes order) and `slug` is lowercase-kebab.

### Shape

Default-export a `SeedUnit` — shape defined in `prisma/runner.ts`:

```typescript
import type { SeedUnit } from '../runner';

const unit: SeedUnit = {
  name: '008-example',
  async run({ prisma, logger }) {
    logger.info('🔧 Seeding example rows...');
    await prisma.thing.upsert({
      where: { slug: 'example' },
      update: {},
      create: { slug: 'example', name: 'Example' },
    });
  },
};

export default unit;
```

### Rules

**Idempotent.** Every write is an `upsert` (or equivalent). `update: {}` is the common idiom — re-seeding never overwrites admin edits. `createMany` is not safe unless you pair it with `skipDuplicates: true` and a unique constraint.

**Self-contained.** Look up dependencies from the DB, don't pass them between units. For admin ownership:

```typescript
const admin = await prisma.user.findFirst({
  where: { role: 'ADMIN' },
  select: { id: true },
});
if (!admin) throw new Error('No admin user found — ensure 001-test-users runs first.');
```

**Use the context.** The runner injects `prisma` and `logger`. Do **not** import `prisma` from `@/lib/db/client` or instantiate your own — use the ones passed to `run()`.

**Current schema only.** Always author against the latest schema. If a migration changes a column that an existing seed referenced, update that seed file — its hash changes and it re-runs.

**Declare external data dependencies.** If your unit reads a data file that lives outside the seed file itself (e.g. a JSON payload, a CSV), list the paths in `hashInputs` (relative to the seed file). The runner folds each file's contents into the hash so edits to the data trigger a re-run. Without this, the wrapper's hash is unchanged and the unit silently skips.

```typescript
const unit: SeedUnit = {
  name: '008-example',
  hashInputs: ['../../lib/example/data.json'], // re-run when data.json changes
  async run({ prisma, logger }) {
    /* ... */
  },
};
```

Missing `hashInput` files throw a clear error naming the unit and path — they are not optional.

### Anti-Patterns

**Don't:** assume prior data state

```typescript
// Bad — seeds may run against dirty or partially-seeded DBs
const existing = await prisma.thing.findFirstOrThrow({ where: { slug: 'foo' } });
await prisma.thing.update({ where: { id: existing.id }, data: { name: 'New' } });
```

**Do:** upsert against current schema

```typescript
await prisma.thing.upsert({
  where: { slug: 'foo' },
  update: {},
  create: { slug: 'foo', name: 'New' },
});
```

**Don't:** chain state between units via parameters

```typescript
// Bad — unit cannot be re-run in isolation
export default { name: '...', run: ({ prisma, adminId }) => { ... } };
```

**Do:** look up what you need inside `run()`.

## Embeddings (Opt-in)

Knowledge-base chunks are seeded by `007-knowledge-chunks.ts` (calls `seedChunks()` from `lib/orchestration/knowledge/seeder.ts`). Embeddings are **not** part of `db:seed` because they require an active embedding provider (Voyage / OpenAI / Ollama) and cost money.

```bash
npm run db:seed:embeddings   # Runs embedChunks() — phase 2, paid / network-dependent
```

Safe to re-run: `embedChunks()` only processes rows where `embedding IS NULL`. A developer without provider keys can still run `db:seed` to completion; vector search just won't work until embeddings are generated.

Implementation: `scripts/seed-embeddings.ts` → `embedChunks()` in `lib/orchestration/knowledge/seeder.ts`.

## When NOT to Use a Seed

Seeds rewrite _current state_ — they can't clean up history. If a schema change invalidates previously-seeded rows (e.g. dropping a required column value), write a proper Prisma migration with SQL to migrate the data. Do **not** try to "fix" it by editing a seed.

## SeedHistory Table

```prisma
model SeedHistory {
  id          String   @id @default(cuid())
  name        String   @unique
  contentHash String
  appliedAt   DateTime @default(now())
  durationMs  Int

  @@map("seed_history")
}
```

Inspect which seeds have run and when:

```sql
SELECT name, "contentHash", "appliedAt", "durationMs"
FROM seed_history ORDER BY name;
```

## Known Quirks

- **Whole-file hashing.** Any edit to a seed file — including whitespace — triggers a re-run on next `db:seed`. Same for any file listed in `hashInputs`. Safe because units are idempotent `upsert`s, just slightly noisier.
- **Unit 007 uses the module prisma client.** `007-knowledge-chunks.ts` delegates to `seedChunks()` in `lib/orchestration/knowledge/seeder.ts`, which imports `prisma` from `@/lib/db/client` rather than the context-supplied one. This is intentional — the helper is also used by admin HTTP endpoints — and works fine because both point at the same database. Unit 007 also declares `hashInputs: ['./data/chunks/chunks.json']` so edits to the parsed knowledge-base data trigger a re-run.

## Key Files

| File                                    | Purpose                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| `prisma/runner.ts`                      | Discovery, hashing, dispatch                                   |
| `prisma/seed.ts`                        | Thin entry point invoked by Prisma CLI                         |
| `prisma/seeds/`                         | One file per logical seed unit                                 |
| `scripts/seed-embeddings.ts`            | Opt-in embeddings runner                                       |
| `lib/orchestration/knowledge/seeder.ts` | `seedChunks()` / `embedChunks()` helpers                       |
| `prisma.config.ts`                      | `migrations.seed` hooks `prisma migrate reset` into the runner |

## Related Documentation

- [Schema](./schema.md) — Prisma schema reference
- [Migrations](./migrations.md) — migration workflow
- [Knowledge Base](../orchestration/knowledge.md) — chunking and embedding pipeline
