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

| Policy                            | `onDelete` | What                                                                                                                                                                                                              |
| --------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Personal data → erased**        | `Cascade`  | Sessions, accounts, conversations (+messages, embeddings, shares), workflow executions (+steps), user memory, evaluation sessions, API keys, webhook subscriptions                                                |
| **Org config + audit → retained** | `SetNull`  | Agents, profiles, versions, invite/embed tokens, workflows (+versions, schedules, triggers), event hooks, knowledge documents, provider configs/models, experiments, admin audit log, MCP prompts/keys, cost logs |

**Why retain a cost log?** Different reason from the config rows beside it, and
worth stating separately: a cost row is a **billing record**. Cascading it would
let an erasure request quietly rewrite the books, so the FK is `SetNull` — the
spend stays, the person is detached. `scripts/smoke/erasure.ts` asserts exactly
that against a real database: row retained, `userId` null, amount unchanged.

**Why retain config?** `createdBy` is attribution, not ownership — any admin can
already manage any agent/workflow/provider regardless of who created it. So a
departing creator's config keeps working; only the `createdBy`/`uploadedBy` link
is nulled. Child rows (messages, embeddings, deliveries, steps) already cascade
from their parents, so only the root `User` relations carry the policy.

### System-owned runs

`AiConversation.userId` and `AiWorkflowExecution.userId` are **nullable** (still
`Cascade`), and the engine handles `string | null` throughout — the
`user-memory` capability returns a `no_user_context` error rather than assuming
a user.

Schedule- and inbound-triggered runs use that: they are written **system-owned**,
`userId = null`. Nobody with an account caused them, and the data on them is
frequently somebody else's — an inbound run's `inputData.trigger` is the adapter
payload verbatim (sender phone number, email From/Subject/body, base64
attachments), and the conversation row carries `fromAddress` and the whole
thread.

| Where                                          | Writes                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| `app/api/v1/inbound/[channel]/[slug]/route.ts` | conversation, execution, audit row, engine context |
| `lib/orchestration/scheduling/scheduler.ts`    | execution, engine context                          |

Attribution lives on the config rows instead: `AiWorkflowTrigger.createdBy` and
`AiWorkflowSchedule.createdBy` name the operator who set the thing up, and
`AiWorkflowExecution.triggerSource` records what fired the run
(`inbound:<channel>` or `schedule`).

**Do not "fix" a null `userId` on these rows by filling it in.** Until #502 they
carried the operator's id, and it cost twice:

1. **Erasure over-deleted.** The FK is `Cascade`, so erasing that one operator
   destroyed every third party's inbound conversation and run routed through any
   trigger they had configured. `eraseUser()` reported success; the
   correspondence was simply gone.
2. **Access over-disclosed.** The rows matched the operator on `userId`, so a
   subject-access export handed them a stranger's phone number, email body and
   attachments, labelled as their own data.

Two consequences follow for anything you build on these rows:

- **Admin surfaces need the system basis, not an owner match.** A null owner
  matches no admin, so `lib/orchestration/access/execution-access.ts` and
  `conversation-access.ts` grant every admin access to unowned rows (basis
  `'system'`, audit-logged like `'shared'`). Route a new surface through those
  helpers; a hand-rolled `userId === session.user.id` check will silently hide
  every scheduled and inbound run.
- **Steps that require a real account must refuse, not borrow one.**
  `judge_call` throws `judge_call_requires_user_context` on a system-owned run
  because it files a transcript into an account's chat history. Borrowing the
  schedule's author there would re-create the mis-attribution above.

Erasure of an inbound thread is a different request from erasure of an account:
the sender has no account, so `eraseUser()` cannot reach them. Delete the
conversation through the admin conversation route, which allows it on the
`'system'` basis and records who did it.

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
4. Declare what a **data subject** receives from it in `SUBJECT_DATA_SOURCES`
   (`lib/privacy/export-sources.ts`) — the same decision, seen from the access
   side. This one is enforced: `tests/unit/lib/privacy/export-sources.test.ts`
   fails until the model is listed. See
   [Subject Access Export](./data-export.md).

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
3. **Remove avatar blobs** — `deleteByPrefix('avatars/{userId}/')`. On the local
   provider this sweeps both storage roots (`public/uploads/` and the private
   `.storage/private/`), so a file uploaded with `public: false` is erased too.
   A provider that stored objects in more than one place and swept only one
   would make this step a partial delete that still reported success — see
   [`.context/storage/overview.md`](../storage/overview.md#local-provider).

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

| Guard                            | Where                       | Rule                                                              |
| -------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| **Last admin** (`LAST_ADMIN`)    | `DELETE /api/v1/users/me`   | An admin may self-delete only if another **human** admin remains. |
| **No admin-deletes-admin**       | `DELETE /api/v1/users/[id]` | Must demote the target to `USER` first.                           |
| **No self-delete (admin route)** | `DELETE /api/v1/users/[id]` | Admins delete their own account via `/users/me`, not this route.  |

The asymmetry is deliberate: the admin route blocks deleting any admin (demote
first), but self-delete has no demotion gate — so the **last-admin** check lives
on `/users/me` to prevent locking the system out of all admins.

The last-admin count uses `humanAdminWhere` (`{ role: 'ADMIN', accountType:
'HUMAN' }` from [`lib/auth/account.ts`](../../lib/auth/account.ts)), so it
**excludes** the seeded `system@sunrise.local` config-owner (a `SERVICE`
account: role `ADMIN`, no credential, cannot log in). Counting it would let the
last human admin self-delete down to zero real operators, which would re-open
the first-user-is-admin bootstrap and silently promote the next signup (issue
#278). The SERVICE account is itself immutable via `users/[id]` (cannot be
demoted or deleted). See
[`../auth/user-creation.md`](../auth/user-creation.md#first-admin-bootstrap).

## GDPR Mapping

| Requirement                           | Status                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------- |
| **Art. 17 — Right to erasure**        | ✅ Personal data cascaded, residual PII scrubbed, avatar blobs removed. |
| **Art. 5(2) — Accountability**        | ✅ Append-only `DataErasureReceipt`.                                    |
| **Art. 15 — Right of access**         | ✅ `exportUserData()` — see [Subject Access Export](./data-export.md).  |
| **Art. 20 — Portability/export**      | ✅ Same path; the bundle is structured, machine-readable JSON.          |
| **Art. 5(1)(e) — Storage limitation** | ⏳ Retention purge is a separate feature (see roadmap).                 |

## Related Documentation

- [Privacy & Cookie Consent](./overview.md) — consent system
- [Security Overview](../security/overview.md) — application security
- [Auth Security](../auth/security.md) — sessions, password handling
- `lib/privacy/erasure-hooks.ts` — the app erasure cleanup-hook registry
- [`CUSTOMIZATION.md`](../../CUSTOMIZATION.md#4-database-schema) — Building on Sunrise: the satellite profile-table pattern for extending `User`
