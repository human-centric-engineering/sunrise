# Account Deletion & Right to Erasure

How Sunrise erases a user and the data tied to them (GDPR Art. 17), and what it
deliberately retains. Both delete endpoints call `requestUserErasure()` in
`lib/privacy/erasure-requests.ts`, which records the deletion and disables the
account, then runs `eraseUser()` in `lib/privacy/erase-user.ts`. See
[Pending erasures](#pending-erasures).

## Quick Reference

| Need                          | Use                                                                   |
| ----------------------------- | --------------------------------------------------------------------- |
| Delete an account (a request) | `requestUserErasure()` — `lib/privacy/erasure-requests.ts`            |
| Erase a user (the only way)   | `eraseUser()` — `lib/privacy/erase-user.ts`                           |
| Finish pending deletions      | `processPendingErasures()` — the `pendingErasures` maintenance job    |
| Self-service deletion         | `DELETE /api/v1/users/me` (confirmation `{ confirmation: "DELETE" }`) |
| Admin deletes another user    | `DELETE /api/v1/users/[id]` (admin only)                              |
| What cascades vs. is retained | Per-table `onDelete` in `prisma/schema/`                              |

### Anti-Pattern

**Don't** call `prisma.user.delete()` directly:

```typescript
// ❌ Skips PII scrub, contact messages, the erasure receipt, and avatar cleanup.
await prisma.user.delete({ where: { id: userId } });
```

**Do** route through the service. A route deleting an account calls
`requestUserErasure()`, so a request killed part-way is still finished:

```typescript
// ✅ Record + disable the account, then scrub residual PII + write receipt +
// delete + remove blobs. A failure is retried by the maintenance tick.
import { requestUserErasure } from '@/lib/privacy/erasure-requests';

const result = await requestUserErasure({
  userId: session.user.id,
  actorUserId: session.user.id, // who initiated (self or an admin)
  reason: 'self_service', // 'self_service' | 'admin_action'
});
// result.status: 'erased' (with receiptId)
//   | 'pending' (out of time; the maintenance tick finishes it)
//   | 'in_progress' (another attempt holds it)
```

`eraseUser()` with the same arguments is the erasure itself, for callers that
need no durability, such as the seed and the smoke scripts. Without a
`deadline` it runs to the end, however long that takes.

## Pending erasures

`eraseUser()` can take minutes. Its pre-passes redact in committed chunks, and
its transaction can wait up to about 13 minutes behind a writer holding the
person's lock (t-840). A host with a short request limit can kill the request
between the two. Before t-842 that left a live account with part of its data
already redacted, and nothing that would finish the job. So a deletion is
recorded before any of that work starts (t-842; design on f-gdpr-erasure,
2026-10-18):

1. **Record and disable, in one transaction.** `requestUserErasure()` sets the
   intent on the `User` row (`erasureRequestedAt`, `erasureRequestedBy`,
   `erasureReason`), deletes the person's sessions and sets `revokedAt` on
   their `AiApiKey`s. From then on `sessionCreateBeforeHook` refuses sign-in
   (`refuseIfErasurePending`), and fails closed: if it can't read the row, the
   sign-in is refused.
2. **Erase, within a budget.** `eraseUser()` with a deadline
   `ERASURE_REQUEST_BUDGET_MS` (8 s; env `ERASURE_REQUEST_BUDGET_MS`) after the
   request began (t-845). Its delete removes the intent columns with the row,
   and the `DataErasureReceipt` is the record that it finished. If the budget
   runs out first, the request answers `pending` and the attempt is left due
   at once for the tick.
3. **Finish what did not.** The `pendingErasures` platform job
   (`processPendingErasures()`, every maintenance tick, system scope, one
   erasure per run) erases every person whose intent is still there once their
   next attempt is due, with the actor and reason the request stored. With
   no deadline: an attempt runs to the end, as every erasure did before
   t-845, so a heavy erasure finishes on a host that lets it. One killed by
   its host (the tick route's `maxDuration` on serverless) is retried once its
   lease runs out.

**The deadline** (`lib/privacy/erasure-deadline.ts`) is the request's alone.
`eraseUser()` checks it before the avatars, each `cleanupExternal` hook, each
delivery pre-pass chunk, each run pre-pass page and each try of the
transaction. Work already running is capped at the time left: a lock wait
outside the transaction (`waitForSubjectLocks`'s `maxWaitMs`), and each
pre-pass statement and the transaction itself through `statement_timeout`,
`lock_timeout` and Prisma's timeout. The statement cap is measured once the
transaction has its connection, since Prisma's timeout only starts then. When
the deadline runs out, `eraseUser()` throws `ErasureDeferredError`. What
committed before then stays done (the pre-passes write in committed chunks, and
redaction is idempotent); the transaction rolls back whole, so the account is
still there. A deferral is not a failure: the next attempt is due at once, and
the deferral does not count toward `erasureAttempts`, so a later failure's
backoff starts from the failures alone. Only a timeout that arrives after the
deadline (Postgres's statement or lock timeout, Prisma's transaction or pool
timeout; `isTimeoutError()`) is a deferral. Any other error is a failure,
however late, so it is logged and backed off. An attempt that finds the account
already erased, whatever it threw, answers with the receipt.

The run pass after the commit (`redactSubjectFromRunsSince`, t-843) is not held
to the deadline. The account is gone by then and nothing would redo the pass,
so it always runs in full. A request whose transaction commits near the end of
its budget can therefore take longer than the budget to answer.

`erasureNextAttemptAt` is both a **lease** and a **backoff**. Each attempt
claims the row by moving it 20 minutes ahead (`ERASURE_LEASE_MS`, longer than an
erasure's worst case), and the claim only applies if the row still has the
values it read. So two retriers, or a retrier and a request, never run the same
erasure at once. A killed attempt is retried when its lease runs out. A failed
one is retried after a backoff of 1, 2, 4… minutes, capped at an hour
(`erasureBackoffMs`). Nothing gives up: an erasure that keeps failing logs an
error on every attempt. While any erasure is pending, the job reports work, so
the idle gate never skips past its next attempt. The cost: one that keeps
failing keeps the gate awake, and the tick sweeps every minute until it is
fixed.

What a caller sees: `200` when the erasure finishes within the budget; `202`
`{ pending: true, requestedAt }` when it does not, and the tick finishes it;
`409 CONFLICT` when another attempt holds it or a failed one is waiting out
its backoff; and the original error when it fails. After a `202` or an error
the account is already disabled. The delete-account form shows "Deletion in
progress" on a `202` and on a `409` (the route has signed the person out
either way), and the admin users table shows a pending deletion as a
**Deletion pending** badge with no Delete action.

**Erasure hooks run again.** A deferred or failed attempt is finished by the
tick, which runs every hook from the start, in whichever process runs the tick.
`cleanupExternal` must be idempotent, and is not cut short once started, so keep
it to seconds. `scrubInTransaction` runs inside the transaction, so a deferral
rolls it back with everything else.

**Limits:**

- **No cancelling.** A pending erasure can't be called off (owner ruling,
  2026-10-18): its pre-passes may already have redacted data, and a cancelled
  account would be left damaged.
- **Up to 5 minutes of cached session.** Deleting the session rows does not end
  a session cookie that is already cached. It can still authenticate until the
  cache expires, as with any revocation (see
  [Auth Security](../auth/security.md)).
- **A session minted mid-claim.** A sign-in that read the row just before the
  intent committed can create its session just after the sessions were
  deleted. That session lasts until the next attempt, which deletes sessions
  again, or until the erasure's cascade.
- **A key minted from a cached session is refused.** The cookie-cache window
  lets a disabled account's cached session create an `AiApiKey`.
  `resolveApiKey` refuses any key whose owner has a pending erasure, so the
  new key never works.
- **The requester is not kept.** Erasing an admin clears their id from
  `erasureRequestedBy` on any erasure they asked for that is still pending
  (the column has no FK for a `SetNull` to reach). The retry then records the
  person as the actor. The subject-access export leaves out
  `erasureRequestedBy` and the retry state (`erasureAttempts`,
  `erasureNextAttemptAt`); when the deletion was requested, and why, are
  included.
- **MCP keys are not revoked.** An `McpApiKey` is the org's service key, kept
  through erasure (`createdBy` is `SetNull`), not the person's credential.
- **The tick must run.** On a host without the tick cron, nothing retries
  (see [scheduling](../orchestration/scheduling.md)).

## Erase-vs-Retain Model

Deletion leans on Postgres referential actions (`prisma.user.delete` triggers
them atomically and unbypassably). Relations to `User` fall into two policies —
see the `account_deletion_erasure_cascade` migration for the full per-table list.

| Policy                            | `onDelete` | What                                                                                                                                                                                                                                             |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Personal data → erased**        | `Cascade`  | Sessions, accounts, conversations (+messages, embeddings, shares), workflow executions (+steps), user memory, evaluation sessions, API keys                                                                                                      |
| **Org config + audit → retained** | `SetNull`  | Agents, profiles, versions, invite/embed tokens, workflows (+versions, schedules, triggers), event hooks, webhook subscriptions (t-782), knowledge documents, provider configs/models, experiments, admin audit log, MCP prompts/keys, cost logs |

**Why retain a cost log?** Different reason from the config rows beside it, and
worth stating separately: a cost row is a **billing record**. Cascading it would
let an erasure request quietly rewrite the books, so the FK is `SetNull` — the
spend stays, the person is detached. `scripts/smoke/erasure.ts` asserts exactly
that against a real database: row retained, `userId` null, amount unchanged.

**Why retain config?** For most of these, `createdBy` is attribution, not
ownership — any admin can already manage any agent/workflow/provider regardless
of who created it. So a departing creator's config keeps working; only the
`createdBy`/`uploadedBy` link is nulled. Child rows (messages, embeddings,
steps) already cascade from their parents, so only the root `User` relations
carry the policy.

**Webhook subscriptions outlive their creator** (t-782). An integration an
admin set up — a CRM feed, an escalation pager — must not silently stop when
they leave, so `createdBy` is `SetNull` and the subscription keeps delivering.
It is scoped to its creator, so once that is null it is managed by whoever the
authorization policy permits an ownerless `webhookSubscription` — platform
admins by default; a fork that wants an org's own admins to inherit it widens
the policy (see [Rows nobody owns](../auth/authorization.md#rows-nobody-owns)).
Its webhook URL and signing secret are org configuration and are kept; one of
its email addresses that is the subject's own is cleared (step 7).

**Webhook deliveries survive their subscription, deliberately** (§109 t-739).
Their parent FK is `SetNull` too, so deleting a subscription keeps its
`AiWebhookDelivery` rows as the org's record of where its events went — the payloads are about the org's customers, not about the
admin who configured the subscription. Each row records its destination, and
for a notification emailed to a person that is their own address — whoever's
subscription sent it, and whether or not it still exists — so `eraseUser()`
redacts it: a destination equal to the subject's verified address becomes
`[erased]`, its fingerprint is dropped, and the same goes for any earlier
destination in `previousDestinations`; a delivery still retrying is stopped
too, since its next attempt would email the erased person again. It matches
through the same rule as
subject access (`webhookDeliveriesAddressedTo()`: exact on the normalised
address, never `ILIKE`), so an unverified account's address, which may be a
stranger's inbox, is left alone. What a payload says about a person — an
escalated customer's id and the reason given, say — is redacted too (t-783;
see step 6 below). Event-hook deliveries behave the same way (`SetNull` on the
hook), and hooks already survive their creator.

**Two of them are owner-scoped, and they need a third rule.** `AiExperiment`
(`createdBy`) and `AiDataset` (`userId`) narrow every one of their routes to the
caller's own rows. Nulling the link on such a model does not de-attribute the row
so much as **orphan** it: keyed purely on the caller, every route answers "not
yours", and a row deliberately retained becomes one nobody can list, open, edit
or delete.

Both now handle that case explicitly, and it is the shape to copy. A row belongs
to **me**, to **someone else**, or to **nobody**, and the third is not a synonym
for the second. The visible set is "mine, plus nobody's" — and who gets the
second half is `canRead`'s `'unattributed'` arm, which exists for exactly this.
The default policy grants it to platform staff, so an admin sees and can delete
an orphaned row; a fork narrows it by registering a policy rather than by editing
a route. An admin can also **claim** one (`POST /experiments/:id/claim`,
`POST /evaluations/datasets/:id/claim`), which stamps them as the owner so the
row re-enters the normal rules instead of staying a permanent special case. The
boundary is untouched: another admin's _owned_ row is still a 404.

Both **log** access to a row nobody owns — the detail read and every write carry
`metadata.accessBasis = 'orphan'`, so who reached a de-attributed row after the
erasure is answerable. Experiments gained that in t-687; datasets have had it
since t-679. The definitions live in `lib/orchestration/access/dataset-access.ts`
and `lib/orchestration/access/experiment-access.ts` — one module per model, all
of them in that directory, each reading the policy answer
`session.unattributedReads` carries. Webhook deliveries are the third
owner-scoped `SetNull` case (`webhook-delivery-access.ts`, owned through the
subscription's creator); they can be discarded but not claimed, since a
delivery whose subscription is gone has nothing to re-enter.

The two differ on one point, and it is the one to decide rather than copy when
you add a model: experiments log a **write** whoever makes it, owner included,
because every experiment mutation already wrote a config-change row before the
basis existed and narrowing it would have deleted rows an operator can read.
Datasets log only non-owner writes. Neither logs its list.

**So when you classify the next `SetNull` model, decide two things, not one.**
This table records the retain policy. Whether the model's routes are owner-scoped
is a separate decision, and where both are true you owe the orphan rule above or
you are shipping rows that outlive everyone's ability to reach them.

### System-owned runs

`AiConversation.userId` and `AiWorkflowExecution.userId` are **nullable** (still
`Cascade`), and the engine handles `string | null` throughout — the
`user-memory` capability returns a `no_user_context` error rather than assuming
a user.

An anonymous embed-widget visitor is the other kind of caller with no `User`
row (#705, t-765). Their conversations carry `userId = null` and are owned
through `AiConversation.embedVisitorId`, a plain column with no foreign key, so
they appear in no user's export or erasure. They belong to the token's org and
go with its export, erasure and retention. See
[`.context/orchestration/embed.md`](../orchestration/embed.md#a-visitor-is-not-a-user).

Schedule- and inbound-triggered runs use that: they are written **system-owned**,
`userId = null`. Nobody with an account caused them, and the data on them is
frequently somebody else's — an inbound run's `inputData.trigger` is the adapter
payload verbatim (sender phone number, email From/Subject/body, base64
attachments), and the conversation row carries `fromAddress` and the whole
thread.

| Where                                          | Writes                                             |
| ---------------------------------------------- | -------------------------------------------------- |
| `app/api/v1/inbound/[channel]/[slug]/route.ts` | conversation, execution, audit row, engine context |
| `lib/orchestration/scheduling/scheduler.ts`    | execution, engine context                          |

Attribution lives on the config rows instead: `AiWorkflowTrigger.createdBy` and
`AiWorkflowSchedule.createdBy` name the operator who set the thing up, and
`AiWorkflowExecution.triggerSource` records what fired the run
(`inbound:<channel>` or `schedule`).

**Do not "fix" a null `userId` on these rows by filling it in.** Until #502 they
carried the operator's id, and it cost twice:

1. **Erasure over-deleted.** The FK is `Cascade`, so erasing that one operator
   destroyed every third party's inbound conversation and run routed through any
   trigger they had configured. `eraseUser()` reported success; the
   correspondence was simply gone.
2. **Access over-disclosed.** The rows matched the operator on `userId`, so a
   subject-access export handed them a stranger's phone number, email body and
   attachments, labelled as their own data.

Two consequences follow for anything you build on these rows:

- **Admin surfaces need the system basis, not an owner match.** A null owner
  matches no admin, so `lib/orchestration/access/execution-access.ts` and
  `conversation-access.ts` grant admins access to unowned rows on a `'system'`
  basis — every admin on a default install, and beyond that whichever admins the
  authorization policy permits, which both helpers now ask. **Only the
  conversation routes log that
  access** (`accessBasis` on the admin audit row, as they do for `'shared'`); no
  execution route logs a read, so do not rely on this for an audit trail over
  scheduled runs. Route a new surface through those helpers; a hand-rolled
  `userId === session.user.id` check will silently hide every scheduled and
  inbound run.
- **Steps that require a real account must refuse, not borrow one.**
  `judge_call` throws `judge_call_requires_user_context` on a system-owned run
  because it files a transcript into an account's chat history. Borrowing the
  schedule's author there would re-create the mis-attribution above.

Erasure of an inbound thread is a different request from erasure of an account:
the sender has no account, so `eraseUser()` cannot reach them. Delete the
conversation through the admin conversation route, which allows it on the
`'system'` basis and records who did it.

### Adding a new `User` relation (required step)

This is the easiest way to silently regress erasure, and it has happened twice.
Any **new** model with a `userId` or `createdBy` FK to `User` **must** declare an
explicit `onDelete` — Prisma's default is `Restrict`, which makes
`prisma.user.delete()` throw `P2003` for any user who has touched that table:

1. Decide the policy: **personal data → `onDelete: Cascade`**; **reusable config,
   audit, or logs → `onDelete: SetNull`** (and make the FK column nullable).
2. If `SetNull` leaves any residual PII on the retained row (an IP, a name, an
   email), scrub it in `eraseUser()` inside the transaction — `SetNull` drops the
   link, not the column.
3. Add an assertion to `scripts/smoke/erasure.ts` proving the new row is erased
   or de-attributed against a real DB.
4. Declare what a **data subject** receives from it in `SUBJECT_DATA_SOURCES`
   (`lib/privacy/export-sources.ts`) — the same decision, seen from the access
   side. This one is enforced: `tests/unit/lib/privacy/export-sources.test.ts`
   fails until the model is listed. See
   [Subject Access Export](./data-export.md).

When bringing an erasure branch up to date with `main`, **re-scan for new `User`
relations the merge introduced** — they reintroduce this bug unnoticed.

## What `eraseUser()` Does Beyond the Cascade

The DB cascade can't reach everything. The service adds eight steps; all but
the avatar cleanup run in **one transaction** with the delete (avatar cleanup
is a best-effort side effect first, since object storage can't enlist in a DB
transaction):

1. **Scrub residual PII** — `SetNull` drops the `userId` link on retained
   `AiAdminAuditLog` rows but leaves `clientIp` (an IP address = PII). The
   service nulls it before the link is gone.
2. **Write an erasure receipt** — see below.
3. **Remove avatar blobs** — `deleteByPrefix('avatars/{userId}/')`. On the local
   provider this sweeps both storage roots (`public/uploads/` and the private
   `.storage/private/`), so a file uploaded with `public: false` is erased too.
   A provider that stored objects in more than one place and swept only one
   would make this step a partial delete that still reported success — see
   [`.context/storage/overview.md`](../storage/overview.md#local-provider).
4. **Delete contact-form messages** — `ContactSubmission` has no FK to `User`
   (the public form takes an address, not a session), so no cascade reaches it.
   The service deletes the rows sent from the subject's address, matched
   **exactly** on the trimmed, lower-cased form the contact route stores, through
   `contactSubmissionsOf()` in `lib/privacy/contact-submissions.ts`. The export
   uses the same matcher on the same input — the address on the user row, read
   inside the transaction, not the caller's `userEmail`, which a cached session
   can hold stale across an email change — so the two cannot drift. Never
   `mode: 'insensitive'`: Prisma compiles it to an unescaped `ILIKE`, so a `_`
   or `%` in the address would delete a stranger's messages too (#766).
   **Only for a verified address.** The contact form proves nothing about who
   typed an address, and with email verification off anyone can open an account
   under someone else's, so an account whose `emailVerified` is false matches
   nothing: its erasure leaves those messages in place, and its export omits
   them. Erasure counts the messages it left and, when there are any, logs a
   warning carrying `contactSubmissionsLeft`, so the operator knows to answer
   the rest of that request by hand. The address is not logged; find the rows
   by hashing each `contact_submission.email` with SHA-256 and comparing it to
   the erasure receipt's `subjectEmailHash` (both use the trimmed, lower-cased
   address). Where verification is required (the production default) the only unverified
   accounts are sign-ups that never clicked their link — those, and every
   account where verification is off, are the ones this affects.
   Deleted rather than anonymised, because the export already hands these rows
   over as the subject's personal data. It is a system model, so no org scope
   is needed at either tenancy mode. It is matched on the account's current
   address only: messages sent from an address the person used before are not
   linked to them by anything. See the export doc's
   [Tables With No `User` FK](./data-export.md#tables-with-no-user-fk).
5. **Redact their address from webhook deliveries** (§109 t-739) — described
   [above](#erase-vs-retain-model): an email-channel delivery sent to the
   subject's verified address keeps the row and loses the address.
6. **Redact them from delivery payloads** (t-783) — a webhook or event-hook
   delivery stores the event it sent, and many events name the person whose
   activity caused them. `lib/privacy/delivery-payloads.ts` finds every
   delivery whose payload `data` carries the subject's id (`userId`,
   `actorUserId`, or in `approverUserIds`), or the `conversationId` or
   `executionId` of one of their conversations or runs — read before the user
   row goes, since those cascade with it. Matched by JSON containment, which a
   GIN index on each table's `payload` serves, so the transaction never scans
   the table. **Redacted, not deleted**: the row stays the org's record that
   an event was sent and where, as t-739 ruled.
   - An event about the subject's **own activity** (their conversation, their
     run, their id as `userId`, or as `actorUserId` on any event that is not
     an admin action) keeps only the keys that record which event it
     was — agent, workflow, ids, costs (`EVENT_RECORD_KEYS`). Free text
     (`reason`, `metadata`, `prompt`, `error`, `body`), approval links, and any
     key a fork's own event adds are dropped. An allowlist, so a new field is
     erased by default. One still waiting to retry is stopped
     (`exhausted`, "not retried: subject erased"), decided against the row's
     status when it is rewritten, so one the retry worker has just delivered
     stays delivered: what it would send is now about nobody. The stop holds
     (t-793):
     - An attempt already in flight when the erasure commits writes its
       outcome only to a row still `pending` or `failed`, so a stopped row
       stays stopped, and no further retry is armed. The POST that was
       already out cannot be recalled; the row records it as an attempt
       (count, time, response code) without touching its status, its mark or
       its destination.
     - A due retry is sent only by whoever claims it: the in-process timer or
       the maintenance tick moves the row's `nextRetryAt` on by a five-minute
       lease (`claimArmedRetry`, with `updateManyAndReturn`) and sends the
       payload the claim returned, never a copy read before it, which an
       erasure may have redacted since. A timer also checks the row is still
       the retry it was armed for (`isArmedRetry`). A row the erasure stopped,
       one an admin retried by hand meanwhile, or one the other sender
       claimed is left alone. A stale timer used to send a hand-retried row a
       second time, and a timer and the tick could both send one due retry. A
       sender that dies holding a claim hands the row back to the tick when
       the lease runs out. **Accepted:** an admin who retries a row by hand
       while a claimed attempt is still out sends it a second time, because a
       held lease and an armed retry both look like a future `nextRetryAt`.
       Every channel's send is bounded well inside the lease
       (`DISPATCH_TIMEOUT_MS`: webhook 5 s, email 15 s, event hook 10 s; a test
       fails if any reaches it), so an attempt cannot outlive its claim and be
       sent again by the next sender (t-808). An email that times out fails as
       retriable.
     - A manual retry (`409`) or a DLQ replay (counted as skipped) refuses a
       row an erasure marked: an `activity` row here, and an email delivery
       that was still retrying when step 5 ran. A delivered or exhausted email
       row sent to the person's address is not marked; step 5 has taken the
       address off it, and if its event names them, this step marks it. The
       mark is the row's `stoppedByErasure` column (t-809), which no later
       `lastError` write can clear; `lastError` also gets "not retried:
       subject erased" (or "recipient erased") for people to read, added once
       however many erasures match the row. A replay of a whole subscription
       leaves marked rows out of its oldest-first window, so a heavy erasure
       cannot fill it. A retry also resets the row only if it is unchanged and
       unmarked since it was read, and sends the payload the reset returned; a
       row that changed in between answers `409` too. Rows an erasure stopped
       before the column existed were marked by its migration from their
       `lastError` wording, the test the old check used, so a row from before
       it whose text merely ended in those words is marked too. The wording
       ("not retried: subject erased") is still added to `lastError`, once,
       for people to read, including on a row step 5 already stopped as
       "recipient erased".

     Every `activity` row gets the mark, whatever its status: one already
     `exhausted` (the DLQ's population) or `delivered` keeps its status, and a
     replay or manual retry refuses it.

   - An event about a **change they made** (`ADMIN_ACTION_EVENTS`:
     `agent_updated`, `capability.*quarantined`, `execution.force_failed`) or
     a step they were asked to approve keeps its
     data — the change is the org's — and loses only them, as the admin audit
     log does (`SetNull`).
   - In both, their id becomes `null`, their display name goes, and they leave
     `approverUserIds`. Other people's ids are untouched.

   **Two passes** (t-806; owner ruling 2026-10-15). Before the transaction,
   once nothing will refuse the erasure (where the avatars go),
   `preRedactSubjectFromDeliveries` matches the person's rows once and
   rewrites them in committed chunks of 5,000, each one `UPDATE` in Postgres
   with no payload passing through Node. Then the transaction's own pass,
   `eraseSubjectFromDeliveries`, matches again and writes only rows that still
   need it: a delivery written since, or everything if the pre-pass failed
   (logged, not fatal). The transaction has 60 s
   (`ERASURE_TRANSACTION_TIMEOUT_MS`) rather than Prisma's 5 s default.
   **Accepted:** if the transaction fails after the pre-pass, the person's
   delivery payloads are already anonymised and their retries stopped while
   the account still exists. Redaction is idempotent, and a retried erasure
   completes the rest.

   **Measured** (`scripts/spikes/erasure-delivery-scale.ts`, local Postgres on
   a loaded dev machine, vacuumed before seeding):

   | Rows naming the person (both tables) | Pre-pass (no limit) | Then `eraseUser()` | Share of the 60 s |
   | ------------------------------------ | ------------------- | ------------------ | ----------------- |
   | 100,000                              | 13.6 s              | 5.9 s              | 10%               |
   | 400,000                              | 33.1 s              | 16.5 s             | 28%               |
   | 1,000,000                            | 93.0 s              | 57.6 s             | 96%               |

   The last column overstates the transaction: it includes `eraseUser()`'s
   own pre-pass, which in the spike only re-matches. Timed on its own, the
   transaction's delivery pass after a pre-pass took 39.8 s for a million rows (19.9 s per table; tables vacuumed before seeding, not between the pre-pass and the pass). It still matches and redacts every
   row the person was ever named on, only to drop the ones already done, so
   past a million that match is what grows. Cutting it to rows created since
   the pre-pass began was considered and not done: a delivery committed by a
   transaction that started before the match would fall outside both passes.
   The pass locks only the rows that looked unfinished as it read them
   (locking every matched row is a write to each: 80 s for a million), in id
   order, and redacts each as it is once locked, so two erasures over one row
   do not undo each other. Two concurrent erasures can still deadlock, since
   the address passes (step 5) lock rows in their own order; Postgres aborts
   one, which fails, and its caller has to run it again; nothing retries it
   automatically. Before t-806 a single in-transaction rewrite timed out near 600,000
   rows. Two things made the difference, both measured: each SQL redaction
   step is fenced (`OFFSET 0`), since an inlined step re-ran its `jsonb_each`
   per reference (9.9 s against 0.6 s for 50,000 rows), and the payload GIN
   indexes have no pending list (`fastupdate = off`), since every probe of the
   transaction's match otherwise scanned the entries the pre-pass had just
   added (29.6 s against 4.7 s for 200,000 rows). Delivery rows are kept for
   ever unless `webhookRetentionDays` is set; an install whose users generate
   deliveries at that scale should set it. Every core event about a conversation or workflow run names its
   owner on the payload itself (`userId`, or `embedVisitorId` for a visitor),
   so the match does not depend on the conversation or run still existing
   (t-792). **Known limit:** rows written before that change by
   `chat_budget_exceeded_per_turn`, `workflow_budget_exceeded` and the force-fail hooks name the subject only
   by `conversationId` or `executionId`. Once the person deletes that
   conversation, or retention prunes it or the run before the delivery,
   nothing links the row to them, and erasure and subject access both miss it
   until retention prunes the delivery too. The same goes for a delivery written while the erasure is in flight — a
   chat turn or run still emitting events as the person is erased — which
   the match has already passed by. **A fork that emits
   its own events** (`emitHookEvent('app.…')`) and names a person under a key
   other than these must clear it with a `scrubInTransaction` hook; an
   `activity` row already loses every key it does not recognise, but an event
   matched on nothing here is not found at all. An anonymous embed visitor is
   not a `User`: their events carry `embedVisitorId` and go with the org's
   export, erasure and retention.

7. **Clear their address from email subscriptions that send to it** (t-786;
   owner ruling 2026-10-13) — a colleague's, or since t-782 the subject's own,
   which outlives them. Either would keep emailing an erased person and
   writing the address onto every new delivery. (Their own subscription to
   their own account address is cleared even when it was never verified:
   they set it up to email themselves.) Each one
   whose address matches the subject's verified address — each normalised
   by `normaliseAddress()`, the function the deliveries are recorded with,
   since a subscription stores the address as typed; compared in code, not
   re-implemented in SQL, whose `btrim`/`lower` differ on tabs and non-ASCII
   case; exact, never `ILIKE` — has the address cleared and is **deactivated**, not deleted: the
   integration stays visible to whoever manages it, who can point it at someone
   else. Each gets an admin audit entry, `webhook_subscription.recipient_erased`,
   naming the subscription, its owner (null for the subject's own) and org,
   and never the address. An
   unverified account's address matches nothing, as in steps 4 and 5. This
   runs before step 5, so the window in which a dispatch still reads the
   subscription as active is as short as it can be.

8. **Remove them from configuration that names them** (t-791; owner rulings
   2026-10-14), through `lib/privacy/config-recipients.ts`. Four places name a
   person, and no foreign key reaches any of them:
   - the **escalation email list** (`AiOrchestrationSettings.escalationConfig.emailAddresses`),
     which every escalation emails;
   - a workflow **`send_notification` step's `to`**, a literal address or a
     list of them;
   - a **`human_approval` step's `approverUserIds`**;
   - a **`human_approval` step's `notificationChannel.target`**, which can hold
     an address and is sent on in every `approval_required` event (the target
     goes; the channel and its type stay).

   An address is matched as in step 7 (verified only; `normaliseAddress()`,
   exact, compared in code), so an unverified account's address is left
   everywhere, and a template recipient such as `{{input.email}}` is never an
   address. An approver is matched on the user id, which names one account
   whether or not its address was verified, so it is removed either way.

   **Every version is rewritten**, not just the draft: the version executions
   run would keep emailing the person, a rollback would bring the address back,
   and old snapshots would keep their personal data. Erasure is the one writer
   allowed to change a published version — see
   [Workflow Versioning](../orchestration/workflow-versioning.md). Workflows are
   narrowed in SQL by a substring test on the definition's text — the user
   id, or the address with ASCII letters (and U+212A KELVIN SIGN, which
   `toLowerCase()` folds to `k`) folded by `translate()`, never `lower()`,
   which depends on the collation — so a workflow that cannot name the person
   is never loaded; the exact match is made in code. An address that is not
   plain ASCII, or holds a character JSON escapes, falls back to reading every
   workflow with an email notification step or an approval notification
   channel. The settings row, drafts and versions are read
   `FOR NO KEY UPDATE`: a write to the same row waits for the erasure rather
   than landing between its read and its write, while a new run's insert is
   not blocked. The work runs after the delivery passes, so those locks are
   held only until the commit.

   **A list the person leaves empty stays empty, and fails loudly.** A
   notification step whose only recipient was the person has none (`''`, or
   `[]` for a list): the step fails when it runs — its error strategy decides
   what follows, so a step set to `skip` is skipped, with nothing sent — and
   the builder will not save, publish or run the workflow until an admin adds
   one. The audit entry lists those steps (`stepsLeftWithoutRecipients`). The escalation list keeps its
   webhook and priority with no addresses, so the webhook still fires and
   nothing is emailed; the settings form refuses to save escalation as
   enabled with no address, so an admin adds one or turns escalation off — it
   never quietly drops the webhook. An approval step with no named approvers
   needs nothing: the run's owner and admins can still answer it.

   Each change is audited: `settings.escalation_recipient_erased` (recipient
   count before and after) and `workflow.recipient_erased`, one per workflow,
   naming the draft, the version numbers and the step ids changed, and the
   steps left without a recipient. Never the address. **Not reached:** a
   workflow inside a backup bundle already downloaded is outside the database.
   A saved template is an ordinary workflow row, so it is rewritten like any
   other. A writer that read before the erasure and writes after it is refused
   by the writer itself — see [Writers that read before an erasure](#writers-that-read-before-an-erasure)
   (t-805).

   **Then what the definitions became at run time** (t-804), through
   `lib/privacy/run-recipients.ts`:

   - **A schedule's `inputTemplate`** — free-form JSON handed to every tick
     as the run's input, and the documented home of a per-user schedule's
     literal address (`{ userEmail: 'x@co.com' }`, read by a
     `{{input.userEmail}}` recipient). A value that is the subject's verified
     address is blanked to `''`, or taken out of a list: the disposition t-791
     gave a step's `to`, so the step it feeds has no recipient and fails when
     it runs. The schedule stays **enabled**, so the failure is seen rather
     than the workflow quietly stopping. Each change is audited as
     `workflow_schedule.recipient_erased`, naming the schedule and its
     workflow and counting the values cleared, never the address. Only the
     address is matched here; an unverified account changes no schedule.
   - **Other people's runs** — a run keeps a copy of everything it was given
     and did: `inputData` (a scheduled run's copy of the template),
     `executionTrace` (each step's config and output), `outputData` (the step
     outputs the engine copies there on completion) and `errorMessage`. A run **paused at an
     approval** keeps its `approverUserIds` and notification target there,
     and the approval routes read them until retention prunes the run. In
     both columns the subject's id leaves every approver list, a notification
     target that is their address is removed (the channel and its type stay),
     and any other value that is their address or their id becomes
     `[erased]`, as a delivery's destination does — their id inside a longer
     string too, such as an approval's `actor: 'admin:<id>'` (a cuid is
     unique; an address is not searched for inside free text, where a
     substring may be someone else's). Matched on the id whether
     or not the address was verified. The subject's own runs cascade with the
     user row and are not read. Counted in the `User erased` log line as
     `executionsRedacted` rather than audited row by row, as redacted
     deliveries are: runs are records, not configuration.

   Both are narrowed in SQL by the same folded substring test, or by the
   address's domain when the whole address cannot be searched, and read in
   pages of 200 `FOR NO KEY UPDATE`. **Runs are redacted ahead of the
   transaction** (`preRedactSubjectFromRuns`, as deliveries are in t-806): a
   large run table folded and searched inside the transaction's 60 s would
   time the erasure out, and an erasure that times out erases nothing. Each
   page commits on its own; the transaction's pass then reads only runs
   written since the pre-pass started (on the database clock) or not yet
   finished, and every run if the pre-pass failed. The cut-off is moved back
   five minutes (`RUN_CLOCK_SKEW_MS`), because `updatedAt` is stamped by the
   app host's clock and the start time is the database's. If the transaction then
   fails, those runs stay redacted while the account still exists — accepted,
   as for deliveries. Each pre-pass page may take up to
   `PRE_PASS_PAGE_TIMEOUT_MS` (5 min): it commits on its own, outside the
   erasure's 60 s.

   **A run still executing** holds its input and definition in memory from
   the moment it starts, whichever path started it (a scheduler tick just
   before the erasure, the execute route, a trigger, recovery). So the places
   it sends to a person check at the moment they send (t-841):

   - **A `send_notification` email step** checks its resolved recipients
     against the receipts, under the subjects' locks, in the transaction it
     sends in, and holds the locks until the send settles. It takes them
     shared, so two sends to one address run side by side; only an erasure,
     which takes them exclusively, waits — and once queued it is not overtaken
     by a later send. Whichever of the
     send and the erasure takes a lock first finishes before the other reads:
     the erased recipient is left out, or the email went before the erasure
     committed. A step left with no recipient fails (`RECIPIENT_ERASED`, not
     retried), as one whose `to` erasure emptied does; one left with some
     sends to them, and its output counts the rest (`recipientsLeftOut`). The
     send is bounded (15 s) so the locks are let go, and carries a Resend
     idempotency key so a retry after a timeout is not delivered twice. A
     step past its own `timeoutMs`, or in a cancelled run, sends nothing: the
     engine gives up on a timed-out step without stopping it.
   - **An approval pause** is a writer: under the same locks, shared, it
     redacts anyone erased from its payload and its trace entry by the rule
     erasure applies to a run (`redactErased`) — out of the approver list, the
     notification target removed, any other value that is their address or id
     `[erased]` — before it writes the paused row, and
     the hook, webhook and streamed events carry what it wrote. The approval
     notification does not log its target address
     (`dispatchApprovalNotification`), since the application log is beyond
     erasure.

   **And what it writes back** (t-843). The engine writes the trace whole
   after each step, and the input, step outputs and error message at the
   end, from what it holds in memory, so a write after the erasure could
   restore what the erasure removed. Every write of a run — a checkpoint,
   the approval pause, the final write — therefore runs in a transaction:
   the write locks the row, then the run asks for erasure receipts since it
   started (`findErasedSinceRunStarted`: one query on the indexed `erasedAt`,
   from the run's `startedAt` less `RUN_CLOCK_SKEW_MS`). When there are any,
   whoever the run names among them is taken out of its trace, `inputData`,
   step outputs (so later steps read the redacted copy) and error message by
   `redactErased`, and the row is written again before the transaction
   commits. Holding the row orders the two: erasure locks a run naming the
   person before it redacts it, so a write queued behind it sees the receipt
   once it commits, and an erasure queued behind a write reads what the write
   left. A write that lands while the erasure's transaction is open, on a row
   its pass did not lock — the run named the person only in memory then —
   finds no receipt yet; erasure makes **one more pass after it commits**
   (`redactSubjectFromRunsSince`) over other people's runs still pending or
   running, or written since its transaction began, and counts them in
   `executionsRedacted`. It lists them by id and then locks and reads each in
   a transaction of its own, rather than narrowing by their text as the other
   passes do: Postgres tests a row's text against its committed version
   before it waits for the row's lock, so a run's write still open would be
   passed over, and a page holding every run it locked would keep the
   engine's writes waiting until it filled. The subject is the one the
   transaction matched on. The pass is best-effort: a run it cannot lock or
   write is skipped and counted in an error log, and that run's next write,
   if it has one, takes the person out instead. The completion event and the
   `workflow.failed` hook sent after the final write carry what it wrote,
   without them. **Not reached:** the `workflow_failed` event, and the
   webhook it sends, go out before the final write, with the failure reason
   as the run held it. Measured on a local
   Postgres, the check adds about 2 ms to a checkpoint's median when nobody
   was erased (500 interleaved pairs). `npm run smoke:erasure-running` proves
   all three orders against the real engine.

   **Not reached:** the approval events are sent after the pause commits
   and its locks are let go, so an erasure that ran from start to finish in
   that gap of milliseconds would not see the delivery they create. A run's
   multi-turn step state (`ai_workflow_running_step.turns`) is not redacted
   by erasure at all, nor is `supervisorReport` (t-882). Nor are the writes of
   a paused run made outside the engine — an approval or rejection, and a
   scheduler's failure write — which read the row before they write it
   (t-883). The engine deletes the running-step row when its step ends, but it
   is kept while the run is paused at an approval (resume reads its turns
   back) and when the host running it dies mid-step. A tick that read a schedule before the erasure and creates
   its run after it is a writer like any other (t-839, see "Writers that read
   before an erasure" below).

**At `multi`, a person's rows in every org go** (§107 t-748). The cascades are
FK actions, which row-level security does not filter, so `user.delete` removes
the person's rows in every org whichever org the caller is in. The hooks and the
transaction run as the audited system scope (`runAsSystem`), so a fork's hook
that clears a tenant-owned table, filtered on the `userId` it is handed,
reaches the person's rows in every org rather than only the caller's, and no
longer throws "No tenant context" when an admin API key entered none. There is
no org to ask for: `requireOrgId()` throws, and a tenant-owned row a hook
creates is not stamped, so write its `orgId` explicitly, read off the row it
relates to (not `runAsOrg` inside `scrubInTransaction`: the transaction was
opened as the system scope, and an op for another org inside it is refused).
An unfiltered query reaches every org's rows. At `single` no scope is entered,
and a hook keeps the implicit install org.
`scripts/smoke/tenancy-isolation.ts` ([18]) proves it as the restricted role,
with a hook that counts the person's rows in both orgs.

Apps and forks extend these same two reach-limits (residual-PII scrub, external
resource cleanup) via registered hooks — see
[App / fork tables relating to `User`](#app--fork-tables-relating-to-user).

## Writers that read before an erasure

Erasure removes a person from configuration under row locks, but a writer
that **read before** the erasure and writes its whole copy **after** it would
put them back, with no erasure audit trail: an open settings form, a builder
tab, a publish or rollback in flight, a webhook or schedule edit page — or a
backup taken before the erasure (t-805). The read is long over by then, so
row locks cannot stop it.

So each of those writers asks, inside the transaction that writes, whether
what it is about to write names an erased person —
`lib/privacy/erased-subjects.ts`, from the erasure receipt
(`subjectUserId`, and `subjectEmailHash` of the normalised address):

| Writer                                                                     | Names it checks                                                                                           | On a match                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH /settings`                                                          | `escalationConfig.emailAddresses`                                                                         | 400 on the field                                                                                                                                                                                                                    |
| `saveDraft`, `publishDraft`, `createInitialVersion` (`version-service.ts`) | every `to`, approver id and notification target in the definition                                         | an erased address: `ValidationError`, nothing written; an erased approver id: stripped, the rest written (an opaque id the builder cannot show, and a workflow naming someone erased before t-791 would otherwise never save again) |
| `rollback`                                                                 | the same, in the target snapshot                                                                          | stripped from the copy, with `erasedRecipientsRemoved` on the audit row: a snapshot cannot be edited, so a refusal would block it for good                                                                                          |
| `POST` / `PATCH /webhooks`                                                 | `emailAddress`                                                                                            | 400 on the field                                                                                                                                                                                                                    |
| `POST` / `PATCH .../schedules`                                             | every string in `inputTemplate`                                                                           | 400 on the field                                                                                                                                                                                                                    |
| Backup import                                                              | all of the above in the bundle                                                                            | stripped, with a warning; the import goes ahead                                                                                                                                                                                     |
| Scheduler tick (`processDueSchedules`)                                     | every string in the schedule's `inputTemplate`, and every recipient and approver in its published version | the address blanked in the run's input and the person left out of the definition the engine runs, as erasure does to the rows; logged without the address (t-839)                                                                   |

The tick reads its schedules at the top of the tick, and an erasure can commit
before it creates the run. So it creates the run, and claims the schedule's
firing, in one transaction that checks the receipts first. Unlike the other
writers it only **tries** the locks (`tryLockSubjects`): a schedule whose
person is locked by an erasure or a backup import is left, unclaimed, for the
next tick, rather than holding up every other due schedule while it waits. Any
other failure to create the run still claims the firing, so a broken schedule
fails once per firing, not on every tick. The tick takes no row lock before
the insert, so it cannot deadlock with an erasure or a workflow delete.
`npm run smoke:erasure-writers` runs both orders against a real tick.

**Why a lock and not just a check.** A check alone races the erasure: the
writer finds no receipt, the erasure scans and strips, the writer's write
lands after the scan. So both take a transaction-scoped Postgres advisory
lock per address and per user id: the writer before it checks
(`lockSubjects`), the erasure straight after it reads the user row, before it
writes or reads anything else. The erasure only tries the lock, and on a miss
rolls back and waits outside its transaction (below). Whichever holds the lock
first commits before the other reads — the writer then sees the receipt, or
the erasure sees the write and strips it. `npm run smoke:erasure-writers` proves both orders
against Postgres; with the erasure's lock removed, its writer-first case
fails.

**Waiting is bounded by erasure, not by Prisma's default.** A writer may
queue behind an erasure holding the lock for its whole transaction (up to
60 s), so every writer's transaction runs with `WRITER_TRANSACTION_OPTIONS`
(70 s): Prisma's 5 s default would turn the 400 the field shows into a 500.
The keys are locked one statement per key, in sorted order, and receipts are
looked up by `subjectEmailHash` through its own index.

**What is refused, and what is not.** A user id with a receipt, always. An
address only when the receipt says erasure matched it as verified
(`metadata.addressVerified`, written since t-805): erasure never strips an
unverified address, which may be a stranger's inbox, so a writer does not
refuse one either; a receipt from before t-805 does not say, and is not
refused. And never an address a live, verified account holds again — a
person erased and later signed up again may be notified like anyone else.

**Erasure does not wait for a writer inside its transaction** (t-840). The
backup importer holds the locks for everyone its bundle names for the whole
import (`IMPORT_TRANSACTION_TIMEOUT_MS`, up to 130 s), so an erasure that
waited inside its 60 s transaction could time out behind a long import and
erase nothing. The erasure transaction only tries the person's locks
(`tryLockSubjects`), straight after it reads the user row and before it writes
anything. On a miss it throws `SubjectLocksBusyError`, which rolls back nothing
but that read, and `eraseUser()` waits outside it (`waitForSubjectLocks`, each
lock in its own transaction, bounded by Postgres's `lock_timeout` at
`SUBJECT_LOCK_WAIT_MS`, 150 s, so up to 300 s for an address and an id), then
runs it again. Every lock wait inside the erasure transaction is bounded the
same way, at its 60 s. A writer that queued
during the wait gets the lock first, so this can repeat. The last of
`SUBJECT_LOCK_TRIES` (3) tries waits inside the transaction, as every try did
before, so a lock that keeps being taken cannot hold the erasure off for good;
a busy error from that try is thrown, not retried. A failed wait is logged,
and the next try finds out for itself.

**Why not simply wait inside a longer transaction.** It would keep the
erasure's place in the queue, but its transaction would then outlast the
writers' 70 s, which have to outlast it. The importer's 130 s includes that
70 s, and erasure has to outlast the importer. So once erasure's transaction
includes its wait, no set of timeouts satisfies all three. Trying keeps the
time erasure holds the lock within its 60 s.

This covers the subject locks only. An import that holds a **row** the erasure
also needs still makes it wait inside its 60 s: for example, an import that
rewrites a workflow whose current draft names the person, from a bundle that
does not. `npm run smoke:erasure-long-import` holds a real import open for
longer than erasure's 60 s and checks that the erasure completes after it. It
takes a little over a minute.

**A fork's own writer** of a recipient — a module that stores an address or
user id it notifies — calls `refuseErasedSubjects(tx, { addresses, userIds },
field)` inside its write transaction, and the same guarantee holds.

## App / Fork Tables Relating to `User`

An app built on Sunrise (or an external fork) keeps its own models in its own
schema file and relates them to the Sunrise `User`. It **cannot** add a Prisma
`@relation` to `User` — that needs a reverse field _on_ `User`, a core edit to
the most central, most merge-prone model. So the canonical pattern is a **plain
`String` FK with no `@relation`**, and the referential action is written by hand
in the migration:

```prisma
// app-owned schema file — a satellite profile/extension table
model AppHubUserProfile {
  id     String @id @default(cuid())
  userId String @unique // FK to User.id — no @relation
  // …app fields…

  @@index([userId])
}
```

```sql
-- hand-added to the generated migration
ALTER TABLE "AppHubUserProfile"
  ADD CONSTRAINT "AppHubUserProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE; -- personal data; SET NULL (nullable FK) for retained config/audit
```

**⚠️ The schema-level `onDelete` guard does NOT catch this.** The
[Adding a new `User` relation](#adding-a-new-user-relation-required-step) rule
above is enforced by reviewing `@relation onDelete` in `schema.prisma`. A
plain-scalar FK has no `@relation`, so it **slips past that guard entirely**.
Two failure modes if the migration FK is wrong:

- **No DB FK at all** → `prisma.user.delete()` leaves the app rows **orphaned**
  (a silent retention violation).
- **FK left at the default `RESTRICT`** → `prisma.user.delete()` throws `P2003`
  and **erasure breaks for every user** who has an app row.

So the migration FK with an explicit `ON DELETE` is **mandatory**, not optional.

### What the FK cascade can't do — register a cleanup hook

A `CASCADE` FK is erased automatically by `prisma.user.delete()`. But, exactly as
for Sunrise's own tables, the cascade **cannot** (1) scrub residual PII left in
columns of `SET NULL` retained rows, or (2) delete external resources (object
storage, search indexes) keyed to the user. For those, register a hook from `initAppErasureHooks()` in
`lib/app/erasure.ts` — it runs inside the same `eraseUser()` flow, with no edit
to the service:

```ts
// lib/app/erasure.ts
import { registerErasureCleanupHook } from '@/lib/privacy/erasure-hooks';

export function initAppErasureHooks(): void {
  registerErasureCleanupHook({
    name: 'app-hub',
    // Best-effort, BEFORE the transaction (like avatar cleanup). A throw is
    // logged and swallowed — it can never block the user's erasure. May run
    // again in a later attempt, in another process: make it idempotent.
    async cleanupExternal({ userId }) {
      await deleteAppBlobsFor(userId);
    },
    // INSIDE the transaction, BEFORE the user row is deleted, so it can still
    // match on userId and commits atomically — a throw rolls the erasure back.
    async scrubInTransaction({ tx, userId }) {
      await tx.appHubAuditEntry.updateMany({ where: { userId }, data: { actorIp: null } });
    },
  });
}
```

**A fork table keyed by email (no `userId` at all) is the `ContactSubmission`
case** — no FK, so delete it in `scrubInTransaction`. The hook is handed only
the `userId`, but the user row still exists at that point, so read the address
from `tx.user` and match it exactly, normalised as your writer stores it. If the
writer takes an address nobody proved (a public form), also read
`emailVerified` and match nothing when it is false, as `contactSubmissionsOf()`
does.

`getErasureCleanupHooks()` runs `initAppErasureHooks()` once, before its first
read, in the module graph `eraseUser()` runs in. Keep it synchronous: register
there, and do the async work inside the hook. A throw rolls back every hook it
registered and is logged; erasure then runs without them.

Registering from `initApp()` (`lib/app/bootstrap.ts`) also works: the registry
is held on `globalThis`, so it is one store across `instrumentation.ts` and the
route handlers. Before #691 it was not, and a hook registered there was never
run. Prefer the seam — it is the documented place, and it gets the rollback.

Then add an assertion to `scripts/smoke/erasure.ts` proving the app table is erased or
de-attributed against a real DB — the same proof the core tables get.

## Erasure Receipt (Accountability)

`DataErasureReceipt` (`prisma/schema/`, migration `add_data_erasure_receipt`)
is an **append-only** record proving an erasure happened, without re-introducing
the subject's PII:

- `subjectUserId` — opaque; the user row is gone, so it identifies nothing on its own.
- `subjectEmailHash` — `sha256` of the trimmed, lower-cased email, for correlating a later
  "did you erase me?" request. Not reversible; the raw email is never stored.
  It hashes the address **stored on the user row**, read inside the erasure
  transaction (t-797), not a caller's copy: a session cached across an email
  change would otherwise have the receipt name an address the account no
  longer held. `eraseUser()`'s `userEmail` parameter is therefore deprecated
  and ignored.
- `actorUserId`, `reason`, `erasedAt`.
- `metadata.addressVerified` — whether erasure matched the address (it does
  only for a verified one). Written since t-805; a writer refuses an erased
  address only when this is `true` (see
  [Writers that read before an erasure](#writers-that-read-before-an-erasure)).
  Both hashes are now `subjectEmailHash()` in `lib/privacy/erased-subjects.ts`,
  the trimmed, lower-cased form erasure matches on.
- **No foreign keys** — the receipt must outlive every referenced row, including
  the actor if they are erased later.

## Deletion Guards

| Guard                            | Where                       | Rule                                                                                                              |
| -------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Last admin** (`LAST_ADMIN`)    | `DELETE /api/v1/users/me`   | An admin may self-delete only if another **human** admin remains, not counting one whose own deletion is pending. |
| **No admin-deletes-admin**       | `DELETE /api/v1/users/[id]` | Must demote the target to `USER` first.                                                                           |
| **No self-delete (admin route)** | `DELETE /api/v1/users/[id]` | Admins delete their own account via `/users/me`, not this route.                                                  |

The asymmetry is deliberate: the admin route blocks deleting any admin (demote
first), but self-delete has no demotion gate — so the **last-admin** check lives
on `/users/me` to prevent locking the system out of all admins.

The last-admin count uses `humanAdminWhere` (`{ role: 'ADMIN', accountType:
'HUMAN' }` from [`lib/auth/account.ts`](../../lib/auth/account.ts)), so it
**excludes** the seeded `system@sunrise.local` config-owner (a `SERVICE`
account: role `ADMIN`, no credential, cannot log in). Counting it would let the
last human admin self-delete down to zero real operators, which would re-open
the first-user-is-admin bootstrap and silently promote the next signup (issue
#278). The SERVICE account is itself immutable via `users/[id]` (cannot be
demoted or deleted). See
[`../auth/user-creation.md`](../auth/user-creation.md#first-admin-bootstrap).

## GDPR Mapping

| Requirement                           | Status                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------- |
| **Art. 17 — Right to erasure**        | ✅ Personal data cascaded, residual PII scrubbed, avatar blobs removed. |
| **Art. 5(2) — Accountability**        | ✅ Append-only `DataErasureReceipt`.                                    |
| **Art. 15 — Right of access**         | ✅ `exportUserData()` — see [Subject Access Export](./data-export.md).  |
| **Art. 20 — Portability/export**      | ✅ Same path; the bundle is structured, machine-readable JSON.          |
| **Art. 5(1)(e) — Storage limitation** | ⏳ Retention purge is a separate feature (see roadmap).                 |

## Related Documentation

- [Org Erasure](./org-erasure.md) — deleting an organisation; its members' accounts stay (§106)
- [Privacy & Cookie Consent](./overview.md) — consent system
- [Security Overview](../security/overview.md) — application security
- [Auth Security](../auth/security.md) — sessions, password handling
- `lib/privacy/erasure-hooks.ts` — the app erasure cleanup-hook registry
- [`CUSTOMIZATION.md`](../../CUSTOMIZATION.md#4-database-schema) — Building on Sunrise: the satellite profile-table pattern for extending `User`
