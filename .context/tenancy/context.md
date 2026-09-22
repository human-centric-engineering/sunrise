# Tenant Context

Which org a request — or a job, or a script — is acting for, how that is
decided, and what reads it. The second piece of the multi-tenancy programme
([design record](../architecture/multi-tenancy-design.md), Hub §106); the
identity it rests on is [`identity.md`](./identity.md). Row isolation (§107)
and the job scopes (§108) build on the primitive this page describes and are
named here only where it has to promise them something.

**At `TENANCY_MODE=single` the install org is the only answer**, and every
component on this page runs anyway — that is the point. A single-tenant
install exercises the same guard entry, the same policy arm, the same
context and the same data-layer chokepoint every multi-tenant install does,
with the install org where a tenant would be. Nothing here changes what a single-tenant install does, and
[`authorization-org.test.ts`](../../tests/unit/lib/auth/authorization-org.test.ts)
proves it by sweep rather than by sentence.

## Quick Reference

| Need                                         | Use                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| The org this call stack acts for             | `getTenantContext()` (nullable) / `requireTenantContext()` — `lib/tenancy/context.ts` |
| Run something as an org / as the platform    | `runAsOrg(orgId, fn)` / `runAsSystem(reason, fn)` — same module                       |
| Iterate every active org, one scope each     | `forEachOrg(fn)` — same module; the maintenance tick's per-org jobs run through it    |
| Is this install multi-tenant?                | `isMultiTenant()` — same module (`env.TENANCY_MODE`)                                  |
| How the guards decide the org for a request  | `enterSessionOrg` / `enterApiKeyOrg` — `lib/tenancy/entry.ts`                         |
| The org facts the policy is told             | `viewer.orgId` / `viewer.orgRole` on `AuthorizationPrincipal`; `scope.org`            |
| Resolve a tenant in the proxy (fork)         | `registerAppTenantResolver()` — `lib/app/tenant-resolver.ts` (Web-standard only)      |
| The header the proxy writes, the guards read | `TENANT_HEADER_NAME` = `x-sunrise-org` — `lib/tenancy/resolver.ts`                    |
| The org in a log line                        | `orgId` in `getRequestContext()` / `getFullContext()` — `lib/logging/context.ts`      |

### Anti-Pattern

**Don't** read the org from the session, the header, or the tenant context
inside a handler or a policy:

```typescript
// ❌ Three different answers on a bad day, and none of them verified.
const orgId = session.session.activeOrgId ?? request.headers.get('x-sunrise-org');

// ❌ A policy that sniffs the context is testable only inside a scope, and
//    wrong for a caller holding a principal but no context.
canAdminister: async (viewer) => getTenantContext()?.role === 'OWNER';
```

```typescript
// ✅ The guard decided once, verified membership, and told everyone.
//    Handlers and jobs read the context; policies read the principal.
const { orgId } = requireTenantContext(); // in a handler or a job
canAdminister: async (viewer, resource) =>
  // in a policy
  resource?.orgId !== undefined &&
  resource.orgId === viewer.orgId &&
  orgAdministers(viewer.orgRole);
```

## The primitive — `lib/tenancy/context.ts`

An `AsyncLocalStorage<TenantContext>` (the `lib/auth/signup-mode.ts`
precedent), where

```typescript
interface TenantContext {
  orgId: string | null; // null only for a `system` scope
  source:
    | 'session'
    | 'api-key'
    | 'embed-token'
    | 'mcp-key'
    | 'resolver'
    | 'inbound-trigger'
    | 'approval-token' // a signed token naming a ROW (t-708)
    | 'system'
    | 'job'
    | 'implicit';
  role?: OrgRole | null; // the caller's role in orgId, when the entering code looked it up
}
```

- **`getTenantContext()`** — the scope, or `null` when none was entered.
- **`requireTenantContext()`** — the scope; at `multi` **throws** when none
  was entered (a request path or job nobody taught to enter one — refusing
  before a query runs wide is the only safe answer); at `single` answers the
  install org marked `implicit`, the eighth source, so a log line can tell it
  from a real entry.
- **`requireOrgId()`** — the entered org, for a lookup that has to name it: a
  per-org unique key (`orgId_slug` on an agent, a knowledge base or a
  document, t-708) cannot be asked without saying whose `support` is meant.
  The same answers as `requireTenantContext`, and the `system` scope is
  refused too — a global scope cannot name one org's row by slug, it has to
  search (`findFirst({ where: { slug } })` inside an org is the shape every
  slug read uses).
- **`runAsOrg(orgId, fn, { source?, role? })`** — the scope covers `fn`'s
  whole async subtree and nothing outside it. A throw does not leak the
  context to the next caller; concurrent work on the same process does not
  see it. The six ALS guarantees are pinned by
  [`context.test.ts`](../../tests/unit/lib/tenancy/context.test.ts). The
  seam **awaits `fn` inside the scope** rather than merely calling it there:
  a `PrismaPromise` is lazy and reads the context when it is awaited, so
  `runAsOrg(org, () => prisma.x.findMany())` — a non-async callback — would
  otherwise hand the promise out unawaited and lose its org (§107 t-704
  measured it both ways; t-706 fixed it here rather than as a rule for every
  caller).
- **`runAsSystem(reason, fn)`** — the audited platform bypass: no org, and
  the reason logged at `info` on every entry. For genuinely global work
  only; at `multi` this is the one scope the data layer lets through
  unscoped — it sets `app.bypass_rls` for the transaction instead of an org
  (below).
- **`runAsCredentialLookup(credential, fn)`** (t-709) — the same null-org
  system scope, for the ONE read that learns which org a credential belongs
  to: a key hash, an embed token, an MCP key, a trigger row, an execution
  named by an approval token. Logged at `debug`, because it runs once per
  credential-authenticated request and an `info` line per entry would drown
  the signal `runAsSystem`'s log exists to give (an unexplained bypass); the
  sites are enumerable by grep, and what an audit needs is that nothing but
  the lookup — and the credential's last-used touch, which rides with it —
  runs inside one.
- **`forEachOrg(fn)`** — one `runAsOrg` scope per `ACTIVE` org, sequential on
  purpose (per-org batch caps are meaningless if every org runs at once).
  The maintenance tick's per-org jobs run through it (§108 t-711) — see
  "Background work" below.

## Who enters it — the read rule

The guards enter the org for every request they admit, from one of three
sources, and it is decided **once** ([`lib/tenancy/entry.ts`](../../lib/tenancy/entry.ts)):

| Source              | Where the org comes from                                       | Verified against membership?                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolver` (header) | `x-sunrise-org`, written by the proxy from the fork's resolver | **Always** — including the install org, including a platform admin. The header picks _which_ org; it never grants entry. Wins over the session for that request.                                         |
| `session`           | `session.session.activeOrgId` (t-670)                          | When it names a non-install org, or at `multi`. **At `single`, null or the install org enters the install org with no read** — the role is the platform role projected by `initialMembershipFor`'s rule. |
| `api-key`           | the key's `orgId` — the org it was minted in (t-673)           | `admin` scope ⇒ a platform credential, **no org entered** (finding 13). Otherwise: bound ⇒ that org, verified against the owner's membership; unbound ⇒ install org at `single`, refused at `multi`.     |
| `embed-token`       | the token's `orgId` (t-673)                                    | No user to verify: the org's own status is read with the token (`resolveCredentialOrg`) — a suspended org's tokens are refused. Unbound ⇒ install org at `single`, refused at `multi`.                   |
| `mcp-key`           | the key's `orgId` (t-673)                                      | As `embed-token`. The transport wraps each method in `runAsOrg`; the key outlives its creator but not its org.                                                                                           |

**Why the install org needs no read at `single`.** Every user is a member of
the install org (the identity invariant) and their role in it is the platform
role's projection — the ONE statement the migration's backfill and the signup
hook also apply. Reading the row would confirm what the rule already says. It
is also what keeps the guards' hot path free of a per-request query on every
single-tenant install, and every route test that runs the real guards free of
a Prisma mock it never needed (124 test files run them; 91 mock Prisma
without `orgMembership`, 32 not at all). The row is kept in step with the
projection: a platform-role change re-applies the rule to the install
membership (ruling a, [identity.md](./identity.md#the-invariant-one-install-org-every-user-a-member)),
and the members API refuses to edit install-org roles. The one remaining way
the two can differ is an invitation that names an explicit `orgRole` on the
install org, which is honoured as written.

**A refusal is a 403 that names nothing.** "Not a member" and "no such org"
are one answer; a suspended org is refused with the same words. The guard's
log line (`tenancy: refused to enter an org for a request`) carries the
reason.

**Two routes do not enter the session's org:** `POST /api/v1/orgs/switch`
and `GET /api/v1/orgs` declare `tenancy: { entersOrg: false, because }`
(`WithAuthOptions`), so a member whose active org was suspended, or who was
removed from it, can still see their orgs and reach the way out — a switch
behind the refusal would lock them out of every other org they belong to. Both
handlers run outside any scope, with no org facts on the principal, and read
only the caller's own membership rows (the switch checks membership of the org
it switches _to_).
The marker carries a required `because`, like `ownership`; it is not a lever
for making a 403 go away. Sign-in helps too: `activeOrgForSession` chooses
among the user's **active** orgs, so a member of one suspended and one active
org starts in the active one; a user whose every org is suspended starts in
the most recent of them and is refused at entry, which is what suspension
means.

**Then the guard carries the org two ways:** on the principal (`viewer.orgId`,
`viewer.orgRole`) for the policy, and as the tenant context that the
route's `resource` resolver, the policy call and the handler all run inside
— one `runAsOrg` around all three, so the resolver's own query is scoped the
same way the handler's are.
A platform credential runs outside any scope.

**Also entered, by the guard-less routes themselves:** the webhook trigger
(`app/api/v1/webhooks/trigger/[slug]`) from its API key; the three embed
routes (`app/api/v1/embed/**`) from the embed token; the MCP transport
(`app/api/v1/mcp`) from the MCP key — each resolver applies the read rule
and the route wraps its handler in `runAsOrg` (t-673). **An agent invite
token enters nothing**: it is a gate the session passes through, and
`lib/orchestration/invite-tokens.ts` compares the token's org with the one
the guard entered ([agent-visibility.md](../orchestration/agent-visibility.md#org-binding-106)).
**Entered from the row, by the two routes whose credential is a signed token
naming a row rather than a principal** (t-708): the inbound trigger route
(`app/api/v1/inbound/[channel]/[slug]`) and the HMAC approval routes
(`approvals/[id]/{approve,reject,status}` and their `chat`/`embed` variants,
through `runAsExecutionOrg` in `lib/orchestration/approval-route-helpers.ts`).
Nothing has authenticated when they look their row up, so that one read —
the trigger by `(channel, workflow.slug)`, the execution by id — runs under
`runAsCredentialLookup` (`inbound-trigger`, `approval-token`; t-709 moved
them from `runAsSystem` to the quieter scope), and the row's `orgId` with its org's status goes through the same
`resolveCredentialOrg` rule a credential's does before the rest of the
request runs inside `runAsOrg(orgId, …, { source: 'inbound-trigger' |
'approval-token' })`. A refusal — no org at `multi`, a suspended org — is
the route's usual 404. The fire-and-forget engine drain and resume start
inside that scope and keep it.
**The credential resolvers read their row the same way** (t-709):
`resolveApiKey` (`lib/auth/api-keys.ts`), `resolveEmbedToken`
(`lib/embed/auth.ts`) and `authenticateMcpRequest`
(`lib/orchestration/mcp/auth.ts`) each read a tenant-owned credential row
**to learn** the org the guard or route then enters, so that one lookup —
and the `lastUsedAt` touch that rides with it, which has no org to run in
either (a platform `admin` key has none) — runs under
`runAsCredentialLookup(<credential>)`. The resolver hands the org back; it
never enters it. Pinned in each resolver's unit test by recording
`getTenantContext()` inside the prisma mock at `multi` with no context.
**Background work enters it per job** (§108 t-711). Every task in the
maintenance tick — the platform's own (`lib/orchestration/maintenance/platform-jobs.ts`),
the schedules sweep, and a fork's `registerAppJob` registrations — declares a
`scope` and is run by `lib/orchestration/maintenance/job-scope.ts`:

- **`'per-org'`** — `forEachOrg`: once per `ACTIVE` org, each run inside
  `runAsOrg(orgId, …, { source: 'job' })`. Inside it the data layer stamps
  every create and, at `multi`, the policies confine every read and write —
  so a `take: 50` in the job body is a per-org cap. This is the scope for
  **every** job that touches a tenant-owned table, including the ones that
  read like global queue drains: the zombie reaper writes lease events,
  orphan/pending recovery and the scheduler start the engine (and the `void
drainEngine` continuation keeps the scope it was started in — pinned by
  test), the evaluation worker writes cases. Under the system scope nothing
  is stamped, and each of those would land a `NULL`-org row outside every
  policy for good. At `single` the one org is the install org and the run
  happens once, with the result untouched; at `multi` the results fold
  across orgs and a failing org is contained, logged with its id, and the
  next org still runs.
- **`{ system: reason }`** — `runAsSystem(reason)`, once, for genuinely global
  work: in core, the prune of the two system audit tables
  (`auditLogRetention`) and the idle gate's horizon read (the earliest
  `nextRunAt` across every org). The reason is what the audit line carries.

A tick fired from an admin's session does **not** inherit that admin's org:
each job enters its own scope, and `tests/unit/lib/orchestration/maintenance/run-tick.test.ts`
starts the tick inside a foreign org to prove it. A fork's job with no
`scope` gets `'per-org'` — a job that forgets is scoped, never bypassing
([scheduling.md → App jobs](../orchestration/scheduling.md#app-jobs--the-fork-seam-on-the-tick)).
The smoke scripts under `scripts/smoke/` run their `main` inside
`runAsOrg(INSTALL_ORG_ID)`; `scripts/smoke/tenancy-isolation.ts` drives a
per-org job through the registry as its scenario [10].

## The fork's resolver — `lib/app/tenant-resolver.ts`

A subdomain scheme, a path prefix, a header from an upstream gateway:
Sunrise core does not know which and ships none. A fork registers **one**
resolver from the scaffold (`registerAppTenantResolver()` →
`registerTenantResolver(fn)` in `lib/tenancy/resolver.ts`); `proxy.ts` calls
the scaffold once at module scope and asks the resolver on every request.

The header contract — the `x-visitor-id` shape, and the `else` is the
security property:

```typescript
const tenantOrgId = resolveTenantFromRequest(request);
if (tenantOrgId) requestHeaders.set('x-sunrise-org', tenantOrgId);
else requestHeaders.delete('x-sunrise-org'); // strip any inbound copy
```

The proxy is the header's **sole writer**, so a client cannot pick its org by
header; the guard trusts it for _which_ org only because of that, and still
verifies membership. A resolver that throws answers `null` and the proxy logs
it at `error` — every request it throws on falls back to the session's org
while the hostname says otherwise, which must never be silent — and an answer
that is not org-id shaped (`[A-Za-z0-9_-]{1,200}`) is `null` too, so a value
derived from an inbound header can never make `Headers.set` throw. The
second half is load-bearing on its own: the proxy's
matcher skips paths ending in an image extension (`/api/v1/users/x.png`
reaches a guard unproxied), and there the header arrives unstripped — which
lets a caller enter only an org they are already a member of, exactly what
the switch lets them do. A resolver picks; membership admits. A resolver that throws answers `null` (the proxy strips
the header rather than 500-ing the site). **Web-standard only**: the resolver
runs in the proxy, so `Request`, `URL`, `Headers` and nothing that needs Node
or Prisma — answer from what you can verify without I/O (the hostname, a
signed cookie) and leave the membership check to the guard. (The proxy's
bundle already carries `lib/auth/config` through the logging context and
`AsyncLocalStorage` through `signup-mode.ts`; the constraint is on the
resolver and its module, which stay import-free.)

Standing steps the scaffold carries, all enforced: a row in
`defaults.test.ts`, the `### Covered` bullet in `VERSIONING.md`, the
registrar count and `proxy.ts` as a consumer in `fork-init-seams.test.ts`,
and its row in [`fork-init-seams.md`](../architecture/fork-init-seams.md).

## What reads it

- **The authorization policy** reads the org facts from the **principal**,
  never from the context — [`auth/authorization.md`](../auth/authorization.md#the-org-input)
  has the arm and everything it deliberately does not grant.
- **The log context**: `getRequestContext()` and `getFullContext()` carry
  `orgId` inside a scope and omit it outside, so scoping a breach to an org
  is a lookup on the logs.
- **The admin layout and the maintenance wrapper** pass the session's org on
  the principal with no org role: they ask with `resource: null`, where the
  org arm grants nothing by design, so a membership read could not change the
  answer.
- **The data layer** — the section below — stamps and scopes every query by
  it, which is why `multi` throws rather than answers when nothing entered a
  context.

## The data layer — `lib/db/tenancy-extension.ts`

The client every importer receives from `lib/db/client.ts` is the base
`PrismaClient` through `withTenancy()`, a Prisma `$extends` that reads this
context below the handler. No route, job or script learns about `orgId`.
Two behaviours, and only these:

- **Every create of a tenant-owned row is stamped** with the context's org
  — at `single` the install org when nothing entered a context — in both
  modes, one code path. The walk runs on every write whatever the root model
  (an `AiAgent` update carrying a nested `embedTokens.create`), descends
  nested `create` / `createMany` / `connectOrCreate` / `update` / `upsert`,
  and stamps **create-shaped nodes only**: an update payload is never
  stamped, because that would move a row between orgs wherever RLS is not
  enforcing. The stamp takes the form the row already uses — the scalar
  `orgId`, or `org: { connect }` when the row names a relation carrying its
  own foreign key (`creator: { connect }`), since Prisma's checked create
  form forbids the scalar beside it; which relations those are is read from
  the schema the client embeds (`lib/tenancy/classification.ts`,
  `foreignKeyRelations`). An explicit `orgId` or `org` is never overwritten;
  a create reached through the org relation itself is left to the nesting;
  under `runAsSystem` nothing is stamped.
- **At `multi` every operation on a tenant-owned model, every raw op, every
  read on a non-tenant model that reaches a tenant-owned one through a
  relation at any depth (an `include` / `select` / `_count`, a relation
  filter, a relation `orderBy` — `aiCapability.findMany({ include: { agents } })` would
  otherwise answer "no agents" for every org under the policies rather than
  fail), and — when a context exists — every write on any model runs as
  `$transaction([set_config('app.current_org', <org>, true), op])`**, the
  transaction-local GUC the `org_isolation` policies read; `runAsSystem`
  sets `app.bypass_rls` instead. An interactive or batch `$transaction`
  gets one setter at its top (the override delegates to the runtime's own
  `$transaction` with the outermost client as `this`, so a later layer's
  hooks fire inside transactions too). Reads on non-tenant models stay
  unwrapped; a no-context write on a non-tenant root passes through — that
  is `POST /orgs/switch` writing `Session.activeOrgId`. **An operation that
  needs an org and has none throws before any SQL** — a path nobody taught
  to enter an org fails loud instead of reading wide. A `$transaction`
  opened for one org refuses an op for another inside it.

  The one such path that existed — the credential resolvers' own row
  lookup, which reads a tenant-owned row **to learn** the org it will then
  enter — runs under `runAsCredentialLookup` since t-709 (above); the
  chokepoint sees a null-org system scope and sets the bypass for that one
  statement.

At `single` **no `set_config` is ever issued** and no transaction is opened
that the caller did not ask for. The design record's Spike register
([`multi-tenancy-design.md`](../architecture/multi-tenancy-design.md#spike-register))
carries the measurements behind each rule; the bypass-as-GUC choice (item 9)
is a §107 journal decision.

Enabling `multi` is only correct with the policies enabled
(`npm run db:tenancy:enable`) and the app connecting as a `NOBYPASSRLS` role
that does not own the tables — on Neon the deploy role has `BYPASSRLS` and
is never subject to a policy. The policies, the switch, the role split and
the drift probes are [`isolation.md`](./isolation.md).

## Proving it

- [`tests/unit/lib/tenancy/context.test.ts`](../../tests/unit/lib/tenancy/context.test.ts)
  — the six ALS behaviours, both modes of `requireTenantContext`,
  `runAsSystem`'s logged reason, `forEachOrg`'s one-scope-per-active-org,
  and the seam keeping a non-async callback's context.
- [`tests/unit/lib/orchestration/maintenance/job-scope.test.ts`](../../tests/unit/lib/orchestration/maintenance/job-scope.test.ts),
  [`platform-jobs.test.ts`](../../tests/unit/lib/orchestration/maintenance/platform-jobs.test.ts),
  [`app-jobs.test.ts`](../../tests/unit/lib/orchestration/maintenance/app-jobs.test.ts),
  [`run-tick.test.ts`](../../tests/unit/lib/orchestration/maintenance/run-tick.test.ts)
  — the job scopes: every platform task's declared scope, once inside the
  install org at `single` with the summary unchanged, once per org at
  `multi` with the fold and per-org containment, the system scope's audit
  line, and a tick started inside a foreign org sweeping every org.
- [`tests/unit/lib/db/tenancy-extension.test.ts`](../../tests/unit/lib/db/tenancy-extension.test.ts)
  — the real generated client and the real extension on a recording driver
  adapter: the stamped column on every create shape at both modes, no
  `set_config` at `single`, the exact statements and transaction boundaries
  at `multi`, the bypass GUC under `runAsSystem`, the refusal with no
  context, and the undocumented `__internalParams.transaction` the
  pass-through keys on.
- [`tests/unit/lib/tenancy/entry.test.ts`](../../tests/unit/lib/tenancy/entry.test.ts)
  — every arm of the read rule, both credentials, both modes; the install
  org's no-read at `single` asserted by the mock never being called.
- [`tests/unit/lib/auth/guards-tenancy.test.ts`](../../tests/unit/lib/auth/guards-tenancy.test.ts)
  — the three sources through the real guards, refusals, the header winning,
  the handler inside the scope the policy saw.
- [`tests/unit/lib/security/proxy.test.ts`](../../tests/unit/lib/security/proxy.test.ts)
  — `x-sunrise-org` set from a resolver and stripped without one.
- [`tests/unit/lib/auth/authorization-org.test.ts`](../../tests/unit/lib/auth/authorization-org.test.ts)
  — the org arm, the byte-identical sweep, parity and reachability with an
  org admin on the roster.
- [`tests/unit/lib/tenancy/resolver.test.ts`](../../tests/unit/lib/tenancy/resolver.test.ts)
  — the registry, including a throwing resolver answering `null`.

## Related

- [Org identity](./identity.md) — the org and membership the context names
- [Authorization](../auth/authorization.md) — the policy that reads the org
- [Multi-tenancy design record](../architecture/multi-tenancy-design.md) —
  the request-path diagram this page implements down to the policy
- [Fork init seams](../architecture/fork-init-seams.md) — the registrar family
  the resolver scaffold joins
