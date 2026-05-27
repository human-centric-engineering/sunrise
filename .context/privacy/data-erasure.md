# Account Deletion & Right to Erasure

How Sunrise erases a user and the data tied to them (GDPR Art. 17), and what it
deliberately retains. The entry point is `eraseUser()` in `lib/privacy/erase-user.ts`;
both delete endpoints route through it.

## Quick Reference

| Need                          | Use                                                                   |
| ----------------------------- | --------------------------------------------------------------------- |
| Erase a user (the only way)   | `eraseUser()` — `lib/privacy/erase-user.ts`                           |
| Self-service deletion         | `DELETE /api/v1/users/me` (confirmation `{ confirmation: "DELETE" }`) |
| Admin deletes another user    | `DELETE /api/v1/users/[id]` (admin only)                              |
| What cascades vs. is retained | Per-table `onDelete` in `prisma/schema/`                              |

### Anti-Pattern

**Don't** call `prisma.user.delete()` directly:

```typescript
// ❌ Skips PII scrub, the erasure receipt, and avatar cleanup.
await prisma.user.delete({ where: { id: userId } });
```

**Do** route through the service:

```typescript
// ✅ Scrub residual PII + write receipt + delete + remove blobs, atomically.
import { eraseUser } from '@/lib/privacy/erase-user';

await eraseUser({
  userId: session.user.id,
  userEmail: session.user.email,
  actorUserId: session.user.id, // who initiated (self or an admin)
  reason: 'self_service', // 'self_service' | 'admin_action'
});
```

## Erase-vs-Retain Model

Deletion leans on Postgres referential actions (`prisma.user.delete` triggers
them atomically and unbypassably). Relations to `User` fall into two policies —
see the `account_deletion_erasure_cascade` migration for the full per-table list.

| Policy                            | `onDelete` | What                                                                                                                                                                                                   |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Personal data → erased**        | `Cascade`  | Sessions, accounts, conversations (+messages, embeddings, shares), workflow executions (+steps), user memory, evaluation sessions, API keys, webhook subscriptions                                     |
| **Org config + audit → retained** | `SetNull`  | Agents, profiles, versions, invite/embed tokens, workflows (+versions, schedules, triggers), event hooks, knowledge documents, provider configs/models, experiments, admin audit log, MCP prompts/keys |

**Why retain config?** `createdBy` is attribution, not ownership — any admin can
already manage any agent/workflow/provider regardless of who created it. So a
departing creator's config keeps working; only the `createdBy`/`uploadedBy` link
is nulled. Child rows (messages, embeddings, deliveries, steps) already cascade
from their parents, so only the root `User` relations carry the policy.

### System-owned runs

`AiConversation.userId` and `AiWorkflowExecution.userId` are **nullable** (still
`Cascade`). A real user's runs cascade-erase on deletion; schedule- and
inbound-triggered runs are **system-owned** (`userId = null`) and unaffected.
Consequently `userId` is `string | null` through the engine, and the
`user-memory` capability returns a `no_user_context` error for system runs
rather than assuming a user.

### Adding a new `User` relation (required step)

This is the easiest way to silently regress erasure, and it has happened twice.
Any **new** model with a `userId` or `createdBy` FK to `User` **must** declare an
explicit `onDelete` — Prisma's default is `Restrict`, which makes
`prisma.user.delete()` throw `P2003` for any user who has touched that table:

1. Decide the policy: **personal data → `onDelete: Cascade`**; **reusable config,
   audit, or logs → `onDelete: SetNull`** (and make the FK column nullable).
2. If `SetNull` leaves any residual PII on the retained row (an IP, a name, an
   email), scrub it in `eraseUser()` inside the transaction — `SetNull` drops the
   link, not the column.
3. Add an assertion to `scripts/smoke/erasure.ts` proving the new row is erased
   or de-attributed against a real DB.

When bringing an erasure branch up to date with `main`, **re-scan for new `User`
relations the merge introduced** — they reintroduce this bug unnoticed.

## What `eraseUser()` Does Beyond the Cascade

The DB cascade can't reach everything. The service adds three steps; the scrub,
receipt, and delete run in **one transaction** (avatar cleanup is a best-effort
side effect first, since object storage can't enlist in a DB transaction):

1. **Scrub residual PII** — `SetNull` drops the `userId` link on retained
   `AiAdminAuditLog` rows but leaves `clientIp` (an IP address = PII). The
   service nulls it before the link is gone.
2. **Write an erasure receipt** — see below.
3. **Remove avatar blobs** — `deleteByPrefix('avatars/{userId}/')`.

Apps and forks extend these same two reach-limits (residual-PII scrub, external
resource cleanup) via registered hooks — see
[App / fork tables relating to `User`](#app--fork-tables-relating-to-user).

## App / Fork Tables Relating to `User`

An app built on Sunrise (or an external fork) keeps its own models in its own
schema file and relates them to the Sunrise `User`. It **cannot** add a Prisma
`@relation` to `User` — that needs a reverse field _on_ `User`, a core edit to
the most central, most merge-prone model. So the canonical pattern is a **plain
`String` FK with no `@relation`**, and the referential action is written by hand
in the migration:

```prisma
// app-owned schema file — a satellite profile/extension table
model AppHubUserProfile {
  id     String @id @default(cuid())
  userId String @unique // FK to User.id — no @relation
  // …app fields…

  @@index([userId])
}
```

```sql
-- hand-added to the generated migration
ALTER TABLE "AppHubUserProfile"
  ADD CONSTRAINT "AppHubUserProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE; -- personal data; SET NULL (nullable FK) for retained config/audit
```

**⚠️ The schema-level `onDelete` guard does NOT catch this.** The
[Adding a new `User` relation](#adding-a-new-user-relation-required-step) rule
above is enforced by reviewing `@relation onDelete` in `schema.prisma`. A
plain-scalar FK has no `@relation`, so it **slips past that guard entirely**.
Two failure modes if the migration FK is wrong:

- **No DB FK at all** → `prisma.user.delete()` leaves the app rows **orphaned**
  (a silent retention violation).
- **FK left at the default `RESTRICT`** → `prisma.user.delete()` throws `P2003`
  and **erasure breaks for every user** who has an app row.

So the migration FK with an explicit `ON DELETE` is **mandatory**, not optional.

### What the FK cascade can't do — register a cleanup hook

A `CASCADE` FK is erased automatically by `prisma.user.delete()`. But, exactly as
for Sunrise's own tables, the cascade **cannot** (1) scrub residual PII left in
columns of `SET NULL` retained rows, or (2) delete external resources (object
storage, search indexes) keyed to the user. For those, register a hook with
`lib/privacy/erasure-hooks.ts` — it runs inside the same `eraseUser()` flow,
with no edit to the service:

```ts
import { registerErasureCleanupHook } from '@/lib/privacy/erasure-hooks';

registerErasureCleanupHook({
  name: 'app-hub',
  // Best-effort, BEFORE the transaction (like avatar cleanup). A throw is
  // logged and swallowed — it can never block the user's erasure.
  async cleanupExternal({ userId }) {
    await deleteAppBlobsFor(userId);
  },
  // INSIDE the transaction, BEFORE the user row is deleted, so it can still
  // match on userId and commits atomically — a throw rolls the erasure back.
  async scrubInTransaction({ tx, userId }) {
    await tx.appHubAuditEntry.updateMany({ where: { userId }, data: { actorIp: null } });
  },
});
```

Register once at startup (alongside the app's capability registration), then add
an assertion to `scripts/smoke/erasure.ts` proving the app table is erased or
de-attributed against a real DB — the same proof the core tables get.

## Erasure Receipt (Accountability)

`DataErasureReceipt` (`prisma/schema/`, migration `add_data_erasure_receipt`)
is an **append-only** record proving an erasure happened, without re-introducing
the subject's PII:

- `subjectUserId` — opaque; the user row is gone, so it identifies nothing on its own.
- `subjectEmailHash` — `sha256(lowercased email)` for correlating a later
  "did you erase me?" request. Not reversible; the raw email is never stored.
- `actorUserId`, `reason`, `erasedAt`.
- **No foreign keys** — the receipt must outlive every referenced row, including
  the actor if they are erased later.

## Deletion Guards

| Guard                            | Where                       | Rule                                                             |
| -------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| **Last admin** (`LAST_ADMIN`)    | `DELETE /api/v1/users/me`   | An admin may self-delete only if another admin remains.          |
| **No admin-deletes-admin**       | `DELETE /api/v1/users/[id]` | Must demote the target to `USER` first.                          |
| **No self-delete (admin route)** | `DELETE /api/v1/users/[id]` | Admins delete their own account via `/users/me`, not this route. |

The asymmetry is deliberate: the admin route blocks deleting any admin (demote
first), but self-delete has no demotion gate — so the **last-admin** check lives
on `/users/me` to prevent locking the system out of all admins.

## GDPR Mapping

| Requirement                           | Status                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------- |
| **Art. 17 — Right to erasure**        | ✅ Personal data cascaded, residual PII scrubbed, avatar blobs removed. |
| **Art. 5(2) — Accountability**        | ✅ Append-only `DataErasureReceipt`.                                    |
| **Art. 20 — Portability/export**      | ⏳ Not implemented — no user-facing data-export endpoint yet.           |
| **Art. 5(1)(e) — Storage limitation** | ⏳ Retention purge is a separate feature (see roadmap).                 |

## Related Documentation

- [Privacy & Cookie Consent](./overview.md) — consent system
- [Security Overview](../security/overview.md) — application security
- [Auth Security](../auth/security.md) — sessions, password handling
- `lib/privacy/erasure-hooks.ts` — the app erasure cleanup-hook registry
- [`CUSTOMIZATION.md`](../../CUSTOMIZATION.md#4-database-schema) — Building on Sunrise: the satellite profile-table pattern for extending `User`
