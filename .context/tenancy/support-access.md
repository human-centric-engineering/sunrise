# Support access: an org's consent to vendor support

At `TENANCY_MODE=multi` the customer org is the data controller and the
platform is its processor. So a platform admin who is not a member of a
customer's org cannot get into it (`lib/tenancy/entry.ts`), and should not
become a member to get in: that is standing access with no time limit, no
consent on record, and an audit trail that reads as the org's own user.

A **support grant** is the org's consent instead: its OWNER lets the vendor's
support staff in, at a level, for a stated reason and a bounded time. This
page covers the grant, entering an org under one (t-824), and how every
audit row made inside names the grant, for the vendor and for the org (t-825).

## Quick Reference

| Need                     | Where                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| The model                | `OrgSupportGrant` + `SupportGrantLevel` in `prisma/schema/tenancy.prisma`                         |
| The rules                | `lib/tenancy/support-grants.ts`                                                                   |
| Is the org's grant open? | `findOpenSupportGrant(orgId)`, or the `openSupportGrantWhere(now)` filter                         |
| Levels                   | `SUPPORT_GRANT_LEVELS`, `DEFAULT_SUPPORT_GRANT_LEVEL` (`lib/tenancy/roles.ts`)                    |
| Durations                | `SUPPORT_GRANT_DEFAULT_HOURS` (24), `SUPPORT_GRANT_MAX_HOURS` (168), `lib/validations/tenancy.ts` |
| List / grant             | `GET` / `POST /api/v1/orgs/[id]/support-grants`                                                   |
| Revoke                   | `DELETE /api/v1/orgs/[id]/support-grants/[grantId]`                                               |
| The org's page           | `/admin/support-access` (org-tier, nav shown at `multi` only)                                     |
| The vendor's view        | the **Support access** column on `/admin/orgs` (`GET /api/v1/admin/orgs` → `supportGrant`)        |
| Enter under a grant      | **Enter as support** on `/admin/orgs` → `POST /api/v1/orgs/switch`                                |
| Does a grant admit now?  | `verifiedSupportGrant(orgId)` in `lib/tenancy/entry.ts`                                           |
| What support presents as | `lib/auth/support-principal.ts`                                                                   |
| Entering outside guards  | `presentSessionEntry(session, entry, method)` after `enterSessionOrg()`                           |
| The banner               | `components/admin/support-banner.tsx`, fed by `requestSupportSession()`                           |
| An audit row's grant     | `AiAdminAuditLog.supportGrantId` / `supportOrgId`, stamped by `logAdminAction()`                  |
| What support did         | `GET /api/v1/orgs/[id]/support-grants/activity`, `listSupportActivity()`                          |

### Anti-patterns

- **Letting platform standing grant.** The policy admits a platform admin to
  every org's routes, and in the install org their role is OWNER. A grant
  check that reads `isPlatformAdmin`, lifecycle's owner standing, or the
  principal's `orgRole` without checking `principal.orgId` lets the vendor
  consent on the customer's behalf. `grantSupportAccess` requires
  `actor.orgId === orgId && actor.orgRole === OWNER`, and the route test pins
  the platform-admin case.
- **Making the grant tenant-owned.** Entry reads it before any org is entered.
  Under row isolation a tenant-owned grant would be invisible exactly then.
  It is in `SYSTEM_MODELS`, beside `OrgMembership`, for that reason.
- **Writing on expiry.** Nothing runs when a grant expires. "Open" is
  computed, `revokedAt IS NULL AND expiresAt > now`, and
  `openSupportGrantWhere` is the one statement of it.
- **Telling a policy "this is support" with a flag.** A support actor is a
  platform admin, and a fork's `canAdminister` written as
  `isPlatformAdmin(viewer)` would hand them the whole console inside the
  customer's org whatever flag core set. The guards instead replace the
  platform role with the default user role on the principal and on the
  handler's session (`presentedRole` / `presentedSession`), which is
  fail-closed for every policy and every handler check.
- **Caching the right to be there.** Entry re-reads the grant on every
  request. The 5-minute session cookie cache holds `activeOrgId`, never the
  grant, so expiry and revocation refuse the very next request.
- **Deleting grants.** An ended grant is the org's record of what it agreed
  to. Grants go only with their org (`eraseOrg`), and keep standing when the
  person who granted or revoked them is erased (`SetNull`).

## The rules

| Act    | Who                                                                              | Refused                                                              |
| ------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Read   | Whom the org arm admits: the org's OWNER/ADMIN acting in it, or a platform admin | A MEMBER, anyone acting in another org, an API key                   |
| Grant  | An OWNER of this org, acting in it. Never platform standing                      | At `single`; the install org; a suspended or missing org; an API key |
| Revoke | Whom the org arm admits. Ending access is always safe                            | A grant id that is not this org's (404); an API key                  |

- **Level.** `ADMIN` by default: support may do what an org ADMIN of the org
  may (§121 ruling 2). The OWNER may restrict a grant to `READ_ONLY`.
- **Any platform admin** may use an open grant (ruling 1). Each entry and
  audit row names the person, so accountability stays per person.
- **Bounded.** 24 hours unless the OWNER chooses, never past 7 days. A longer
  need is a new grant with a new reason.
- **One open per org.** A new grant revokes the open one, as the person
  granting, in the same SERIALIZABLE transaction. The route audits both
  (`support_grant.replace` for each grant revoked, then `support_grant.create`),
  and answers with the new grant and `replacedGrantIds`. Two grants for one org
  at the same moment: the later fails with 409 `GRANT_CONFLICT` and writes
  nothing.
- **Revoking an ended grant** answers 200 with `revoked: false` and writes
  nothing, so a second click or a race with expiry is not an error.

Audit actions: `support_grant.create`, `support_grant.replace`,
`support_grant.revoke`, all `entityType: 'support_grant'`, with the org id in
`metadata`.

## Entering under a grant (t-824)

A platform admin, at `multi`, who is **not** a member of an org, is admitted
to it while it has a grant that `verifiedSupportGrant` finds: open (not
revoked, not expired), its org `ACTIVE`, not the install org, and its
**granter still an OWNER of the org**. A grant is consent, and consent from
someone who has since been removed or demoted (or erased, which nulls
`grantedById`) admits nobody. Nothing is written when that happens; the grant
reads as open in the history until it expires.

- **One rule, both paths.** `enterSessionOrg` falls through to the grant only
  on `not-a-member`, for the resolver header and `activeOrgId` alike. A
  platform admin who is a member enters as that member. A member of a
  suspended org stays refused as suspended. API keys never take this path.
- **The entry.** Source `'support'`, role `ADMIN`, and `support: { grantId,
level, expiresAt }`. The tenant context carries the same `support` field,
  which is what the audit log reads (see [Audit rows](#audit-rows-t-825)).
- **What the actor is.** An org ADMIN of that org who is **not** a platform
  admin (§121 ruling 3). The guards present the default user role on the
  principal and on the session the handler gets, and `sessionPrincipal` does
  the same for the admin layout and maintenance bypass. So the default policy
  admits org-tier surfaces only, the owner layer included;
  `adminPageViewerTier()` answers `org`; platform-tier routes and pages
  refuse; and a handler's own `isPlatformAdmin(session.user)` is false. The
  user id is untouched, so every row names the individual.
- **READ_ONLY.** Both guards refuse every method but `GET`, `HEAD` and
  `OPTIONS` (a missing method too), with a 403, before the resource
  resolver, the policy or the handler runs. It goes by method alone, so a
  `POST` that only reads (the knowledge base search test, an estimate) is
  refused too: the safe direction for a rule that cannot see what a handler
  does.
- **Switching in and out.** `POST /api/v1/orgs/switch` admits a platform
  admin into an org whose grant `verifiedSupportGrant` finds, and writes a
  `support.enter` audit row (`entityType: 'support_grant'`, the grant's id,
  the org id, level and expiry in `metadata`). The response carries
  `support: { grantId, level, expiresAt }`, or `null` for a member's switch.
  Ending a session is a switch back to the install org. The route does not
  enter the current org, so it works from one whose grant has ended.
- **The banner.** The admin layout shows `SupportBanner` for the whole
  session: the org, the level, the time left, and **End support session**.
  When the grant ends mid-session the next request is refused. The layout then
  recognises a platform admin refused entry to an org that has granted support
  before, and shows the banner's ended state with the same way back (`HB10`).
- **No credentials.** `orgForMint()` refuses inside a support session, so no
  embed token, invite token, MCP key or personal API key is bound to the
  customer org under a grant. Those are checked against the org's status when
  used, not against the grant, so one minted under a grant would outlive it.
- **Maintenance.** The maintenance bypass asks the policy about the platform
  admin's own role, with no org facts, inside a support session. Otherwise the
  presented plain-user role would put them on the maintenance page,
  the banner's way back included.
- **The ended state** shows only to a platform admin who entered that org as
  support (a `support.enter` row for one of its grants). An admin who was a
  member and was removed is not told a support session ended.
- **The Organisations list** offers **Enter as support** only for a grant
  entry would admit (the granter still an OWNER of the org).
- **Account deletion.** `DELETE /api/v1/users/me` refuses inside a support
  session: the presented role would otherwise skip its last-admin check.

## Entering an org outside the guards

`withAuth` / `withAdminAuth` apply both support rules for every route they
wrap. A route that enters an org itself, with `getServerSession()` and
`enterSessionOrg()` (one that also serves a cookie-less caller, say), gets the
raw entry: source `'support'`, role ADMIN, and a session whose user is still a
platform `ADMIN`. Nothing refuses its writes under a READ_ONLY grant, and
nothing scopes the work to the org. Three things are then the caller's duty:

```typescript
const entry = await enterSessionOrg(user, activeOrgId, headerOrgId);
if (isOrgRefusal(entry)) throw new ForbiddenError('Access denied');
// 403 (logged) for a write under a READ_ONLY grant; the default user role inside support.
const session = presentSessionEntry(rawSession, entry, request.method, { path });
// Run the work in the org's tenant context, as the guards do: row isolation
// reads it, and so does the support stamp on audit rows.
return runAsOrg(entry.orgId, () => handle(session), {
  source: entry.source,
  role: entry.role,
  ...(entry.support ? { support: entry.support } : {}),
});
```

Without the `runAsOrg`, `logAdminAction()` finds no support context, so the
row carries no `supportGrantId` and the action is missing from the org's view
of what support did ([Audit rows](#audit-rows-t-825)).

Use the presented `session` for every check after entry. A check on the raw
session's `isPlatformAdmin(session.user)` is true for a support actor, so an
"admin, or a member of this row's org" rule would admit them at both levels.
Before 0.15.0 the same caller was refused `not-a-member`, so a route written
then may need this added. `isSupportEntry(entry)` is there for a route that
should refuse support outright.

## Audit rows (t-825)

Every admin audit row made inside a support session carries
`supportGrantId` (the grant, `SetNull`) and `supportOrgId` (the org, no FK).
`logAdminAction()` stamps them from the tenant context, so no route passes
anything; the switch route stamps its `support.enter` row itself, because it
does not enter the org. The full rules, including what is not stamped, are in
[the audit log guide](../admin/orchestration-audit-log.md#support-rows).

- **The vendor** sees a **Support** badge on those rows in the Audit Log, and
  filters by support sessions or by one grant.
- **The org** sees them on its Support access page, below the grants: when
  support entered, and what they did, newest first, filterable by grant. The
  read (`listSupportActivity`) names the grant **and** requires it to be the
  org's, in one query. `AiAdminAuditLog` is a system model, so row isolation
  does not bound it; that condition does, and another org's grant id matches
  nothing. Admission is the grant list's: the org's OWNER/ADMIN acting in it,
  or a platform admin, and never an API key.
- **What the org gets.** Action, entity and when, the person's name, and the
  grant. Not the IP address, which is the support person's, and not the
  `changes` diff: the vendor's log keeps both.
- **After the org is erased** the grant goes and `supportGrantId` with it.
  `supportOrgId` stays, so the vendor's own log still says which rows were
  support, and where.

## Privacy

- **Subject export** (`SUBJECT_DATA_SOURCES`): `supportGrants`, attribution.
  The person receives the fact that they granted or revoked access for an org,
  labelled with the org's name, not the grant's reason or terms. Those are the
  org's.
- **Org export** (`ORG_DATA_SOURCES`): `supportGrants`, export. Every grant,
  with the names of who granted and who ended it.
- **Erasure.** A person's erasure nulls `grantedById` / `revokedById`. The
  org's erasure cascades its grants.
- **Audit rows** (t-825). The support person's own subject export already
  carries their audit rows, now with the grant and org ids, which say where
  their act happened. Their erasure nulls `userId` and `clientIp` as before
  and leaves the support columns, which name no one once the person is gone.
  The org's export does not include these rows: they are the vendor's log.

## Not here

- **User impersonation** (seeing exactly what one user sees) is deliberately
  not built (§121 ruling 4): support enters as themselves. It would need the
  user's consent as well as the org's.
- **Email to the org on entry** is not in v1. The org reads entries on its
  Support access page.
- **An org switcher in the console.** Support enters from the Organisations
  page and leaves from the banner. A platform admin on a platform-tier page
  during a support session is sent to the landing route, as an org admin is.

## Related

- [Org identity](./identity.md) — `Org`, `OrgMembership` and the lifecycle
  rules this page sits beside
- [Tenant context](./context.md) — how a request enters an org
- [Multi-tenancy design record](../architecture/multi-tenancy-design.md) —
  decision Q7
