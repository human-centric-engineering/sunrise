# Template: App-agent seed (`isSystem: false`)

Use this when an **app/fork** agent must always exist — on a fresh install or
after `db:reset` — instead of being created ad-hoc through the admin API. Agents
created via `POST /agents` are admin-editable rows but **do not** exist on a
fresh deploy; a persistent app agent has to be seeded.

**Do NOT model your seed on a Sunrise _core_ agent** (the platform-agent
definitions in `lib/orchestration/agents/platform-agent-definitions/` —
`model-auditor.ts`, `evaluation-judges.ts`, …). Those are platform machinery:
the reconcile writes each one as an `isSystem: true` row. Setting that flag on
your seeded app agent silently elevates it into the **reserved** class
(undeletable, undeactivatable, instruction-locked, excluded from backup/export)
while it masquerades as core. **App rows you seed keep `isSystem: false`.**
Start from this scaffold instead.

If the agent should exist **in every org** and be maintained from code the way
Sunrise's own are, register it as a platform agent instead of seeding it:
`registerPlatformAgent()` from `initAppPlatformAgents()` in
`lib/app/platform-agents.ts`. The reconcile then creates it in each org as a
system agent and owns what it is (instructions, temperature, bindings and the
other non-cost fields), so admin edits to those do not survive; the org keeps
provider, model and spend. See `.context/orchestration/platform-agents.md`. An
ordinary app agent seeded once, as below, remains the default.

## Placement

Drop the file in an **app-namespace subdirectory**, not at the top level:

```
prisma/seeds/app-<yourapp>/001-<agent-slug>.ts
```

The runner discovers seeds recursively, so a subdirectory still runs. Keeping app
seeds out of the top-level `NNN-*.ts` core range avoids numbering collisions and
makes "this is app, not platform" obvious at a glance. The basename must still
match `NNN-slug.ts` (e.g. `001-questionnaire-extractor.ts`).

## Scaffold

```typescript
import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';

const QUESTIONNAIRE_EXTRACTOR_INSTRUCTIONS = `You are ...

## Output Format

Always respond with ...`;

const unit: SeedUnit = {
  // The `name` is the SeedHistory key; for a subdir seed it is the path
  // relative to prisma/seeds minus `.ts` (e.g. `app-acme/001-questionnaire-extractor`).
  name: 'app-acme/001-questionnaire-extractor',
  async run({ prisma, logger }) {
    logger.info('🌱 Seeding questionnaire-extractor agent (app)...');

    // `createdBy` is a required FK to a User. Reuse the platform's SERVICE
    // config-owner (seeded by 001-system-owner) so the seed needs no human
    // admin to exist. Resolve it via the shared predicate, never by hardcoded id.
    const owner = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!owner) {
      throw new Error('No SERVICE config-owner found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: 'questionnaire-extractor' },
      // create-once: an empty `update` means re-seeds (and `db:seed` re-runs
      // after a content-hash change) DON'T clobber operator edits made in the
      // admin UI. If you instead want this agent to be framework-managed —
      // re-asserting fields on every deploy like a core seed — list those
      // fields here explicitly (e.g. `{ systemInstructions: ... }`). Either way,
      // NEVER add `isSystem` here.
      update: {},
      create: {
        name: 'Questionnaire Extractor',
        slug: 'questionnaire-extractor',
        description: 'Extracts structured answers from a questionnaire transcript.',
        systemInstructions: QUESTIONNAIRE_EXTRACTOR_INSTRUCTIONS,
        // Empty strings → resolved at runtime from the model matrix by
        // agent-resolver.ts, exactly as the API-created agents do. Pin an
        // explicit provider/model pair only if the role genuinely needs one.
        model: '',
        provider: '',
        temperature: 0.2,
        maxTokens: 4096,
        monthlyBudgetUsd: 25,
        isActive: true,
        // RESERVED for Sunrise core machinery. App/fork agents MUST keep this
        // false — true makes the row undeletable, undeactivatable,
        // instruction-locked, and invisible to config backup/export. Do not
        // "fix" this to true by copying a core seed.
        isSystem: false,
        createdBy: owner.id,
      },
    });

    logger.info('✅ questionnaire-extractor agent seeded');
  },
};

export default unit;
```

## Notes

- **`isSystem: false`** is the one non-negotiable. The comment is there so the
  next reader doesn't "tidy" it to `true`.
- **Idempotent `upsert` keyed on `slug`** — re-seeds converge instead of
  duplicating. The runner additionally skips a unit whose source hash is
  unchanged, so a no-op `update: {}` is genuinely create-once.
- The same reservation applies to **`AiCapability`** and **`AiAgentProfile`** —
  if you seed those, set `isSystem: false` there too. (App capabilities created
  through `POST /capabilities` can't set it at all; the seed path is the only
  way to reach the flag, which is why this matters.)
- If your app agent's prompt is built **in code** per call (a common pattern for
  capability-dispatched agents) rather than read from `systemInstructions`, the
  stored instructions are inert — note that in the seed so operators aren't
  misled by the admin "effective prompt" preview.
