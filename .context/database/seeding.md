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
npm run db:seed        # All units apply, SeedHistory records each (20 units as of 2026-05-31)
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

### 4. Upgrading hosted environments (Neon preview/prod)

The Vercel **Build Command** (`npm run build && npm run db:migrate:deploy`) runs
migrations automatically on deploy, but **not** `db:seed`. So a schema change
(e.g. the `accountType` column) ships automatically, while seed-borne data
changes — the SERVICE config-owner (`001-system-owner`) and the legacy-user
reconciliation (`019-reconcile-legacy-seed-users`) — must be applied by running
`npm run db:seed` against each environment when ready:

```bash
# Per environment, pointing DATABASE_URL at the target Neon database:
npm run db:migrate:deploy   # (already run by the Vercel build on deploy)
npm run db:seed             # apply 001 SERVICE owner, 004–018, 019 reconciliation
```

Run dev → preview → prod. The reconciliation is idempotent and safe to re-run.

## Guiding Principle

**Seeds express desired current state, not a replay log.** Each seed file is always authored against the current schema. `SeedHistory` tracks "have I applied _this version_ of this unit?" via content hash — if the hash changes, the unit re-runs.

Migrations alone advance schema; seeds alone populate data; neither tries to do the other.

## How the Runner Works

Source: `prisma/runner.ts`

1. Discovers seed files **recursively** under `prisma/seeds/**`, matching each file's basename against `^\d{3}-[a-z0-9-]+\.ts$`, sorted by the path relative to `prisma/seeds/` (so digit-prefixed top-level core seeds run before any letter-prefixed app subdirectory).
2. For each file:
   - Dynamic-imports the file to read the exported `SeedUnit`.
   - Computes sha256 of the seed file's source, then appends the contents of any files declared in `hashInputs` (in declared order) before finalising the hash. This lets a unit that wraps external data (e.g. a JSON file) re-run when that data changes.
   - Looks up `SeedHistory` by `name` (= the path **relative to `prisma/seeds/`** sans `.ts`). Top-level files keep their bare slug (`001-system-owner`); a nested file keys as `app-foo/001-init`, so same-numbered seeds in different directories don't collide.
   - If stored `contentHash` matches → skip, log `⏭`.
   - Otherwise → invokes `SeedUnit.run({ prisma, logger })`, upserts `SeedHistory` with new hash and `durationMs`.
3. Errors from a unit propagate and exit non-zero. Successful earlier units remain in `SeedHistory`, so a re-run resumes at the failing unit.

## Authoring a New Seed Unit

### Filename

`prisma/seeds/NNN-slug.ts` where `NNN` is a three-digit numeric prefix (fixes order within a directory) and `slug` is lowercase-kebab. Apps built on Sunrise can nest their own seeds in a subdirectory (e.g. `prisma/seeds/app-<name>/001-init.ts`); discovery is recursive and the `SeedHistory` key includes the subdirectory path.

### Shape

Default-export a `SeedUnit` — shape defined in `prisma/runner.ts`:

```typescript
import type { SeedUnit } from '@/prisma/runner';

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

**Idempotent.** Every write is an `upsert` (or equivalent). `createMany` is not safe unless you pair it with `skipDuplicates: true` and a unique constraint.

**Split the `update` branch by who owns the field.** `update: {}` — "never overwrite admin edits" — is the common idiom and the right default, but it is wrong for anything that has to track the code. A row seeded once then never re-synced keeps advertising the original definition forever, and nothing fails: the tests pin the class against the seed constant, not the seed constant against the DB row (#545).

| Ownership          | Examples                                                   | On update       |
| ------------------ | ---------------------------------------------------------- | --------------- |
| **Code-owned**     | `functionDefinition`, `executionType`, `executionHandler`  | Always re-apply |
| **Operator-owned** | `isActive`, `rateLimit`, `name`, `description`, `category` | Never touch     |

A stale `functionDefinition` is not a customisation — it is a schema the handler will reject, shown to every LLM and MCP client. A stale `executionHandler` points at a class that may no longer exist. Neither is something an admin chose.

The split falls where it does because **what the model reads lives inside `functionDefinition`** — its own `name`, `description` and parameter schema. The row's top-level `name` / `description` are the admin UI's presentation, editable via `PATCH /capabilities/{id}`, so re-applying them would revert an operator's rename on the next deploy while gaining nothing the LLM sees.

Hoist the code-owned half into a constant and spread it into both branches, so the two cannot drift:

```typescript
const CALL_EXTERNAL_API_IMPL = {
  executionType: 'internal',
  executionHandler: 'CallExternalApiCapability',
  functionDefinition: {/* … */},
};

await prisma.aiCapability.upsert({
  where: { slug: 'call_external_api' },
  update: { isSystem: true, ...CALL_EXTERNAL_API_IMPL },
  create: {
    slug: 'call_external_api',
    name,
    description,
    category,
    rateLimit: 60,
    isActive: true,
    ...CALL_EXTERNAL_API_IMPL,
  },
});
```

**The write paths enforce this split on system rows** (#598), via `changedSeedOwnedFields()` in `lib/orchestration/capabilities/seed-owned.ts`:

- `PATCH /capabilities/{id}` returns **403** naming the fields, rather than accepting an edit the next re-seed reverts with no audit entry.
- The **config importer** skips those fields on a system row and records a warning, rather than failing the whole restore. Sunrise's exporter filters `isSystem: false`, so only a hand-edited or foreign bundle reaches that path. It also skips `isActive: false` on a system row, because PATCH refuses that too — deactivating a built-in is equivalent to deleting it, and no re-seed restores it (seeds set `isActive` only in their `create` branch). Re-activating is still imported.
- The **capability form** does not send an _untouched_ `functionDefinition` for a system row. It has to normalise the stored definition on load — `name` forced to the slug, a non-string `description` replaced, `parameters` coerced — so a row whose stored value did not already match that normalisation would 403 a save that only edited the description, naming the one field the operator cannot fix there. An **edited** definition is still sent and still refused: dropping it unconditionally would silently discard a deliberate edit and report "Saved", which is a worse failure than the one being fixed.

`slug` is guarded alongside the three, for a different reason: it is the upsert's `where` key, so a rename is **not** reverted — the next re-seed matches nothing and creates a **second row** for one built-in.

Two things to preserve if you touch that guard, both of which shipped broken once:

1. **Gate on the value changing, not on the field being present.** The capability form PATCHes the whole form on every save, so a presence check 403s an admin who only edited the description, naming three fields they never touched.
2. **Compare `functionDefinition` structurally, not with `JSON.stringify`.** It is `jsonb`: Postgres canonicalises key order on write and Zod rebuilds the parsed body in schema order, so the same value round-trips to two different strings. `jsonEquals()` (`lib/utils/json-equal.ts`) is key-order-insensitive; the two other `valuesEqual` helpers in the codebase are not, deliberately.

`npm run smoke:capability-ownership` proves (2) against the real database rather than against anyone's belief about it — writing `{description, parameters, name}` and reading back `{name, parameters, description}`. It fails loudly if a future Postgres stops re-ordering, because that would mean the comparison strategy needs re-deciding rather than that the guard is fine.

Two caveats when seeding a live box:

- **Caches do not clear across processes.** The PATCH route pairs every `functionDefinition` write with `capabilityDispatcher.clearCache()`, `clearMcpToolCache()` and `broadcastMcpToolsChanged()`. `db:seed` runs in a different process and cannot, so a running app keeps serving the previous MCP `inputSchema` on `tools/list` for up to the dispatcher's 5-minute TTL. Restart the app after a seed that changes a capability, or wait it out.
- **A re-seed only happens when the seed FILE hash changes** (plus any `hashInputs`). Editing a capability class alone will not trigger one — which is why the parity test below matters: it forces the seed constant to change whenever the class does, which is what moves the hash.

Enforced by `tests/unit/prisma/seeds/capability-code-owned-fields.test.ts`, which parses every `aiCapability.upsert` in this directory and checks both directions. **The same shape applies to any seeded row with code-owned fields** — built-in agents' `systemInstructions` are the obvious next case, and the agent seeds are currently inconsistent about it (`008`/`016`/`017`/`018` re-apply them; `005`/`006`/`010` do not).

**Self-contained.** Look up dependencies from the DB, don't pass them between units. For config ownership — `001-system-owner` seeds a non-login `system@sunrise.local` user (`role: ADMIN`, `accountType: SERVICE`, no credential) precisely so config-owning seeds always have a deterministic owner. Resolve it via the SERVICE predicate (not "first ADMIN", which is non-deterministic once humans exist):

```typescript
import { serviceAccountWhere } from '@/lib/auth/account';

const owner = await prisma.user.findFirst({ where: serviceAccountWhere, select: { id: true } });
if (!owner) throw new Error('No SERVICE config-owner found — ensure 001-system-owner runs first.');
```

`019-reconcile-legacy-seed-users` is a one-time idempotent upgrade unit: on databases seeded under v0.0.1 it erases the legacy credential-less `admin@example.com` / `test@example.com` artifacts (preserving real users), re-points orphaned config ownership to the SERVICE owner, and marks the bootstrap complete when a human admin exists.

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
- **Unit 007 depends on Unit 003.** `seedChunks()` creates an `AiKnowledgeDocument` row with `knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID` (FK to `ai_knowledge_base`). Unit 003 (`default-knowledge-base`) creates the parent `kb_default` row. The numeric prefix on each filename pins the order: 003 always applies before 007. Forks that skip `db:seed` entirely won't have either row — runtime upload paths self-heal via `getOrCreateDefaultKnowledgeBase()` in `lib/orchestration/knowledge/document-manager.ts`, but the pre-loaded pattern-advisor chunks won't be present.

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
