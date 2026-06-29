# Agent Field Registry

`AiAgent` has ~40 configuration columns, and almost every agent-management feature needs to enumerate them: validation, the create/update/clone write paths, version snapshot + diff + restore, and config export/import (bundle and full backup). Historically each of those kept its **own hand-maintained list** of field names, with nothing tying them together. Adding one field meant editing ~15 lists, and missing any one produced a **silent** gap — no type error, no test failure, the field just evaporated in that code path.

The registry (`lib/orchestration/agents/agent-field-registry.ts`) is the single source of truth. Each field is declared once as a descriptor; every subsystem derives its behaviour from that declaration or is parity-tested against it.

## Why this exists

These aren't hypothetical. Before the registry, the divergence had already shipped real bugs on `main`:

- **`persona` / `guardrails` / the three `*Mode` fields** were marked versioned (editing them logged a "changed" version) but were never written to the snapshot — version history claimed a change it never captured, and restore couldn't recover it.
- **`reasoningEffort` / `maxCostPerTurnUsd`** were snapshotted but missing from the diff metadata, so a change to them showed nothing in version history.
- **Full-config backup** silently dropped `kind`, `reasoningEffort`, `persona`, `guardrails`, the `*Mode` fields, the attachment toggles, and the runtime-prompt fields — so exporting and re-importing a config reset a `judge` agent to `chat` and lost persona/guardrails/toggles.

All three were divergences between hand-maintained lists. The registry makes the first two **structurally impossible** (the snapshot set and the versioned set are the _same_ derived list) and the third a **loud test failure** (a parity test fails if any config field is missing from a serialised shape).

## Adding an agent config field

1. **Add the column** to `prisma/schema/orchestration-agents.prisma` and migrate. The column now appears in Prisma's generated `AiAgentScalarFieldEnum`.
2. **Add one descriptor** to `CORE_SCALAR_FIELDS` in `agent-field-registry.ts`. This is now a **compile error until you do** — the object is `satisfies Record<AgentConfigScalarField, …>`, and `AgentConfigScalarField` is derived from the scalar enum, so a registered-but-missing or unregistered-but-present field won't type-check. (If the column is genuinely not user config — an audit/derived column — add it to `NonConfigScalar` instead.)
3. **Add validation** to `createAgentObjectSchema` / `updateAgentObjectSchema` in `lib/validations/orchestration.ts`. A registry parity test fails if the field sets don't agree, so you can't forget this.
4. If the field should round-trip through config export/import, **add it to** `bundledAgentSchema` (`lib/validations/orchestration.ts`) and `agentBackupSchema` + the exporter select + the importer apply (`lib/orchestration/backup/`). A parity test fails if a config scalar is missing from either serialised shape.

That's it. The version snapshot, diff labels/tabs/order, restore apply, the PATCH data mapping, and the clone copy **derive from the descriptor automatically** — no further edits.

### What derives vs what's parity-tested

The registry drives two kinds of surface differently, by risk:

| Surface                                 | How it stays in sync                                                  |
| --------------------------------------- | --------------------------------------------------------------------- |
| Version snapshot / diff / restore apply | **Derived** — the field set _is_ the registry's                       |
| PATCH data mapping, clone copy          | **Derived** — generic loop over the registry                          |
| create/update Zod schemas               | **Parity-tested** — hand-written, a test asserts the field sets match |
| export bundle + full backup schemas     | **Parity-tested** — a test asserts every config scalar is present     |

Validation and serialization are hand-written on purpose: they carry per-field, type-aware logic (enum members, bounds, null/JSON coercion, backwards-compatible backup defaults) that's working and battle-tested. Deriving them would mean re-encoding column types and risks subtle regressions on the highest-traffic write paths for no bug fix. The parity tests give the same guarantee that matters — **a forgotten surface is loud, not silent** — without the rewrite.

## Fork extension

Forks add their own agent columns and declare them in the fork-owned scaffold `lib/app/agent-fields.ts` (the `appAgentFields` array), which the platform concatenates into `AGENT_FIELDS`. **You never edit a platform file to add a field**, so a field addition conflicts with upstream on zero files — the same pattern as the other `lib/app/*` scaffolds (capabilities, nav, emails, surface).

```ts
import type { AgentFieldDescriptor } from '@/lib/orchestration/agents/agent-field-registry';

export const appAgentFields: AgentFieldDescriptor[] = [
  {
    name: 'interviewerStyle', // your AiAgent column
    kind: 'scalar',
    versioned: true,
    ui: { label: 'Interviewer style', tab: 'Instructions', order: 500 },
  },
];
```

For the same compile-time exhaustiveness the platform gets, a fork can `satisfies Record<YourConfigField, …>` against its own `Prisma.AiAgentScalarFieldEnum` keys — see `CORE_SCALAR_FIELDS`.

You still add the field to your fork's copy of the create/update schemas and (if exported) the bundle/backup schemas — the parity tests run in your fork too and will tell you exactly which you missed.

## Descriptor reference

```ts
interface AgentFieldDescriptor {
  name: string; // matches the AiAgent column (scalar) or grant key (relation)
  kind: 'scalar' | 'relation'; // 'relation' = a knowledge-grant join table, not a column
  versioned: boolean; // captured in snapshots, diffed, restored — all one derived set
  ui?: { label; tab; order }; // diff label / form tab / sort order; present iff versioned
  write?: 'relation' | 'historyTracked'; // special create/PATCH write (profileId / systemInstructions)
  patchOmit?: true; // not in the PATCH body (kind, widgetConfig)
  json?: true; // Prisma Json column — write paths coerce null → Prisma.JsonNull
}
```

Invariants enforced by `agent-field-registry.test.ts`: a field is versioned iff it has `ui`; the snapshot set equals the versioned set; every config scalar is present in the create/update/bundle/backup schemas (with documented exceptions); the scalar set is exhaustive against Prisma.

## See also

- `lib/orchestration/agents/agent-field-registry.ts` — the registry
- `lib/app/agent-fields.ts` — the fork-owned extension scaffold
- [`.context/admin/agent-form.md`](../admin/agent-form.md) — the admin form the `ui.tab` values group under
- [`VERSIONING.md`](../../VERSIONING.md) — public-surface contract (the registry exports are public)
