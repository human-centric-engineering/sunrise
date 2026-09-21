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

| Question (research §13)                           | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane decoupled from `TENANCY_MODE`? (Q8) | **Yes.** With one org always existing, #366's bespoke single-tenant case is "org-admin of the install org" — no third `role` value. The vendor/customer split of the 68 admin surfaces is written down in [the playbook's control-plane section](./multi-tenancy.md#the-control-plane-which-admin-surfaces-are-whose), derived from the model inventory; the decision seam that routes it is `canAdminister`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Global-config models per tenant? (Q3)             | **No, in v1.** Provider configs/models, capabilities, profiles, flags, tags and both singletons stay global. Per-tenant defaults/budgets are a separately-costed later decision (research §5C B3). One consequence to state plainly: **one embedding model per install** — vector dimension is a schema property, not a setting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Credential custody (Q5)                           | **Declined as policy.** Shared platform keys + per-org quotas ship; `resolveProviderCredential(config, ctx)` (default: today's `process.env` lookup) keeps gateway / vault-reference / workload-federation models open. Sunrise never stores a tenant's vendor key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Breakers / in-flight counters per tenant? (Q4)    | **Global in v1**, keyed on (provider slug, credential identity) so a later per-tenant policy is a keying change, not a redesign.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `admin` API-key scope (Q6)                        | **Platform-only.** Mintable only by a platform ADMIN; org-bound keys can never carry it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AiCostLog` ownership (Q10)                       | **Yes** — durable `userId` (groundwork), `orgId` (row isolation).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Impersonation (Q7)                                | **Platform-tier.** It is a compliance surface (consent, time-box, distinct audit actor); forks would each get it subtly wrong.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Storage ladder (Q9)                               | **Publish rungs 0–5; exclude rung 6** (arbitrary bespoke backends). Rung 5 — a dedicated deployment — already ships.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Auto-fallback (Q15)                               | **Fixed via an eligibility seam**: fallback only within `resolveEligibleProviders(ctx)`; default = today's behaviour at `single`, deny-by-default at `multi`. **Shipped 2026-09-03** as `registerProviderEligibility` (`lib/app/llm-providers.ts`), covering the auto-picked primary AND both fallback lists at the agent-binding resolver, plus the second chokepoint — a workflow step with no `modelOverride`, knowledge keyword enrichment, an unpinned retroactive-review judge, audio transcription's matrix fallback, and (added 2026-09-07) the knowledge embedder's fallback chain including its bare-`OPENAI_API_KEY` arm, all of which resolve a provider without reaching the resolver and so consult the seam directly via `isProviderEligible`. Every path is listed as covered or not in the coverage table in `.context/orchestration/llm-providers.md`; still uncovered by design are an explicit step or review `modelOverride`, an operator's pinned audio default and the `EVALUATION_*` env vars. **That table is hand-derived and was short on all three occasions it was checked**, so it is the current state rather than a boundary — the same file documents the Proxy every manager-built provider passes through and the two routes that bypass the provider manager, which is why a complete boundary needs enforcement where calls pass through rather than at each site that chooses (see the journal decision and its correction on this feature). **The limit, decided 2026-09-07: that guarantee binds Sunrise core, not a fork’s own code** — a fork can construct a provider directly, and a guard it owns the source to is not a boundary. What ships instead is enumerability: `METHOD_DISPOSITION` fails the build when the egress surface widens. An EXPLICIT `agent.provider` is deliberately not overridden at runtime; enforcing that belongs at write time (do not offer a provider the org has not approved), which is per-org work. Both layers are required: write-time validation cannot reach agents stranded by a policy that changed after they were configured, nor writes that bypass the form. |

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
   (The contract Daybreak validated fork-first on #367.) **Shipped 2026-09-09**
   as `lib/auth/authorization.ts` with the fork seam at `lib/app/authorization.ts`
   — the `tier` and `ownership` inputs are carried and `org` is reserved for this
   programme. The contract, the owner-scoped list recipe and the parts of the
   read axis **not** yet behind the seam are in
   [`.context/auth/authorization.md`](../auth/authorization.md); read the
   "what is not behind the seam yet" section before designing against it.
8. **Platform owns the mechanism; forks own the product.** Org roles stop at
   `OWNER / ADMIN / MEMBER`. Plans, billing, pricing, org branding, self-serve
   signup UX, and any team/workspace layer beneath the org are fork-owned.

And two standing rules inherited from the repo: every seam lands in
`VERSIONING.md`'s public surface with a CHANGELOG bullet in the same PR, and
core-schema diffs stay mechanical (one field + one index per model) so a fork's
sync conflict is a "keep both", not a re-read.

## Target architecture

> **Partly target state.** Of the tenancy pieces named in this section,
> `lib/auth/authorization.ts`, `lib/auth/roles.ts` and `lib/app/authorization.ts`
> shipped with §105 (0.12.0); `prisma/schema/tenancy.prisma` with its
> identity migration and `lib/tenancy/{roles,constants,membership}.ts` shipped
> with §106 t-669 ([`.context/tenancy/identity.md`](../tenancy/identity.md));
> `Session.activeOrgId`, the switch and org-aware invitations with t-670;
> `lib/tenancy/context.ts`, `lib/tenancy/entry.ts`, `lib/app/tenant-resolver.ts`
> (+ `lib/tenancy/resolver.ts`), the `x-sunrise-org` header, the guards
> entering the org and the default policy's org arm with t-671
> ([`.context/tenancy/context.md`](../tenancy/context.md)); the org
> lifecycle API, `lib/tenancy/lifecycle.ts`, and the org-level privacy entry
> points (`exportOrgData`, `eraseOrg`, the `orgId` manifest) with t-672
> ([`.context/api/org-endpoints.md`](../api/org-endpoints.md)); every
> credential bound to an org at mint and entering it at resolution
> (`resolveCredentialOrg`, `orgForMint`, `lib/orchestration/invite-tokens.ts`)
> with t-673 ([`.context/tenancy/identity.md#credentials`](../tenancy/identity.md#credentials));
> `orgId` on every tenant-owned model (42, child rows included), backfilled
> to the install org, with the classification allowlists and the runtime
> roster in `lib/tenancy/classification.ts` and the org-export dispositions
> for each, with §107 t-705; the `lib/db/client.ts` `$extends`
> (`lib/db/tenancy-extension.ts`, [`tenancy/context.md`](../tenancy/context.md#the-data-layer--libdbtenancy-extensionts))
> — `orgId` stamped on every tenant-owned create in both modes, every
> operation scoped by `set_config` at `multi`, the `$transaction` override,
> the bypass GUC under `runAsSystem`, the throw before SQL with no context,
> and the seam awaiting inside the scope — with t-706; the dormant
> `org_isolation` policies (one per tenant-owned table, in a raw-SQL
> migration), `db:tenancy:enable|disable`, the required role split with
> `MIGRATE_DATABASE_URL` and `db:tenancy:role`, and the derived T-series
> drift probes ([`tenancy/isolation.md`](../tenancy/isolation.md)) with
> t-707. Of this section's request path, everything down to and including
> Postgres exists; the tick's `forEachOrg` wiring (§108) does not yet —
> `forEachOrg` itself ships, uncalled. At `TENANCY_MODE=single` the same components run with the
> install org as the only answer, as the diagram says. One measurement from
> t-706 that binds §115 and any fork layer: the exported client is typed
> `Omit<PrismaClient, '$on'>` and asserted from the `$extends` result,
> because typing it as the extension's own result type made `tsc` exhaust a
> 4 GB heap across this tree (baseline 7 s) — every call site re-instantiates
> the dynamic extension types. A further layer keeps the same exported type.

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
  inbound-trigger · approval-token · system · job. Entered by the guards (in-repo precedent:
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
  set (after backfilling any `NULL` `orgId` to the install org); `disable`
  clears both flags. At `multi` the app connects as a restricted role (no `BYPASSRLS`, not
  the table owner); migrations and seeds use a privileged DSN. Every
  tenant-owned row carries its own `orgId`, child rows included — no
  join-based policies, so the policy, the probe and the injection derive from
  one column (§107 planning decision, 2026-09-18: a join policy is
  hand-written per table and cannot be derived). `orgId` is nullable first and backfilled to the
  install org; `NOT NULL` is a later staged migration (the
  `AiKnowledgeDocument.slug` precedent).
- **Control plane** — `lib/auth/authorization.ts` default policy; override
  registry at `lib/app/authorization.ts`; optional `resource` resolvers on
  `withAuth`/`withAdminAuth`; role known-values in `lib/auth/roles.ts`.

### Namespace rules

Human-meaningful slugs (`AiAgent`, `AiKnowledgeBase`, `AiKnowledgeDocument`)
are `@@unique([orgId, slug])` — shipped with §107 t-708, together with the two
partial uniques on the same tables that Prisma cannot model (the ready-document
dedupe on `(orgId, fileHash)`, one default knowledge base per org), which would
otherwise have failed an org's upload with a violation from a table it cannot
see into. Global-config slugs stay global. **Routing keys stay globally
unique** — trigger channels, `dedupKey`, `idempotencyKey`, inbound/webhook
slugs, and so `AiWorkflow.slug` (journal decision) — because the routes they
address carry no tenant: those routes resolve the row under system context and
then `runAsOrg(row.orgId)` (the inbound route and the HMAC approval routes do,
with t-708; [`tenancy/context.md`](../tenancy/context.md)).

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

Open questions a day of throwaway code answers better than a paragraph. Items
5 and 6 were resolved by §106 (t-670 and t-671; see
[`tenancy/identity.md`](../tenancy/identity.md) and
[`tenancy/context.md`](../tenancy/context.md)). Items 1–4 and the three added
by §105/§106 were answered on 2026-09-19 by
`scripts/spikes/rls-chokepoint-spike.ts` (§107 t-704), run against a local
`pgvector/pgvector:pg15` container direct and through PgBouncer 1.25 in
transaction mode, and against a Neon preview branch (PostgreSQL 17.11, direct
and `-pooler`). All 42 checks pass on both. The script header carries the run
commands; the numbers below are from those runs.

> **The one fact that reshapes 3.3 first:** on Neon the deploy role
> (`neondb_owner`, via `neon_superuser`) is **not** superuser but **has
> `BYPASSRLS`**. An app connecting as it is never subject to a policy, FORCE
> or not. At `multi` the app **must** connect as a separate `NOBYPASSRLS`
> login role; the migrate DSN keeps `neondb_owner`. The role split is a
> requirement of the deploy target, not an option.

1. **Client extension × interactive transactions — answered.** A top-level
   `query.$allOperations` hook fires for ops made through the `tx` client
   inside `$transaction(async tx => …)`, but the documented per-op
   `$transaction([set_config, op])` wrap issued from inside one **runs on a
   different connection and escapes the transaction** — a write made that
   way survived a rollback. It is not a nesting error; it is silent. So the
   shape is: an extension `client` component **may replace `$transaction`**
   (Prisma accepts it; no Proxy over the client needed). **How it delegates
   matters:** the replacement must call the runtime's own `$transaction`
   (read off the base client) with `this` set to the _outermost_ client
   (`Prisma.getExtensionContext(this)`). Closing over an inner layer's
   `$transaction` instead clones the transaction client from that layer, and
   a hook added by any later `$extends` — §115's guard — silently never
   fires inside a transaction; the review caught it, and 6b now asserts the
   outer hook fires on the `tx` client. The replacement
   issues one `set_config` at the top of an interactive transaction and runs
   the callback under an ALS `inTx` flag that makes the per-op hook pass
   through; the setter itself must be issued **inside** that flag or it is
   wrapped onto another connection too. For the batch form it prepends the
   setter and slices the results. Measured: three ops in one interactive
   transaction → exactly one `set_config`; 20 interleaved per-op wraps across
   four pooled connections each saw only their org, and an unscoped query
   afterwards saw 0 rows. The override survives a further `$extends` layer
   (item 8). **The inverse hazard is real too:** an op issued on the _root_
   client from inside a transaction callback is not bound to that
   transaction, and an ALS-keyed pass-through lets it run unwrapped on
   another connection — it read 0 rows at `multi` beside a `tx` op that read 2. Prisma hands the hook an undocumented `__internalParams.transaction`
   that is set for the `tx`-bound op and absent for the root-client op in the
   same callback, so 3.2 should key the pass-through on _that_ (or on both),
   not on the ALS flag alone; it is undocumented, so a test pins it.
2. **Nested-create `orgId` — answered.** `WITH CHECK` fires: a nested create
   with no `orgId` at `multi` is refused (`P2039`, the Postgres message in
   `meta.driverAdapterError`) and the parent rolls back with it. Two remedies
   both work: (a) a recursive walk over `create` / `createMany` /
   `connectOrCreate` using the client's runtime data model (relation fields
   carry the target model), which landed `orgId` on nested children of two
   models in one create; (b) a column `DEFAULT
NULLIF(current_setting('app.current_org', true), '')`, which fills a nested
   child with no injection because Prisma omits the unset column. **3.2 ships
   (a)** — at `single` the GUC is never set, so (b) would leave `NULL` there
   and the one-code-path principle would be lost. Three rules the walk
   taught: it runs on **every write** whatever the root model — an `AiAgent`
   create reaches tenant-owned `embedTokens` while `AiAgent` itself is not
   yet tenant-owned, and a nested create under an `update` root (measured)
   or inside a nested `update` / `upsert` is a create all the same, so the
   walk descends `create` / `createMany` / `createManyAndReturn` / `update` /
   `updateMany` / both `upsert` branches at the root and `create` /
   `createMany` / `connectOrCreate` / `update` / `upsert` under relations —
   but **stamps `orgId` only on create-shaped nodes**. An update payload is
   descended for the nested creates it may carry and never stamped: stamping
   it would `SET "orgId" = <current org>` and, wherever RLS is not enforcing
   (every `single` install), silently move another org's row into the
   caller's (measured: an `update` and an `updateMany` under the install
   org's context leave org B's rows in org B). At `multi` **every write** is wrapped when a context exists, not only
   writes on tenant-owned roots — the nested inserts run inside the root's
   statement and need the GUC. Reads on non-tenant models
   stay unwrapped; a no-context write on a non-tenant root (the switch route's
   `session.update`) passes through with `WITH CHECK` as the backstop.
3. **Per-op cost and pooling — measured.** The wrap is a four-statement
   transaction (`BEGIN`, `set_config`, op, `COMMIT`) where there was one
   statement, and the cost is round trips, not work: local direct 0.5 → 2.0 ms
   median per op (×4), local PgBouncer 0.4 → 1.6 ms (×4), Neon from a
   developer machine 19 → 63 ms direct and 16 → 65 ms pooled (×3.3–4). Five
   ops in one interactive transaction cost **0.33–0.46×** of five wraps on
   every target, so the amortisation lever is transaction scope, not the
   hook. In-region (Vercel → Neon) the absolute cost is the ×4 of a ~1 ms
   round trip. Through the pooler: `set_config(…, true)` outside an explicit
   transaction is gone by the next statement (a one-statement transaction);
   a **session-level `SET` poisons the pooler's server connection for other
   clients** (client 2 read client 1's org and an unscoped query saw both
   orgs' rows) — the wrapped op still saw only its org because `SET LOCAL`
   inside the transaction overrides the session value, but nothing unwrapped
   is safe on a poisoned pool. Six interactive transactions each holding
   400 ms against a client pool of 4 completed in 850 ms locally, 1.1 s on
   Neon, no errors. Also observed: a pooler keeps server connections
   authenticated by role OID, so dropping and recreating a role behind it
   hands out sessions with the old role's (now absent) grants.
4. **Dormant policies — answered.** `CREATE POLICY` on a table without
   `ENABLE ROW LEVEL SECURITY` is inert for a `NOBYPASSRLS` role: every row
   visible, a `NULL`-org insert accepted. After `ENABLE` + `FORCE` the same
   role sees 0 rows and `WITH CHECK` refuses. `ENABLE` twice is a no-op;
   `DISABLE ROW LEVEL SECURITY` **plus** `NO FORCE ROW LEVEL SECURITY` (two
   independent flags; `DISABLE` alone leaves `relforcerowsecurity` set)
   leave the policies in place and clear the two `pg_class` flags
   (`relrowsecurity`, `relforcerowsecurity`) — those flags are the
   idempotence check `db:tenancy:enable|disable` should read, and the
   disable script must issue both statements.
   `prisma migrate diff` from the database to the schema **does not mention
   policies at all** (it emits only the known unmodelled-index drops), so
   policies neither appear in nor are dropped by `migrate dev`; the drift
   probes are the only thing that notices a missing one.
5. **Session `additionalFields`** — resolved in §106 t-670.
6. **Proxy runtime** — resolved in §106 t-671.
7. **FORCE RLS and the migrate role — answered.** A `NOBYPASSRLS` table
   _owner_ sees every row without FORCE and **sees and updates nothing under
   FORCE** — a data migration run by such a role backfills zero rows and
   reports success. A `BYPASSRLS` role (superuser locally, `neondb_owner` on
   Neon) is unaffected. The remedy for any role is the policy's bypass arm:
   `current_setting('app.bypass_rls', true) = 'on' OR …` in both `USING` and
   `WITH CHECK`, set with `set_config('app.bypass_rls','on', true)` inside the
   transaction — the owner saw everything again with it, and it is what
   `runAsSystem` maps to. So: policies carry the bypass arm; migrations that
   touch tenant-owned rows open with the bypass setter (Prisma runs each
   migration in one transaction); the app role is `NOBYPASSRLS` and is
   granted `USAGE` on the schema, `SELECT/INSERT/UPDATE/DELETE` on all tables
   and `USAGE/SELECT` on all sequences, plus `ALTER DEFAULT PRIVILEGES` for
   tables future migrations create. On Neon `neondb_owner` cannot `DROP OWNED
BY`; a role is removed by revoking those grants explicitly first.
8. **Types, layering and the tenant-owned set — answered.** The extended
   client's `$transaction` hands its callback a `tx` that satisfies a callee
   typed `(tx: Prisma.TransactionClient)`, so the four such callers need no
   change (the spike file itself is under `npm run type-check`). A second
   `$extends` layer inspecting `args.where` on `findMany` composes with the
   tenancy layer — both hooks fire, scoping intact, outside a transaction
   _and_ on the `tx` client inside one, the latter only because the
   `$transaction` override delegates with the outermost client as `this`
   (item 1). That is §115's starting point; its per-read cost was not
   measured separately (one object walk per read).
   Prisma types the **top-level** `$allOperations` hook's `args` and `query`
   as `any` (the per-model hooks are typed): 3.2 owes a typed boundary at
   that one point rather than a lint exemption. The generated client's
   `_runtimeDataModel` (a private property, stable across Prisma 7) carries
   every model's field names, kinds, relation targets and **`dbName`**, so
   the tenant-owned set — "has an `orgId` scalar" minus the system allowlist
   — and the table names the policies, probes and enable script need are all
   derivable at runtime with no registration; a schema-parsing test pins the
   derivation to `prisma/schema/*.prisma`. Today it derives the four
   credential models plus `OrgMembership`, which the allowlist removes.

9. **Bypass GUC versus bypass role — decided for the GUC, t-706 (journal
   decision at merge).** `runAsSystem` runs on the same client and pool and
   sets `app.bypass_rls` for its transaction. The role alternative would
   hand `runAsSystem`'s callback a different client — a signature change
   every consumer and fork feels — and the GUC arm must exist in the
   policies regardless, for the migrate role under FORCE (item 7). The
   exposure below is bounded by the raw-SQL allowlist. As spiked: the spike validates
   the bypass as a GUC arm in the policy, and proves (item 7) that the
   `NOBYPASSRLS` app role can set it. That is the property `runAsSystem`
   needs, and it is also the property an attacker wants: a SQL injection
   into the app's connection — a `$queryRawUnsafe` that ever receives user
   input — becomes a one-statement total bypass
   (`SELECT set_config('app.bypass_rls','on',true)` in the same transaction),
   not a cross-row read inside one tenant. The alternative is role-based:
   `runAsSystem` runs on a second pool connected as a `BYPASSRLS` role the
   app role cannot assume, and the GUC arm exists only for the migrate-role
   remedy. Cost: a second DSN and pool at `multi`; benefit: no reachable
   bypass from the request path at all. 3.2 decides, with the raw-SQL
   allowlist (`tests/unit/db-raw-sql-allowlist.test.ts`) as the input: on
   2026-09-19 `lib/` and `app/` hold ten `$queryRawUnsafe` /
   `$executeRawUnsafe` sites (vector search, cost reports, conversation
   search, the knowledge seeder and embedder), every one passing values as
   `$n` parameters and using the unsafe form only for SQL structure — the
   injection would have to arrive through a future site, which is what the
   allowlist exists to make deliberate. (Raised by the security
   review of the spike PR.)

One hazard is about the seam rather than the client, and the spike closes it
there. A `PrismaPromise` is lazy: the extension hook — and with it the read of
the tenant context — runs when the promise is awaited, not when it is created.
`lib/tenancy/context.ts` did `tenantContext.run(ctx, fn)`, so
`runAsOrg(org, () => prisma.x.findMany())` with a **non-async** callback
returned the promise out of the scope unawaited and lost the context (it threw
at `multi` in the spike). Changing the seam to
`tenantContext.run(ctx, async () => await fn())` makes the await happen inside
the scope; measured, the same non-async callback then keeps its context. t-706
made that change in `runAsOrg` / `runAsSystem` (and so `forEachOrg`) and pins
it with a lazy-thenable test, rather than documenting a rule every caller has
to remember.

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
