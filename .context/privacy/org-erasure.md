# Org Erasure

How Sunrise deletes an organisation and what goes with it (§106 t-672) — "delete
us" for a customer being offboarded. The entry point is `eraseOrg()` in
`lib/privacy/erase-org.ts`; the admin endpoint calls it. The per-person
counterpart is [Account Deletion & Right to Erasure](./data-erasure.md).

## Quick Reference

| Need                          | Use                                                            |
| ----------------------------- | -------------------------------------------------------------- |
| Erase an org (the only way)   | `eraseOrg()` — `lib/privacy/erase-org.ts`                      |
| The vendor erases a client    | `DELETE /api/v1/admin/orgs/[id]` (platform admin)              |
| The export that precedes it   | [Org Data Export](./org-export.md)                             |
| Suspend instead of erase      | `PATCH /api/v1/admin/orgs/[id]` with `{ status: "SUSPENDED" }` |
| Proving it against a database | `npm run smoke:tenancy`                                        |

### Anti-Pattern

**Don't** delete the row directly:

```typescript
// ❌ Leaves pending invitations into the org, and sessions pointing at an org
//    that no longer exists.
await prisma.org.delete({ where: { id: orgId } });
```

**Do** route through the service:

```typescript
// ✅ One transaction: invitations, session pointers, the org — and the cascade.
import { eraseOrg } from '@/lib/privacy/erase-org';

const { members, pendingInvitations, sessionsCleared } = await eraseOrg({
  orgId,
  actorUserId: session.user.id,
});
```

## What goes, and what stays

One transaction, in this order:

1. **Pending invitations into the org** — `Verification` rows whose metadata
   names it. They have no FK to `Org`, so nothing else would remove them, and
   an invitation accepted after the org was gone would create a membership
   the database refuses.
2. **The `activeOrgId` pointer on every session still acting in the org** is
   set to null. `session` is better-auth's table and carries no FK, so the
   pointer is cleared by hand before the row it names goes. The guard then
   resolves null to the install org at `single` and refuses with `no-org` at
   `multi` until the user switches or is invited somewhere. One window to
   know about: the session cookie cache (5 minutes,
   [security.md](../auth/security.md)) can still present the erased org as the
   session's active org until it expires; every guarded request in that window
   is refused at entry (`not-a-member`, since the membership is gone), and
   `GET /api/v1/orgs` plus the switch — the two routes that do not enter the
   org — remain the way to another org, as they are for a suspended one.
3. **The org row.** Memberships and the four credential kinds cascade from it
   (`onDelete: Cascade` on each) — nothing here enumerates them, and a model
   that joins the org later joins the cascade by declaring the same policy.

**Users are never deleted.** This is ruling a on the feature, and the docblock
in `erase-org.ts` records the alternatives so it reads as a decision rather
than an omission:

- _Cascade the users_ — erases accounts nobody asked to erase, and other orgs'
  members with them. Rejected.
- _Refuse to erase an org with members_ — makes offboarding a two-step with a
  manual roster purge, and the roster purge would be the cascade anyway.
  Rejected.
- **A member left with no membership keeps their account.** Their sessions
  pointing at the erased org have the pointer cleared, and
  `activeOrgForSession` gives them the install-org default at their next
  sign-in. Deleting the account is `eraseUser()`, on their own request or an
  admin's, with a receipt.

**The install org is refused** (ruling b). It is the one row that always
exists; `eraseOrg` throws `INSTALL_ORG_IMMUTABLE` before opening a
transaction, and the endpoint answers 400 with that code.

**No receipt.** The org is not a data subject; the memberships that go with it
are exported to their subjects while they exist, not after. The acting admin
and the counts are logged.

## Nothing is best-effort

A throw inside the transaction rolls the whole erasure back — the org either
exists with everything, or is gone with everything. This is the opposite of
`eraseUser()`, where app-side cleanup hooks are swallowed so app trouble can
never block a person's erasure. The asymmetry is deliberate: an org erasure is
an operator action with an operator watching, and a half-erased org is worse
than a refused one.

## Suspension is not erasure

`PATCH /api/v1/admin/orgs/[id]` with `{ status: "SUSPENDED" }` keeps every row
and refuses every request into the org at the guard
([context.md](../tenancy/context.md)). Members are not signed out; their next
request is refused and `POST /api/v1/orgs/switch` is their way to another org.
Reinstating is the same write back, with nothing to repair. Suspend first when
the question is "should this customer still have access"; erase when the
answer is "and delete our data".

## Related Documentation

- [Org Data Export](./org-export.md) — give them their data first
- [Account Deletion & Right to Erasure](./data-erasure.md) — the per-person counterpart
- [Tenancy: Org Identity](../tenancy/identity.md) — the lifecycle, and the rules the members API enforces
- [Org Endpoints](../api/org-endpoints.md) — the HTTP reference
