# Authorization

**Authentication asks who you are. Authorization asks what you may touch, and
over whose data.** Sunrise ships one answer to the second question — a platform
`ADMIN` administers everything and reads everyone; everyone else reads
themselves — behind a seam a fork replaces without editing a route.

This document is the contract for that seam: the three inputs it is shaped to
take, the recipe for owner-scoped reads, the leak that recipe prevents, and —
stated as plainly as the capabilities — the parts of the read axis that are
**not** behind the seam yet.

- **The module:** [`lib/auth/authorization.ts`](../../lib/auth/authorization.ts)
- **The fork's file:** [`lib/app/authorization.ts`](../../lib/app/authorization.ts) — ships empty
- **Guards that consult it:** [`lib/auth/guards.ts`](../../lib/auth/guards.ts)

> **Scope of this page.** It describes what ships today. Anything owned by the
> multi-tenancy programme (the org input, `Org`/`OrgMembership`, RLS) is marked
> as such and is **not** available; see
> [`multi-tenancy-design.md`](../architecture/multi-tenancy-design.md).

---

## Three orthogonal inputs, one predicate

The mistake this design exists to avoid is a single widening `role` string.
"Admin of this org", "sees only their own rows" and "is vendor staff" are three
different questions, and folding them into one enum means every new combination
is a new value.

| Axis          | Question                                                           | Supplied by                    | State today                                                                                                         |
| ------------- | ------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Tier**      | Is this principal platform staff, a customer's admin, or a member? | #366                           | `scope.tier` is carried; nothing in core populates it. A fork branches on it in its own policy.                     |
| **Ownership** | Within one tenant, over _whose_ rows?                              | #367                           | `scope.ownership` (`'own' \| 'team' \| 'all'`) is carried; `canRead` / `subjectScope` are the faces that answer it. |
| **Org**       | Which tenant's rows exist at all?                                  | Multi-tenancy programme (§106) | **Does not ship.** `scope.org` is a reserved key. Between-tenant isolation is enforced by RLS, not by this policy.  |

`AuthorizationScope` is an open struct with every member optional, so each axis
arrives as a new key rather than a new signature. That is the whole reason the
struct exists — a later `scope.org` must not be a sweep of every caller. For the
same reason **every face returns a `Promise`** although today's default body
needs none: the org input requires a membership lookup, and converting a
synchronous seam to an asynchronous one later is a caller sweep.

---

## The seam

### Where the question is asked

Sunrise consults the policy in exactly four places, and they are the reason a
fork edits nothing else. **Which face each one asks matters more than the
count** — three ask `canAdminister`, one asks `canRead`:

| Chokepoint                             | Face            | What it gates                                                                                                                                      |
| -------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withAdminAuth` (`lib/auth/guards.ts`) | `canAdminister` | 262 handler wrappings across 190 files, 257 of them under `/api/v1/admin`                                                                          |
| `app/admin/layout.tsx`                 | `canAdminister` | The whole `/admin` page tree                                                                                                                       |
| `components/maintenance-wrapper.tsx`   | `canAdminister` | The maintenance-mode bypass — an access decision, not chrome, because getting past that page reaches the whole site                                |
| `withAuth` (`lib/auth/guards.ts`)      | `canRead`       | 23 handler wrappings. Asked on **every** one of them, but no core route declares a `resource` resolver, so it is asked about `{ kind: 'nothing' }` |

Read that table before assuming an override is doing what you meant.
**Replacing `canAdminister` alone changes nothing about a `withAuth` route**,
and replacing `canRead` alone changes nothing about the 262 admin handlers.
`subjectScope` has no core call site at all.

The last row carries a trap. `canRead` runs on every `withAuth` request whether
or not the route named a resource, so **a policy that denies `'nothing'` takes
down every core `withAuth` route** — the arm exists precisely so "the route
declared no resource" is answerable without being confused for "the row has no
owner". Permit `'nothing'` unless you have migrated every route to a resolver.

### Registering a policy

`getAuthorizationPolicy()` runs `initAppAuthorizationPolicy()` once, lazily,
before the first read — which happens at the top of every guarded request. A
fork registers; it wires nothing.

```ts
// lib/app/authorization.ts
import {
  registerAuthorizationPolicy,
  DEFAULT_AUTHORIZATION_POLICY,
} from '@/lib/auth/authorization';

export function initAppAuthorizationPolicy(): void {
  registerAuthorizationPolicy({
    ...DEFAULT_AUTHORIZATION_POLICY,
    canAdminister: async (viewer, resource, scope) => {
      /* … */
    },
  });
}
```

**Spread the default and override a face; do not send a patch.** The copy is
then visible in the fork's own diff, which is what keeps "I overrode `canRead`
and forgot `subjectScope`" a thing they can see.

**Registering must be synchronous, and here that is a security property.** An
`async` `initAppAuthorizationPolicy` makes the init gate latch success on the
_promise_ rather than the work, so every read in that window — and every read
forever, if the promise rejects — gets Sunrise's default policy, the widest one,
while the safe-mode machinery reports nothing wrong. Lint catches it
(`@typescript-eslint/no-misused-promises`); [#739] tracks making the gate refuse.

### The three faces

```ts
canAdminister(viewer: AuthorizationPrincipal,
              resource: AuthorizationResource | null,
              scope: AuthorizationScope): Promise<boolean>;

canRead(viewer: AuthorizationPrincipal,
        target: ReadTarget,
        scope: AuthorizationScope): Promise<boolean>;

subjectScope(viewer: AuthorizationPrincipal,
             scope: AuthorizationScope): Promise<SubjectFilter>;
```

`canRead` takes a **union**, not a nullable id, and answering every arm is
enforced by the compiler:

```ts
type ReadTarget =
  | { kind: 'nothing' }                                        // route declared no resolver
  | { kind: 'unattributed'; resource: AuthorizationResource }  // a row with no owner
  | { kind: 'subject'; userId: string; resource: … | null };   // a row owned by someone
```

A `switch` that misses an arm returns `undefined`, which does not satisfy
`Promise<boolean>`, so an incomplete policy **fails the fork's build**. The
previous signature was `subject: string | null`, and the natural line to write
against it — `subject === null || subject === viewer.userId` — permitted every
caller on any ownerless row while reading exactly like a check. Build the target
with `readTargetFor(resource)` or `readSubject(userId)`; do not construct it by
hand at a call site, which is how two guards drifted apart in the first place.

`'unattributed'` is the arm to think hardest about. It is a row the resolver
named and could not attribute — an org-owned row, or a nullable `createdBy` on a
`SetNull` model, which `CLAUDE.md` mandates for retained config and audit models.
The default narrows it to platform staff and logs once per resource kind.

### What a failure does

Every path fails closed, and that is a deliberate outage rather than a
degradation:

- A policy method that **throws** denies, and is logged. All three faces then
  answer from `SAFE_MODE_POLICY`, so the degraded behaviour is parity-consistent
  by construction rather than hand-written per face. This is **per call**, not a
  latch: the next request goes back to the fork's policy. An intermittently
  throwing `subjectScope` therefore produces intermittently narrowed lists and
  does not close the console — unlike the registration failure below.
- A **registration** that throws puts the install in safe mode for the life of
  the process: nobody administers anything, and every declared read narrows to
  the reader's own rows.

Sunrise deliberately does **not** fall back to its own default policy on a failed
registration. A fork's policy typically _narrows_ the platform default, so
falling back would widen access under a log line saying the feature was disabled.

Safe mode does not deny a read with **no declared subject** — core routes declare
none, so denying those would take the application down over a seam that is not
yet load-bearing for them. Safe mode refuses what it was asked about, not what it
was not asked about.

---

## What is not behind the seam yet

Read this before trusting a narrowing `canRead`.

**One core route decides a read from the platform role inline.**
`app/api/v1/users/[id]/route.ts:52` tests
`session.user.id !== id && !isPlatformAdmin(session.user)` — `canRead` written
longhand. Its `withAuth` wrapper does consult the policy, but with no `resource`
resolver, so it is asked about `{ kind: 'nothing' }`, allows, and the real
decision is the line below it. The consequence is directional and it is the
unsafe direction: **a fork's narrowing policy does not narrow it, and neither
does safe mode** — safe mode's promise that every declared read narrows to the
reader's own rows cannot bind a read that was never declared. Migrating it is
the first real adopter of the `resource` resolver; it is scheduled, and this
paragraph goes when it lands.

`app/api/v1/users/me/route.ts` is **not** a second instance, though this
document said so until 2026-09-09. Its `GET` reads
`where: { id: session.user.id }` and is self-scoped by construction; its only
`isPlatformAdmin` call (`:295`) guards the last-admin count inside `DELETE`,
which is a restriction on admins rather than a read decision.

**`subjectScope` has no core caller.** There is no list endpoint in Sunrise core
scoped by subject. It ships because it is the half of the contract a fork's
`AND`-it-into-the-query code needs, and because shipping `canRead` without the
thing that keeps it honest is how the two faces diverge.

**There is no declarative owner-scope marker.** #367 asked for one. What ships is
the _predicate_ (`subjectScope`) and a resolver on the detail read — not an
annotation that makes a list endpoint owner-scoped. A new list route that forgets
to spread the filter still leaks, exactly as one that forgets a `where` clause
does. The recipe below is a convention, and the next section says plainly what
that costs.

---

## Owner-scoped reads: the recipe

The two faces are **one rule in two shapes**. Use both, or the detail page opens
a record its own list does not contain.

### The principal comes from the guard — never rebuild it

`subjectScope` takes an `AuthorizationPrincipal`, and the guard hands you the
one it used for its own decision:

```ts
export const GET = withAdminAuth(async (request, session) => {
  const filter = await subjectScope(session.principal);
  // …
});
```

`session` is an `AuthenticatedSession` — `AuthSession` plus `principal`. That is
the whole API; there is nothing to construct.

**Do not rebuild it from `session.user`.** `administersEverything` branches on
`credential` and `scopes`, and a handler cannot see either: the credential kind
and an API key's scopes are known only inside the guard, and `AuthSession`
carries neither. The plausible reconstruction — `credential: 'session'`, taken
from the session object you were handed — is a **widening bug**: `withAuth`
accepts a key of any scope, so a `chat`-scoped key held by a user whose role is
`ADMIN` gets judged by the role, and a policy that should answer `{ userId }`
answers `{}` — every subject.

It is also invisible to `checkAuthorizationParity`, which is why the fix is one
object rather than a documented convention. The guard asks `canRead` with the
true principal; a handler asking `subjectScope` with a reconstruction makes the
two faces disagree **at the call site**, for a policy the checker passes clean.
Passing `session.principal` makes them the same object, so there is nothing to
drift.

### The list

```ts
import { subjectScope } from '@/lib/auth/authorization';

export const GET = withAdminAuth(async (request, session) => {
  const filter = await subjectScope(session.principal);

  // `{}` means every subject, so an unrestricted viewer adds no clause and a
  // narrowed one adds `createdBy`.
  const ownerClause = filter.userId ? { createdBy: filter.userId } : {};

  // AND, not spread. `{ ...ownerClause, ...otherFilters }` is last-wins, so a
  // `createdBy` key in `otherFilters` — the most natural extra filter on an
  // admin list, and usually built from a query parameter — silently deletes
  // the boundary and returns 200 with the whole table.
  const where: Prisma.AiWidgetWhereInput = { AND: [ownerClause, otherFilters] };

  const [rows, total] = await Promise.all([
    prisma.aiWidget.findMany({ where /* … */ }),
    prisma.aiWidget.count({ where }),
  ]);
  return paginatedResponse(rows, { page, limit, total });
});
```

**Make the security clause unclobberable.** `webhooks/route.ts:26-29` does the
equivalent by putting `createdBy` in the literal and _assigning_ the optional
filters onto it. Either shape is fine; a spread with the owner clause first is
not.

**Count with the same `where` as the query.** A total computed without the filter
tells the caller how many rows exist that they cannot see — a small leak that
survives every test asserting the _page_ is correct.

### The single row

```ts
export const GET = withAuth<Params>(
  async (request, session, { params }) => {
    /* … */
  },
  {
    // `context` is optional on the resolver type, hence the `!`.
    resource: async (_request, context) => {
      const { id } = await context!.params;
      const row = await prisma.aiWidget.findUnique({
        where: { id },
        select: { id: true, createdBy: true },
      });
      // Returning null DENIES. It is a refusal, not "unscoped".
      if (!row) return null;
      return { kind: 'widget', id: row.id, ownerId: row.createdBy ?? undefined };
    },
  }
);
```

Two things about the resolver that are easy to get backwards:

- **It runs before authorization**, because the policy cannot be asked about an
  unresolved resource. On an admin route that means it is reachable by any
  authenticated caller — keep it cheap and do not leak through its errors.
- **`null` and a throw both deny.** The permissive state is reached by declaring
  _no resolver at all_, which is visible in the route's source rather than in a
  row that happened to be missing. `ownerId: row.createdBy ?? undefined` is the
  idiom for a nullable `SetNull` FK; an explicitly-`undefined` `ownerId` lands in
  the `'unattributed'` arm, not the `'subject'` arm.

### Proving the two agree

`checkAuthorizationParity` is a pure function — no vitest import — so a fork's
own harness can call it:

```ts
const violations = await checkAuthorizationParity(myPolicy, [
  {
    label: 'a member',
    viewer: { userId: 'u1', credential: 'session' },
    subjects: ['u1', 'u2'], // at least one subject the viewer is NOT
  },
]);
expect(violations).toEqual([]);
```

**Give every case a subject the viewer is not.** A self-only case is clean under
every self-inclusive policy, correct or divergent, because both faces agree
trivially about the viewer. The checker reports that as a violation rather than
passing it — along with zero cases and zero subjects, because a parity check that
proves nothing must not report success.

---

## The leak, stated plainly

**A read that forgets to narrow is silent.** It returns 200 with more rows than
the caller should see. Nothing throws, no log line is unusual, the page renders,
and the test that asserts "an admin can list widgets" passes. The failure is
visible only to someone who knows which rows _should_ have been absent.

This is the same class of failure that row-level security removes for the
_between_-tenant axis — with RLS, a query that forgets its `where` returns zero
rows rather than everyone's. Nothing removes it for the _within_-tenant axis.
`subjectScope` gives the rule one name and one implementation so it cannot be
_inconsistent_; it does not make forgetting to call it fail. Treat a new
owner-scoped list route as needing a test that a second user's rows are absent —
asserting the caller's own rows are present passes just as well without the
filter.

---

## The precedent in this tree

Owner-scoping is not hypothetical here. Sunrise already hand-rolls it in two
families, and comparing them is the argument for the recipe.

### Webhooks — coherent, and what the recipe generalises

Every read of `AiWebhookSubscription` **under `/admin/orchestration/webhooks`**
is narrowed by owner, list and detail agreeing: the list (`webhooks/route.ts`),
detail GET/PATCH/DELETE (`webhooks/[id]/route.ts`), the test action
(`[id]/test`), the deliveries list (`[id]/deliveries`), the DLQ list, stats and
replay through the relation (`webhooks/dlq/route.ts`, `dlq/stats`,
`dlq/replay`), and two post-fetch comparisons on individual deliveries
(`deliveries/[id]`, `deliveries/[id]/retry`) — **twelve sites across nine
files**, all spelling `createdBy: session.user.id` by hand. That is the shape
`subjectScope` + `canRead` replace with one rule.

**And that qualifier is load-bearing, which is the real lesson.** This paragraph
first read "every read of `AiWebhookSubscription`", and that was false:
`lib/orchestration/backup/exporter.ts:93` — reached by
`GET /api/v1/admin/orchestration/backup/export` — reads every subscription's
`url` and `emailAddress` with no owner filter. It is correct today, because a
config backup is a platform-level operation and every caller is already a
platform admin; under a customer tier it is a leak, and org-filtering that
exporter is scheduled with the external plane.

So even the family held up here as coherent is coherent only within one
directory. A roster of call sites assembled by reading routes will miss the
library function a route calls — which is the same argument this page makes
about `createdBy` two sections down, turned on the page itself.

### Experiments — the same idea, applied incoherently

`AiExperiment` is classified tenant-owned, and its routes disagree with each
other:

| Route                                 | Scoped by owner?                 |
| ------------------------------------- | -------------------------------- |
| `experiments` (GET list)              | **No**                           |
| `experiments/[id]` GET, PATCH, DELETE | **No**                           |
| `experiments/[id]/run`                | Yes — `where: { id, createdBy }` |
| `experiments/[id]/compare`            | Yes — post-fetch, cross-user 404 |
| `experiments/[id]/verdicts`           | Yes — post-fetch, cross-user 404 |

So one admin sees another's experiment in the list, opens it, edits it and can
**delete** it — but gets a "not found" trying to run or compare it. The comments
at those sites say the 404 is deliberate, "so the existence of a foreign
experiment never leaks", while the list two directories up leaks exactly that.

This is not a hypothetical divergence between a list and a detail read. It is
that divergence, in `main`, in the family the ownership seam is for — which is
why the rule needs a name and a checker rather than a convention. Tracked in
scheduled separately; it is deliberately not fixed here, because it changes shipped route
behaviour and wants its own review.

### The families that record `createdBy` and never read it

`AiAgent`, `AiWorkflow`, `AiWorkflowTrigger`, `AiEventHook`, `McpApiKey` and
`McpExposedPrompt` all stamp `createdBy` on write and never filter on it — every
admin sees every admin's rows. `evaluations/runs/route.ts` carries a comment
noting it followed that precedent deliberately.

**Stamping `createdBy` on write is not scoping, and the two are indistinguishable
to a grep.** `createdBy: session.user.id` inside a `create`'s `data` is
attribution; the same eight characters inside a `where` are a boundary. In the
webhooks routes, twelve of the thirteen occurrences are the second kind and one
is the first. That is why "we filter by `createdBy` here" is not a claim a reviewer can
check by searching, and why the rule wants a named function.

**That is correct today and it is not a bug list.** Single-tenant Sunrise has one
class of admin, so provenance is all `createdBy` is for. It is listed because
those are the models a fork adding a customer tier must revisit — the
classification is in the playbook's
[model inventory](../architecture/multi-tenancy.md#model-inventory), and a
`createdBy` FK is what makes them _reachable_ by the ownership axis, not what
makes them scoped.

---

## Which admin surfaces are whose

A fork adding a customer tier has to split `app/admin/*` into what the vendor
runs and what a customer runs. That mapping is in the multi-tenancy playbook, as
[the control plane](../architecture/multi-tenancy.md#the-control-plane-which-admin-surfaces-are-whose),
because it derives from the same model inventory: a surface belongs to whichever
plane its backing models sit in.

The short version, and the reason it is worth reading rather than guessing: **the
split does not follow the URL tree.** `orchestration/mcp/keys` and
`mcp/prompts` are a customer's; `mcp/tools`, `mcp/resources` and `mcp/settings`
are the vendor's — one nav section, both planes.

---

## The `admin` API-key scope

An `admin`-scoped API key bypasses the role check entirely, and always has: the
scope _is_ the capability. That is pinned platform-only (design decision Q6) —
minting one already requires a platform admin with a browser session, and
`app/api/v1/user/api-keys/route.ts` documents why that check deliberately asks
`isPlatformAdmin` rather than `canAdminister`.

Keys do not bind an org yet, so "an org-bound key can never carry `admin`" is
**not** something this seam enforces today. It arrives with the org axis.

---

## Related

- [`lib/auth/authorization.ts`](../../lib/auth/authorization.ts) — the contract, with the reasoning for each shape decision
- [`lib/app/authorization.ts`](../../lib/app/authorization.ts) — the fork's scaffold, with two worked policies
- [`integration.md`](./integration.md) — `withAuth` / `withAdminAuth` usage
- [`../architecture/multi-tenancy.md`](../architecture/multi-tenancy.md) — the model inventory and the control-plane split
- [`../architecture/multi-tenancy-design.md`](../architecture/multi-tenancy-design.md) — the org axis; design principles and the Q6 ruling
- [`../architecture/fork-init-seams.md`](../architecture/fork-init-seams.md) — the init-gate contract every `lib/app/*` seam shares
- [`CUSTOMIZATION.md`](../../CUSTOMIZATION.md) §4 — the fork-facing seam list

[#739]: https://github.com/human-centric-engineering/sunrise/issues/739
