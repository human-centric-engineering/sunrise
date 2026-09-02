# Subject Access Export (Right of Access)

How Sunrise gives a data subject a copy of what it holds about them (GDPR
Art. 15), and how a fork extends that to its own tables. The entry point is
`exportUserData()` in `lib/privacy/export-user.ts`; both export endpoints route
through it.

This is the counterpart to [Account Deletion & Right to Erasure](./data-erasure.md).
The two paths answer the same question — _which tables hold this person's data?_
— and they answer it in the same place, so read them together.

## Quick Reference

| Need                            | Use                                                      |
| ------------------------------- | -------------------------------------------------------- |
| Export a subject (the only way) | `exportUserData()` — `lib/privacy/export-user.ts`        |
| Self-service download           | `GET /api/v1/users/me/export` (browser session only)     |
| Admin exports another user      | `GET /api/v1/users/[id]/export` (admin only)             |
| Decide what a new table exports | `SUBJECT_DATA_SOURCES` — `lib/privacy/export-sources.ts` |
| Add a fork's own tables         | `collectAppSubjectData()` — `lib/app/data-export.ts`     |
| Declare them for the guard      | `initAppSubjectSources()` — `lib/app/data-export.ts`     |

### Anti-Pattern

**Don't** hand-roll an export by querying the tables you happen to remember:

```typescript
// ❌ Complete on the day it was written, quietly short six months later.
const data = {
  user: await prisma.user.findUnique({ where: { id } }),
  conversations: await prisma.aiConversation.findMany({ where: { userId: id } }),
};
```

**Do** go through the service, so the manifest and its coverage guard apply:

```typescript
// ✅ Walks every declared source; the build fails if a table was never declared.
import { exportUserData } from '@/lib/privacy/export-user';

const bundle = await exportUserData({
  userId: subject.id,
  actorUserId: session.user.id, // who asked (self or an admin)
  reason: 'self_service', // 'self_service' | 'admin_action'
});
```

**Don't** narrow a source with `select`:

```typescript
// ❌ Exports exactly these three columns forever. Add a `notes` column holding
// free text about the subject, and it is silently missing from every export.
fetch: ({ userId }) =>
  prisma.appThing.findMany({ where: { userId }, select: { id: true, name: true, createdAt: true } }),
```

**Do** name the secrets with `omit`, so new columns are exported by default:

```typescript
// ✅ Everything except the credential. A column added tomorrow is included.
fetch: ({ userId }) => prisma.appThing.findMany({ where: { userId }, omit: { apiSecret: true } }),
```

## Why a Manifest and a Build-Breaking Test

An export that omits a table **looks exactly like a complete answer**. The
subject receives a plausible bundle; nothing in it says "one table was missed".
Neither they nor the operator who sent it can tell. That makes a partial export
worse than no export at all — it closes the question with a wrong answer.

Erasure does not have this problem. Forget an `onDelete` and
`prisma.user.delete()` throws `P2003`; erasure breaks loudly, in CI, for
everyone. Access has no equivalent natural failure, so Sunrise manufactures one:

`tests/unit/lib/privacy/export-sources.test.ts` parses `prisma/schema/*.prisma`
and fails if a model that identifies a person is missing from
`SUBJECT_DATA_SOURCES`. It casts two nets — models declaring a `User` relation,
and models holding a user-id column with no relation behind it (see
[Tables With No `User` FK](#tables-with-no-user-fk)). Adding either without
deciding what the subject receives from it breaks the build.

**When that test fails, do not delete the row to make it pass.** That ships a
short answer to a data subject. Add the model with a disposition.

### The second guard — `npm run smoke:export`

The unit suite mocks Prisma, so it verifies the _arguments_ the manifest builds
and never that the resulting queries run. `scripts/smoke/export.ts` closes that
gap against real Postgres (and runs in CI beside the erasure smoke): it creates a
throwaway subject carrying a session token, a password hash, an API-key hash and
a webhook secret, exports it, and asserts every manifest source executed and that
not one of those four values appears anywhere in the serialised bundle. The
credential check is a recursive sweep over the whole JSON rather than a per-table
assertion, so a source added later without an `omit` fails there even if nobody
wrote a test for it. Two counter-assertions (the subject's own IP address and
their message text _are_ present) stop the sweep from passing on an empty export.

## The Three Dispositions

Every `User`-linked model carries exactly one:

| Disposition   | What it means                  | What the subject gets                                               |
| ------------- | ------------------------------ | ------------------------------------------------------------------- |
| `export`      | The subject's own data         | The full row, minus credential columns named in `omit`              |
| `attribution` | Org config the subject created | `{ id, label, createdAt }` — the fact of authorship, not the config |
| _excluded_    | Listed in `EXCLUDED_SOURCES`   | Nothing, plus a written reason shown in the export's `meta`         |

**Why `attribution` is not just `export`.** `createdBy` is attribution, not
ownership — this is the same reasoning the erasure model uses when it retains an
agent and nulls its creator link (see
[Erase-vs-Retain](./data-erasure.md#erase-vs-retain-model)). Any admin can
already manage any agent regardless of who made it, so the agent's system prompt
is the organisation's data, not the departing creator's. What _is_ the subject's
personal data is the record that they made it. So attribution rows carry
identity and date and nothing else.

**Exclusions are not an escape hatch.** `EXCLUDED_SOURCES` is for tables a
reader would reasonably wonder about — message embeddings (numeric vectors
derived from message text that is already in the bundle) and short-lived
verification tokens. A test asserts that nothing in the exclusion list has a
`User` FK, so it cannot be used to write off a table the coverage rule covers.

`AiCostLog` is the worked example of that rule biting. It sat in this list on
the stated grounds that it "carries no user link" — true when written. Adding
`AiCostLog.userId` made it false, the coverage guard started requiring the
model, and it moved to `SUBJECT_DATA_SOURCES` as an `export` source. That is the
intended direction of travel: an exclusion is only as good as its reason, and
the guard re-checks the reason rather than trusting the entry.

## `omit`, Not `select`

Every `export` source uses Prisma's `omit`. This is deliberate and it is the
opposite of the usual API instinct.

An allowlist (`select`) is right when you are deciding what a response _needs_.
An export is deciding what the subject is _owed_, and the failure modes are not
symmetric: over-include a harmless column and the subject sees something dull;
under-include and they receive an answer that is wrong in a way nobody can
detect. With `omit`, a column added to `AiConversation` next year lands in every
export automatically, and only a deliberate act keeps it out.

What is omitted is credential material only:

| Table                   | Omitted                                              | Why                                        |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------ |
| `Session`               | `token`                                              | A live credential — hands over the account |
| `Account`               | `password`, `accessToken`, `refreshToken`, `idToken` | Password hash and OAuth credentials        |
| `AiApiKey`              | `keyHash`                                            | Material for an offline guess              |
| `AiWebhookSubscription` | `secret`                                             | HMAC signing key for outbound deliveries   |

## Failing Whole, Not Partial

Nothing in `exportUserData()` is best-effort. If any source throws, the whole
export fails and the caller gets a 500.

This is the **opposite** of `eraseUser()`, where a hook failure is logged and
swallowed so app-side trouble can never block a deletion. The asymmetry follows
from which failure the subject can detect:

- A blocked erasure is visible — the account is still there, and the subject
  complains.
- A partial export is invisible — the bundle arrives and looks fine.

So erasure degrades gracefully and access refuses to.

## When a Row Matches the Subject but Isn't Theirs

`where: { userId }` encodes an assumption — that a row pointing at someone is a
row _about_ them. **No shipped source narrows today**, but two did until #502,
and the reason is worth keeping in view because the next table like it will
arrive the same way.

Inbound traffic used to be written with `userId = trigger.createdBy` — the
operator who configured the channel — while `fromAddress`, the message bodies
and the `inputData.trigger` payload belonged to whoever sent them. Matching on
`userId` alone therefore handed one data subject another person's phone number
and correspondence, labelled as their own: a disclosure, and an Art. 15 answer
that is wrong about whose data it is. `AiConversation` filtered `channel: null`
and `AiWorkflowExecution` filtered `triggerSource: null` to contain it.

Both filters are gone. Those rows are [system-owned
now](./data-erasure.md#system-owned-runs) — `userId = null` — so no subject
matches them and no filter is needed. `export-sources.test.ts` pins the two
sources as unnarrowed, so reinstating a filter is a deliberate act rather than a
drive-by.

**If you ever do narrow a source, it must set `scopeNote`.** It is surfaced in
`meta` beside the row count, because a source that quietly returns some of the
rows is the silent-omission failure at row granularity — a count of 3 reads like
a complete answer whether or not a fourth row was withheld. The disclosure path
keeps its own test through a synthetic narrowed source in
`export-user.test.ts`.

**The better fix is almost always upstream.** A filter here contains a
disclosure; it does nothing about the erasure side of the same mistake, and
`AiConversation.userId` / `AiWorkflowExecution.userId` are `Cascade`. #502 is the
worked example: the same mis-attribution that would have leaked a stranger's
messages into an export was, in the erasure direction, deleting them outright
whenever that operator's account was erased. If you find yourself reaching for a
row-level filter, check what the same rows do when their apparent owner is
erased — `smoke:erasure` is where that assertion belongs.

## Tables With No `User` FK

A table can identify a person without declaring a Prisma relation to `User` —
and then it is invisible to a relation-based scan, **and to the erasure
cascade**. Sunrise has two, both in the manifest by hand:

| Table               | Identified by                    | How it is matched                     |
| ------------------- | -------------------------------- | ------------------------------------- |
| `ContactSubmission` | `email` — no user id at all      | `email`, case-insensitively           |
| `FeatureFlag`       | `createdBy String?`, no relation | `createdBy`, as an attribution source |

The guard casts **two nets**, because the first one missed both of these:

1. **Relation scan** — models declaring `x User? @relation(...)`. Catches the 27
   ordinary cases.
2. **Scalar scan** — models holding a `userId` / `createdBy` / `uploadedBy` /
   `ownerId` column with no relation behind it. Catches `FeatureFlag`, and
   anything a fork adds in the same shape.

`DataErasureReceipt` trips the second net and is allowlisted in the test, because
`exportUserData()` fetches it directly into the bundle's `erasureReceipts`
section rather than through a manifest source. That allowlist is an accounting
note, not an escape hatch — anything added to it still owes a reader a reason.

**Neither net can reach `ContactSubmission`.** It holds no user id in any
column, only an email, so no mechanical scan finds it. That is the residual gap,
and it is why the manifest still needs a human deciding what a new table holds
rather than trusting the guard to ask. If your fork adds a table keyed by email,
phone number, or an external identifier, **the guard will not find it for you** —
add it by hand and write a test row that says why.

If your fork adds a table like this — anything keyed by email, phone number, or
an external identifier rather than `userId` — **the guard will not find it for
you.** Add it to your own manifest by hand and write a test row that says why.

## Extending It — the App Seam

Fill in `collectAppSubjectData()` in `lib/app/data-export.ts`. It receives the
subject's `userId` and `email` and returns sections that land under `app` in the
bundle:

```ts
import { prisma } from '@/lib/db/client';
import type { AppSubjectQuery, AppSubjectData } from '@/lib/app/data-export';

export async function collectAppSubjectData({
  userId,
  email,
}: AppSubjectQuery): Promise<AppSubjectData> {
  const [invoices, enquiries] = await Promise.all([
    prisma.appInvoice.findMany({ where: { userId }, omit: { gatewayToken: true } }),
    prisma.appEnquiry.findMany({ where: { email: { equals: email, mode: 'insensitive' } } }),
  ]);

  return { invoices, enquiries };
}
```

**The collector is a plain function, not a registry.** The erasure sibling
(`lib/privacy/erasure-hooks.ts`) is a boot-time registry; this seam deliberately
is not, for the same reason the service fails whole. Erasure fails loudly if a
hook never registers — the rows are still sitting there afterwards. An
unregistered export collector yields a bundle that looks complete and is not. A
static import cannot be missed.

The _declaration_ below is a registry, and that is not a contradiction: it
carries no rows, and a declaration that fails to register is caught at build
time by the coverage guard rather than shipping a short bundle. The rows stay on
the static import.

### Declare your tables — core's guard covers them too

Core's coverage guard used to protect only core's tables while _scanning_ yours,
which meant a fork that filled the seam correctly still had a red
`export-sources.test.ts` and no fork-owned way to green it (#533). Now you
declare, in `initAppSubjectSources()` in the same file:

```ts
import { registerAppSubjectSources } from '@/lib/privacy/subject-source-registry';

export function initAppSubjectSources(): void {
  registerAppSubjectSources({
    tier: 'app',
    sources: [
      {
        model: 'AppInvoice',
        section: 'invoices',
        disposition: 'export',
        description: 'Invoices raised against your account.',
      },
      {
        model: 'AppEnquiry',
        section: 'enquiries',
        disposition: 'export',
        description: 'Enquiries you sent us.',
      },
    ],
    excluded: [
      { model: 'AppCountry', reason: 'Reference list of countries — holds no personal data.' },
    ],
  });
}
```

Core runs this once, lazily, before its first read — no wiring step — and folds
what you declared into the same guard that holds its own manifest level with the
schema.

**Every model in a schema file that is not Sunrise's own must be declared or
excluded** — `app.prisma`, `framework-*.prisma`, or any other name you pick.
Core identifies its own eleven files by name and treats everything else in
`prisma/schema/` as a fork tier's, because splitting a domain across files is
normal and core cannot know what you will call them.

That is stricter than the `userId`/`createdBy` heuristic core applies to itself,
and deliberately so: core reads its own column vocabulary and cannot read yours,
so a table keyed `authorId` or `respondentId` is invisible to that scan — and
the tables it cannot see are exactly the ones nobody remembers. A lookup or join
table is one `excluded` line with a reason, which is the note a DPO wants
anyway.

The failure names the models:

```
These models live in a fork-owned schema file and no tier has said what a
data subject receives from them: AppAnswerOption, AppQuestionnaireResponse.
```

**Declaring is a promise the export keeps.** Every `section` you declare must
appear in what `collectAppSubjectData()` returns, or `exportUserData()` throws
`DeclaredAppSourceMissingError`. Return the key with an empty array when the
subject owns nothing:

```ts
return { invoices, enquiries }; // both keys always present, `[]` when empty
```

`undefined` counts as missing, not as empty — `JSON.stringify` drops the key, so
`rows.length ? rows : undefined` would certify a section and then ship a bundle
without it. `null` is fine; it survives serialisation.

`npm run smoke:export` asserts the other half against real Postgres: the subject
it creates is seconds old and owns nothing of yours, so a declared section that
comes back with rows in it means the collector matched a stranger's.

### Two tiers, declaring independently

`CLAUDE.md` reserves `/app` for a leaf fork and `/framework` for a tier sitting
between Sunrise and its own leaf forks. This is a registry rather than one
exported constant precisely so both can declare: a single slot means a framework
tier consumes the seam its leaves are entitled to.

A framework tier registers from its own init with `tier: 'framework'`, reached
from the leaf's `initAppSubjectSources()` — the same bridge shape as
`bootstrap.ts → initFramework()`:

```ts
// lib/framework/privacy/export-sources.ts
export function initFrameworkSubjectSources(): void {
  registerAppSubjectSources({ tier: 'framework', sources: [...], excluded: [...] });
}
```

The `tier` string appears only in diagnostics, so a rejected row says who tried
to register it. A model claimed by two tiers keeps the first claim and logs the
second — it is never silently overwritten.

### What a malformed declaration does

A row is dropped, with `logger.error`, if it has an empty model or section, a
disposition that is neither `export` nor `attribution`, a description under 10
characters, an exclusion reason under 20, a section already in use, a model
claimed by another tier, or the same model as both a source and an exclusion.

Dropped is not silently accepted: the model stays unaccounted for, so the
coverage guard fails naming it. Throwing instead would abort the rest of your
tier's valid declarations. For the same reason a **throwing** init rolls the
whole registry back rather than keeping the rows registered before the throw —
half a contribution would give a failure list that moves with the position of
the bug.

## The Bundle

```jsonc
{
  "meta": {
    "formatVersion": 1,
    "generatedAt": "2026-07-31T12:00:00.000Z",
    "subjectUserId": "cmjb…",
    "exported": [{ "model": "Session", "section": "sessions", "description": "…", "rows": 3 }],
    "attribution": [{ "model": "AiAgent", "section": "agents", "description": "…", "rows": 1 }],
    "excluded": [{ "model": "AiMessageEmbedding", "reason": "…" }],
  },
  "account": {/* the User row */},
  "personalData": {
    "sessions": [],
    "conversations": [],
    /* … */
  },
  "attributions": { "agents": [{ "id": "…", "label": "Support bot", "createdAt": "…" }] },
  "erasureReceipts": [],
  "app": {},
}
```

`meta` is the part worth understanding. It echoes every source with its row
count, plus the exclusion list and reasons — so the subject can see the
**boundary** of what they received rather than having to infer it, and an
operator reviewing a response can tell an empty section from a missing one.

Bump `EXPORT_FORMAT_VERSION` on any breaking change to that shape; forks read it
to know what they are parsing.

## Endpoints

| Route                           | Guard           | Notes                                                  |
| ------------------------------- | --------------- | ------------------------------------------------------ |
| `GET /api/v1/users/me/export`   | `withAuth`      | **Refuses API-key sessions** — see below               |
| `GET /api/v1/users/[id]/export` | `withAdminAuth` | For a request that arrives by email rather than in-app |

Both apply the `exportLimiter` sub-cap keyed on the **calling** user
(`export:user:<id>`), on top of the section tier the proxy already applied, and
both send `Cache-Control: no-store` with a `Content-Disposition` filename.

**Why the self-service route refuses API keys.** `withAuth` accepts an API key of
any scope, and keys are self-service. A `chat`-scoped key pasted into a
third-party integration or left in a CI config would otherwise read out the
owner's entire account in one request. Same reasoning as the identity-mutation
refusal on `PATCH /api/v1/users/me`. Admins use the `[id]` route, which is
guarded by role rather than by session type.

**Volume is unbounded by design.** A subject with a long conversation history
gets all of it. Truncating an access response without saying so is the failure
this whole path exists to avoid, so there is no `take` — bound it at the
transport (streaming, an expiring download) rather than by dropping rows.

## GDPR Mapping

| Requirement                        | Status                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| **Art. 15 — Right of access**      | ✅ Full bundle, scope disclosed in `meta`, both self-service and admin paths.   |
| **Art. 20 — Data portability**     | ✅ Structured, machine-readable JSON, delivered on request.                     |
| **Art. 12(3) — Response deadline** | ⚠️ Process, not code. Sunrise makes the response immediate; the clock is yours. |
| **Identity re-verification**       | ⏳ Not implemented — the session is the only proof. See below.                  |

### Deliberately not implemented

- **Re-authentication before export.** The self-service route trusts the
  session, exactly as the erasure route does. A fork holding especially
  sensitive data should add a password confirmation, following the
  `currentPassword` pattern in `PATCH /api/v1/users/me`.
- **An expiring download link.** The bundle is returned inline. A fork with
  large exports (or a compliance need for a revocable link) should stage it to
  object storage and hand back a signed URL.
- **An access receipt.** Erasure writes an append-only `DataErasureReceipt`;
  access only logs. Both routes emit a structured log line naming the subject
  and the acting user, which covers accountability without a new table.

## Related Documentation

- [Account Deletion & Right to Erasure](./data-erasure.md) — the Art. 17 counterpart
- [Privacy & Cookie Consent](./overview.md) — consent system
- `lib/privacy/export-sources.ts` — the manifest
- `lib/app/data-export.ts` — the fork seam (collector + declarations)
- `lib/privacy/subject-source-registry.ts` — where a fork tier's declarations land
- [`CUSTOMIZATION.md`](../../CUSTOMIZATION.md#4-configuration--environment--the-libapp-surface) — the full `lib/app/` surface
