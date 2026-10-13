# Org Data Export

How Sunrise answers "give us our data" for an organisation — a customer being
offboarded, or one asking what the install holds about them (§106 t-672). The
entry point is `exportOrgData()` in `lib/privacy/export-org.ts`; the admin
endpoint calls it. The per-person counterpart is
[Subject Access Export](./data-export.md), and this page assumes you have read
its "why a manifest and a build-breaking test" section — the org export is the
same discipline with an org as the subject.

## Quick Reference

| Need                            | Use                                                                  |
| ------------------------------- | -------------------------------------------------------------------- |
| Export an org (the only way)    | `exportOrgData()` — `lib/privacy/export-org.ts`                      |
| The vendor exports for a client | `GET /api/v1/admin/orgs/[id]/export` (platform admin, download)      |
| What counts as the org's data   | `ORG_DATA_SOURCES` — `lib/privacy/org-sources.ts`                    |
| What is deliberately left out   | `ORG_EXCLUDED_SOURCES` — same file, with the reason shown            |
| A fork's own org tables         | `initAppOrgSources()` — `lib/app/org-export.ts` (see Fork tables)    |
| The guard on the manifest       | `tests/unit/lib/privacy/org-sources.test.ts` (scans `orgId`)         |
| Proving it against a database   | `npm run smoke:tenancy` (creates, exports, erases a fixture org)     |
| …at `multi`, across two orgs    | `scripts/smoke/tenancy-isolation.ts` section [19] (CI `smoke-multi`) |

## Which org it reads as

The org being exported, whoever asks. `exportOrgData()` reads every source
inside `runAsOrg(orgId)`. That matters at `TENANCY_MODE=multi`: the admin
route's guard enters the admin's own active org, and the `org_isolation`
policy would AND each source's `orgId` match with that org, so any other
org's bundle came back with every tenant section empty and no error. An admin
API key enters no org, and the same reads threw (§106 t-735). The service
scopes itself rather than the route, so any caller gets the right answer.

## The manifest and its guard

`ORG_DATA_SOURCES` is the single place that says which tables are an org's
data. **Every Prisma model carrying an `orgId` column must appear there
exactly once** — as a source with a disposition, or in `ORG_EXCLUDED_SOURCES`
with a reason — and `org-sources.test.ts` parses `prisma/schema/*.prisma` for
`orgId` columns and fails until it does. Today that is 43 models:
`OrgMembership`, the four credential kinds, and — since row isolation's first
schema task (§107 t-705) — every tenant-owned model, child rows included. That
task is the rule working as designed: the test named all 38 new columns until
each had a disposition, and a fork adding `orgId` to its own model meets the
same test. That is the point: a column can join an org, but an export cannot
silently omit it.

A fork's models are not added to that list — it is core's, and a fork editing
it conflicts on every upgrade. They are registered from `lib/app/org-export.ts`
(below), and the test unions the registry into its accounted set, so a fork's
`orgId` model passes once registered and still fails by name when it is not.

The scan matches the column name `orgId` exactly. `Session.activeOrgId` is a
pointer to the org a session acts in, not the org's data, and does not match.

The test is also run against a synthetic schema with an undeclared `orgId`
model, so the rule is shown to fire — in vanilla Sunrise every such model is
declared, and a rule with nothing to catch would pass while protecting nothing.

The same test holds every `orgId` model to an `Org` relation with
`onDelete: Cascade` or `SetNull`. [Org erasure](./org-erasure.md) deletes the
`Org` row and lets the database cascade; it does not walk this manifest. A
model with no relation outlives the org's erasure with an id nothing resolves,
and one with the default `Restrict` makes erasure fail. The rule cannot judge
retention: `SetNull` keeps the rows, which is right for a record that must
outlive the org (the `AiCostLog` billing precedent) and wrong for the org's own
data. That choice belongs to the model's author.

## Fork tables

A fork registers its own org-owned models from `initAppOrgSources()` in
`lib/app/org-export.ts`, a scaffold Sunrise ships empty and does not change
after release:

```typescript
import { prisma } from '@/lib/db/client';
import { ownedBy } from '@/lib/privacy/org-sources';
import { registerAppOrgSources } from '@/lib/privacy/org-source-registry';

export function initAppOrgSources(): void {
  registerAppOrgSources({
    tier: 'app',
    sources: [
      {
        model: 'AppContract',
        section: 'contracts',
        disposition: 'export',
        description: 'Contracts the organisation holds with its clients.',
        fetch: ({ orgId }) =>
          prisma.appContract.findMany({ where: ownedBy(orgId), orderBy: { createdAt: 'asc' } }),
      },
    ],
    excluded: [
      {
        model: 'AppContractIndex',
        reason: 'Search index rebuilt from contracts the export already carries.',
      },
    ],
  });
}
```

- **Each source carries its own `fetch`**, the shape of a core manifest row.
  The subject seam splits declarations from a static collector and then has to
  check at runtime that every declared section came back; here, registering a
  source is what puts it in the bundle, so that state cannot arise.
- **Fork rows land under the bundle's `app` key** with a summary per source in
  `meta.app`, never beside core's sections, so a section core adds later cannot
  overwrite one of yours. Fork exclusions are appended to `meta.excluded`.
- **`fetch` runs as the org**, after core's sources and one at a time. Filter by
  the org yourself — the `org_isolation` policy applies only at `multi` — with
  `ownedBy(orgId)`, as core does. At `single` it also returns the install org's
  rows whose `orgId` is `NULL` (written under `runAsSystem`, which stamps
  nothing), which `where: { orgId }` would leave out.
- **It must resolve to an array** — `[]` for none — or the export fails with
  `AppOrgSourceInvalidError`.
- **If `initAppOrgSources()` throws, or registers a row the registry
  rejects and no other declaration covers that model**, the registry logs, and `exportOrgData()` throws
  `AppOrgDeclarationsUnavailableError` for every org until it is fixed. A
  bundle without the fork's tables would read as complete, and the coverage
  test catches a dropped row only when its model carries `orgId`.
- **`disposition` is the fork's label.** Core cannot see what a fork's `fetch`
  returns, so `attribution` there is a statement of intent, not a guarantee.
- **A framework tier** registers with `tier: 'framework'`, from a function the
  leaf's `initAppOrgSources()` calls — not from boot, which a registry reset
  loses.

With nothing registered the bundle is unchanged: no `app` key, no `meta.app`.

## The two dispositions

The subject manifest's two, read for an org:

- **`export`** — the org's own records, in full minus named secrets.
  `OrgMembership` is this: who belongs and as what, with each member's id,
  name and email riding along so the roster reads as people. The members'
  _other_ data is theirs, not the org's, and is not included — a member who
  wants their own record asks for a subject export. Every tenant-owned model
  is this too (36 sections: agents, conversations and messages, knowledge
  bases, documents and chunks, workflows, executions and step results,
  datasets, evaluations, experiments, hooks, webhooks, cost rows, user
  memories). Four withhold credential material: `AiWebhookSubscription`
  omits `secret`, `AiWorkflowTrigger` omits `signingSecret`,
  `AiWorkflowExecution` omits the engine's `leaseToken`, and `AiEventHook`
  rows pass through `toSafeHook` — the admin API's own redaction — so the
  signing secret is dropped and the custom request headers keep their names
  but not their values (that is where a receiver's `Authorization` lives).
  Vector columns are `Unsupported` in Prisma and are never selected, so a
  chunk's text is exported and its embedding is not.
  A `NULL` `orgId` is read the way the tenant context reads a missing org: at
  `TENANCY_MODE=single` it is the install org's, so the install org's export
  matches `orgId IS NULL` as well — the data-layer chokepoint
  (`lib/db/tenancy-extension.ts`, §107 t-706) stamps the column on every
  create, but a row born before it, or written under `runAsSystem`, still
  carries `NULL`, and a fresh install's seeded agents would otherwise be
  missing from its own export (the `smoke:tenancy` run asserts a `NULL`-org
  agent is carried beside a stamped one). At `multi` the match is strict —
  the enable script that ships with the policies (§107 t-707) will backfill
  `NULL` to the install org before enforcing, so a `NULL` seen at `multi` is
  an orphan. The four credential attributions never read `NULL` — a
  `NULL`-org API key is a platform credential, not the org's.

  One tenant-owned relation is `SetNull` rather than `Cascade`: `AiCostLog`.
  A cost row is a billing record, so erasing an org detaches its spend rather
  than deleting it — the same rule `data-erasure.md` applies to a person —
  and `smoke:tenancy` asserts the row survives `eraseOrg()` with `orgId` null
  and the amount unchanged. A consequence of the `NULL` rule above: at
  `single`, an erased org's detached cost rows read as the install org's and
  appear in its export. Both are the platform operator's own books on a
  single-tenant install; the staged `NOT NULL` migration, which gives `NULL`
  one meaning, ends it.

- **excluded, with a reason** — `AiMessageEmbedding` (vectors only; the
  message it derives from is exported) and `AiWorkflowExecutionLeaseEvent`
  (engine lease bookkeeping; the execution is exported). The reason travels
  in the bundle's `meta` so the recipient can see what was left out and why.
- **`attribution`** — the fact that the org holds a thing, not the thing:
  id + label + date. The four credential kinds (`AiApiKey`,
  `AiAgentEmbedToken`, `AiAgentInviteToken`, `McpApiKey`) are this. A key's
  hash is credential material the export must not carry, and its scopes are
  platform configuration.

`export` sources use Prisma `omit` for secrets, never `select` — a column
added tomorrow is exported by default, and only a deliberate `omit` keeps it
out.

## Size

The bundle is assembled in memory and returned as one JSON body. With every
tenant-owned table in it — messages, chunk text, document content twice
(original and processed), step results, delivery payloads — a modest install
produces megabytes, and a hosted function's response limit (Vercel: 4.5 MB)
is the ceiling. The sources run one at a time (since #901), so the export
holds one pooled connection rather than queueing 42 reads behind a pool of ten,
and its duration is the sum of the reads. The size ceiling is acceptable for
the installs this ships to today and is recorded on the §107 feature as
follow-up work (streaming to a stored file), not something this endpoint will
grow into silently.

## The one source listed by hand

A pending invitation _into_ the org lives in `Verification`, keyed by the
invitee's email, with the org in the metadata JSON the invite route writes.
There is no `orgId` column, so the scan cannot see it; it is in the manifest by
hand (the `ContactSubmission` precedent in the subject manifest), selected by
`metadata->>'orgId'`, with the token (`value`) omitted, and pinned by a test
row. Any future table that names an org without a column needs the same
treatment; nothing mechanical will find it.

## Failing whole, not partial

Every source runs; any that throws fails the export. Same reasoning as the
subject export: a bundle that quietly lost a section is indistinguishable, to
the person reading it, from one that had nothing to show — and the org being
offboarded is exactly the reader who cannot check.

## The bundle

```json
{
  "meta": {
    "formatVersion": 1,
    "generatedAt": "2026-09-18T10:00:00.000Z",
    "orgId": "cmorg…",
    "exported": [{ "model": "OrgMembership", "section": "members", "description": "…", "rows": 2 }],
    "attribution": [{ "model": "AiApiKey", "section": "apiKeys", "description": "…", "rows": 0 }],
    "excluded": [],
    "app": [
      {
        "model": "AppContract",
        "section": "contracts",
        "description": "…",
        "disposition": "export",
        "rows": 0
      }
    ]
  },
  "org": { "id": "cmorg…", "slug": "acme", "name": "Acme", "status": "ACTIVE", "…": "…" },
  "data": { "members": [], "pendingInvitations": [] },
  "attributions": {
    "apiKeys": [],
    "agentEmbedTokens": [],
    "agentInviteTokens": [],
    "mcpApiKeys": []
  },
  "app": { "contracts": [] }
}
```

`app` and `meta.app` appear only when a fork registered a source.

`meta` describes exactly what was delivered — every section with its row
count, and every withheld table with its reason — so the reader can see the
boundary of what they received. `ORG_EXPORT_FORMAT_VERSION` is separate from
the subject bundle's version because the two bundles have different readers.

No receipt is written and no `reason` is required: the org is not a data
subject. The acting admin is logged.

## Stored files are not in the bundle

The bundle carries rows, not the bytes of files the org's agents uploaded. An
upload's key and URL appear wherever a row recorded them (a conversation's tool
result, for instance), but the file itself does not. `StorageProvider` has no
list operation, so there is no way to enumerate an org's files to put them in;
at `multi` they all sit under `orgs/{orgId}/`
([Storage and Tenancy](../storage/tenancy.md)), so an operator with access to
the bucket can copy that prefix by hand. Org erasure does delete that prefix.

## What is deliberately not here yet

- **Self-service.** An org OWNER downloading their own export is §111's page,
  on top of the same service; today the vendor answers the request.

## Related Documentation

- [Org Erasure](./org-erasure.md) — the deletion this precedes
- [Subject Access Export](./data-export.md) — the per-person shape this mirrors
- [Tenancy: Org Identity](../tenancy/identity.md) — the lifecycle these endpoints belong to
- [Org Endpoints](../api/org-endpoints.md) — the HTTP reference
