/**
 * App org-data export sources (§109 t-737).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body).
 *
 * Auto-wired: `lib/privacy/org-source-registry.ts` calls this once, lazily,
 * before its first read, through the shared fork init gate. Both
 * `exportOrgData()` (`lib/privacy/export-org.ts`) and the org-manifest
 * coverage test read that registry, so a source registered here lands in the
 * org export and counts as declared with no core edit.
 *
 * Declare every model in your tier that carries an `orgId` column — as a
 * source the org receives, or as an exclusion with the reason the org is shown
 * instead. `tests/unit/lib/privacy/org-sources.test.ts` scans every schema
 * file, yours included, and fails naming any `orgId` model nobody declared:
 *
 *   import { prisma } from '@/lib/db/client';
 *   import { ownedBy } from '@/lib/privacy/org-sources';
 *   import { registerAppOrgSources } from '@/lib/privacy/org-source-registry';
 *
 *   export function initAppOrgSources(): void {
 *     registerAppOrgSources({
 *       tier: 'app',
 *       sources: [
 *         {
 *           model: 'AppContract',
 *           section: 'contracts',
 *           disposition: 'export',
 *           description: 'Contracts the organisation holds with its clients.',
 *           // Prisma `omit` for a secret column, never `select`: a column
 *           // added tomorrow is then exported by default.
 *           fetch: ({ orgId }) =>
 *             prisma.appContract.findMany({ where: ownedBy(orgId), orderBy: { createdAt: 'asc' } }),
 *         },
 *       ],
 *       excluded: [
 *         { model: 'AppContractIndex', reason: 'Search index rebuilt from contracts the export already carries.' },
 *       ],
 *     });
 *   }
 *
 * Read before writing one:
 *
 *  - **Your rows land under the bundle's `app` key**, by `section`, with a
 *    summary in `meta.app`. They never share a namespace with core's sections,
 *    so a section core adds in a later release cannot overwrite yours.
 *  - **`fetch` runs as the org being exported** (`runAsOrg`), one source at a
 *    time, after core's. Row isolation applies if your table has the
 *    `org_isolation` policy — but filter by the org yourself as well: the
 *    policy is enforced only at `TENANCY_MODE=multi`. Use `ownedBy(orgId)` from
 *    `@/lib/privacy/org-sources`, as core does: at `single` it also returns the
 *    install org's rows whose `orgId` is `NULL` (written under `runAsSystem`,
 *    which stamps nothing), which `where: { orgId }` would leave out.
 *  - **`fetch` must resolve to an array.** Return `[]` when the org has no
 *    rows. Anything else fails the whole export, because a bundle short by a
 *    section reads exactly like a complete answer.
 *  - **A throw anywhere fails the export.** In `fetch`, because a partial
 *    export is worse than none. In this function, because your declarations
 *    are then unknown: the registry rolls back what you registered, logs, and
 *    `exportOrgData()` refuses every org until it is fixed. A row the registry
 *    rejects (a short description, a clashing section) is dropped and logged,
 *    and unless another declaration still covers that model the export refuses
 *    the same way — a dropped source is a missing table.
 *  - **`disposition` is your label, not something core enforces.** Core's
 *    `attribution` sources return id + label + date only, because core owns
 *    their `fetch`. Here you own it, so `attribution` means what your `fetch`
 *    returns.
 *  - **Your org table must cascade from `Org`** — `onDelete: Cascade` on the
 *    relation, or `SetNull` for a record that must outlive the org (the
 *    `AiCostLog` billing precedent). Org erasure deletes the `Org` row and lets
 *    the database cascade; it does not walk this registry. Without the relation
 *    your rows outlive the org's erasure; with the default `Restrict`, erasure
 *    fails. The coverage test checks every `orgId` model for one of the two.
 *  - **Register synchronously.** This function must not be `async`.
 *
 * A framework tier registers with `tier: 'framework'`, from a function this
 * one calls — not from `initFramework()` at boot, which a registry reset loses.
 *
 * Empty = today's export, byte-for-byte: no `app` key and no `meta.app`.
 *
 * Full guide: .context/privacy/org-export.md (Fork tables)
 */
export function initAppOrgSources(): void {
  // No app org sources by default.
}
