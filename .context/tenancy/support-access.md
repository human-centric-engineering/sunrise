# Support access: an org's consent to vendor support

At `TENANCY_MODE=multi` the customer org is the data controller and the
platform is its processor. So a platform admin who is not a member of a
customer's org cannot get into it (`lib/tenancy/entry.ts`), and should not
become a member to get in: that is standing access with no time limit, no
consent on record, and an audit trail that reads as the org's own user.

A **support grant** is the org's consent instead: its OWNER lets the vendor's
support staff in, at a level, for a stated reason and a bounded time. This
page covers the grant. Entering an org under one, and how the audit log names
the support actor, are §121's later tasks (t-824, t-825); until t-824 lands, a
grant is recorded and listed but admits nobody.

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

## Privacy

- **Subject export** (`SUBJECT_DATA_SOURCES`): `supportGrants`, attribution.
  The person receives the fact that they granted or revoked access for an org,
  labelled with the org's name, not the grant's reason or terms. Those are the
  org's.
- **Org export** (`ORG_DATA_SOURCES`): `supportGrants`, export. Every grant,
  with the names of who granted and who ended it.
- **Erasure.** A person's erasure nulls `grantedById` / `revokedById`. The
  org's erasure cascades its grants.

## Not here

- **User impersonation** (seeing exactly what one user sees) is deliberately
  not built (§121 ruling 4): support enters as themselves. It would need the
  user's consent as well as the org's.
- **Email to the org on entry** is not in v1. The org reads entries off its
  grant list once t-825 lands.

## Related

- [Org identity](./identity.md) — `Org`, `OrgMembership` and the lifecycle
  rules this page sits beside
- [Tenant context](./context.md) — how a request enters an org
- [Multi-tenancy design record](../architecture/multi-tenancy-design.md) —
  decision Q7
