# Fork Init Seams

Every `lib/app/*` scaffold Sunrise ships is reached the same way: a core registry
runs the fork's `initApp*()` function **once, lazily, before its first read**.
That lets a fork accumulate registrations at module-import time without a startup
hook, and without core needing to know which bundle realm got there first.

This page is about what happens when one of those functions **throws** — and what
Sunrise does and does not promise about it.

## The guarantee

> A fork init that throws leaves the registry exactly as it was before the init
> ran. The log line saying the feature is disabled is literally true.

That guarantee is implemented once, in [`lib/fork-init.ts`](../../lib/fork-init.ts),
and every seam below runs through it. It was not always true: seven of the eleven
seams caught the throw, logged "disabled", and kept every registration the init
had already made (#633).

Three properties come with it:

- **Latched before the init runs.** A throwing init is not retried. For several
  of these registries "the next read" is every chat turn or every maintenance
  tick, so a retry would re-pay the failure forever. One seam latched
  _afterwards_ and did exactly that, under a comment claiming it did not.
- **All-or-nothing, not the arbitrary prefix.** "Some of your registrations
  applied, we will not say which" is not a contract a fork author can reason
  about — and which ones survive depends on where the bug sits in their file,
  not on what they meant.
- **The catch cannot itself throw.** `String(err)` raises on a null-prototype
  value; that would escape the catch _after_ the rollback, surfacing as an
  unexplained failure of the thing the catch protects. `describeThrown()` handles
  it for every seam.

## The roster

| Seam file (`lib/app/`)             | Init function                        | Registry                                                    | On a throw                     |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------- | ------------------------------ |
| `account-sections.ts`              | `initAppAccountSections`             | `lib/account-sections/registry.ts`                          | roll back, log, degrade        |
| `capabilities.ts`                  | `initAppCapabilities`                | `lib/orchestration/capabilities/registry.ts`                | roll back, log, **re-raise**   |
| `context-contributors.ts`          | `initAppContextContributors`         | `lib/orchestration/chat/context-builder.ts`                 | roll back, log, degrade        |
| `data-export.ts`                   | `initAppSubjectSources`              | `lib/privacy/subject-source-registry.ts`                    | roll back, log, **remembered** |
| `evaluations.ts`                   | `initAppGraders`                     | `lib/orchestration/evaluations/graders/registry.ts`         | roll back, log, degrade        |
| `guard-event-contributors.ts`      | `initAppGuardEventContributors`      | `lib/orchestration/chat/guard-events.ts`                    | roll back, log, degrade        |
| `guard-floor-contributors.ts`      | `initAppGuardFloorContributors`      | `lib/orchestration/chat/guard-floor.ts`                     | roll back, log, degrade        |
| `jobs.ts`                          | `initAppJobs`                        | `lib/orchestration/maintenance/app-jobs.ts`                 | roll back, log, degrade        |
| `knowledge-access-contributors.ts` | `initAppKnowledgeAccessContributors` | `lib/orchestration/knowledge/resolveAgentDocumentAccess.ts` | roll back, log, degrade        |
| `mcp-resources.ts`                 | `initAppMcpResources`                | `lib/orchestration/mcp/resource-registry.ts`                | roll back, log, degrade        |
| `user-created.ts`                  | `initAppUserCreatedHooks`            | `lib/auth/user-created-hooks.ts`                            | roll back, log, degrade        |

`admin-nav.ts` → `initAppNav()` is **not** in this family. It is called at module
scope from `components/admin/admin-sidebar.tsx`, in the client realm, because
module registries do not cross Next's bundle boundaries. A throw there fails the
module's evaluation, so nothing reads the partial registry — loud, and a
different shape.

### The two that do more than degrade

**`subject-sources` remembers.** Degrading is right for a seam whose absence is
visible — a missing nav section is missing. It is wrong for a subject-access
export: `collectAppSubjectData()` is a separate static import unaffected by the
throw, so the bundle would still carry the tier's rows while `meta.app` described
none of them. `exportUserData()` refuses rather than shipping a bundle whose own
manifest contradicts its contents.

**`capabilities` re-raises.** Rollback means an init throw costs the fork its
_entire_ capability set, not one entry. The other seams degrade to something a
person notices; an agent missing its whole toolset does not go quiet, it answers
from its own weights with nothing marking the gap. This is the behaviour that
shipped, and it is re-raised on every call rather than only the first — a signal
that appears at boot and then vanishes leaves the deployment looking healthy.

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

That is a fork-visible contract change across eleven seams and is tracked
separately. Until it lands, an init that can fail should guard itself.

### Where isolation already exists

One half of the capability path is core code walking items core already holds, so
it _does_ have a boundary — and it uses it. `registerAppCapabilities()` calls
`capabilityDispatcher.register()` per entry inside a `try`; a capability that
fails the PII guard (`processesPii = true` with no `redactProvenance()` override)
is named in the log and skipped, and the fork's other capabilities register
normally. Before #633 that throw propagated mid-loop, so one misdeclared
capability at position 12 of 28 left 11 registered and 16 absent.

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

`ensure()` returns whether the init completed, for a consumer that needs to do
more than degrade. `onSuccess` receives the pre-init snapshot (the graders
registry diffs it to warn that a fork replaced a built-in slug); `onFailure`
receives whatever was thrown, after the rollback and the log line.

## See also

- [`CUSTOMIZATION.md` §4](../../CUSTOMIZATION.md#4-configuration--environment--the-libapp-surface) — the `lib/app/` surface a fork fills
- [`lib/fork-init.ts`](../../lib/fork-init.ts) — the gate
- [`tests/unit/lib/fork-init.test.ts`](../../tests/unit/lib/fork-init.test.ts) — the contract, including the sabotages it must fail against
