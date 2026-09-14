# Conversation Access — Consent-Gated by Default

End users own their conversations. An admin (or any other user) gains access to another user's conversation **only** when the owner has explicitly granted consent via an active `AiConversationShare`. There is no admin-can-see-everything mode. This is the GDPR / CCPA default, the trust posture partner pilots in regulated domains (legal, mortgage, health, tenant rights) need, and the smallest blast-radius posture in the event of an admin account compromise.

## The rule

An admin can access a conversation iff:

0. **Nobody owns it** (`AiConversation.userId IS NULL`) and the authorization
   policy permits this caller an unattributed read. Inbound threads — SMS,
   WhatsApp, email, Slack — are stored ownerless since
   [#502](https://github.com/human-centric-engineering/sunrise/issues/502),
   because the messages belong to a member of the public with no account here
   rather than to the operator who configured the channel. This basis is
   `'system'`, it is audit-logged like `'shared'`, and since t-686 it is the
   **policy's** answer rather than a fixed rule: a fork registering a narrowing
   `canRead` keeps one tenant's admins out of another tenant's customers'
   messages. See [`.context/auth/authorization.md`](../auth/authorization.md).

1. They are the participant (`AiConversation.userId == session.user.id`), or
2. The participant has created an active share record.

"Active" means `revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now())`. Default expiry on share creation is 7 days. The consumer (end user) controls share / revoke through the [share routes](../api/orchestration-endpoints.md#consumer-chat--share-routes).

## Single source of truth

Every per-id admin conversation route gates through
`adminCanViewConversation(conversationId, session)` at
[`lib/orchestration/access/conversation-access.ts`](../../lib/orchestration/access/conversation-access.ts).
Returns `{ ok, basis: 'owner' | 'shared' | 'system' | null, ownerId }`.

**It takes the session, not a user id** — the `'system'` arm reads the policy's
answer from `session.unattributedReads.conversation`, which the guard resolved
before the handler ran. Passing `session.user.id` will not compile, and what a
cast does next depends on what you cast: a bare string throws `TypeError` on
every conversation read, while a hand-built object carrying only `user` reads
its owner arm fine and throws only when it reaches an ownerless row — a quiet,
partial failure that looks like a data problem. Pass the session the guard gave
you.

The set form is `conversationVisibilityWhere(session)` in the same module, and
the list route uses it. The two faces are written next to each other and read the
same answer, because a list that admits a thread its detail route refuses is the
divergence this module exists to prevent — and nothing mechanical catches it.

```typescript
// What the fragment produces on a default install:
where: {
  OR: [
    { userId: session.user.id },
    { userId: null }, // present only where the policy permits it
    {
      share: {
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    },
  ],
}
```

**Two routes do not use either face, and both are deliberate.** Semantic search
hand-writes the predicate in SQL, because a pgvector distance query is not
expressible through Prisma's query builder — the copies are pinned against each
other in `policy-narrowing.test.ts`, in both directions: the arm is asserted
present on a default install and absent under a narrowing policy, and the
active-share test is compared character for character against the fragment's. And `GET /conversations/export` is
hard-scoped to `{ userId: session.user.id }`: bulk export of other people's
conversations is a privacy footgun, so it is owner-only by design and sees
neither shared nor ownerless rows.

## What's owner-only, what's consent-gated

| Route                                    | Scope                   | Why                                                                    |
| ---------------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `GET /conversations` (list)              | Owned + actively shared | Browse                                                                 |
| `GET /conversations/:id`                 | Helper-gated            | Audit / debug                                                          |
| `GET /conversations/:id/messages`        | Helper-gated            | Audit / debug                                                          |
| `GET /conversations/:id/provenance[.md]` | Helper-gated            | Audit export                                                           |
| `PATCH /conversations/:id`               | **Owner-only**          | Mutation — a share grants view consent, not write                      |
| `DELETE /conversations/:id`              | **Owner-only**          | Destroy — same reason                                                  |
| `GET /conversations/export`              | **Caller-only**         | Bulk export — per-conversation provenance covers the audit-export case |
| `POST /chat/conversations/:id/share`     | Owner-only              | Only the owner can grant their own consent                             |
| `DELETE /chat/conversations/:id/share`   | Owner-only              | Only the owner can revoke their own consent                            |

## Audit-of-audits

Every cross-user (shared-basis) read writes an `AiAdminAuditLog` row via [`logConversationAccess`](../../lib/orchestration/audit/admin-audit-logger.ts) with:

- `userId` — the admin who read
- `action` — one of:
  - `conversation.metadata_viewed` (GET `/conversations/:id`)
  - `conversation.messages_viewed` (GET `/conversations/:id/messages`)
  - `conversation.provenance_export` (GET `/conversations/:id/provenance[.md]`)
  - `conversation.search_matched` (GET `/conversations/search` — fired per cross-user row in the result set)
- `entityId` — the conversation id
- `metadata.accessBasis: 'shared'`
- `metadata.conversationOwnerId` — the end user who owns the row

The list endpoint (`GET /conversations`) is **not** audited per-row — it returns summary data only (title, tags, summary, message count; no message content), and per-row audit on a paginated browse would write 25+ rows per page render without adding compliance signal. Substantive cross-user reads — single-conversation detail, messages, provenance bundle, and search matches (which uniquely return up to 500 chars of message content) — all write a row.

Owner reads skip logging by convention — routine self-access would flood the log without adding signal. The helper silently no-ops on `basis === 'owner'` so callers don't need a branch.

Compliance can answer "which other users' conversations did admin X view this month?" in one SQL:

```sql
SELECT
  "createdAt", action, "entityId" AS conversation_id,
  metadata->>'conversationOwnerId' AS owner_id,
  metadata
FROM ai_admin_audit_log
WHERE "userId" = '<admin-id>'
  AND action LIKE 'conversation.%'
  AND metadata->>'accessBasis' = 'shared'
  AND "createdAt" > NOW() - INTERVAL '30 days'
ORDER BY "createdAt" DESC;
```

## Threat model — what this defends against

- **Routine admin curiosity.** An admin can't browse to a user's conversation just because they have an admin role. Cross-user access requires the owner's explicit consent, and consent expires by default.
- **Admin account compromise.** If an admin account is taken over, the attacker can pull only what users actively shared — typically a small subset, time-bounded. Compared to "admin can see everything," the blast radius drops by orders of magnitude.
- **Cross-user data leakage via predictable IDs.** Conversation IDs are CUIDs (cryptographically random), not enumerable. Combined with consent-gating, knowing an ID alone grants no access.

## Threat model — what this does _not_ defend against

- **A malicious or coerced end user.** A user who shares their own conversation has, by definition, consented. Out of scope.
- **The PII the admin sees once consent is granted.** Provenance-bundle PII redaction (the separate write-time redaction architecture) handles that layer.
- **An admin who has been _given_ the user's session.** Authentication is the wider system's responsibility.

## Future: compliance officer role

A `COMPLIANCE_OFFICER` role (separate from `ADMIN`) will be the named exception to consent-gating: documented legal-basis access for regulators or court orders, every access logged with mandatory justification, user notification on access. Out of scope for the initial backend; the architecture has a place for it (`access.basis` can grow a `'compliance'` case) without callers needing to change.

## See also

- [Orchestration API endpoints](../api/orchestration-endpoints.md#conversations) — route reference
- [`adminCanViewConversation`](../../lib/orchestration/access/conversation-access.ts) — authorization helper
- [`AiConversationShare`](../../prisma/schema/) — schema
- [PII redaction at the capability layer](./pii-redaction.md) — what's already redacted before any admin (even with consent) sees it
