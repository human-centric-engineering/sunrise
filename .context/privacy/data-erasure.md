# Account Deletion & Right to Erasure

How Sunrise erases a user and the data tied to them (GDPR Art. 17), and what it
deliberately retains. The entry point is `eraseUser()` in `lib/privacy/erase-user.ts`;
both delete endpoints route through it.

## Quick Reference

| Need                          | Use                                                                   |
| ----------------------------- | --------------------------------------------------------------------- |
| Erase a user (the only way)   | `eraseUser()` — `lib/privacy/erase-user.ts`                           |
| Self-service deletion         | `DELETE /api/v1/users/me` (confirmation `{ confirmation: "DELETE" }`) |
| Admin deletes another user    | `DELETE /api/v1/users/[id]` (admin only)                              |
| What cascades vs. is retained | Per-table `onDelete` in `prisma/schema/`                              |

### Anti-Pattern

**Don't** call `prisma.user.delete()` directly:

```typescript
// ❌ Skips PII scrub, contact messages, the erasure receipt, and avatar cleanup.
await prisma.user.delete({ where: { id: userId } });
```

**Do** route through the service:

```typescript
// ✅ Scrub residual PII + write receipt + delete + remove blobs, atomically.
import { eraseUser } from '@/lib/privacy/erase-user';

await eraseUser({
  userId: session.user.id,
  actorUserId: session.user.id, // who initiated (self or an admin)
  reason: 'self_service', // 'self_service' | 'admin_action'
});
```

## Erase-vs-Retain Model

Deletion leans on Postgres referential actions (`prisma.user.delete` triggers
them atomically and unbypassably). Relations to `User` fall into two policies —
see the `account_deletion_erasure_cascade` migration for the full per-table list.

| Policy                            | `onDelete` | What                                                                                                                                                                                                              |
| --------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Personal data → erased**        | `Cascade`  | Sessions, accounts, conversations (+messages, embeddings, shares), workflow executions (+steps), user memory, evaluation sessions, API keys, webhook subscriptions                                                |
| **Org config + audit → retained** | `SetNull`  | Agents, profiles, versions, invite/embed tokens, workflows (+versions, schedules, triggers), event hooks, knowledge documents, provider configs/models, experiments, admin audit log, MCP prompts/keys, cost logs |

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

**Webhook deliveries are the exception, deliberately** (§109 t-739). A
subscription cascades with its creator, but its `AiWebhookDelivery` rows do
not: their parent FK is `SetNull`, so they survive as the org's record of where
its events went — the payloads are about the org's customers, not about the
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
       The email channel has no send timeout, so an email attempt that hangs
       past the lease can also be claimed and sent again (t-808).
     - A manual retry (`409`) or a DLQ replay (counted as skipped) refuses a
       row an erasure stopped or marked. That covers both stop reasons:
       "subject erased" here, and "recipient erased" in step 5. The mark is
       the `lastError` wording (`isStoppedByErasure`), which the erasure SQL
       builds from the same functions; a write that settles a row for another
       reason (its subscription deactivated or deleted) is conditional on the
       row still awaiting a send, so it cannot overwrite the mark. A retry
       also resets the row only if it is unchanged since it was read, and
       sends the payload the reset returned.

     Every `activity` row gets the mark, whatever its status: one already
     `exhausted` (the DLQ's population) or `delivered` keeps its status, and a
     replay or manual retry refuses it. The mark lives in `lastError` text; a
     dedicated column would not depend on every writer preserving it (t-809).

   - An event about a **change they made** (`ADMIN_ACTION_EVENTS`:
     `agent_updated`, `capability.*quarantined`, `execution.force_failed`) or
     a step they were asked to approve keeps its
     data — the change is the org's — and loses only them, as the admin audit
     log does (`SetNull`).
   - In both, their id becomes `null`, their display name goes, and they leave
     `approverUserIds`. Other people's ids are untouched.

   Written in bulk (500 rows a statement), so a person with years of chat
   events costs a few statements, not a round trip each, and the transaction
   is given 60 s (`ERASURE_TRANSACTION_TIMEOUT_MS`) rather than Prisma's 5 s
   default. **Measured limit** (t-793,
   `scripts/spikes/erasure-delivery-scale.ts`, local Postgres on a loaded dev
   machine, vacuumed tables):

   | Rows naming the person (both tables) | Erasure | Share of the 60 s timeout |
   | ------------------------------------ | ------- | ------------------------- |
   | 50,000                               | 3.0 s   | 5%                        |
   | 200,000                              | 18.9 s  | 32%                       |
   | 400,000                              | 39.3 s  | 66%                       |

   That is about 0.1 ms a row, mostly the read-back-and-rewrite of each
   payload; the matching read is a small part of it (7.6 s at 400,000).
   Somewhere around 600,000 rows the transaction times out, rolls back, and
   the person cannot be erased until their history shrinks. Rows inserted
   since the last vacuum cost more: GIN's pending list (up to
   `gin_pending_list_limit`, 4 MB by default) is scanned on every match, and
   a table bulk-loaded and not yet vacuumed doubled the time. Delivery rows
   are kept for ever unless `webhookRetentionDays` is set. An install whose
   users generate deliveries at that scale should set it. Moving the rewrite
   into SQL (one `UPDATE … FROM`) is filed as t-806. Every core event about a conversation or workflow run names its
   owner on the payload itself (`userId`, or `embedVisitorId` for a visitor),
   so the match does not depend on the conversation or run still existing
   (t-792). **Known limit:** rows written before that change by
   `chat_budget_exceeded_per_turn`, `workflow_notification`,
   `workflow_budget_exceeded` and the force-fail hooks name the subject only
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

7. **Clear their address from colleagues' email subscriptions** (t-786; owner
   ruling 2026-10-13) — the subject's own subscriptions cascade, but another
   admin's email-channel subscription that notifies them would keep emailing
   an erased person and writing the address onto every new delivery. Each one
   whose address matches the subject's verified address — each normalised
   by `normaliseAddress()`, the function the deliveries are recorded with,
   since a subscription stores the address as typed; compared in code, not
   re-implemented in SQL, whose `btrim`/`lower` differ on tabs and non-ASCII
   case; exact, never `ILIKE` — has the address cleared and is **deactivated**, not deleted: the
   integration stays visible to its owner, who can point it at someone else.
   Each gets an admin audit entry, `webhook_subscription.recipient_erased`,
   naming the subscription, its owner and org, and never the address. An
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
   other. Two gaps are open. First (t-804), data that is not a definition: a
   literal address in a schedule's `inputTemplate`, which a template recipient
   such as `{{input.userEmail}}` resolves to, and a run already paused at an
   approval, whose stored approval payload and trace keep the person's id
   (`approverUserIds`) and any notification target address. Second (t-805),
   writers that read before the erasure and write after it: a settings form
   (or another instance's 30 s settings cache), a workflow builder tab, or a
   publish or rollback in flight writes the copy it read back, address
   included.

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
storage, search indexes) keyed to the user. For those, register a hook with
`lib/privacy/erasure-hooks.ts` — it runs inside the same `eraseUser()` flow,
with no edit to the service:

```ts
import { registerErasureCleanupHook } from '@/lib/privacy/erasure-hooks';

registerErasureCleanupHook({
  name: 'app-hub',
  // Best-effort, BEFORE the transaction (like avatar cleanup). A throw is
  // logged and swallowed — it can never block the user's erasure.
  async cleanupExternal({ userId }) {
    await deleteAppBlobsFor(userId);
  },
  // INSIDE the transaction, BEFORE the user row is deleted, so it can still
  // match on userId and commits atomically — a throw rolls the erasure back.
  async scrubInTransaction({ tx, userId }) {
    await tx.appHubAuditEntry.updateMany({ where: { userId }, data: { actorIp: null } });
  },
});
```

**A fork table keyed by email (no `userId` at all) is the `ContactSubmission`
case** — no FK, so delete it in `scrubInTransaction`. The hook is handed only
the `userId`, but the user row still exists at that point, so read the address
from `tx.user` and match it exactly, normalised as your writer stores it. If the
writer takes an address nobody proved (a public form), also read
`emailVerified` and match nothing when it is false, as `contactSubmissionsOf()`
does.

Register once at startup (alongside the app's capability registration), then add
an assertion to `scripts/smoke/erasure.ts` proving the app table is erased or
de-attributed against a real DB — the same proof the core tables get.

## Erasure Receipt (Accountability)

`DataErasureReceipt` (`prisma/schema/`, migration `add_data_erasure_receipt`)
is an **append-only** record proving an erasure happened, without re-introducing
the subject's PII:

- `subjectUserId` — opaque; the user row is gone, so it identifies nothing on its own.
- `subjectEmailHash` — `sha256(lowercased email)` for correlating a later
  "did you erase me?" request. Not reversible; the raw email is never stored.
  It hashes the address **stored on the user row**, read inside the erasure
  transaction (t-797), not a caller's copy: a session cached across an email
  change would otherwise have the receipt name an address the account no
  longer held. `eraseUser()`'s `userEmail` parameter is therefore deprecated
  and ignored.
- `actorUserId`, `reason`, `erasedAt`.
- **No foreign keys** — the receipt must outlive every referenced row, including
  the actor if they are erased later.

## Deletion Guards

| Guard                            | Where                       | Rule                                                              |
| -------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| **Last admin** (`LAST_ADMIN`)    | `DELETE /api/v1/users/me`   | An admin may self-delete only if another **human** admin remains. |
| **No admin-deletes-admin**       | `DELETE /api/v1/users/[id]` | Must demote the target to `USER` first.                           |
| **No self-delete (admin route)** | `DELETE /api/v1/users/[id]` | Admins delete their own account via `/users/me`, not this route.  |

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
