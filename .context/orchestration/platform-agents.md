# Platform Agents

Sunrise ships its own agents: the Pattern Advisor, the Pattern Quiz Master, the
MCP dispatch identity, nine evaluation judges, the evaluation case generator,
the Document Clean Up Assistant, and the two provider auditors. They are
platform machinery rather than content an admin wrote, and most have to exist
in **every** org, because features call them by slug. The clean-up upload opens
a conversation with `cleanup-agent`, an unscoped MCP tool call dispatches as
`mcp-system`, and an evaluation run is scored by `eval-judge-*`.

So each one is a **definition in code**, and every org it is for gets its own
**instance** of it (a few are the install org's only; see below): an ordinary `AiAgent` row with `isSystem: true`, in that
org, created when the org is and kept in line with the definition on every
release. Nothing is shared between orgs, so row isolation, the per-org caches,
rate limits, budgets and retention apply to them exactly as to an org's own
agents (§116, decided 2026-09-29).

## Where things are

| Piece                | Location                                                             |
| -------------------- | -------------------------------------------------------------------- |
| The registry         | `lib/orchestration/agents/platform-agents.ts`                        |
| The definitions      | `lib/orchestration/agents/platform-agent-definitions/*.ts`           |
| The reconcile        | `lib/orchestration/agents/reconcile-platform-agents.ts`              |
| Who owns which field | `platformAgent` on each descriptor in `agent-field-registry.ts`      |
| The org's marker     | `Org.settings.platformAgents` (`lib/tenancy/org-settings.ts`)        |
| The fork seam        | `lib/app/platform-agents.ts` → `initAppPlatformAgents()`             |
| The seed unit        | `prisma/seeds/021-platform-agents.ts`                                |
| The maintenance job  | `platformAgents` in `lib/orchestration/maintenance/platform-jobs.ts` |

## Who gets which agent

| Audience       | Agents                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `every-org`    | `mcp-system`, the six answer-quality judges, the three RAG judges, `eval-case-generator`, `cleanup-agent` (12) |
| `install-only` | `pattern-advisor`, `quiz-master`, `provider-model-auditor`, `audit-report-writer` (4)                          |

The provider auditors run inside the install org's Provider Model Audit
workflow. That workflow writes the provider-model catalogue every org reads,
so no other org may run them. The Pattern Advisor and Quiz Master (the Learn
page) are there to help the install's app admins build their app, not as a
tenant product (§116 ruling, 2026-09-29). At `TENANCY_MODE=single` the install
org is the only org there is, and the only one reconciled.

## What the platform owns, and what the org owns

Every agent field declares its side (see
[agent fields](./agent-fields.md#ownership-on-a-platform-agent)):

- **The platform owns what the agent is.** That covers name, description,
  kind, instructions, temperature, max tokens, knowledge access and
  retrieval, visibility, persona, guardrails, brand voice and every other
  behavioural field. It also covers the capability set (bound and enabled,
  exactly the declared list), the knowledge-tag grants (document grants are
  always empty), and the active flag. The one exception to the capability
  set is `mcp-system`, which has no tools of its own: MCP clients call
  whatever the MCP Tools page exposes. Its binding rows are the org's
  (`capabilityBindings: 'org'`). Under `CAPABILITY_BINDING_MODE=strict` an
  operator grants it tools by adding rows, and a reconcile never removes
  them. Every reconcile writes these back: a
  definition's value where it has one, otherwise
  `PLATFORM_AGENT_BASELINE`, the schema default.
- **The org owns how it runs there.** That covers provider, model, fallback
  providers, provider config, monthly budget, per-turn cost cap, rate limit
  and retention. They are set once, when the instance is created, and never
  touched again. A definition may give a starting value (the auditor starts
  with a $25 monthly budget), and `cleanup-agent` pins the strongest
  tool-using model the org can reach, among providers the org may use
  (§120 t-746). That pin is the one exception to "set once" (t-798). Who
  decides provider and model is stored on the row, in `AiAgent.bindingOwner`
  (`lib/orchestration/agents/binding-owner.ts`):
  - **`'platform'`**: every reconcile moves them to the current pick, onto a
    model newly reachable, off a provider the org lost, or back to "inherit"
    when nothing qualifies. The write lands only while the binding and its
    owner are still what the run read, so an admin's save in between stands.
  - **`'org'`**: never moved. `PATCH /agents/:id` and version restore set it
    whenever they change provider or model. `bindingOwner: 'platform'` in a
    PATCH body hands the binding back and reconciles the org at once. `'org'`
    takes it as it stands, which is how an admin keeps the agent on inherit,
    since the API cannot set provider or model to empty.
  - **`null`**: not yet classified, which covers every agent from before
    t-798. The next reconcile classifies it once:
    - the org's, when the definition sets its own starting binding, as a new
      instance would;
    - the platform's, when it is on inherit, on the platform's current pick,
      or when the service account wrote the version where its current
      binding began, so a pin the platform placed on a since-revoked provider
      moves. A first version backfilled long after the agent was created
      doesn't count: it records who backfilled it, not who chose the binding;
    - otherwise the org's, as when there's no history to go on, because
      moving an admin's choice is worse than leaving a pin the platform
      placed.

  Only a platform agent whose definition picks its binding has an owner;
  every other agent's `bindingOwner` stays null. A PATCH that echoes it back
  unchanged, or as `null`, asks for nothing, because an owner can't be
  cleared.

  Ownership is stored rather than inferred from the values because a value
  can't say who wrote it. The pick is asked at most once per agent per run,
  and only for a binding the platform owns or has yet to classify. A pick
  that can't be answered (the org's policy unreadable, or a fork's
  eligibility or credential resolver down) leaves that agent's binding as it
  is and holds the org's marker back so the next pass asks again; every
  other agent is still reconciled. Both fork seams answer "nothing" by
  default when a resolver fails, which would move the agent to inherit,
  version the move, and move it back on the next pass. So the clean-up pick
  asks for the difference (t-819): eligibility with `onFailure: 'throw'`, and
  credentials through `classifyProvidersByCredential`, which keeps the rows
  a resolver failed for apart. A failed row blocks the pick only when its
  model would have won. A resolver that throws for a provider it doesn't
  serve therefore changes nothing unless that provider has the best model.

## What an org's admin can change

The API refuses what a reconcile would put back, so an edit is never
accepted and then quietly undone
(`lib/orchestration/agents/platform-agent-guard.ts`). On a system agent:

- **`PATCH /agents/:id`** returns 403 for a change to any platform-owned
  field, and names the fields. `isActive` is one of them, in both
  directions: a retired agent stays off. Values are compared, not keys, so
  a client that sends the whole agent back with only the model changed
  goes through. The org's fields (provider, model, fallbacks, provider
  config, budget, per-turn cap, rate limit, retention) are always writable.
  A change to provider or model sets `bindingOwner: 'org'`. On an agent whose
  definition picks its binding, the body's `bindingOwner` hands the binding
  back (`'platform'`) or takes it as it stands (`'org'`). A hand-back that
  also changes provider or model is refused with 400. The agent form shows
  who decides on such an agent and offers the hand-back ("Let the platform
  choose", t-818). `GET /agents/:id` says which agents those are, in
  `platformAgent.picksOwnBinding`.
- **The binding routes** refuse attach, detach, and switching a binding on
  or off (`isEnabled`): the reconcile writes both the set and the state back.
  A binding's `customConfig` and `customRateLimit` stay writable, because
  the reconcile never writes them — locking them would freeze whatever they
  hold with no way to change or clear it. `mcp-system`'s
  bindings are the org's, and every binding route accepts them.
- **`PATCH /agents/:id/widget-config`** is refused outright; a platform
  agent's widget config is the platform's.
- **Version restore** brings back only the org's fields and leaves the
  grants as they are. The Versions tab's confirm dialog says so and names
  the fields. While the platform owns the binding (`bindingOwner:
'platform'`), a restore leaves provider and model as they are too (owner
  ruling 2026-10-26, t-821). They move on their own, so almost every older
  version holds another pair, and restoring one would freeze the agent on an
  old pick, or be refused outright if that pick's provider has since been
  revoked. The provider the restore leaves alone is not one it asks approval
  for. It leaves the provider configuration as well, since that belongs to
  whichever provider is primary. It does bring back the version's
  fallbacks, the org's own list, minus the current primary, which would
  otherwise fall back to itself. A fallback whose provider has since been
  revoked still refuses the restore, as on any agent. An admin who wants an
  old pair sets it on the form. Once the org owns the binding, a restore
  brings provider, model and configuration back, and keeps the binding the
  org's.
- **Delete, bulk actions and the instructions revert** refuse system agents,
  as they always have. **Clone** is allowed: the copy is the org's own agent.

`GET /agents/:id` returns the same split as `platformAgent: { lockedFields,
tunableFields, bindingsLocked }` (`null` on an org's own agent). The agent
form disables the locked controls from it, never sends them, and its banner
names what the org can change.

**Reserved slugs.** No agent an org makes may take a registered platform
slug, in any org, including the install-only ones and any a fork registers.
Create and rename refuse one with a 400 on `slug`; clone refuses a slug the
caller chose and skips past a generated one; both importers skip the agent
with a warning. An org that took a platform slug before this rule keeps its
agent. The reconcile never adopts it, and every lookup of an agent by a
platform slug matches system rows only, so such an org gets "not found"
rather than its own agent run in the platform agent's place:

- the fixed lookups filter on `isSystem`: the clean-up and `mcp-system`
  agents, the patterns-tag grant, and the quiz master behind saved quiz
  scores and the Learn page;
- a lookup by one slug spreads `platformSlugWhere(slug)`: chat's agent load
  (which the judges and the case generator go through), the workflow
  `agent_call` and `chat_turn` steps, the consumer and admin chat routes,
  the invite-token check, and the judge checks when an evaluation run or an
  experiment verdict is created;
- a lookup by a list spreads `platformSlugsWhere(slugs)`: the orchestrator's
  agents, the workflow validator's `agent_call` check, the workflow and
  evaluation cost estimates, and the agent names on an execution's trace.

Checks and estimates ahead of a run therefore resolve the same agent the run
will.

## When the reconcile runs

`reconcilePlatformAgents(orgId)` is the only writer of instances. It enters
the org's own scope itself, and it has five callers:

1. **`createOrg`**, after the org is committed. A new org has its agents
   before the request that made it returns. A failure is logged and never
   fails the org's creation.
2. **A provider-policy change**: `PUT /api/v1/admin/orgs/[id]/providers`
   calls `tryReconcilePlatformAgents` after writing a changed policy, so the
   clean-up agent moves at once (t-798). It is a shortcut, not the guarantee:
   it skips a suspended org, never throws, and never fails the grant. The
   maintenance job below catches up anything it misses.
3. **A binding hand-back**: `PATCH /api/v1/admin/orchestration/agents/:id`
   with `bindingOwner: 'platform'` calls `tryReconcilePlatformAgents` the same
   way, so the agent lands on the platform's pick before the response, which
   carries where it landed (t-798).
4. **`npm run db:seed`**: the `021-platform-agents` unit reconciles every
   active org. Its `hashInputs` include every definition file, the seeder
   and the patterns chunk file, so editing one re-runs it on the next seed.
5. **The `platformAgents` maintenance job**, every 15 minutes, per org. It
   compares the org's stored digest with the running registry's and
   reconciles only an org that is behind: after a deploy changed a
   definition or the patterns knowledge, or after a creation-time reconcile
   failed. An org whose definitions name a capability or tag that has no
   row yet, or whose copy of the patterns knowledge could not be written, is
   reconciled on every run until it is complete. It also reconciles an org
   whose platform-picked binding is no longer what the platform would pick
   (t-798): what an org can reach changes without the registry changing — a
   grant or revocation, a provider switched on, a key set, a strong model
   added, a fork's eligibility rule — and some of those (an env var, a fork's
   credential resolver) have no write a hook could catch. So the job asks,
   every pass. For an org whose agents pick, it first drops this process's
   cached copy of the org's provider policy, which may predate a grant or
   revocation another instance served. Cached provider rows (their
   jurisdiction) keep their 60-second TTL, so a pick made in that minute is
   corrected next pass. Otherwise it is one `Org` read per org, plus, where
   an agent picks its own binding, that agent's binding, the org's provider
   policy and the pick's per-org filters (credential, eligibility). The
   provider and model rows are read once per run, not once per org: the job
   hands every org of a run one `PlatformAgentCatalogue` (t-816), since both
   tables are global. A drifted org's reconcile reuses the picks its drift
   check got rather than asking for them again; one the check could not get
   is asked again.

The digest covers every definition, the baseline, and the patterns
document's slug (`PATTERNS_DOCUMENT_SLUG` in
`lib/orchestration/knowledge/patterns-knowledge.ts`, which carries the chunk
file's content hash). A test recomputes that slug from the committed file, so
editing `chunks.json` fails until the constant follows.

## What a reconcile does, and refuses to do

These are the properties the unit tests pin, one test each:

- **Idempotent.** An instance that already matches is not written: no update,
  no version row, no `updatedAt` churn. The marker is rewritten only when it
  changed.
- **Code-owned fields are written back; org-tunable ones never are.**
- **Bindings and tag grants are set to the declared set.** Stray bindings are
  removed and disabled ones re-enabled; capability and tag rows that don't
  exist yet are skipped with a warning. `mcp-system`'s bindings are left
  exactly as the org has them.
- **A version row when a versioned field changes**, holding the post-change
  config and summarised as `Platform definition: …`. The service account is
  its author, and it is the creator of every instance. A change to bindings
  alone writes no version, because bindings are not in the snapshot.
- **It never takes over an org's own agent.** A non-system agent holding a
  platform slug is logged and left alone.
- **A definition removed from the registry deactivates its instances; it
  never deletes them.** Conversations, cost rows and evaluations point at
  them. Only agents this reconcile placed (the marker's `slugs`) are
  candidates, so a fork's own seeded `isSystem` agent is never switched
  off.
- **Safe on empty.** A registry that resolves empty changes nothing. A fork
  cannot remove a core agent, so an empty registry means an import broke,
  not that every agent should go.

## The patterns knowledge

The Pattern Advisor and Quiz Master search the patterns document, "Agentic
Design Patterns": one document of 191 chunks, built from the committed
`prisma/seeds/data/chunks/chunks.json`. **The knowledge goes where its agents
go**: the reconcile writes a copy only into an org one of whose definitions
declares the `agentic-design-patterns` tag (`materialisePatternsKnowledge` in
`lib/orchestration/knowledge/seeder.ts`). In core that is the install org
alone, since both agents are install-only. A fork that gives one of its own
agents the tag gets a copy wherever that agent goes. The copy is ordinary
tenant knowledge: every search, list and grant sees it the way it sees the
org's own documents.

- **Before the agents.** Writing an org's first copy creates the managed
  `agentic-design-patterns` tag, which both agents are granted. So their
  grants land on the same run.
- **In the org's own default knowledge base.** `AiKnowledgeChunk.chunkKey` is
  unique per org, because the seeded keys are fixed and any org that loads the
  document (the knowledge page's **Load Agentic Design Patterns**) holds them.
- **Without embeddings.** Vector search needs them. The advisor and quiz find
  nothing until the chunks are embedded, as before: **Generate Embeddings** on
  the knowledge page (`POST /knowledge/embed`, the calling org's chunks only)
  or `npm run db:seed:embeddings` (the install org's). The pattern explorer and
  `get_pattern_detail` read chunks directly, so they work straight away.
- **Idempotent by slug.** The slug carries the content hash, so an org that
  holds this version is not written.
- **An existing copy is never refreshed.** An org holding a copy of an
  earlier `chunks.json` keeps it, with a warning logged on each run.
  Replacing it would drop the org's embeddings, and the seeder has never
  done so. Only an org's first copy comes from the current file.
- **A failure never stops the agents.** It is logged, the agents are
  reconciled anyway, and the org's marker is left unwritten, so the next
  run tries again.

## Adding or replacing one in a fork

Register it from `lib/app/platform-agents.ts`:

```ts
import { registerPlatformAgent } from '@/lib/orchestration/agents/platform-agents';

export function initAppPlatformAgents(): void {
  registerPlatformAgent({
    slug: 'intake-triage',
    audience: 'every-org',
    agent: {
      name: 'Intake Triage',
      description: 'Routes new requests to the right queue.',
      systemInstructions: 'You triage incoming requests…',
      temperature: 0.2,
      maxTokens: 2048,
    },
    capabilities: ['search_knowledge_base'],
    knowledgeTags: [],
  });
}
```

It runs once, lazily, before the registry's first read, through the shared
init gate ([fork init seams](../architecture/fork-init-seams.md)). A throwing
init is rolled back. Registering a slug Sunrise uses replaces Sunrise's
definition in every org, and that is logged at warn.

A definition can pick its own provider and model with `defaultBinding(db,
catalogue)`, as the clean-up agent does (`pickCleanupBinding`). The
maintenance job asks it every pass while the platform owns the binding, so:

- **Read provider and model rows from `catalogue`**, not `db`. It is shared by
  every org of one run, so the tables are read once per run (t-816).
- **Tell "no" from "could not ask"** (t-819): call
  `resolveEligibleProviders(slugs, context, { onFailure: 'throw' })`, and
  `classifyProvidersByCredential(rows)` rather than
  `filterProvidersWithCredential`. Return `null` only for a real "nothing
  qualifies", and throw when a row you couldn't ask about could change the
  answer.
- **Keep it deterministic**: a total order with no locale-dependent
  comparison, or the agent moves back and forth between passes.

Core's tests whose assertions a fork's agents would change hold this seam
empty, so they measure core's registry alone, and the two-org smoke (`smoke:tenancy-isolation`,
section [11]) takes its counts from the registry and finds the install org's
agents by registered slug, so a system agent you seed there outside the
registry is not counted. Adding an agent of your own needs no edit to either.
What still notices:

- `tests/unit/lib/app/defaults.test.ts` asserts this seam ships empty, so
  filling it fails that row by design. Pin your definitions there, as its
  header says, rather than deleting the row.
- The smoke runs `cleanup-agent`, `eval-judge-relevance`,
  `eval-case-generator` and `mcp-system` in a second org by slug. Replacing
  one runs your definition there, and moving one to the install org fails
  those steps.
- The patterns knowledge is the install org's only. An every-org agent that
  declares its tag puts a copy in every org, and the smoke's check that a new
  org holds none fails.

An agent seeded once as the install org's content is still the right shape
for an app's own agent. Register a platform agent only when every org needs
its own instance.

## Not yet

- An org admin's console still lists the Learn page, whose advisor, quiz and
  pattern explorer find nothing outside the install org, and the MCP patterns
  resource answers "not found" to another org's key. The console split (§111)
  decides what an org admin sees.
