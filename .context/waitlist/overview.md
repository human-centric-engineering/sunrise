# Waitlist

> **In progress (§125).** Joining (t-974), the erasure receipt (t-975) and the
> admin page (t-976) are built. Confirming the address and the leave link
> (t-977), invites and linking the new account (t-978) are not yet. Until
> t-977 lands, every entry stays unconfirmed — so the admin page shows no one
> until you tick "Show unconfirmed" — and nothing sends the joiner an email.
> Don't switch the waitlist on in production before then.

A pre-launch waitlist a fork switches on: Sunrise owns the table, the routes,
the privacy wiring, the admin page and (soon) invites; the fork owns its
fields, copy and look. The binding design is the
[Sunrise Waitlist spec](https://claude.ai/artifact/NVEu3CqpBAXskCoBQnBExN).

## Switching it on

Two switches, answering different questions:

| Question                | Who changes it               | Where it lives                                                       |
| ----------------------- | ---------------------------- | -------------------------------------------------------------------- |
| Does the app have one?  | The fork's developers        | `lib/app/waitlist-config.ts` — `null` (shipped) means no waitlist    |
| Is a list taking joins? | The admin running the launch | A `WaitlistListState` row per org and list, set on `/admin/waitlist` |

Neither is an env var: neither should differ between staging and production,
and closing a list must not need a redeploy. A declared list starts open
unless it says `startsClosed: true`; once a row exists, the row wins.

```ts
// lib/app/waitlist-config.ts
import type { WaitlistConfig } from '@/lib/waitlist/config';

export const waitlistConfig: WaitlistConfig | null = {
  consentVersion: '2026-11-01', // the version of your privacy notice
  fields: [
    {
      key: 'role',
      label: 'What do you do?',
      kind: 'select',
      options: [
        { value: 'producer', label: 'Producer' },
        { value: 'dj', label: 'DJ' },
      ],
    },
    {
      key: 'useCase',
      label: 'What would you use it for?',
      kind: 'textarea',
      help: 'A sentence is plenty.',
    },
  ],
  lists: [{ key: 'default' }],
  screen: ({ email }) =>
    email.endsWith('@mailinator.com')
      ? { action: 'flag', reason: 'disposable-domain' }
      : { action: 'accept' },
};
```

Then mount the form wherever you like:

```tsx
import { Waitlist } from '@/components/waitlist/waitlist';

<Waitlist copy={{ submitLabel: 'Get early access', consentNotice: <PrivacyLine /> }} />;
```

`<Waitlist>` is a server component. It builds the same answer
`GET /api/v1/waitlist` gives, from the same functions, but reads them directly
rather than through `serverFetch()`: that route is rate-limited by IP, and a
server-side call would put every visitor's render in one bucket, so a busy
launch page would lose its form to a 429. It renders nothing without a config
or when the state cannot be read, and shows the closed message for a closed
list — including one closed after the page rendered, when the join answers 409. `<WaitlistForm>` (`components/waitlist/waitlist-form.tsx`) is the client
form, for a page that supplies the fields itself. Every label, placeholder and
message it draws is a `copy` prop.

**An invalid config switches the waitlist off** and logs
`Waitlist config is invalid` with each problem — a select without options,
duplicate keys, a field key that is a body name (`email`, `name`, `list`,
`website`, `referrer`) or an `Object` member (`constructor`, `toString`…).
Half a waitlist is worse than none.

## Routes

| Route                   | Who    | What                                                                   |
| ----------------------- | ------ | ---------------------------------------------------------------------- |
| `GET /api/v1/waitlist`  | Anyone | `{ lists: [{ key, open }], fields }` — the form's fields, serialisable |
| `POST /api/v1/waitlist` | Anyone | Join. 5 an hour per IP (`waitlistLimiter`, `RATE_LIMIT_WAITLIST`)      |

Admin routes — org-tier (`withAdminAuth({ tier: 'org' })`, listed in
`ORG_TIER_ADMIN_ROUTES`), so an org's OWNER or ADMIN works their own org's list:

| Route                                     | What                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/admin/waitlist`              | One page: `page`, `limit` (≤100), `sortBy` (`createdAt` / `email` / `confirmedAt`), `sortOrder`, filters ↓ |
| `GET /api/v1/admin/waitlist/counts`       | Per list: open or closed, counts by state, confirmed by source; and the declared fields                    |
| `GET /api/v1/admin/waitlist/export`       | CSV with the same filters. `exportLimiter` keyed `export:waitlist:user:<id>`; BOM; `no-store`; 10,000 rows |
| `PATCH /api/v1/admin/waitlist/:id`        | `{ removed: boolean }` — the state to reach                                                                |
| `DELETE /api/v1/admin/waitlist/:id`       | Erase: the row, a waitlist receipt, and this org's pending invitation for the address                      |
| `PATCH /api/v1/admin/waitlist/lists/:key` | `{ open: boolean }` for a declared list — records who and when                                             |

The filters: `list`, `q` (the address as typed, the name, or any declared
answer — a JSON-path text match), `includeUnconfirmed`, `includeRemoved`,
`includeJoined`, `flaggedOnly`. **By default only confirmed entries still on
the list** are listed and exported: anyone can type any address into the
form, so an unconfirmed entry is asked for, never assumed. Every route
answers 404 without a config, and the page and its nav item are hidden.

The public routes answer 404 without a config too. The join body:
`{ email, name?, list?, details?: { <field key>: string }, utm_source?, utm_medium?, utm_campaign?, referrer? }`.
`list` may be left out when there is one list. Unknown `details` keys are a 400.

## The join rules

Each was found in Lelanea's waitlist, in review or in use, and each has a test.

- **One answer for every accepted join**: a first join, a repeat, a confirmed
  repeat, a removed address re-joining, a flagged join and a honeypot hit get
  the same status, body and headers. Anything else tells a stranger whether an
  address is on the list. What does differ says nothing about the address: a
  400 (the body), a 409 `WAITLIST_CLOSED` (whether a list is open is public),
  and a 429 (the caller).
- **The honeypot is decided on its value**, before validation: absent, `null`
  and `''` are a person. (Deciding it on a validation error, as the contact form
  does, turns `website: null` into success with nothing written.)
- **Before confirmation, a repeat replaces the answers**; **after, it only
  fills empty ones**. `consentedAt` and `consentVersion` never move.
- **Removed stays removed.** A re-join increments `rejoinRequests` and stamps
  `rejoinRequestedAt`, nothing else.
- **A flag sticks.** `screen()` can flag, never unflag; a throwing `screen()`
  flags `screen-error`.
- **Exact address matching**, on the trimmed, lower-cased form — never
  `mode: 'insensitive'` (#766).
- **No address in the logs.** The route logs the list and the outcome.

Attribution is reduced before it is stored: the first `Accept-Language` tag,
the referrer's host only, UTM values capped at 100 characters.

## Tenancy

Both tables are tenant-owned. Public joins land in the **install org**, entered
with `runAsOrg(INSTALL_ORG_ID, …, { source: 'public-form' })`. At `multi`, a
fork's tenant resolver does not route a join to another org yet.

The migration that creates the tables enables and forces row-level security on
them **if the install's switch is already on** (it reads `ai_agent`'s flag).
They are the first tenant-owned tables since §107. Without this, a
`migrate deploy` on a multi-tenant install would leave them readable across
orgs until `db:tenancy:enable` ran again.

## Privacy

- **Subject access / erasure** match through `waitlistEntriesOf()`
  (`lib/waitlist/subject.ts`): an entry linked to the account, or under its
  address once the account has verified it. See
  [data-export](../privacy/data-export.md#tables-with-no-user-fk) and
  [data-erasure](../privacy/data-erasure.md).
- **Erasing a waitlist-only person** (no account) goes through
  `eraseWaitlistEntry()` (`lib/waitlist/erase.ts`): it deletes the entry,
  writes a `waitlist` erasure receipt, and deletes the pending invitation for
  the address that this org issued — otherwise a working sign-up link survives
  the erasure. Another org's invitation is left (invitations are install-wide,
  one per address); one whose metadata cannot be read is left and logged. The
  admin page's Erase calls it; the leave link (t-977) will. See
  [Waitlist-only receipts](../privacy/data-erasure.md#waitlist-only-receipts).
- **Removing is not erasing.** Remove (`PATCH { removed: true }`) keeps the
  row — `removedAt`, never a delete — so a re-join stays removed and Art. 15
  still discloses it. Erase deletes it.
- **`userId` cascades** with the account: an entry is personal data.
- **Org export** includes both tables.
- **Your privacy notice** must cover what the form collects, that answers are
  kept while the list is open, and the version you put in `consentVersion`.

## The admin page

`/admin/waitlist` (org-tier, in Management). Per list: open/closed with the
button that changes it, counts by state (confirmed, unconfirmed, flagged,
invited, signed up, removed) and confirmed by source. Below it, the people:
search, filters, sortable columns, Remove / Restore (Restore asks first, and
says how many times a removed address tried to re-join) and Erase (asks
first). The export button states its row cap. The table drops a stale
response, never shows "empty" after a failed load, and the server breaks
sort ties by `id`. Every field has a `<FieldHelp>`; a failed save shows
`<SaveError>` beside the button pressed.

## Retention

Every state has a limit, each a config setting (`retention`, defaults in
`DEFAULT_WAITLIST_RETENTION`), enforced by the per-org maintenance job
`waitlistRetention` (hourly, `lib/waitlist/retention.ts`):

| State                         | Deleted                             | Setting            |
| ----------------------------- | ----------------------------------- | ------------------ |
| Removed                       | 90 days after removal               | `removedDays`      |
| Confirmed, on a closed list   | 12 months after the list closed     | `closedListMonths` |
| Unconfirmed                   | 30 days (t-977)                     | —                  |
| Joined (linked to an account) | with the account, never by this job | —                  |

A list "closed" is its `WaitlistListState` row with `open: false`; its
`changedAt` dates the window, and closing a closed list again does not move
it. Deleting a removed entry ends its "stays removed" protection, which is
safe because a new entry for the address must be confirmed by its owner.
These deletions are retention, not erasure requests, and write no receipt.
Rows on a list the config no longer declares are not shown on the admin page
and are not deleted by this job — remove the list from the config only once
it is empty. `npm run smoke:waitlist-admin` holds the windows against a real
database.

## Testing

The config seam is pinned to `null` for every test file (`tests/setup.ts`). A
test that needs a waitlist `vi.doMock`s `@/lib/app/waitlist-config`, calls
`__resetWaitlistConfigForTests()`, and restores the pin with another
`vi.doMock` — never `vi.doUnmock`. See
`tests/unit/app/api/v1/waitlist/route.test.ts`.
