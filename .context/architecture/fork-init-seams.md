# Fork Init Seams

Eighteen of the `lib/app/*` scaffolds Sunrise ships are reached the same way: a
core registry runs the fork's `initApp*()` function **once, lazily, before its
first read**. (Most of `lib/app/` is not this — the majority of those files are
value and config scaffolds with no init function at all, and two of the twenty
`initApp*` exports are different shapes; see below.)
That lets a fork accumulate registrations at module-import time without a startup
hook, and without core needing to know which bundle realm got there first.

This page is about what happens when one of those functions **throws** — and what
Sunrise does and does not promise about it.

## The guarantee

> A fork init that throws leaves the registry exactly as it was before the init
> ran. The log line saying the feature is disabled is literally true.

That guarantee is implemented once, in [`lib/fork-init.ts`](../../lib/fork-init.ts),
and every seam below runs through it. **One of them then goes further** — see
"the ones that do more than degrade" below: rolling back an _authorization_
policy leaves the platform's own, and for a fork whose policy narrows it that is
a silent widening rather than a degradation. It was not always true: **seven of the
eleven did not provide it** (#633). Six caught the throw, logged "disabled", and
kept every registration the init had already made. The seventh, `capabilities`,
did not catch at all — it propagated, and latched _after_ the call, so a throwing
init also re-ran on every dispatch for the life of the process.

Three properties come with it:

- **Latched before the init runs.** A throwing init is not retried. For several
  of these registries "the next read" is every chat turn or every maintenance
  tick, so a retry would re-pay the failure forever. One seam latched
  _afterwards_ and did exactly that, under a comment claiming it did not.
- **All-or-nothing, not the arbitrary prefix.** "Some of your registrations
  applied, we will not say which" is not a contract a fork author can reason
  about — and which ones survive depends on where the bug sits in their file,
  not on what they meant.
- **`ensure()` cannot throw, structurally.** Its body is wrapped, so a
  `snapshot` or `restore` closure that fails — or anything added inside it later
  — surfaces as a log line and a settled verdict rather than as an exception out
  of a public read. That is a backstop rather than a rule to remember, because
  the "never throws" contract was re-broken three times from inside the module
  while it was being written, each time by code that was correct in isolation.
- **The catch cannot itself throw.** `String(err)` raises on a null-prototype
  value; that would escape the catch _after_ the rollback, surfacing as an
  unexplained failure of the thing the catch protects. `describeThrown()` handles
  it for every seam.

## The roster

| Seam file (`lib/app/`)             | Init function                        | Registry                                                    | On a throw                     |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------- | ------------------------------ |
| `account-sections.ts`              | `initAppAccountSections`             | `lib/account-sections/registry.ts`                          | roll back, log, degrade        |
| `admin-tier.ts`                    | `initAppOrgTierAdminPages`           | `lib/auth/admin-tier.ts`                                    | roll back, log, degrade        |
| `authorization.ts`                 | `initAppAuthorizationPolicy`         | `lib/auth/authorization.ts`                                 | roll back, log, **safe mode**  |
| `capabilities.ts`                  | `initAppCapabilities`                | `lib/orchestration/capabilities/registry.ts`                | roll back, log, **re-raise**   |
| `context-contributors.ts`          | `initAppContextContributors`         | `lib/orchestration/chat/context-builder.ts`                 | roll back, log, degrade        |
| `data-export.ts`                   | `initAppSubjectSources`              | `lib/privacy/subject-source-registry.ts`                    | roll back, log, **remembered** |
| `erasure.ts`                       | `initAppErasureHooks`                | `lib/privacy/erasure-hooks.ts`                              | roll back, log, degrade        |
| `evaluations.ts`                   | `initAppGraders`                     | `lib/orchestration/evaluations/graders/registry.ts`         | roll back, log, degrade        |
| `guard-event-contributors.ts`      | `initAppGuardEventContributors`      | `lib/orchestration/chat/guard-events.ts`                    | roll back, log, degrade        |
| `guard-floor-contributors.ts`      | `initAppGuardFloorContributors`      | `lib/orchestration/chat/guard-floor.ts`                     | roll back, log, degrade        |
| `jobs.ts`                          | `initAppJobs`                        | `lib/orchestration/maintenance/app-jobs.ts`                 | roll back, log, degrade        |
| `knowledge-access-contributors.ts` | `initAppKnowledgeAccessContributors` | `lib/orchestration/knowledge/resolveAgentDocumentAccess.ts` | roll back, log, degrade        |
| `mcp-resources.ts`                 | `initAppMcpResources`                | `lib/orchestration/mcp/resource-registry.ts`                | roll back, log, degrade        |
| `org-export.ts`                    | `initAppOrgSources`                  | `lib/privacy/org-source-registry.ts`                        | roll back, log, **remembered** |
| `owner-classification.ts`          | `initAppOwnerClassification`         | `lib/db/owner-classification.ts`                            | roll back, log, degrade        |
| `platform-agents.ts`               | `initAppPlatformAgents`              | `lib/orchestration/agents/platform-agents.ts`               | roll back, log, degrade        |
| `provider-credentials.ts`          | `initAppProviderCredentials`         | `lib/orchestration/llm/provider-credentials.ts`             | roll back, log, **refuse**     |
| `user-created.ts`                  | `initAppUserCreatedHooks`            | `lib/auth/user-created-hooks.ts`                            | roll back, log, degrade        |

## The other family: `registerApp*`

Four scaffolds are reached by a **direct call from the one core module that
needs them**, not through `createAppInitGate`. Different mechanism, identical
failure if the wiring is lost — a scaffold nothing imports is dead wiring, and
every fork's registrations in it silently never run. `fork-init-seams.test.ts`
guards them by import detection and pins the count at **four**, so adding a
fifth is a deliberate edit rather than a silent one.

| Edit this file       | Export                           | Called by                                                                                  |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------ |
| `db-drift.ts`        | `registerAppDriftProbes`         | `scripts/db/check-drift.ts` (a CLI, not a runtime module)                                  |
| `rate-limit.ts`      | `registerAppRateLimits`          | the rate-limit middleware, at module scope                                                 |
| `llm-providers.ts`   | `registerAppProviderEligibility` | `ensureWired()` in `lib/orchestration/llm/provider-eligibility.ts`, lazily on first use    |
| `tenant-resolver.ts` | `registerAppTenantResolver`      | `proxy.ts`, at module scope (§106 — the resolver runs on every request; Web-standard only) |

The third is the one to read if you are adding a fifth. It was originally wired
as a module-load side effect of its consumer, which made registration depend on
**who imported what**: a second consumer that did not import the first ran with
no rule registered and silently got an unfiltered answer. Wiring from the module
that owns the state removes the question, and is the shape to copy — the guard's
count exists partly so that decision gets made again consciously.

Unlike the `initApp*` family there is no shared gate, so this doc's
throw-behaviour contract below does not apply to them: each registrar's consumer
decides what a failure means. For provider eligibility a failure denies (a
restriction that cannot be established must not be read as permission), which is
deliberately stricter than the roll-back-and-degrade default opposite.

Two `initApp*` exports are **not** in this family, and
`tests/unit/fork-init-seams.test.ts` pins both exemptions with their reasons
rather than letting them be absorbed by a path prefix.

`bootstrap.ts` → `initApp()` is the app **boot** hook, not a registry seam:
`instrumentation.ts` awaits it once at startup inside its own try/catch, and it
registers nothing itself, so there is no registry to snapshot. (It is also the
only async one — a scanner that matched `export function` alone could not see it
at all, which is how it went unnoticed until review.)

`admin-nav.ts` → `initAppNav()` is **not** in this family either. It is called at module
scope from `components/admin/admin-sidebar.tsx`, in the client realm, because
module registries do not cross Next's bundle boundaries. A throw there fails the
module's evaluation, so nothing reads the partial registry — loud, and a
different shape.

`admin-tier.ts` → `initAppOrgTierAdminPages()` **is** in the family. Its gate is
in `lib/auth/org-tier-admin-pages.ts`, and it runs on the server only, at the
admin layout's first read. The tier gate and the header in the browser are
handed the list the layout built rather than running the init themselves: a
list each realm built for itself could differ (an init that reads a
server-only env var), and the browser would then turn away an org admin the
layout admitted. Its rollback fails closed: every fork page goes back to being
the platform's.

### The seams that do more than degrade

**`subject-sources` remembers.** Degrading is right for a seam whose absence is
visible — a missing nav section is missing. It is wrong for a subject-access
export: `collectAppSubjectData()` is a separate static import unaffected by the
throw, so the bundle would still carry the tier's rows while `meta.app` described
none of them. `exportUserData()` refuses rather than shipping a bundle whose own
manifest contradicts its contents. **`org-sources` remembers too**, for the
org export: `exportOrgData()` refuses every org while the fork's
`initAppOrgSources()` is known to have thrown, or to have registered a row the
registry rejected that no other declaration covers, because a bundle without the fork's tables would read as
complete.

**`authorization` closes the door.** Every other seam on this list rolls back to
"Sunrise's own behaviour", and for every other seam that is the safe answer. It
is not here. A fork's policy typically _narrows_ the platform default — an org
admin must not see another org's rows — so falling back to the default would
**widen** access under a log line saying the feature was disabled. Instead the
registry latches a flag and `getAuthorizationPolicy()` serves `SAFE_MODE_POLICY`
for the life of the process: nobody administers anything, every declared read
narrows to the reader's own rows, and a second log line says so in those words.
That is an outage, deliberately preferred to a quiet widening. Reads the route
declared **no subject** for are still allowed, because core declares none and
denying those would take the whole application down over a seam that is not yet
load-bearing for them.

**`capabilities` re-raises.** Rollback means an init throw costs the fork its
_entire_ capability set, not one entry. The other seams degrade to something a
person notices; an agent missing its whole toolset does not go quiet, it answers
from its own weights with nothing marking the gap. This is the behaviour that
shipped, and it is re-raised on every call rather than only the first — a signal
that appears at boot and then vanishes leaves the deployment looking healthy.

### A seam must be synchronous

`init: () => void` does **not** stop you writing `export async function
initAppJobs()` — TypeScript lets a function returning anything satisfy a `void`
return, so it compiles. The gate cannot vouch for one: the call returns before
the work does, registrations made after your first `await` land outside the
rollback, and a later rejection happens after the gate has already answered.

This is easier to reach than it sounds, because core sets the pattern:
`lib/app/bootstrap.ts` ships `export async function initApp()`, and every fork's
copy is async. That one is the **boot** hook and is meant to be async; the lazy
registry seams are not.

**So the gate refuses an async seam, as if it had thrown** (#739): it rolls back
what the init registered, settles `'failed'`, logs that the seam must be
synchronous, and runs `onFailure`. A rejection that arrives later is logged
rather than reaching the process. It used to log and report `'ok'` instead,
which mattered most for the seams that do more than degrade: they act only from
`onFailure`, so an async `initAppAuthorizationPolicy` that rejected left the
install on Sunrise's default policy rather than safe mode, with nothing saying
so. Refusing does break an async seam that happened to register everything
before its first `await` — it was outside the guarantee either way, and a
failure at boot is the cheaper way to find out.

Two limits. Refusing rather than awaiting is deliberate: every read through the
gate is synchronous, so there is nothing to await in. And the gate has no hold
on code that runs after it answers, so a registration your continuation makes
_after_ the rollback can still land. **Lint is the guard to rely on**:
`@typescript-eslint/no-misused-promises` rejects `init: <async fn>` at the gate
call site, so an async seam fails `npm run lint` in your fork. Do the async work
elsewhere and register synchronously.

## What this does NOT cover

**A fork's init is a bare sequence of statements, and core has no boundary
inside it.**

```ts
export function initAppCapabilities(): void {
  registerAppCapability(new BillingLookup()); // registers
  registerAppCapability(new OrderStatus()); // throws while CONSTRUCTING
  registerAppCapability(new RefundIssuer()); // never runs
}
```

Every seam takes an **already-constructed value**. By the time core is handed
anything, the fork's expression has already been evaluated — so `new
OrderStatus()` throwing aborts the whole function, and core never even learns
that `RefundIssuer` existed. Rollback is the best available answer to that, not a
correct one: it trades an arbitrary subset for none, and it discards
`BillingLookup`, which was fine.

Per-registration isolation needs a **deferred** form — something core can invoke
inside its own `try`:

```ts
registerAppCapability('order_status', () => new OrderStatus());
```

That is a fork-visible contract change across every seam on the roster and is tracked
separately. Until it lands, an init that can fail should guard itself.

### Where isolation already exists

One half of the capability path is core code walking items core already holds, so
it _does_ have a boundary — and it uses it. `registerAppCapabilities()` calls
`capabilityDispatcher.register()` per entry inside a `try`; a capability that
fails the PII guard (`processesPii = true` with no `redactProvenance()` override)
is named in the log and skipped, and the fork's other capabilities register
normally. Before #633 that throw propagated mid-loop, so one misdeclared
capability at position 12 of 28 left 11 registered and 16 absent.

**One case there is not a clean skip**, and the log says so. The
`register(cap, { slug })` seam mounts a capability over an _existing_ slug,
optionally with a `guard` to gate it. If that registration is the one that fails,
the handler it was replacing stays live — without the fork's guard — where before
per-item isolation the whole flush failed closed. It is not un-done, because the
only lever is dropping the existing handler, and for a built-in slug that removes
the capability from every agent in the deployment over one fork authoring bug. So
that skip logs "the handler it was REPLACING is still live, without its guard"
rather than "skipping it", which would read as absence. **If you override a
built-in slug to restrict it, do not also misdeclare `processesPii` on that
class** — the two together are what produces an un-gated built-in.

## Writing a new seam

Use the gate; do not hand-roll the four parts.

```ts
import { createAppInitGate, restoreMap } from '@/lib/fork-init';

const registry = new Map<string, Thing>();

const appInit = createAppInitGate({
  label: 'my-registry: initAppThings', // "<registry>: <initFnName>"
  subject: 'app things', // what is lost — completes the log line
  init: initAppThings,
  snapshot: () => new Map(registry),
  restore: (before) => restoreMap(registry, before),
});

export function getThings(): Thing[] {
  appInit.ensure(); // at the top of every public read
  return [...registry.values()];
}

export function __resetThingsForTests(): void {
  registry.clear();
  appInit.reset();
}
```

`ensure()` returns `'running' | 'ok' | 'failed'` — **three** states, not two.
`'running'` means this call re-entered the gate from inside the init itself,
which a fork is allowed to do; it is _not_ a failure, and all three values are
truthy strings, so `if (!appInit.ensure())` is dead code on every path. For "did
it fail", prefer the `onFailure` hook, which fires once and only on a real
failure — reading the verdict for that question is what cost Art. 15 subject
access during this work. `onSuccess` receives the pre-init snapshot (the graders
registry diffs it to warn that a fork replaced a built-in slug); `onFailure`
receives whatever was thrown, after the rollback and the log line.

## A fork's own modules are not seams

Three guards read every `lib/app/` entry as a seam owed a row: VERSIONING.md's
Covered list, CUSTOMIZATION.md §4's "Edit this file" table, and `SEAM_DEFAULTS`
in `tests/unit/lib/app/defaults.test.ts`. A leaf fork that keeps its own modules
there lists them in `lib/app/own-modules.ts` (`appOwnModules`), and all three
skip them: they ask through one function, `unlistedSeams()` in
`tests/helpers/app-scaffolds.ts`, so a module is skipped by all of them or none
(#847).

`ownModuleProblems()` refuses an entry that is not on disk, is not
`lib/app/<file>` or `lib/app/<dir>/`, is the declaration file, is already not a
seam, or still has a row in VERSIONING.md, the CUSTOMIZATION.md table
(`versioning-seam-coverage.test.ts`) or `SEAM_DEFAULTS` (`defaults.test.ts`).
Every Sunrise seam has those rows, so declaring one is refused while they stand.
It guards against a mistake, not against a fork that edits the lists: a fork
that deletes a Sunrise seam's rows to declare it has taken that seam out of its
own version contract. The shared-gate check in
`fork-init-seams.test.ts` does not subtract them: an `initApp*` nothing calls is
dead wiring whoever owns it.

A fork others build on should not declare its modules: they are its own forks'
public surface.

## See also

- [`CUSTOMIZATION.md` §4](../../CUSTOMIZATION.md#4-configuration--environment--the-libapp-surface) — the `lib/app/` surface a fork fills
- [`lib/fork-init.ts`](../../lib/fork-init.ts) — the gate
- [`tests/unit/lib/fork-init.test.ts`](../../tests/unit/lib/fork-init.test.ts) — the contract, including the sabotages it must fail against
