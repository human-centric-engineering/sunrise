# Prisma 7 baseline-generation bugs

Five reproducible bugs in Prisma 7's `migrate diff --from-empty --to-schema` output, discovered during the 2026-05-29 migration squash and hand-folded into the baseline. This doc is the canonical reference for the workarounds. The same bugs occur for `prisma db push` against an empty database.

Track upstream filing here. None have public issue URLs yet — feel free to file once a clean minimal repro is extracted.

## Quick context

`prisma migrate diff --from-empty --to-schema prisma/schema --script` should emit DDL that recreates the exact deployed schema starting from an empty DB. We use this to consolidate many incremental migrations into a single baseline. The bugs below are cases where the generator's output omits something the Prisma model declared.

The pattern across all five: **the original incremental migration emitted the correct DDL** (because Prisma's per-change generator is well-tested). The `--from-empty` flat-generate path takes a different code path through the engine and loses information that the per-change path preserves.

## Inventory

| Bug ID | Description                                                               | Affected object                                  | Workaround                                                    | Upstream issue |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- | -------------- |
| B1     | `@@unique(name: …)` named unique constraint dropped to default-name index | `AiConversation` (`ai_conversation_inbound_key`) | Manual `ALTER TABLE ADD CONSTRAINT` with the named constraint | (not filed)    |
| B2     | NOT NULL omitted on array column with `@default([…])`                     | `AiProviderModel.deploymentProfiles`             | Manual `ALTER COLUMN SET NOT NULL`                            | (not filed)    |
| B3     | (same shape as B2)                                                        | `AiWebhookSubscription.agentIds`                 | Manual `ALTER COLUMN SET NOT NULL`                            | (not filed)    |
| B4     | (same shape as B2)                                                        | `AiWebhookSubscription.workflowIds`              | Manual `ALTER COLUMN SET NOT NULL`                            | (not filed)    |
| B5     | (same shape as B2)                                                        | `AiWebhookSubscription.retryBackoffMs`           | Manual `ALTER COLUMN SET NOT NULL`                            | (not filed)    |

## B1 — named UNIQUE constraint dropped to default-name UNIQUE INDEX

**The model declares:**

```prisma
model AiConversation {
  // …
  channel       String?
  inboundFromId String?

  @@unique([channel, inboundFromId], name: "ai_conversation_inbound_key")
}
```

**Prisma 7 baseline-generator emits:**

```sql
CREATE UNIQUE INDEX "AiConversation_channel_inboundFromId_key"
  ON "ai_conversation" ("channel", "inboundFromId");
```

The `name:` argument is **ignored**. A new index is created with Prisma's default naming convention (`<Model>_<col1>_<col2>_key`), not the named unique constraint the model declared.

**Why it matters:** the conversation lookup path keys on the named constraint via `prisma.aiConversation.findUnique({ where: { ai_conversation_inbound_key: { … } } })`. Without the named constraint (only a same-shape index), the typed lookup compiles fine but fails at runtime because Prisma's query engine can't find the constraint by name.

**Workaround (in baseline):** replace the `CREATE UNIQUE INDEX` with the explicit `ALTER TABLE ADD CONSTRAINT` form:

```sql
ALTER TABLE "ai_conversation"
  ADD CONSTRAINT "ai_conversation_inbound_key"
  UNIQUE ("channel", "inboundFromId");
```

The two are functionally equivalent in Postgres (the constraint creates a backing unique index with the constraint's name), but only the constraint form gives the Prisma query engine the name it expects.

## B2–B5 — NOT NULL omitted on array column with `@default([…])`

**The model declares (B2 example):**

```prisma
model AiProviderModel {
  // …
  deploymentProfiles String[] @default(["hosted"])
}
```

**Prisma 7 baseline-generator emits:**

```sql
ALTER TABLE "ai_provider_model"
  ADD COLUMN "deploymentProfiles" TEXT[] DEFAULT ARRAY['hosted'];
```

The NOT NULL is **missing**. The original incremental migration correctly included `NOT NULL`; the `--from-empty` flat-generate path drops it.

**Why it matters:** A nullable array column changes the semantics — code that reads the field has to handle three states (`null`, empty array, non-empty array) instead of two (empty array, non-empty array). Worse, application code written against the original NOT NULL contract may dereference `null` and crash at runtime.

**Workaround (in baseline):** the `NOT NULL` is added to the column definition by hand:

```sql
"deploymentProfiles" TEXT[] NOT NULL DEFAULT ARRAY['hosted'],
```

The same workaround applies to **B3** (`agentIds`), **B4** (`workflowIds`), and **B5** (`retryBackoffMs`) — all three live on `AiWebhookSubscription` and all three follow the same pattern.

## How to confirm the bugs survive in a future Prisma release

When Prisma releases a new version, re-run the squash audit to see whether any of these still apply:

```bash
# 1. Apply every migration from scratch to a clean reference DB
dropdb sunrise_squash_old && createdb sunrise_squash_old
DATABASE_URL='postgresql://localhost/sunrise_squash_old' npx prisma migrate deploy

# 2. Generate a fresh baseline from the same schema
dropdb sunrise_squash_intent && createdb sunrise_squash_intent
npx prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema \
  --script > /tmp/fresh-baseline.sql

# 3. Apply the fresh baseline to scratch
dropdb sunrise_squash_scratch && createdb sunrise_squash_scratch
psql sunrise_squash_scratch < /tmp/fresh-baseline.sql

# 4. Diff with atlas — any output is a still-present generator bug
atlas schema diff \
  --from postgres://localhost/sunrise_squash_old?sslmode=disable \
  --to   postgres://localhost/sunrise_squash_scratch?sslmode=disable
```

Empty diff (after excluding `_prisma_migrations`) means the bug is fixed and the next baseline regeneration can stop hand-folding it.

## Filing upstream

The reproductions above are minimal: each can be extracted into a tiny `schema.prisma` with the single model and the single bug to demonstrate it without depending on Sunrise. If you file, link the issue here so future contributors can track the fix.

When the upstream fix lands, remove the corresponding `B*` block from this doc and the hand-fold from the baseline (or note in the row that the workaround is no longer needed on Prisma >= X.Y.Z).

## Related

- `prisma/migrations/00000000000000_baseline/migration.sql` — the hand-folded baseline
- `.context/database/prisma-unmodelled-objects.md` — separate A-series doc for objects Prisma cannot model at all (vs the B-series here which Prisma _should_ be able to model but doesn't, due to bugs)
- `.context/database/migrations.md` — migration workflow (general)
