# Waitlist

> **In progress (§125).** Joining (t-974), confirming the address and the
> leave link (t-977) are built. The admin page (t-976), invites and linking
> the new account (t-978) are not yet, so there is no way to read the list
> except the database, and no way to invite anyone from it.

A pre-launch waitlist a fork switches on: Sunrise owns the table, the routes,
the privacy wiring and (soon) the admin page and invites; the fork owns its
fields, copy and look. The binding design is the
[Sunrise Waitlist spec](https://claude.ai/artifact/NVEu3CqpBAXskCoBQnBExN).

## Switching it on

Two switches, answering different questions:

| Question                | Who changes it               | Where it lives                                                    |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Does the app have one?  | The fork's developers        | `lib/app/waitlist-config.ts` — `null` (shipped) means no waitlist |
| Is a list taking joins? | The admin running the launch | A `WaitlistListState` row per org and list (admin page: t-976)    |

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
  retention: { unconfirmedDays: 30 }, // the default; your privacy notice says the same
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

| Route                           | Who                  | What                                                                   |
| ------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `GET /api/v1/waitlist`          | Anyone               | `{ lists: [{ key, open }], fields }` — the form's fields, serialisable |
| `POST /api/v1/waitlist`         | Anyone               | Join. 5 an hour per IP (`waitlistLimiter`, `RATE_LIMIT_WAITLIST`)      |
| `POST /api/v1/waitlist/confirm` | Anyone with the link | `{ entry, token }`: confirm the address. Single use, 7 days            |
| `POST /api/v1/waitlist/leave`   | Anyone with the link | `{ token }`: erase the entry, with a receipt                           |

The join routes and confirm answer 404 without a config. **Leave never
does**: no switch may stop someone leaving, so a fork that drops its config
still lets the links in people's inboxes take them off. The join body:
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

## Confirming the address, and leaving

Anyone can type anyone's address into the form, so every entry starts
unconfirmed, and the join sends a link that proves the address is the
person's own.

- **The join sends one email, after the response** (`after()`, through
  `keepRunningAfterResponse`), so the answer and its timing are the same for a
  member and a stranger. A new or still-unconfirmed entry gets the
  confirmation link; a confirmed address submitted again gets the "already on
  the list" note, with no link. A removed address, a honeypot hit and a closed
  list get nothing.
- **At most one email an hour per entry**, both kinds together, claimed with
  a conditional write on `lastEmailedAt`. The form cannot be used to flood an
  inbox from your sender.
- **A name is put in an email only if it looks like a first name**
  (`firstNameOf()`, `lib/waitlist/mail.ts`): a letter, then letters,
  apostrophes or hyphens, up to 40. Anything else gets "Hello,". A URL typed as
  a name would otherwise arrive as a link from your real sender. Overrides get
  the filtered `firstName`, never the raw text.
- **The confirm link** is `/waitlist/confirm?entry=…&token=…`: 32 random bytes,
  only their hash stored in `Verification` under `waitlist-confirm:<entryId>`
  (no address), seven days, single use. A re-send replaces it. The page shows
  a button; **opening the link alone confirms nothing**, because mail scanners
  open links before people do. An expired, used, unknown or malformed link
  gets one answer: `400 INVALID_TOKEN`.
- **The leave link** is `/waitlist/leave?token=…`, HMAC-signed rather than
  stored, with no expiry: it works for as long as the entry exists. The press
  erases the entry and writes a waitlist-only receipt (`self_service`). A
  second press answers "you're off the list" again. An entry whose org is
  suspended answers `503`, because it is still there.
- **Closing a list stops joins only.** Confirming and leaving still work.
- **Unconfirmed entries are deleted after `retention.unconfirmedDays`**
  (default 30) by the `waitlistRetention` maintenance job, once per org. An
  entry linked to an account is left for the account's erasure.

The two emails are registry kinds, `waitlistConfirm` and
`waitlistAlreadyOnList` (`lib/email/registry.ts`). Override them in
`lib/app/emails.ts` like any other; keep the leave link in both.

Both links name an entry, not a person, so their routes read the entry's org
under `runAsCredentialLookup` and enter it as `waitlist-link`
(`lib/waitlist/entry-org.ts`), as the approval-token routes do.

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
  `eraseWaitlistEntry()` (`lib/waitlist/erase.ts`): it deletes the entry and
  its outstanding confirmation token, and writes a `waitlist` erasure
  receipt. The leave link calls it; the admin page (t-976) will. See
  [Waitlist-only receipts](../privacy/data-erasure.md#waitlist-only-receipts).
- **`userId` cascades** with the account: an entry is personal data.
- **Org export** includes both tables.
- **Your privacy notice** must cover what the form collects, that an
  unconfirmed entry is deleted after `retention.unconfirmedDays`, that answers
  are kept while the list is open, and the version you put in
  `consentVersion`.

## Testing

The config seam is pinned to `null` for every test file (`tests/setup.ts`). A
test that needs a waitlist `vi.doMock`s `@/lib/app/waitlist-config`, calls
`__resetWaitlistConfigForTests()`, and restores the pin with another
`vi.doMock` — never `vi.doUnmock`. See
`tests/unit/app/api/v1/waitlist/route.test.ts`.
