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
| What cascades vs. is retained | Per-table `onDelete` in `prisma/schema.prisma`                        |

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

## Erasure Receipt (Accountability)

`DataErasureReceipt` (`prisma/schema.prisma`, migration `add_data_erasure_receipt`)
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
