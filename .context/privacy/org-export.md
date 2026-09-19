# Org Data Export

How Sunrise answers "give us our data" for an organisation — a customer being
offboarded, or one asking what the install holds about them (§106 t-672). The
entry point is `exportOrgData()` in `lib/privacy/export-org.ts`; the admin
endpoint calls it. The per-person counterpart is
[Subject Access Export](./data-export.md), and this page assumes you have read
its "why a manifest and a build-breaking test" section — the org export is the
same discipline with an org as the subject.

## Quick Reference

| Need                            | Use                                                              |
| ------------------------------- | ---------------------------------------------------------------- |
| Export an org (the only way)    | `exportOrgData()` — `lib/privacy/export-org.ts`                  |
| The vendor exports for a client | `GET /api/v1/admin/orgs/[id]/export` (platform admin, download)  |
| What counts as the org's data   | `ORG_DATA_SOURCES` — `lib/privacy/org-sources.ts`                |
| What is deliberately left out   | `ORG_EXCLUDED_SOURCES` — same file, with the reason shown        |
| The guard on the manifest       | `tests/unit/lib/privacy/org-sources.test.ts` (scans `orgId`)     |
| Proving it against a database   | `npm run smoke:tenancy` (creates, exports, erases a fixture org) |

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

The scan matches the column name `orgId` exactly. `Session.activeOrgId` is a
pointer to the org a session acts in, not the org's data, and does not match.

The test is also run against a synthetic schema with an undeclared `orgId`
model, so the rule is shown to fire — in vanilla Sunrise every such model is
declared, and a rule with nothing to catch would pass while protecting nothing.

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
  matches `orgId IS NULL` as well — nothing writes the column until the
  data-layer chokepoint lands, and a fresh install's seeded agents would
  otherwise be missing from its own export (the `smoke:tenancy` run asserts a
  `NULL`-org agent is carried). At `multi` the match is strict — `multi` is
  unreachable until the chokepoint task lifts the `lib/db/client.ts` guard,
  and the enable script that ships with the policies (§107 3.3) will backfill
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
is the ceiling. The sources also run concurrently through one `Promise.all`,
so on a pool of ten connections with a ten-second connect timeout, a scan slow
enough to hold the pool fails the queued sources and with them the whole
export. Both are acceptable for the installs this ships to today and are
recorded on the §107 feature as follow-up work (bounded concurrency; streaming
to a stored file), not something this endpoint will grow into silently.

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
    "excluded": []
  },
  "org": { "id": "cmorg…", "slug": "acme", "name": "Acme", "status": "ACTIVE", "…": "…" },
  "data": { "members": [], "pendingInvitations": [] },
  "attributions": {
    "apiKeys": [],
    "agentEmbedTokens": [],
    "agentInviteTokens": [],
    "mcpApiKeys": []
  }
}
```

`meta` describes exactly what was delivered — every section with its row
count, and every withheld table with its reason — so the reader can see the
boundary of what they received. `ORG_EXPORT_FORMAT_VERSION` is separate from
the subject bundle's version because the two bundles have different readers.

No receipt is written and no `reason` is required: the org is not a data
subject. The acting admin is logged.

## What is deliberately not here yet

- **A fork seam.** A fork's own org-owned tables are §109's tenant-data
  dimension. The shape is the subject manifest's, which grew
  `registerAppSubjectSources()` the same way, so that lands without a redesign.
- **Self-service.** An org OWNER downloading their own export is §111's page,
  on top of the same service; today the vendor answers the request.

## Related Documentation

- [Org Erasure](./org-erasure.md) — the deletion this precedes
- [Subject Access Export](./data-export.md) — the per-person shape this mirrors
- [Tenancy: Org Identity](../tenancy/identity.md) — the lifecycle these endpoints belong to
- [Org Endpoints](../api/org-endpoints.md) — the HTTP reference
