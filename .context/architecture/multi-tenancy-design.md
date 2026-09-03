# Multi-Tenancy Capability — Design

> **Status: design record, decided 2026-08-27.** Sunrise ships multi-tenancy as
> an **opt-in platform capability**: behaviour-neutral at `TENANCY_MODE=single`,
> enforced by Postgres RLS at `multi`. This document is the binding _how_ — the
> decisions, principles, and target architecture the build follows. The _plan_
> (features, tasks, ordering, ownership) lives in the HCE Hub under the
> **Multi-tenancy** phase and is deliberately not restated here.
>
> Companions: [`multi-tenancy.md`](./multi-tenancy.md) (the RLS playbook — the
> proven policy pattern and its gotchas) and
> [`multi-tenancy-research.md`](./multi-tenancy-research.md) (the gap analysis
> this capability answers). Where this document and either companion disagree,
> this document is the decision; the research is the survey it was made from,
> and the playbook is the recipe it builds with.

## Who this is for

- **Building the capability** — the principles and architecture below bind.
- **A fork deciding whether to enable it** — read
  [What a fork gets, and owns](#what-a-fork-gets-and-what-it-owns).
- **A fork on the releases where it lands** — read
  [Merge impact](#merge-impact-for-forks).

## The decisions (2026-08-27)

Four gating decisions, recorded with their reasoning so they are not re-derived
per session. They answer the research doc's §6 decision gate and §13 Q0/Q1/Q2.

| #   | Decision              | Choice                                                        | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Scope**             | Opt-in capability **in Sunrise**, not fork-tier               | Reverses research §14.5 ("seams, not feature"). ConQuest is a leaf fork; anything a leaf builds in `lib/app/` the next SaaS fork rebuilds — and only upstream CI can run the two-tenant harness on every release, which is the sole control that keeps an isolation boundary honest across syncs. The maintenance tail (every future feature acquires a tenancy dimension) is accepted, and the enforcement tests below are what make it bearable.            |
| 2   | **Topology**          | Pooled, Postgres RLS                                          | The proven playbook, and the only option that keeps **one migration pipeline** — `db:migrate:deploy`, drift-check, seed and Studio all assume one schema, and every fork runs that pipeline. Self-serve org creation is a row, not DDL. Cells (instance per tenant) remain the documented answer to enterprise residency asks (research §14.1); schema-per-tenant was not spiked because its migration fan-out changes the operating model for every MT fork. |
| 3   | **Org model**         | Hand-rolled `Org` + `OrgMembership`, multi-membership allowed | `activeOrgId` rides better-auth `session.additionalFields` (supported). The better-auth `organization` plugin was **declined**: it collides with Sunrise's hand-rolled invitation/bootstrap/invite-only machinery, imposes its own table names and role vocabulary, and adds better-auth upgrade surface (1.7 broke sign-in in 0.11.0). The research's "multi-org membership ⇒ plugin" coupling was wrong — multi-membership is just a join table.            |
| 4   | **Tenant resolution** | Session/credential-bound; **no URL scheme**                   | Active org lives in the session; API keys, embed tokens and MCP keys bind an org at mint time; unauthenticated slug routes keep a globally-unique routing key and enter org context from the resolved row. The template imposes no subdomain/path scheme — a fork adds one via the `lib/app/tenant-resolver.ts` seam (proxy resolves, forwards a header it is the sole writer of, the guard verifies membership — the visitor-id precedent).                  |

### Decided by consequence

| Question (research §13)                           | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane decoupled from `TENANCY_MODE`? (Q8) | **Yes.** With one org always existing, #366's bespoke single-tenant case is "org-admin of the install org" — no third `role` value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Global-config models per tenant? (Q3)             | **No, in v1.** Provider configs/models, capabilities, profiles, flags, tags and both singletons stay global. Per-tenant defaults/budgets are a separately-costed later decision (research §5C B3). One consequence to state plainly: **one embedding model per install** — vector dimension is a schema property, not a setting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Credential custody (Q5)                           | **Declined as policy.** Shared platform keys + per-org quotas ship; `resolveProviderCredential(config, ctx)` (default: today's `process.env` lookup) keeps gateway / vault-reference / workload-federation models open. Sunrise never stores a tenant's vendor key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Breakers / in-flight counters per tenant? (Q4)    | **Global in v1**, keyed on (provider slug, credential identity) so a later per-tenant policy is a keying change, not a redesign.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `admin` API-key scope (Q6)                        | **Platform-only.** Mintable only by a platform ADMIN; org-bound keys can never carry it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `AiCostLog` ownership (Q10)                       | **Yes** — durable `userId` (groundwork), `orgId` (row isolation).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Impersonation (Q7)                                | **Platform-tier.** It is a compliance surface (consent, time-box, distinct audit actor); forks would each get it subtly wrong.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Storage ladder (Q9)                               | **Publish rungs 0–5; exclude rung 6** (arbitrary bespoke backends). Rung 5 — a dedicated deployment — already ships.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Auto-fallback (Q15)                               | **Fixed via an eligibility seam**: fallback only within `resolveEligibleProviders(ctx)`; default = today's behaviour at `single`, deny-by-default at `multi`. **Shipped 2026-09-03** as `registerProviderEligibility` (`lib/app/llm-providers.ts`), covering the auto-picked primary AND both fallback lists at the agent-binding resolver. NOT yet the second chokepoint. At least five paths resolve a provider without passing through the resolver and are all Sunrise choosing: a workflow step with no `modelOverride`, knowledge keyword enrichment, the retroactive-review judge, audio transcription's matrix fallback, and the embedding provider chain — the last of which never touches the provider manager. t-658 and t-659 are built and gated but unmerged. The enumeration of these paths has been short on all three occasions it has been checked, so the completeness question is being answered with a call-time gate rather than a longer list: see `.context/architecture/provider-selection-waist.md` for the spike, and `.context/orchestration/llm-providers.md` for the current per-path table. An EXPLICIT `agent.provider` is deliberately not overridden at runtime; enforcing that belongs at write time (do not offer a provider the org has not approved), which is per-org work. Both layers are required: write-time validation cannot reach agents stranded by a policy that changed after they were configured, nor writes that bypass the form. |

## Design principles

Every PR in the programme is reviewed against these.

1. **One org always exists.** At `single`, a migration seeds an "install org"
   and every user is a member. The write path, the authorization policy and the
   console split have **one code path, not a dormant one** — which is what lets
   the harness at `multi` protect the write path every single-tenant install
   runs daily.
2. **Inert at `single`, literally.** A single-tenant install behaves
   byte-for-byte as before: no RLS enabled, no per-query `set_config`, no
   resolver, no new operator questions. The mode changes _enforcement and
   resolution_, never the code path. Behaviour-neutrality is test-proven, not
   asserted (`platform.seam-design`).
3. **Chokepoint, not sweep.** Tenancy enters at `lib/db/client.ts` (a Prisma
   client extension) and `lib/auth/guards.ts` (the ALS store). No route handler
   learns about `orgId`.
4. **Derive rosters; the signal covers the class.** A model is tenant-owned
   _because_ it carries `orgId`. Injection, RLS policies, drift probes and the
   coverage test all derive from that one fact — a fork's own models join by
   adding the column, with no registration step.
5. **Classify every model or fail.** A schema-parsing test requires every model
   to be tenant-owned (has `orgId`), on the global-config allowlist, or on the
   system allowlist — the `export-sources.test.ts` shape, including its "never
   delete from the manifest to go green" rule.
6. **Fail closed, fail loud.** Missing context at `multi` throws (the
   `TENANCY_MODE` guard's pattern). RLS `WITH CHECK` rejects an insert with no
   org. A dropped policy is a drift-probe failure, not a silent regression.
7. **Async, two-faced, open-struct authorization.** `canRead` (boolean) and
   `subjectScope` (Prisma `where` fragment) derive from one policy and a parity
   test asserts they agree; scope inputs are an open struct
   `{ ownership?, tier?, org? }`; everything returns a `Promise` from day one.
   (The contract Daybreak validated fork-first on #367.)
8. **Platform owns the mechanism; forks own the product.** Org roles stop at
   `OWNER / ADMIN / MEMBER`. Plans, billing, pricing, org branding, self-serve
   signup UX, and any team/workspace layer beneath the org are fork-owned.

And two standing rules inherited from the repo: every seam lands in
`VERSIONING.md`'s public surface with a CHANGELOG bullet in the same PR, and
core-schema diffs stay mechanical (one field + one index per model) so a fork's
sync conflict is a "keep both", not a re-read.

## Target architecture

> **Target state, not current state.** The tenancy pieces named in this
> section — `lib/tenancy/context.ts`, `prisma/schema/tenancy.prisma`,
> `lib/auth/authorization.ts`, `lib/auth/roles.ts`, `lib/app/authorization.ts`,
> `lib/app/tenant-resolver.ts`, `db:tenancy:enable` — do not exist yet
> (verified at v0.11.2); they are the agreed shape the Hub features build
> toward. The chokepoints they attach to (`proxy.ts`, `lib/auth/guards.ts`,
> `lib/db/client.ts`, the maintenance tick) all exist today. A tenancy path
> here becomes a real reference only when its feature ships.

Request path at `multi` — at `single` the same components run with the install
org as the only answer:

```
request
  → proxy.ts            resolves tenant only via the fork's lib/app/tenant-resolver.ts
  |                     seam (if registered) → x-sunrise-org header (proxy sole writer,
  |                     strips inbound — the visitor-id precedent)
  → withAuth /          reads session.activeOrgId, or the org bound to the API key /
    withAdminAuth       embed token / MCP key, or the verified resolver header;
  |                     verifies membership; ENTERS the tenant context (ALS)
  → authorization       canAdminister / canRead / subjectScope — platform ADMIN sees all;
    policy              org OWNER/ADMIN administer their org's tenant-owned resources
  → route handler       tenancy-unaware
  → lib/db/client.ts    $extends: injects orgId on create paths; at multi wraps each
  |                     operation as $transaction([set_config('app.current_org', org,
  |                     true), op]); runAsSystem sets the audited bypass GUC
  → Postgres            org_isolation policies: USING + WITH CHECK, NULLIF form
                        (see the playbook for why NULLIF is load-bearing)

background tick → forEachOrg(fn)  one org-scoped context per iteration, per-org batch caps
               → runAsSystem(reason)  audited; for genuinely global sweeps only
```

### The four components

- **Identity** — `prisma/schema/tenancy.prisma`: `Org` (slug, name, status,
  settings), `OrgMembership` (`@@unique([orgId, userId])`, role enum,
  `onDelete: Cascade`, export-manifest and erasure dispositions per the
  `CLAUDE.md` FK rules). Invitations extend the existing invitation flow with an
  org and org role. Per-org bootstrap ("first member becomes OWNER") sits beside
  the install-scoped `AuthBootstrap`.
- **Context** — `lib/tenancy/context.ts`: `AsyncLocalStorage<{ orgId, source }>`
  where `source` ∈ session · api-key · embed-token · mcp-key · resolver ·
  system · job. Entered by the guards (in-repo precedent:
  `lib/auth/signup-mode.ts`); `requireTenantContext()` throws at `multi`;
  `runAsOrg`, `runAsSystem(reason)` (logged), `forEachOrg` for non-request call
  stacks. `getFullContext()` carries `orgId` so breach scoping is lookup, not
  reconstruction.
- **Data plane** — the client extension (Prisma's documented RLS pattern:
  `$allModels.$allOperations` wrapping each op in a batch transaction with
  `set_config(..., true)`), plus `org_isolation` policies shipped **dormant** in
  a raw-SQL migration. `CREATE POLICY` on a table without RLS enabled is inert,
  so policies version with the schema (the pgvector-index precedent in the
  baseline migration) while `npm run db:tenancy:enable` runs only
  `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` over the derived tenant-owned
  set. At `multi` the app connects as a restricted role (no `BYPASSRLS`, not
  the table owner); migrations and seeds use a privileged DSN. Child rows
  without their own `orgId` use join-based policies; hot-path children
  (`AiMessage`, `AiKnowledgeChunk`, `AiMessageEmbedding`, `AiCostLog`)
  denormalise the column. `orgId` is nullable first and backfilled to the
  install org; `NOT NULL` is a later staged migration (the
  `AiKnowledgeDocument.slug` precedent).
- **Control plane** — `lib/auth/authorization.ts` default policy; override
  registry at `lib/app/authorization.ts`; optional `resource` resolvers on
  `withAuth`/`withAdminAuth`; role known-values in `lib/auth/roles.ts`.

### Namespace rules

Human-meaningful slugs (`AiAgent`, `AiWorkflow`, `AiKnowledgeBase`,
`AiKnowledgeDocument`) become `@@unique([orgId, slug])`. Global-config slugs
stay global. **Routing keys stay globally unique** — trigger channels,
`dedupKey`, `idempotencyKey`, inbound/webhook slugs — because the routes they
address carry no tenant: those routes resolve the row under system context and
then `runAsOrg(row.orgId)`.

## Assurance

The controls that keep the boundary fixed after the authors move on — each
exists because its failure mode is silent:

| Control                                                                                                                                                                                                                                       | Catches                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Model-classification test (schema-derived, three-way)                                                                                                                                                                                         | A new model — upstream's or a fork's — nobody classified                                                    |
| Policy-coverage test + `rlsEnabled`/`policyExists` drift probes                                                                                                                                                                               | `migrate dev` dropping Prisma-unmodelled policies; a table added without one                                |
| Raw-SQL allowlist test                                                                                                                                                                                                                        | A new `$queryRaw*` site nobody consciously admitted                                                         |
| Two-tenant leakage harness (a `TENANCY_MODE=multi` CI job): seed two orgs, drive the API surface as each, assert zero cross-visibility — raw-SQL paths explicitly (vector search, cost reports, conversation search), plus a `forEachOrg` job | Everything the others miss; the only control that fails when an upstream release lands outside the boundary |
| Authorization parity test (exported for fork overrides)                                                                                                                                                                                       | `canRead` and `subjectScope` diverging — the defect Daybreak's review actually caught                       |
| Behaviour-neutrality tests at `single`                                                                                                                                                                                                        | The capability costing single-tenant installs anything                                                      |

## Spike register

Open questions a day of throwaway code answers better than a paragraph; resolve
before sizing the dependent work, and fold findings back into this document.

1. **Client extension × interactive transactions.** The documented pattern
   wraps each op in a _batch_ transaction; callers already inside
   `prisma.$transaction(async tx => …)` need one `set_config` per transaction,
   not a nested batch per op.
2. **Nested-create `orgId`.** `$allModels.create` sees only top-level args;
   children created via nested writes rely on join policies or explicit
   denormalisation. `WITH CHECK` is the backstop either way — verify it fires.
3. **Per-op cost and pooling.** Two round trips per op at `multi`; measure
   behind Neon's pooled endpoint and PgBouncer transaction mode.
4. **Dormant policies.** Confirm `CREATE POLICY` without enablement is fully
   inert for any single-tenant role, and that `migrate dev`'s drift output
   stays manageable with probes.
5. **Session `additionalFields` in better-auth 1.7.** Type inference through
   `customSessionClient`; whether org switching is `updateSession` or a
   database hook on session create.
6. **Proxy runtime.** The resolver-seam contract must be Web-standard only —
   the proxy may run on Edge for Vercel-deployed forks.

## What a fork gets, and what it owns

Enabling the capability (`TENANCY_MODE=multi` + `db:tenancy:enable` + the
restricted app role) gives a fork org identity, membership, invitations,
context propagation, RLS row isolation, tenant-aware background work,
org-scoped storage/export/providers, quota and budget primitives, and the
org-admin console — maintained and regression-tested upstream.

A fork owns:

- **Its own models** — add `orgId` to each tenant-owned app model; the
  classification test will name every model until it is classified; injection,
  policies and the harness then cover them automatically (principle 4).
- **The product layer** — plans, billing, pricing, self-serve signup, org
  branding, and any team/workspace layer beneath the org.
- **Tenant arrival beyond the session** — a subdomain or path scheme via
  `lib/app/tenant-resolver.ts`, with the cookie/CORS/CSP consequences that
  choice carries.
- **Non-`User` principals** — end-user tokens (e.g. questionnaire respondents)
  bind an org at mint time; the fork decides what those tokens are.

## Merge impact, for forks

- The identity release carries one migration (two tables + install-org seed +
  membership backfill). The row-isolation release carries the big one — an
  `orgId` column and index on every tenant-owned core model, plus the dormant
  policies. Both are mechanical to fold; sync **before** they land rather than
  across them.
- Single-tenant forks feel no behaviour change at any point; the install org is
  invisible to their operators.
- The per-sync tenancy checklist in the playbook shrinks to what the tests
  cannot catch (new process-global state, new background jobs); the rest is
  enforced in CI.

## Explicitly out of scope (v1)

Per-tenant provider credentials held by Sunrise (declined as policy) ·
per-tenant default models, budgets-as-settings, or embedding models (singleton
and vector-dimension consequences, research §5C B3) · per-tenant storage
backends or databases (rungs 4/6 — a dedicated deployment is the answer) ·
plans, invoicing, payments (fork product) · schema-per-tenant and cell
tooling.
