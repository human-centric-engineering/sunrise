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

| Chokepoint                             | Face            | What it gates                                                                                                                                                                                |
| -------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withAdminAuth` (`lib/auth/guards.ts`) | `canAdminister` | 262 handler wrappings across 190 files, 257 of them under `/api/v1/admin`                                                                                                                    |
| `app/admin/layout.tsx`                 | `canAdminister` | The whole `/admin` page tree                                                                                                                                                                 |
| `components/maintenance-wrapper.tsx`   | `canAdminister` | The maintenance-mode bypass — an access decision, not chrome, because getting past that page reaches the whole site                                                                          |
| `withAuth` (`lib/auth/guards.ts`)      | `canRead`       | 23 handler wrappings. Asked on **every** one of them; all but one declare no `resource` resolver, so it is asked about `{ kind: 'nothing' }`. The exception is `app/api/v1/users/[id]` (GET) |

Read that table before assuming an override is doing what you meant.
**Replacing `canAdminister` alone changes nothing about a `withAuth` route**,
and replacing `canRead` alone changes nothing about the 262 admin handlers.

`subjectScope` is asked by **both** guards — that is where
`session.subjectFilter` comes from, and how the guard knows whether the route
owed an ownership decision (see
[the recipe](#every-route-declares-how-it-decides)). Not on every request: only
where the answer can be used, which is a route that declared nothing (the check
needs it) or `{ decidedBy: 'policy' }` (the handler does). It is a third call
site rather than a fifth chokepoint — it supplies an answer and reports an
omission, it does not admit or refuse a request.

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
while the **safe-mode machinery reports nothing wrong** — the gate latched
`'ok'`, so no rollback and no `onFailure`.

It is not silent, though, and the log is where to look first:
`lib/fork-init.ts` emits `logger.error('… returned a promise — this seam must be
synchronous, and the all-or-nothing rollback does NOT apply to it')`, plus a
second error if the promise later rejects. Lint also catches it
(`@typescript-eslint/no-misused-promises`). What is missing is a _refusal_:
the gate logs and carries on, so the install runs the widest policy either way.
[#739] tracks that.

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
  | { kind: 'nothing' }                                      // route declared no resolver
  | { kind: 'unattributed'; asking: UnattributedQuestion;    // nobody owns it
      resource: AuthorizationResource }
  | { kind: 'subject'; userId: string; resource: … | null }; // a row owned by someone

type UnattributedQuestion =
  | 'this-row'               // a resolver named one row and could not attribute it
  | 'any-row-of-this-kind';  // may this caller read unowned rows of this kind at all?
```

A `switch` that misses an arm returns `undefined`, which does not satisfy
`Promise<boolean>`, so an incomplete policy **fails the fork's build**. The
previous signature was `subject: string | null`, and the natural line to write
against it — `subject === null || subject === viewer.userId` — permitted every
caller on any ownerless row while reading exactly like a check. Build the target
with `readTargetFor(resource)` or `readSubject(userId)`; do not construct it by
hand at a call site, which is how two guards drifted apart in the first place.

`'unattributed'` is the arm to think hardest about, and it answers **two**
questions. One is a row the resolver named and could not attribute — an org-owned
row, or a nullable `createdBy` on a `SetNull` model, which `CLAUDE.md` mandates
for retained config and audit models. The other has no row at all: _may this
caller read unowned rows of this kind, before I build a query?_ — the capability
question the guards precompute, and the one
[Rows nobody owns](#rows-nobody-owns) is about.

The default policy answers both alike — platform staff, nobody else — and
**diagnoses only the first**, once per resource kind. A missing `ownerId` on a
resolved row is something a fork can go and fix; there is nothing to fix about
the capability question, and warning on it told every install to correct a
resolver that does not exist. `asking` exists so the arm can tell them apart; a
policy that treats them alike ignores the field, which is what the built-in ones
do. Narrowing the warning to resources carrying an `id` was tried instead and
reverted — a resolver returning a kind with no id is exactly the misconfiguration
the diagnostic is for.

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

Safe mode does not deny a read with **no declared subject** — almost every core
route declares none, so denying those would take the application down over a seam
most of them do not use. It refuses what it was asked about, not what it was not
asked about: `app/api/v1/users/[id]` (GET) declares a resource, and safe mode
refuses that read even for a platform admin.

---

## What is not behind the seam yet

Read this before trusting a narrowing `canRead`.

**Not every read of personal data is a `canRead` read.** No core route decides a
read from the platform role _inline_ any more — `app/api/v1/users/[id]` (GET)
was the last holdout and declares a resolver as of this release. But two core
routes read other users' personal data through **`withAdminAuth`**, so
`canAdminister` governs them, not `canRead`:

| Route                           | Reads                                     | Face            |
| ------------------------------- | ----------------------------------------- | --------------- |
| `GET /api/v1/users`             | Every user's id, name, email and role     | `canAdminister` |
| `GET /api/v1/users/[id]/export` | One user's complete subject-access bundle | `canAdminister` |

So the pattern this page recommends — `{ ...DEFAULT_AUTHORIZATION_POLICY, canRead: narrower }` —
**does not narrow either of them.** A fork that overrides only `canRead` still
lets every platform `ADMIN` list all users and export any user's full record.
Narrowing reads means overriding `canAdminister` too, and giving those routes a
`resource` resolver so it has something to narrow on.

This is the converse of the warning under the chokepoint table, and it is the one
that costs data rather than access: overriding `canAdminister` alone leaves
`withAuth` routes wide, and overriding `canRead` alone leaves the admin read
surface wide.

**No core list endpoint narrows by `subjectScope`.** It is now called by both
guards — that is how `session.subjectFilter` and the ownership check below exist
— but no Sunrise list route narrows by its _answer_, because a single-tenant
install has one class of admin and nothing to narrow to. The predicate ships for
the fork whose `AND`-it-into-the-query code needs it, and because shipping
`canRead` without the thing that keeps it honest is how the two faces diverge.

Owner-scoped core lists do exist, and they are all hand-rolled — **but not all
on the same column**, which is the thing to know before grepping for them:
webhooks and experiments key on `createdBy`, the evaluations family (sessions,
runs, datasets) on `userId`. A roster assembled by searching for one of those
two names silently omits the other half.

Hand-rolled is not an oversight waiting on a migration: the default policy
answers `{}` for a platform admin, so routing one of them through `subjectScope`
would _widen_ it to every admin. The seam is for the fork that changes that
answer, not a replacement for a boundary core has already decided.

**The marker cannot see past the route.** The `ownership` declaration below is
about the handler; a route that declares `{ decidedBy: 'nothing' }` and calls a
library function that reads every row is exactly as leaky as it was before. The
standing example is `lib/orchestration/backup/exporter.ts:93`, reached by
`GET /api/v1/admin/orchestration/backup/export`, which reads every webhook
subscription's `url` and `emailAddress` with no owner filter. What changed is
that the route now has to say so in its own source, which is the difference
between an unreviewed omission and a reviewed decision. Closing it properly
needs a control at the query, which is the tenancy chokepoint in
`lib/db/client.ts` — see [the leak](#the-leak-stated-plainly).

---

## Owner-scoped reads: the recipe

The two faces are **one rule in two shapes**. Use both, or the detail page opens
a record its own list does not contain.

### Every route declares how it decides

`withAuth` and `withAdminAuth` take an `ownership`, and it is the declarative
owner-scope marker #367 asked for. Four ways to satisfy it:

| Declaration                          | Means                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `{ decidedBy: 'policy' }`            | the handler reads `session.subjectFilter` — **and the guard checks that it did**                   |
| `{ decidedBy: 'resource', because }` | the policy decided about the row the `resource` resolver named, and the handler reads nothing else |
| `{ decidedBy: 'self', because }`     | keyed on the caller's own id and nothing else                                                      |
| `{ decidedBy: 'nothing', because }`  | no ownership decision, deliberately                                                                |

**The obligation only exists when the caller is actually narrowed.** The guard
asks `subjectScope(principal)` when the answer can be used; `{}` means this
caller may see every subject, so there is nothing to forget and nothing to
declare. `{ userId }` means there is, and a route that declared none of the four
is reported — a **failing test**, and a `logger.error` said once per route
everywhere else, development included.

Development logs rather than refusing because of what the canonical fork
migration looks like: the documented one-line
`{ ...DEFAULT_AUTHORIZATION_POLICY, canAdminister: isOrgAdmin }` leaves the
default `subjectScope`, so an org admin is narrowed and **all 262
`withAdminAuth` handlers owe a declaration at once**. Refusing in development
would take a fork's whole admin console down the first time they booted after
upgrading, for following the recipe. The failing-test list is the better
instrument anyway: it enumerates the routes instead of withdrawing the app.

**It is also silent on a response that carried no rows.** A handler returning
4xx — a rate-limit 429, a validation 400, a 404 — answered nobody's query, so it
cannot have answered it too widely. This matters because the recipe below pairs
`'policy'` with the handler shape core itself uses, and 38 guarded routes here
open with `if (!rateLimit.success) return createRateLimitResponse(rateLimit)`.
Without the gate, every rate-limited request on such a route would be a 500.

The one shape it gets wrong is a **streamed body**, because the read happens
after the response is returned. Read `session.subjectFilter` before you hand
back the stream — you need it to build the query anyway.

That is why all but nine of Sunrise's 263 `withAdminAuth` handlers carry no
declaration and its 23 `withAuth` handlers do: under the default policy a platform admin is
unrestricted and a member is not. On a fork whose org admin **is** narrowed, the
admin routes start asking too, one route at a time, in that fork's own test
suite.

The nine are the experiments family, which scopes itself by hand and says so
with `'self'` — see [Experiments](#experiments--the-divergence-this-page-was-written-about-since-closed).

`because` is required on all but `'policy'`, and required rather than
encouraged. The value of the marker is the sentence; a reviewer reading
`{ decidedBy: 'nothing' }` alone learns only that somebody typed it. `'policy'`
is the exception because it is the one the guard can check for itself.

**A `resource` resolver is not a declaration on its own.** It used to exempt the
whole handler automatically, and that was too generous: `canRead` was asked about
one row, and says nothing about a list of siblings the same handler goes on to
run. It was also the only escape hatch that needed no sentence and produced no
log line. Declare `{ decidedBy: 'resource', because }` and let the sentence carry
the "and nothing else" — `app/api/v1/users/[id]` (GET) is the worked example.

**Reading `session.subjectFilter` on a route whose declaration settles the
question without it gives you the reader's own id, and logs.** The filter is
only computed where it can be used — a route that declared nothing, or one that
declared `'policy'`. Everywhere else the getter answers `{ userId }`: the
_narrowest_ value the type can express, so a query built from it returns too few
rows rather than too many. It deliberately does **not** answer `{}`, which is the
widest, and it deliberately does not throw — `subjectFilter` is a required member,
so a shared helper typed against `AuthenticatedSession` has no way to know
reading is unsafe, and a 500 for real users is the wrong price for that. Same
trade as `subjectScope`'s own wrapper, which logs and falls back to safe mode
rather than raising.

**`'self'` is not `'policy'` with extra steps, and must not be migrated to it.**
`subjectScope` widens to `{}` for a platform admin — correct for an admin list,
catastrophic on `users/me`, where it would hand an admin everyone else's row.
A route that is self-scoped by construction stays keyed on `session.user.id`.

### The principal comes from the guard — never rebuild it

`session` is an `AuthenticatedSession`: `AuthSession`, plus the `principal` the
guard decided with, plus `subjectFilter` — the policy's answer for this caller,
already computed. There is nothing to construct.

**Do not rebuild the principal from `session.user`.** `administersEverything`
branches on `credential` and `scopes`, and a handler cannot see either: the
credential kind and an API key's scopes are known only inside the guard, and
`AuthSession` carries neither. The plausible reconstruction —
`credential: 'session'`, taken from the session object you were handed — is a
**widening bug**: `withAuth` accepts a key of any scope, so a `chat`-scoped key
held by a user whose role is `ADMIN` gets judged by the role, and a policy that
should answer `{ userId }` answers `{}` — every subject.

It is also invisible to `checkAuthorizationParity`, which is why the fix is one
object rather than a documented convention. The guard asks `canRead` with the
true principal; a handler asking `subjectScope` with a reconstruction makes the
two faces disagree **at the call site**, for a policy the checker passes clean.
Reading `session.subjectFilter` is the same answer from the same principal, so
there is nothing to drift.

### The list

```ts
export const GET = withAdminAuth(
  async (request, session) => {
    // Reading this is what `decidedBy: 'policy'` promises, and the guard
    // notices whether you did. Read it once into a local; it is a getter.
    const filter = session.subjectFilter;

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
  },
  { ownership: { decidedBy: 'policy' } }
);
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

### Rows nobody owns

`session.subjectFilter` answers "whose rows may I read?" and has no way to say
**nobody's**. That is not a corner: four core models can hold a row with a null
owner, two of them by birth and two by erasure.

| Model                 | Owner column | `onDelete` | A null owner means             |
| --------------------- | ------------ | ---------- | ------------------------------ |
| `AiConversation`      | `userId`     | `Cascade`  | born ownerless — inbound       |
| `AiWorkflowExecution` | `userId`     | `Cascade`  | born ownerless — scheduled     |
| `AiDataset`           | `userId`     | `SetNull`  | an Art. 17 erasure detached it |
| `AiExperiment`        | `createdBy`  | `SetNull`  | an Art. 17 erasure detached it |

The two are disjoint by database constraint, which is why the helpers give them
different names (`'system'` versus `'orphan'`) and different audit weight. A
`where` clause keyed on the caller answers "not yours" for all four, which turns
a deliberately retained row into an unreachable one — invisible to every admin,
deletable by none, pruned by nothing.

**The guards resolve the answer once per request and hand it over.** It is
`canRead`'s `'unattributed'` arm asked with `asking: 'any-row-of-this-kind'`,
once for each kind in `UNATTRIBUTED_READ_KINDS` (`lib/auth/orphan-reads.ts`),
before the handler runs:

```ts
export const GET = withAdminAuth(
  async (request, session) => {
    const mine = { createdBy: session.user.id };

    // No await: the answer was decided before this handler was called.
    const where: Prisma.AiExperimentWhereInput = session.unattributedReads.experiment
      ? { OR: [mine, { createdBy: null }] }
      : mine;

    return successResponse(await prisma.aiExperiment.findMany({ where }));
  },
  { ownership: { decidedBy: 'self', because: 'Scoped to createdBy, plus rows nobody owns.' } }
);
```

`unattributedReads` is a **total record** — every kind present, `true` or `false`
— so a denied kind cannot be read the same way as a kind nobody asked about.
Unlike `subjectFilter` it is an ordinary enumerable property, so a spread of the
session carries it; nothing observes whether it was read, because there is no
`ownership` claim for it to make checkable.

**Never widen the owner clause instead.** "Nobody's" is a third case, not a
softer spelling of "someone else's" — re-admitting every admin to every other
admin's rows is the divergence [#741] closed.

**The cost is eager, and a fork inherits it.** The policy is asked once per kind
on **every** guarded request, including requests touching none of these models,
and including `withAuth` routes. On a default install that is free: the built-in
rule does no I/O. **A fork whose `canRead` hits a database pays those lookups per
request and should cache inside its own policy.** Eager was chosen over asking on
demand because the readers built on it compose `where` fragments inline inside
larger objects — `lib/orchestration/admin/live-engine-snapshot.ts` is the awkward
one — where an `await` has nowhere clean to go; making them async would put one
at every call site for a question most requests never ask. Switching to on-demand
later is possible but not free: it is exactly that sweep.

A fork with an ownerless model of its own is not in the record, whose keys are
the core kinds the guards can enumerate. It calls
`mayReadUnattributed(session.principal, kind)` and awaits — the same policy, the
same failure direction, one call.

---

## The leak, stated plainly

**A read that forgets to narrow used to be silent.** It returned 200 with more
rows than the caller should see. Nothing threw, no log line was unusual, the page
rendered, and the test that asserts "an admin can list widgets" passed. The
failure was visible only to someone who knew which rows _should_ have been
absent.

The `ownership` marker removes the silence **at the route**: on an install where
the caller is narrowed, a handler that made no ownership decision is reported
before its response is returned. What it does not remove is the silence **at the
query**. It knows the route did not decide; it cannot know whether the decision
the route claims to have made was applied to every read underneath it. A route
declaring `{ decidedBy: 'nothing' }` that calls a library function reading the
whole table is honest and still leaky.

Row-level security removes both for the _between_-tenant axis: a query that
forgets its `where` returns zero rows, wherever it was written. The equivalent
for this axis is a control at the Prisma client — the tenancy chokepoint in
`lib/db/client.ts`, which is where the org axis is going and where a read-side
owner predicate belongs with it. Until then:

- Treat a new owner-scoped list route as needing a test that **a second user's
  rows are absent**. Asserting the caller's own rows are present passes just as
  well without the filter.
- Prefer `{ decidedBy: 'policy' }` to `{ decidedBy: 'nothing' }` when the route
  reads anything owned. `'nothing'` is a claim about the whole call tree beneath
  the handler, and it is the one the marker cannot check.

---

## The precedent in this tree

Owner-scoping is not hypothetical here. Sunrise hand-rolls it in two families,
and how they got there is the argument for the recipe: one was coherent from the
start, the other had to be made coherent, and nothing but a reader's attention
had told them apart.

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

### Experiments — the divergence this page was written about, since closed

`AiExperiment` is classified tenant-owned, and until [#741] the handlers over it
disagreed with each other. One admin saw another's experiment in the list,
opened it, edited it and could **delete** it — but got a "not found" trying to
run or compare it, from sites whose comments called the 404 deliberate, "so the
existence of a foreign experiment never leaks", while the list two directories
up leaked exactly that. The widest verb had the weakest check.

All nine are now owner-scoped on `createdBy` — the list and its `count`, the
create, the detail `GET` / `PATCH` / `DELETE`, the `run` / `compare` /
`verdicts` routes that already were, and the `claim` route below — and each declares `{ decidedBy: 'self' }`, so a reader of any
one route sees the posture without reading the other five.

**It is spelled as a `createdBy` clause, not as `subjectScope`, and that is the
part worth carrying forward.** The seam cannot express "owner-scoped" here:
`DEFAULT_AUTHORIZATION_POLICY.subjectScope` widens to `{}` for a platform admin
and `canRead`'s `'subject'` arm permits `administersEverything`, so routing this
family through the policy would have been the _admin-global_ choice. Owner-scoped
and policy-expressed were two options, not one — see [What is not behind the seam
yet](#what-is-not-behind-the-seam-yet), which is the same fact from the other end.

Which of the two to take was decided by what an experiment composes with, not by
which mechanism was newer: it reads an `AiDataset` and writes `AiEvaluationRun`
and `AiEvaluationSession` rows, and every route **under `orchestration/evaluations`**
scopes those three by hand already — on `userId`. Admin-global would have listed
experiments whose results the viewer cannot open. `AiAgent` and `AiWorkflow` —
shared configuration rather than personal work product — stay admin-global, which
is the next section.

**That qualifier is load-bearing here too**, for the same reason it is in the
webhooks section above: `agents/compare/route.ts` counts `AiEvaluationSession`
per agent, twice, with no owner clause. This paragraph first read "every route
over those three models", and that was false because of exactly that one file,
two directories away. Twice on one page now: a roster read off a directory
misses the call site filed somewhere else.

**Those counts are install-wide on purpose rather than by omission** (t-682). The
screen compares two _shared_ agents, so the figures are about the agents, not
about the viewer; narrowing them would rank two agents by how much the caller
happened to use them. The route declares `{ decidedBy: 'nothing' }` saying so,
and its tests pin the absence of an owner clause, so a later tidy-up has to
delete a test that explains why not.

**And the same route is a third instance of the roster problem, found while
fixing the second.** It reads four narrowable aggregates, not two: besides the
evaluation counts, `aiConversation.count` and — the one first missed —
`aiCostLog.aggregate`. `AiCostLog` carries an indexed `userId`, read owner-scoped
in `lib/privacy/export-sources.ts` for Art. 15, and the comparison sums spend by
`agentId` alone. Under a customer tier that reports another tenant's spend on a
shared agent, which is the sharpest of the four. **The missed call site was in
`lib/privacy/`** — a directory nobody auditing an admin route thinks to read.

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

The short version, and the reason it is worth reading rather than guessing:
**the split does not follow the URL tree.** `orchestration/mcp/*` alone has
three answers — `keys` is a customer's, `tools`, `resources` and `settings` are
the vendor's, and `prompts` is **neither until `McpExposedPrompt` is scoped**,
because it is served from a process-global cache to every MCP client under a
global name namespace and a global cap. Do not summarise that page from this
one; go and read it.

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
[#741]: https://github.com/human-centric-engineering/sunrise/issues/741
