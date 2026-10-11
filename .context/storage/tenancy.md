# Storage and Tenancy

How stored files are kept apart between organisations at
`TENANCY_MODE=multi` (§109 t-736), what each kind of URL does and does not
protect, and the storage ladder Sunrise publishes for tenants who ask for more.
The provider mechanics (S3, Vercel Blob, local, the signed read route) are in
[Storage System](./overview.md).

## Quick Reference

| Need                                | Use                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| A client limited to one org's files | `getStorageClient({ orgId })` — `lib/storage/client.ts`                         |
| An org's key prefix                 | `orgKeyPrefix(orgId)` → `orgs/{orgId}/` — `lib/storage/org-keys.ts`             |
| Which org a key belongs to          | `orgOfKey(key)` — same file; `null` for a key no org owns                       |
| Delete an org's files               | `eraseOrg()` does it after its transaction commits                              |
| Re-run that after a failed sweep    | `sweepErasedOrgStorage(orgId)` — `lib/privacy/erase-org.ts`                     |
| Upload from an agent                | the `upload_to_storage` capability (prefixed and private by default at `multi`) |

## Org-owned keys

At `multi`, a file an org owns lives under **`orgs/{orgId}/…`**. The key is
the only thing every backend keeps, so it is where the owner has to be
written: nothing else on S3, Vercel Blob or the local disk can say whose a
file is.

**The prefix is enforced, not a convention.** `getStorageClient({ orgId })`
returns the configured provider wrapped by `scopeStorageToOrg`
(`lib/storage/org-scoped.ts`). Upload, read, delete, prefix delete and signing
all refuse a key outside `orgs/{orgId}/`, with a rejected promise naming the
key and the prefix. **And the unbound client refuses the other way round:**
`getStorageClient()` with no `orgId` returns the provider wrapped by
`excludeOrgKeys`, which refuses every key under the reserved `orgs/` root, in
any letter case (on a case-insensitive disk `Orgs/` is the same directory).
So there is no client that will touch an org's file except the one bound to
that org; the signed read route and org erasure ask for it like everything
else. The org-bound wrapper is built per call and holds nothing but the
provider and the org id; the process-wide provider stays org-free.

`getStorageClient()` therefore returns a wrapper exposing the
`StorageProvider` interface, not the provider instance itself. Keys with `.`
or empty path segments are rejected by `validateStorageKey()` for every
provider, because the local provider resolves keys as paths and `./orgs/b/x`
would otherwise reach org `b`'s directory past a string check.

A key that starts `orgs/` but names no org cleanly (`orgs//x/…`, `Orgs/x/…`)
is malformed: no client accepts it and no token can be minted for it. Org ids
used as prefixes must be letters, digits, `_` or `-` (cuids and `install`), so
no id can make a prefix that resolves to the `orgs/` root itself.

**`upload_to_storage` is today's one tenant-owned writer.** At `multi` it takes
the org from the tenant context the dispatch already runs in
(`requireOrgId()`), the same scope every database read in the call is filtered
by, and writes `orgs/{orgId}/{keyPrefix}{uuid}.{ext}`. The org prefix **wraps**
a binding's own `keyPrefix` rather than replacing it, so an admin's layout
survives. A dispatch with no org in its context (a system scope) is refused
with `no_org_context`.

**What is not org-owned:**

- **Avatars** stay at `avatars/{userId}/…`, through the unbound client. A user
  is a system model and can belong to several orgs; their avatar is theirs.
- **Files uploaded before org prefixes existed** (`agent-uploads/{agentId}/…`)
  name no org. They stay readable where they were (public ones at their URL,
  private ones through tokens already issued), and nothing org-scoped reaches
  them: not the org-bound client, not the token claim, not erasure.
- **At `single`, nothing is prefixed.** A single-tenant fork's keys, and its
  `upload_to_storage` results, do not change — with one exception: `orgs/` is
  reserved at both modes, so a binding whose own `keyPrefix` starts with it is
  refused with `invalid_binding` at `single`, and the unbound client refuses
  such keys for any caller. At `multi` a binding prefix like that is simply
  nested inside the org's prefix. (A binding `keyPrefix` with `.`, `..` or
  empty segments is refused at both modes.)

A fork writing tenant-owned files of its own goes through
`getStorageClient({ orgId: requireOrgId() })`; the unbound client will refuse
the key otherwise.

## Private by default at `multi`

An `upload_to_storage` binding that sets **neither** `public` nor
`signedUrlTtlSeconds` uploads privately at `multi` and returns a signed URL
valid for **24 hours** (owner ruling 2026-10-08). `public: true` is the
explicit opt-out, for a link that has to outlive a TTL (an emailed report).
`single` keeps the public default, so forks see no change.

**Why the default changed:** a public URL carries no token, so no org check
can protect it (next section). Leaving public as the default would mean the
org boundary protected only the uploads somebody had remembered to protect.

**Why 24 hours:** the agent hands the link on in conversation, and people
open it some time after the turn that produced it. An hour would expire links
nobody has opened yet; longer makes a leaked link live longer. A binding that
needs something else sets `signedUrlTtlSeconds` (60 s to 7 days).

**On Vercel Blob**, which has no signed URLs, a default binding at `multi` is
refused with `signed_url_not_supported` until it opts into `public: true`. It
fails loudly rather than publishing the file.

## What each URL kind protects

| URL kind               | What it carries                             | Org protection                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local signed token** | One key, an expiry, and an `org` claim      | Minting refuses a key outside the org; the read route (`/api/v1/storage/<key>`) refuses a token whose `org` claim does not match the key's prefix (`TOKEN_ORG_MISMATCH`, 403), or whose org is erased or suspended (`ORG_UNAVAILABLE`, 403). |
| **S3 presigned URL**   | AWS's own signature over one key and expiry | **None in the URL.** A presigned URL is AWS's format and has nowhere to put a claim of ours. The org-bound client's check before signing is the whole control.                                                                               |
| **Public URL**         | Nothing                                     | **None.** Anyone holding it can read the file for as long as it exists. Local public files are served statically from `/uploads/<key>`. This is why the default changed at `multi`.                                                          |

**The local token's claim, in detail** (`lib/storage/access-tokens.ts`). The
payload is `{ typ: 'storage-read', key, expiresAt, org? }`. An org-owned key
can only be signed with a claim naming its own org, and a key no org owns only
without one. Since the token is also bound to one exact key, the read route's
claim check only refuses a token minted wrongly; it is there so a mistake in
the one minting function cannot become a cross-org read, and a test fails if
it is removed. A token minted before the claim existed carries none and still
reads any key no org owns.

Every signed URL is a **bearer** credential until it expires: whoever holds
it can use it. The org claim stops a token being minted for the wrong org; it
does not check who presents it. A read path that checked the reader's session
against the org would be a different mechanism, and Sunrise does not have one.

## Erasure and export

- **Org erasure deletes `orgs/{orgId}/`** after its database transaction
  commits, best-effort, reporting `storageSwept` on the result. Pre-prefix
  files are not reached. See [Org Erasure](../privacy/org-erasure.md).
- **The org export does not include files.** The bundle carries every row,
  including the keys and URLs an upload's conversation recorded, but not the
  bytes: `StorageProvider` has no list operation, so there is no way to
  enumerate an org's files to put them in. See
  [Org Data Export](../privacy/org-export.md).

## The storage ladder

What Sunrise offers a tenant who asks for control over where their files
live. Decided at design question Q9
([multi-tenancy design](../architecture/multi-tenancy-design.md)): **rungs 0–5
are published, rung 6 is excluded.** The full reasoning, with industry
precedent, is research §5B
([multi-tenancy research](../architecture/multi-tenancy-research.md#5b-data-handling-residency-and-storage-flexibility)).

| Rung  | What the tenant gets                               | Status in Sunrise                                                                                                                                 |
| ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Shared everything, isolation by row-level security | **Ships** (§107).                                                                                                                                 |
| **1** | Org-prefixed keys, org claim in signed URLs        | **Ships** (this page).                                                                                                                            |
| **2** | Own bucket and/or region (storage residency)       | **Published, not built in v1.** `getStorageClient({ orgId })` is the seam a per-org provider registry would hang off; nothing resolves one today. |
| **3** | Customer-managed encryption key                    | **A deployment option**, not an application feature: volume or bucket encryption under the customer's KMS key, plus a revocation runbook.         |
| **4** | Own database                                       | **Published, not built in v1.** A dedicated deployment (rung 5) is the answer today.                                                              |
| **5** | Own deployment                                     | **Available now.** A single-tenant install is exactly this.                                                                                       |
| **6** | Any storage backend the tenant chooses             | **Excluded.** Every backend multiplies migrations, backup, retention, erasure and vector search; there is no product-scale precedent.             |

## Related Documentation

- [Storage System](./overview.md) — providers, capabilities, the signed read route
- [Tenancy: Context](../tenancy/context.md) — `requireOrgId()` and the scope it reads
- [Org Erasure](../privacy/org-erasure.md) — the post-commit storage sweep
- [Org Data Export](../privacy/org-export.md) — what the bundle holds
