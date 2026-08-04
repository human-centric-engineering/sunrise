# Changelog

All notable changes to Sunrise will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) — see
[`VERSIONING.md`](./VERSIONING.md) for the public-surface contract and the
release process.

> **Status: `0.x` alpha.** The strict SemVer contract activates at `1.0.0`.
> During `0.x`, forks should expect real merge work between any two releases.
> See [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design)
> for what the version commits to (and does not) at this stage.

---

## [Unreleased]

## [0.8.0] — 2026-08-04

> **Alpha release.** Tenth tagged Sunrise release. **MINOR bump** — a large
> batch: an issue burn-down and a security sweep on top of new fork-facing
> surface.
>
> **Security.** An email change now requires approval at the **old** address,
> the current password, and revokes the account's other sessions (#489) —
> _breaking for API callers_, since `PATCH /api/v1/users/me` no longer moves the
> address in-request. Chat dispatch refuses tool names outside the agent's
> advertised set (#476); `sanitizeUrl()` closes a control-character scheme
> bypass (#437); JSON API responses carry `Cache-Control: private, no-cache`
> (#487); and schedule- and inbound-triggered runs are written system-owned, so
> erasing the operator who configured a trigger no longer destroys third
> parties' inbound conversations (#502 — **ships migration
> `20260801090000_system_owned_inbound_runs`**, which backfills inbound history).
> That is one of **two migrations** in this release; the other,
> `20260730140000_add_message_role_createdAt_index`, is the index the embedding
> backfill's anti-join needed (#442).
>
> **Added.** The subject-access (GDPR Art. 15) export seam, matching erasure
> (#467); `SIGNUP_MODE` to run a fork invite-only (#463); the authenticated-nav
> and post-authentication landing seams (#473); private objects end-to-end in
> storage, with a signed read route and a private root on the local provider
> (#490); fork-owned seams at user creation (#464), for recurring app work
> (#469), and for third-party frame hosts (#450); agent-opened chat turns and
> caller message metadata (#474, #475); `apiClient.put()` (#495);
> `validatePathParam()` (#435); `slugify()` (#451); and a configurable
> dev-server port.
>
> **Changed.** `HookEventType` and the email-kind registry open to fork-owned
> values (#465, #468) — the first is _breaking_ for an exhaustive `switch` with
> an `assertNever` default, deliberately. `prisma/schema/app.prisma` is now
> genuinely fork-reserved and ships empty, its three platform models moved to
> `platform.prisma` with no migration and no client change (#429). An idle
> maintenance tick now does zero database work (#442).

### Security

- **Changing an account's email now requires approval at the old address, the
  current password, and revokes other sessions.** ([#489]) `PATCH
  /api/v1/users/me` wrote the new address straight in and mailed verification to
  it, with no re-authentication and no signal to the address being replaced — so
  a single compromised session converted into permanent account takeover: the
  address moved, the link went to the attacker, and `autoSignInAfterVerification`
  minted them an independent session. A session expires; control of the address
  does not.

  The endpoint now delegates to better-auth's `changeEmail` with
  `sendChangeEmailConfirmation`, which writes nothing until the address
  **currently** on the account approves — so a stolen session can request a
  change but not finish one. On top of that, `currentPassword` is required
  (OAuth-only accounts are exempt, having none), and the user's other sessions
  are revoked when the change lands.

  **Breaking for API callers:** an email change no longer takes effect in the
  request. A success response carries the *old* `email` plus
  `emailChangeRequested: true`, and the address moves only after approval at the
  old address and verification at the new one. Sending `email` without
  `currentPassword` is now a 400 on password accounts.

  New public surface: `changeEmailApproval` in the email registry (overridable
  in `lib/app/emails.ts`), `revokeUserSessions` (`lib/auth/sessions.ts`), and
  `parseEmailChangeToken` (`lib/auth/change-email.ts`) — the last is required
  reading before touching `sendVerificationEmail` or `afterEmailVerification`,
  since better-auth routes email changes through both with no discriminator of
  its own.

- **The chat handler now refuses tool names outside the agent's advertised
  set.** Dispatch previously took the tool name straight off the model's emitted
  call, while the dispatcher synthesizes a default-ALLOW binding when no
  `AiAgentCapability` row exists — so a capability an agent was never granted
  would execute, unrestricted. Reachable via prompt injection, or via a
  conversation resumed across a capability being revoked (the model's own
  earlier calls sit in history and invite imitation). ([#476])

- **`sanitizeUrl()` no longer passes control-character-obfuscated schemes.**
  `java<TAB>script:`, `java<LF>script:`, `javascript<TAB>:` and a leading C0
  control all bypassed the check, because it ran on `trim()` (leading/trailing
  whitespace only) while browsers strip tab/newline/CR from anywhere in a URL
  before parsing the scheme. The replacement character class also covers the
  non-ASCII whitespace `trim()` used to remove (NBSP, BOM, U+2028, the U+2000
  block, ideographic space), so the guard is nowhere narrower than the one it
  replaced — those are not browser-executable, but leaving them out would have
  been a silent narrowing. Only the inspected copy is normalised — the URL
  returned to callers is unchanged. ([#437])

- **`PATCH /api/v1/users/me` clears `emailVerified` when the address changes**
  and re-sends verification. Previously an account that verified one address
  could become a *verified* holder of any unregistered address in one request,
  turning `user.email` from "an address this person controls" into "any unused
  string they typed" — a privilege-escalation primitive for invitation
  redemption and domain allowlists keyed on the address. ([#466])

- **An API key can no longer change the account's email address** (#466,
  found reviewing that fix). `withAuth` accepts an API key of **any** scope, and
  keys are self-service — so a `chat`-scoped key handed to a third-party
  integration could have moved the account to an attacker's address, and the new
  verification mail would have delivered them a working token. With
  `autoSignInAfterVerification` enabled that token mints a real session, turning
  a read-ish scope into full account takeover. `PATCH /api/v1/users/me` now
  returns 403 on the email path for key-authenticated callers, via the new
  `isApiKeySession()` in `lib/auth/api-keys.ts`. Non-identity profile fields are
  unaffected. Re-authentication, old-address notification and session revocation
  remain open — tracked in #489.

- **JSON API responses now carry `Cache-Control: private, no-cache`** (#487).
  Nothing set a cache directive, and a response with a validator (an `ETag`,
  which several routes send) but no freshness information is *heuristically
  cacheable* — RFC 9111 §4.2.2 lets a shared cache store it and invent an expiry.
  Applied in `successResponse`/`errorResponse` and the 304 from
  `checkConditional`, so the 200 and 304 on an endpoint agree. Deliberately
  `no-cache` rather than `no-store`, which would forbid the client copy and
  defeat the conditional-GET path the ETags exist for. It is a default, spread
  before caller headers, so a route serving genuinely public data can override
  it; routes returning a raw `Response` never pass through here.

- **Schedule- and inbound-triggered runs are no longer attributed to the
  operator who configured them.** ([#502]) The inbound route stamped
  `trigger.createdBy`, and the scheduler `schedule.createdBy`, onto the
  conversation and execution rows they created. The data on those rows belongs
  to whoever sent the message — `inputData.trigger` is the adapter payload
  written verbatim (sender phone number, email From/Subject/body, base64
  attachments), and the conversation carries `fromAddress` and the full thread.

  Both `userId` columns are `onDelete: Cascade`, so **erasing one operator
  destroyed every third party's inbound conversation and run routed through any
  trigger they had configured** — `eraseUser()` reported success and the
  correspondence was gone. The same rows matched that operator on `userId`, so
  a subject-access export would have disclosed a stranger's phone number and
  email bodies to them as their own data.

  Those rows are now written system-owned (`userId = null`), which is what
  `.context/privacy/data-erasure.md` always described and what the engine was
  already built for. Migration `20260801090000_system_owned_inbound_runs`
  backfills inbound history; historical *scheduled* runs keep their author,
  because the scheduler set no `triggerSource` before this release and they
  cannot be distinguished from runs an admin started by hand.

  Three behaviour changes follow. New public surface:
  `lib/orchestration/access/execution-access.ts`
  (`adminCanViewExecution`, `executionAccessBasis`, `executionVisibilityWhere`).

  - **Admin visibility.** All 15 execution routes (including the sidebar
    counts and the live-engine dashboard, the latter via
    `getLiveEngineSnapshot`) and the conversation list, detail and search now
    admit rows nobody owns — otherwise every scheduled and inbound run would
    vanish from the UI and a run paused at an approval gate could never be
    cleared. The same widening covers three surfaces that reach execution and
    conversation rows by other routes: the resume path on `POST
    /workflows/:id/execute?resumeFromExecutionId=` (without it an approved
    system-owned run could not be continued and sat in `pending`),
    `GET /observability/dashboard-stats` (which otherwise reported a healthy
    deployment while the live-engine dashboard showed the same runs failing),
    and `POST /evaluations/datasets/:id/capture` (which otherwise 404'd on
    every attempt to capture a scheduled run's output into a dataset).
    `AccessBasis` in `conversation-access.ts` gains a third member, `'system'`,
    which is audit-logged like `'shared'`. Conversation PATCH/DELETE accept
    `'owner'` and `'system'` (still never `'shared'`), so an inbound thread can
    be deleted when the person who sent the messages asks — they have no
    account, so `eraseUser()` cannot reach them. Both mutations write an audit
    row: PATCH logs `conversation.updated` with `metadata.fields` naming what
    changed (not the values, so a renamed `title` doesn't put message content
    in the log).
  - **A resumed run keeps the user context it was created with**, alongside its
    already-pinned `versionId` and persisted `scope` — the execute route passes
    the execution row's `userId`, not the resuming admin's. Otherwise a
    system-owned run's second half would gain a user context its first half
    never had, and `judge_call` would file a stranger's transcript into the
    approving admin's history. For an owner-resume the two are the same value.
  - **`judge_call` cannot run on a scheduled or inbound workflow.** It drives
    `streamChat`, which files the judge transcript into a real account's chat
    history; borrowing the schedule's author would re-create the
    mis-attribution. The step throws `judge_call_requires_user_context`.
  - **Rerun inherits the original's attribution** rather than claiming the run
    for the admin who pressed the button, since `inputData` is copied verbatim.

  `AiWorkflowExecution.triggerSource` is now written as `'schedule'` by the
  scheduler — the value the schema documented and the scheduler never set — so
  a run with no owner still has provenance.

### Added

- **`PORT` and `EMAIL_PORT` are now read from the project's env files, so an app
  can declare the port it binds** — Next's CLI binds `--port` to `PORT` at
  argument-parse time, which happens before it loads any `.env` file. A `PORT=`
  line in `.env.local` was therefore visible to the app and invisible to the
  server hosting it, leaving `-p` on the command line as the only way to move a
  dev server. For anyone running several Sunrise-derived apps side by side —
  reverse-proxying `*.test` hostnames to loopback ports, say — that meant
  remembering which app owned which port, every time.

  `npm run dev`, `npm run start` and `npm run email:dev` now go through
  `scripts/dev-server.mjs`, which reads *only* the port variable out of the env
  files, in Next's own precedence order, and passes it to the child process.
  Resolution runs explicit `-p` flag → real environment variable →
  `.env.<NODE_ENV>.local` → `.env.local` → `.env.<NODE_ENV>` → `.env` → `3000`,
  so every existing way of setting the port keeps working and keeps outranking
  the files. Nothing else about env loading changes, and the port stays
  independent of `NEXT_PUBLIC_APP_URL` / `BETTER_AUTH_URL` — bind loopback,
  advertise the proxied hostname.

  `EMAIL_PORT` does the same for the React Email preview server, which also
  defaults to 3000 and would otherwise collide with an app; it has no env
  binding of its own, so the launcher passes `-p`.

  The launcher is plain `.mjs` with no runtime dependency: `npm start` must
  survive a production install (`npm ci --omit=dev`), which prunes both tsx and
  dotenv. Without dotenv it still starts the server and says it could not read
  the files. Deployed containers are untouched — the Docker image runs the
  standalone server, which reads `process.env.PORT` directly.

  **For forks:** Sunrise now ships a committed `.env.development` setting
  `PORT=3010` — the one env file `.gitignore` deliberately permits, for
  non-secret settings that should travel with the repo. `npm run dev` needs no
  arguments in any clone. **Change the value in your fork:** two Sunrise-derived
  apps that both keep 3010 collide the moment they run together. See
  [`CUSTOMIZATION.md`](./CUSTOMIZATION.md#claiming-your-own-dev-port).

  Deployment is untouched. The production image copies only the standalone
  build, so neither `.env.development` nor `scripts/` reaches it; `ENV PORT=3000`
  is a real environment variable, which outranks any file; Vercel runs
  `next build` and never `npm start`; and `npm start` resolves against
  `.env.production*` / `.env`, never `.env.development`.

- **Server components now call their own API at an address the server can
  actually reach** — `getBaseUrl()` returned `BETTER_AUTH_URL`, so a server
  component rendering a page went *out* to the public hostname and back in.
  Point that hostname at a local reverse proxy terminating TLS with a
  certificate Node does not trust (Herd, Valet, mkcert) and every self-call
  fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` — while the browser works
  perfectly, because it trusts the same CA the server doesn't. Pages that catch
  fetch errors then render empty: an admin user list reporting "No users found"
  against a populated database.

  `getBaseUrl()` (`lib/api/server-fetch.ts`) now resolves
  `INTERNAL_API_URL` → `http://127.0.0.1:$PORT` in development when the port is
  known → `BETTER_AUTH_URL`. Production behaviour is unchanged unless
  `INTERNAL_API_URL` is set explicitly, which is there for the same split in
  other environments — a private network where the public hostname resolves
  elsewhere. Beyond correctness, a self-call over loopback skips a round trip
  through the proxy.

  `INTERNAL_API_URL` is validated as a URL in `lib/env.ts`. It must be **this**
  app's own address; anything else would receive cookie-bearing internal
  requests.

  **New `getPublicUrl()`, and a rule for choosing between the two.**
  `getBaseUrl()` had been doing two jobs: addressing the app's own API, and
  building URLs for *other* systems to call — the inbound-webhook endpoint an
  operator pastes into Slack (`app/admin/orchestration/triggers/**`). Those
  answers are no longer the same, so a loopback internal address would have been
  rendered as a webhook URL reachable from nowhere but the developer's machine.
  `getPublicUrl()` returns the public address for anything that leaves the
  server; `getBaseUrl()` stays internal-only. The two trigger pages now use it,
  restoring exactly their previous output.

- **Hot reload now works when the app is served on a hostname rather than
  `localhost`** — Next allows only `localhost` to reach its dev endpoints and
  blocks the rest, so an app behind a local reverse proxy rendered fine but
  never hot-reloaded, logging _"Blocked cross-origin request to Next.js dev
  resource"_. Rather than have every fork hardcode its own hostname,
  `next.config.js` now derives `allowedDevOrigins` from the hostnames already in
  `NEXT_PUBLIC_APP_URL` and `BETTER_AUTH_URL`. Setting those to the proxied
  hostname is enough; the config never needs editing.

  New optional `ALLOWED_DEV_ORIGINS` adds hosts those URLs don't cover (a LAN IP
  for device testing, or a `*.myapp.test` wildcard for subdomain-per-tenant
  development). It is distinct from `ALLOWED_ORIGINS` — that is API CORS in
  every environment, this is hot reload in `next dev`, and Next ignores it in
  production builds.

- **Subject access (GDPR Art. 15) now has a seam, matching erasure** (#467) —
  Sunrise implemented the *erasure* half of GDPR carefully — `eraseUser()`, a
  documented per-table `onDelete` policy, an append-only receipt, a registration
  seam for app-owned cleanup — and had nothing at all for the *access* half.
  Every fork holding personal data wrote it themselves, each one independently
  re-answering the same question: which tables count?

  `exportUserData()` (`lib/privacy/export-user.ts`) assembles one subject's
  record from `SUBJECT_DATA_SOURCES` (`lib/privacy/export-sources.ts`), a
  manifest where every `User`-linked model carries an explicit disposition:
  `export` for the subject's own data, `attribution` for org config they
  authored (id + label + date — `createdBy` is attribution, not ownership, the
  same reasoning erasure uses when it retains the row and nulls the link), or a
  documented exclusion with a written reason. The export's own `meta` echoes all
  three back with row counts, so a subject can see the boundary of what they
  received rather than infer it.

  **The coverage guard is the substance of the change.**
  `tests/unit/lib/privacy/export-sources.test.ts` parses `prisma/schema/*.prisma`
  and fails if a model relating to `User` is missing from the manifest — so
  adding a table without deciding what a data subject receives breaks the build.
  Erasure gets this free: a missing `onDelete` throws `P2003` and breaks loudly.
  Access has no natural loud failure — an export that omits a table looks
  exactly like a complete answer to the person reading it, and neither they nor
  the operator who sent it can tell. Two consequences follow: sources use
  Prisma's `omit` rather than `select`, so a column added tomorrow is exported
  by default instead of silently dropped (what's omitted is credential material
  only — session tokens, password hashes, OAuth tokens, key hashes, HMAC
  secrets); and nothing is best-effort, so a source that throws fails the whole
  export, the deliberate opposite of the erasure path where hook failures are
  swallowed so app trouble can never block a deletion.

  Two sources shipped narrowed, disclosing it via a `scopeNote` in `meta`:
  inbound conversations and inbound-triggered workflow runs were written
  against the operator who configured the channel, not the person who sent the
  message, so matching on `userId` alone would have disclosed a third party's
  phone number and correspondence to the wrong subject. **Both filters were
  removed later in this same release** once [#502] fixed the mis-attribution
  they contained; a source that narrows must still carry a `scopeNote`.

  A second guard,
  `npm run smoke:export`, runs in CI beside the erasure smoke and proves against
  real Postgres what a mocked suite cannot: that every manifest query executes, and
  that a planted session token, password hash, key hash and webhook secret
  appear nowhere in the serialised bundle.

  New public surface: `exportUserData()` and `SubjectNotFoundError`
  (`lib/privacy/export-user.ts`), the `SUBJECT_DATA_SOURCES` / `EXCLUDED_SOURCES`
  manifest (`lib/privacy/export-sources.ts`), the fork seam
  `collectAppSubjectData()` (`lib/app/data-export.ts` — a static function rather
  than a boot-time registry like `erasure-hooks.ts`, because an unregistered
  export collector yields a bundle that looks complete and is not), and two
  endpoints mirroring the erasure pair: `GET /api/v1/users/me/export` (refuses
  API-key sessions — a `chat`-scoped key must not read out an entire account)
  and `GET /api/v1/users/[id]/export` for admins answering a request that
  arrives by email. Both take the `exportLimiter` sub-cap and send
  `Cache-Control: no-store`. Documented in `.context/privacy/data-export.md`.

- **`SIGNUP_MODE`, the seam to run a fork invite-only** (#463) — Sunrise ships a
  complete invitation system whose premise is that access is *granted*, beside an
  email/password signup endpoint that was unconditionally open with no config to
  close it. A fork whose product is invite-gated could only edit a core auth file
  or leave the front door open, which is easy not to notice: the invite flow
  works, the product *looks* gated, and accounts accumulate. `SIGNUP_MODE=invite_only`
  closes `POST /api/auth/sign-up/email` (better-auth `hooks.before`), every other
  un-invited account creation (`userCreateBeforeHook`, default-deny and
  deliberately path-independent — a Google signup arrives via `/callback/:id` and
  an ID-token sign-in via `/sign-in/social`, so an endpoint allowlist leaks
  silently), and the `/signup` page (proxy redirect). Only account *creation* is refused; sign-in,
  password reset and invitation acceptance are unaffected. New
  `lib/auth/signup-mode.ts` exports `isInviteOnly()`, `isFirstHumanBootstrap()`
  and `runInvitedSignup()` — the last being how a server-side path that has
  already validated an invitation exempts itself, since better-auth routes
  `auth.api.*` through the same hook as HTTP requests. `open` remains the default.

- **`lib/app/protected-nav.ts`, the authenticated-nav seam** (#473) — the nav a
  fork's *users* see was a hardcoded array in
  `components/layouts/protected-nav.tsx`, while the nav its *visitors* see had
  had a seam since #347. Set `protectedNavItems` to a `ProtectedNavItem[]` (from
  the new `lib/protected-nav/types.ts`) and it replaces `DEFAULT_PROTECTED_NAV`
  wholesale; `null` keeps the default. Items gain `exact?` (matching the public
  nav) and an optional `icon`, and the platform keeps owning admin filtering and
  active-state, so `adminOnly` works on a fork's own items.

- **`lib/app/auth-landing.ts`, the post-authentication landing seam** (#473) —
  `/dashboard` was hardcoded at a dozen decision sites across twelve files, with
  no config or scaffold, so an app whose product lives elsewhere edited all of them
  and re-resolved them on every upgrade. `appAuthLandingRoute` /
  `appAuthLandingLabel` (both `null` = platform default) resolve once through the
  new `lib/auth-landing/route.ts` (`AUTH_LANDING_ROUTE`, `AUTH_LANDING_LABEL`),
  now consumed by login, OAuth, signup, invite acceptance, email verification,
  the protected layout's brand link, the admin header and sidebar, both error
  pages and `proxy.ts`. The label moves with the route, so the user-visible copy
  on those controls stops saying "Dashboard" once a fork has moved. A route that
  is not root-relative throws at module load rather than becoming an off-site
  redirect via `safeCallbackUrl()`'s unvalidated fallback.

- **`apiClient.put()`** (#495) — the client exposed `get`/`post`/`patch`/`delete`
  and no `put`, so a fork building a genuine whole-resource replacement (a
  sub-resource collection such as tags, members or assignees) had to choose
  between editing `lib/api/client.ts` — a merge conflict on every upgrade — and
  shipping `PATCH` for something that is really a `PUT`. Same signature and same
  `request()` plumbing as `patch`; no behaviour change for existing callers.

- **`StorageCapabilities` on the storage provider interface** (#490) —
  `getStorageCapabilities(provider)` in `lib/storage/providers/types.ts` resolves
  what a backend can actually do (`privateObjects`, `signedUrls`, `download`), so
  callers stop sniffing `provider.name` to find out. The field on `StorageProvider`
  is an optional `Partial<StorageCapabilities>` and an undeclared capability reads
  as **false**: a fork's custom provider keeps compiling across an upgrade and is
  never assumed capable of something it does not implement. Read it through the
  helper, never off the provider directly.

- **`download(key)` on `StorageProvider`** (#490) — an optional, `Buffer`-based
  read path returning the new `StorageObject`. Implemented by S3 and local;
  Vercel Blob declares it unsupported. The interface could previously write and
  delete an object but never read one back, which is what forced a fork keeping
  a user's uploaded file to discard the original bytes after parsing.

- **`GET /api/v1/storage/<key>?token=…`, the signed object read route** (#490) —
  serves a privately stored object, with stateless HMAC tokens from the new
  `lib/storage/access-tokens.ts` (`generateStorageAccessToken`,
  `verifyStorageAccessToken`, `buildStorageAccessUrl`; no table, no migration).
  `LocalProvider.getSignedUrl()` mints them, which is what completes the local
  provider's private-object story. **The token is the only credential and
  grants exactly one key — there is deliberately no session fallback**, because
  storage keys encode no ownership and a bare `withAuth()` would let any
  authenticated user read any private object. Rotating `BETTER_AUTH_SECRET`
  invalidates every outstanding URL. Responses are always
  `application/octet-stream` + `Content-Disposition: attachment`, so
  user-uploaded HTML or SVG can't execute on the app's origin.

- **A private root for the local provider** (#490) — `LocalProviderConfig.privateDir`
  (default `.storage/private`, gitignored) holds anything uploaded with
  `public: false`, outside the tree Next serves. `createLocalProvider()` now
  takes a config argument and `createLocalProviderFromEnv()` reads
  `STORAGE_LOCAL_BASE_DIR` / `STORAGE_LOCAL_BASE_URL` / `STORAGE_LOCAL_PRIVATE_DIR`
  — the zero-argument factory meant `client.ts` could never configure the
  provider at all.

- **`S3_OBJECTS_PRIVATE_BY_DEFAULT`** (#490) — declares that the bucket blocks
  public access, so every object is already private without ACLs. This is the
  AWS-recommended posture and is invisible at the SDK level; setting it is what
  lets `S3Provider` claim `privateObjects` while leaving `S3_USE_ACL=false`.

- **`assertStoredVectorDimensions(subject)`** in
  `lib/orchestration/knowledge/embedding-dimensions.ts` — the stored-vector
  dimension guard, no longer hard-wired to `aiKnowledgeChunk` (#491). `pgvector`
  fixes dimension at the column level, so changing the active embedding model
  without re-embedding breaks every query against a vector table with a cast
  error, after paying for the embedding round trip. The knowledge corpus was
  guarded; a fork adding its own `vector(...)` table — the documented path,
  since the platform KB is a global asset and per-user scoping there is an
  anti-pattern — inherited the failure with none of the protection, and could
  only get it by copying ~40 lines that would then never learn what the original
  learns. The subject is two closures (`groupByDimension`, `exemplarModel`) plus
  a `label` and a `remediation` string, so it carries no Prisma-delegate typing
  and works for a table that is not a Prisma model at all. `search.ts` now binds
  to it; behaviour and error text are unchanged.

- **`capability.refused_not_advertised` hook event, and `warning` SSE frames on
  a refused tool call** (#488). The handler already refused a tool name outside
  the set advertised to the model for that turn, but said nothing: on the
  single-call path no frame was emitted at all, so the turn carried on and the
  UI showed an answer produced without the data the model asked for, with
  nothing anywhere explaining why. Both refusal paths now yield
  `{ type: 'warning', code }` — `tool_not_advertised` or `tool_unavailable` (the
  repeated-failure breaker) — and the not-advertised case additionally emits the
  new hook event, payload `{ conversationId, agentId, agentSlug, userId,
  toolName, advertised }`. Only the not-advertised case is audited: a name
  outside the advertised set is a hallucination or an injected tool call, which
  is a security signal, whereas the breaker is operational and already logged.
  `advertised` carries the tool set the model actually had, so a reviewer can
  see what it invented the name from.

- **`generatedColumnExists(table, column)`** in `lib/db/drift-probes.ts` — a
  drift probe for a column that must be `GENERATED ALWAYS AS (...) STORED`
  (#481). `columnExists` only asks whether a column of that name is present, so
  a migration that dropped the column and recreated it as a plain one of the
  same type passes the check while the column is never populated again. Probe A1
  (`ai_knowledge_chunk.searchVector`) now uses it. That column backs the BM25
  half of hybrid knowledge search, and the half-missing failure is worse than a
  dropped index: a missing index means slow-but-correct, whereas a column that
  stopped being generated means every row written after the migration holds
  NULL — so search silently returns nothing for new content while old content
  still matches, which reads as an ingestion bug. Forks probing their own
  generated columns should prefer it over `columnExists`.

- **`ChatRequest.openingTurn` — a turn the agent opens** (#474). `streamChat`
  required a non-empty `message` and persisted it as a `role:'user'` row before
  calling the model. Right for a support chatbot; wrong for a facilitated product
  whose method is to orient the person first — the app had to send a stage
  direction *as the user*, leaving text in someone's own transcript that they did
  not write, in the model's history for the rest of the conversation, and
  filterable only by exact string match against a list of every trigger string
  ever shipped. With `openingTurn` set, `message` may be omitted: no user row is
  persisted, no `message.created` fires for a user role, and the content reaches
  the model as a `system` message. `message` wins if both are supplied. A turn
  with no `message`, no `openingTurn` and no attachments is rejected — `message`
  becoming optional made the empty turn expressible, so it is now refused
  explicitly. Attachments count as a turn: the embed surface allows an empty
  `message` when files are attached (a photo with no caption), so gating on
  empty text alone would have rejected vision turns its own route already
  accepted.
  `ChatEvent` `start.messageId` is consequently optional; the shared validator in
  `chat-events.ts` already had it optional, so the TS type was stricter than the
  wire contract, and no bundled consumer reads it off `start`.

- **`ChatRequest.messageMetadata` — caller metadata on the message row** (#475).
  `costLogMetadata` lands on `AiCostLog`; there was nothing for the message
  itself, so an app that caused a turn for its own reasons had nowhere to record
  that fact except inside the message text or an `UPDATE` against a core-owned
  table. Stored verbatim under `MessageMetadata.app`, namespaced so it can never
  collide with a platform field including one a future release adds. The handler
  never inspects it. Together with #474 this replaces sentinel-string detection
  with a structural tag.

- **`lib/app/user-created.ts` — a fork-owned seam at user creation** (#464). A
  fork that needed to react to a new account (provision a profile row, seed a
  workspace, start onboarding, push to a CRM) had to add code to
  `userCreateAfterHook` in `lib/auth/config.ts` — a security-sensitive platform
  file, and a merge conflict on every upstream sync. Register hooks with
  `registerUserCreatedHook(key, hook)`; each receives
  `{ userId, email, name, signupMethod, viaInvitation }`, so it can tell an OAuth
  account (address already verified) from an email/password one. Dispatched last
  in the after-hook, so a hook sees the account fully initialised. A hook
  **cannot reject a signup** — it runs after the row exists, and a throw is
  logged and swallowed rather than reporting a completed signup as an error. To
  gate signup itself, see #463. Empty registry = today's behaviour.

- **`lib/app/jobs.ts` — a fork-owned seam for recurring app work** (#469). The
  scheduler ran workflow schedules only, so an app's own periodic job needed
  either a second cron process and deployment target or an edit to `run-tick.ts`.
  Register with `registerAppJob({ name, intervalMs, run })` and the existing
  maintenance tick runs it when due; the return value is folded into the tick's
  completion log line. Two honest limits, documented on the seam: `intervalMs` is
  a **minimum** gap bounded below by the tick interval (60s), and last-run times
  live in process memory — so a multi-instance deployment runs each job about
  once per instance per interval, and a restart re-arms everything. Write jobs to
  be idempotent; a job needing exactly-once cluster-wide semantics needs its own
  lease. A job still running is never started again (per-job in-flight guard), a
  non-positive `intervalMs` is refused at registration rather than silently
  meaning "every tick", and a rejecting job is contained. Empty registry =
  today's behaviour, byte-for-byte.

- **`NavSection.titleNode` — a fork's own brand lockup in an admin nav section
  header** (#448). Optional `ReactNode` on `registerNavSection({ … })`; when set,
  the sidebar renders it in place of the default uppercase `title` label and
  drops the uppercase treatment. `title` stays required — it remains the React
  key, the registry's dedupe key, and the heading's `aria-label`, so a wordmark
  image cannot degrade the accessible name. Converts a two-file platform edit
  (`lib/admin-nav/registry.ts` + `components/admin/admin-sidebar.tsx`) that
  conflicted on every upstream sync into a supported extension point.

- **`lib/app/csp.ts` — a fork-owned seam for third-party iframe hosts** (#450).
  `frame-src` was hardcoded to `'self'` in both policies, so a fork embedding a
  YouTube or Vimeo player had to edit `lib/security/headers.ts` — a
  security-sensitive platform file, and a recurring merge conflict. Export
  origins from `appFrameSrc` and `getCSPConfig()` folds them into the global CSP.
  Only exact `https://` origins are accepted (left-most wildcard and port
  allowed); anything else is dropped and logged at warn at module load, since
  these values are spliced into a response header. Empty in vanilla Sunrise —
  locked by `tests/unit/lib/app/defaults.test.ts`. See
  [`.context/security/overview.md`](./.context/security/overview.md#third-party-iframes--the-frame-src-seam).

- **`ProcessImageOptions.fit` — an aspect-preserving mode for logos and
  banners** (#447). `processImage()` hardcoded a centre-cropped square, which is
  right for avatars (what it was built for) and wrong for every non-square
  upload. `fit: 'inside'` treats `maxWidth` × `maxHeight` as a real bounding box
  and preserves aspect ratio; `fit: 'cover'` (the default) keeps today's
  behaviour exactly, so no existing caller changes. Both modes remain
  shrink-only. See [`.context/storage/overview.md`](./.context/storage/overview.md).

- **`<RouteErrorBoundary>` — one shared body for every route group's
  `error.tsx`** (#434). New `components/errors/route-error-boundary.tsx` holds
  the logging, Sentry reporting, optional session-expiry detection and recovery
  card that the four `app/**/error.tsx` files each carried a near-identical copy
  of; those files are now thin wrappers. A fork adding a route group writes a
  ~10-line wrapper with its own `boundaryName`, `tag` and `fallback` instead of
  a fifth copy. `fallback.navigate: 'reload'` opts into a full document load for
  boundaries where the shell itself may be broken. `app/global-error.tsx` is
  unchanged — it replaces the root layout and renders its own `<html>`/`<body>`.
  See [`.context/ui/components.md`](./.context/ui/components.md).

- **`slugify(value)`** in `lib/utils.ts` — filename/URL-safe slug. Returns the
  bare slug including the empty string (callers apply their own fallback, e.g.
  `slugify(title) || 'report'`); pure and client-safe, so the same helper works
  in a download button and in a server-side filename. ([#451])

- **`validatePathParam(raw, schema, options?)`** in `lib/api/validation.ts` —
  completes the validation family alongside `validateRequestBody` and
  `validateQueryParams`. Throws the same `ValidationError` that `handleAPIError`
  maps to a 400. Sixteen `[id]` routes drop their hand-rolled copies. ([#435])

- **`CAPABILITY_BINDING_MODE`** env var (`permissive` | `strict`, default
  `permissive` — unchanged behaviour). `strict` makes a missing
  `AiAgentCapability` row DENY instead of synthesizing a default-allow binding.
  Opt-in because it retroactively revokes capabilities agents relied on
  implicitly, including `mcp-system`. ([#476])

- **`DATABASE_POOL_MAX`** — optional cap on pg connections per process, default
  `10` (unchanged behaviour). Serverless deploys set `1` behind a transaction
  pooler; every warm instance holds its own pool, so the default exhausts a
  small Postgres under load. The pool also sets 10s idle and connection
  timeouts, so exhaustion now fails fast instead of hanging until the platform
  kills the request. ([#445])

- **Workflow schedules show their last run time**, alongside the existing next
  run. `AiWorkflowSchedule.lastRunAt` was already on the wire.

[#436]: https://github.com/human-centric-engineering/sunrise/issues/436
[#456]: https://github.com/human-centric-engineering/sunrise/issues/456
[#461]: https://github.com/human-centric-engineering/sunrise/issues/461

- **`framework:*` is now a reserved script namespace, and CI runs
  `framework:ci-checks`** (#483). CUSTOMIZATION.md §7 reserved `app:*` for the
  leaf-fork tier but left a framework-tier fork (one sitting between Sunrise and
  its own forks) with nowhere to put a script — while `scripts/smoke/README.md`
  actively told it to add to Sunrise-owned `smoke:*`. Both are corrected, and
  `scripts/app/` + `scripts/framework/` are now documented as tier-owned
  directories. The `lint` job calls `framework:ci-checks --if-present`, mirroring
  the existing `app:ci-checks` seam, so the reservation is real rather than a
  promise.

### Changed

- **`upload_to_storage` refuses a private-upload binding the provider cannot
  honour** (#490). A binding with `public: false` or `signedUrlTtlSeconds` now
  fails with `private_objects_not_supported` — before any upload — when the
  configured provider does not declare `privateObjects`. **This is a runtime
  break worth planning for:** an agent binding with `signedUrlTtlSeconds` on S3
  with ACLs off previously uploaded a *public* object and returned a signed URL
  to it, which looked like it worked. Set `S3_OBJECTS_PRIVATE_BY_DEFAULT=true`
  (or `S3_USE_ACL=true`) to restore it. `VercelBlobProvider.upload()` likewise
  throws on `public: false` rather than storing the file publicly — that
  provider has no private storage under any configuration.

- **`getOrchestrationSettings()` reads before it writes, and caches for 30s**
  (#442). It was an unconditional `upsert` — a write, taking a row lock, on every
  call, including several per maintenance tick — for a row that is created once
  in the lifetime of an install. It now does a `findUnique` and only upserts when
  the row is absent (still an upsert there, so two instances booting at once
  can't race the unique constraint on `slug`), behind a 30s TTL cache modelled on
  `settings-resolver.ts`. The new `invalidateOrchestrationSettingsCache()` is
  called from the settings PATCH route, so a save is visible immediately.

- **`useHealthCheck` pauses polling while the tab is hidden** (#442). It ran two
  bare `setInterval`s, so a forgotten admin tab issued `GET /api/health` — and
  therefore `SELECT 1` — every 30 seconds indefinitely, enough on its own to keep
  a scale-to-zero database awake. It now runs on `useAutoRefresh`, which already
  pauses on `document.hidden` and handles being hidden at mount. **Two semantic
  shifts for callers:** `isPolling` now means "polling is enabled" rather than "a
  timer is armed", so it stays `true` across a visibility pause; and
  `startPolling()` refreshes immediately instead of waiting out an interval.
  `autoStart: false` still fetches once on mount.

- **Deployment guidance for scale-to-zero databases** (#442).
  `scheduling.md` prescribed `* * * * *` with no note about what that costs on a
  Postgres that autosuspends when idle — a fork following the documented path
  inherited a database that was never allowed to sleep, and a bill to match. The
  recommended cadence is unchanged (the idle gate makes those ticks free), but
  the trade is now stated, with a `*/5` recipe for cutting serverless
  invocations and the price named plainly: a workflow schedule can only be as
  punctual as the cron that drives it. `resilience.md` also now records that
  `tickRunning` is per-instance, so the overlap guarantee does not hold on
  serverless.

- **The maintenance tick can now skip entirely, doing zero database work**
  (#442). Per-task intervals cut how much a tick does; they cannot make it do
  nothing, and nothing is what a scale-to-zero Postgres (Neon, Aurora Serverless
  v2) needs before it will autosuspend — one query a minute defeats a 5-minute
  timer exactly as well as twenty do. A sweep that finds nothing now arms an
  **idle gate**, and subsequent ticks return `200 { skipped: true, reason:
  'idle', resumesAt }` before any Prisma call. Skipping is bounded three ways:
  the gate never skips past known future work (the next `nextRunAt`, via the new
  `getNextScheduleRunAt()`, and the shortest registered app-job interval, via the
  new `getAppJobsMinIntervalMs()`); it re-verifies against the database at least
  every `MAINTENANCE_IDLE_MAX_SKIP_MS` (**new env var**, default 30 min, `0`
  disables the gate); and request paths that create tick-owned work — a delivery
  retry, a created or edited schedule, a queued evaluation run, an execution
  enqueued by a webhook or inbound trigger — call the new `noteMaintenanceWork()`
  to disarm it immediately. It refuses to arm unless the sweep proved there was
  nothing to do: a task that found something, a task that failed, a fired
  schedule, an errored sweep, or a failed horizon probe all leave it disarmed.
  State is per-process, so a restart always sweeps and multi-instance forks
  should lower the cap. **New:** `POST …/maintenance/tick?force=1` sweeps
  regardless (it does not bypass the overlap guard), and the skip response now
  carries `reason` — previously the only skip was the overlap guard and the
  reason string was fixed.

- **Maintenance-tick background tasks now run on per-task minimum intervals**
  (#442). All eight ran on every tick, so at the documented 60s cadence the
  retention sweep — whose windows are measured in days — ran 1,440 times a day
  and the embedding backfill full-scanned the message table just as often. Each
  task now declares the shortest gap at which it can still find work:
  `webhookRetries`, `hookRetries` and `evaluationRuns` stay on every tick
  (sub-minute backoff, one time-slice per tick); `orphanSweep` and
  `pendingExecutionRecovery` 2 min; `zombieReaper` 5 min; `embeddingBackfill`
  15 min; `retention` 1 hour. The table lives in
  `lib/orchestration/maintenance/platform-jobs.ts` and
  `BACKGROUND_TASK_NAMES` is now derived from it, so the route's published
  `backgroundTasks` list cannot drift from what actually runs. **Two visible
  effects:** a task held back by its interval reports the string `'skipped'`
  under its own key in the `Maintenance tick background tasks completed` log
  line (rather than its usual result object), so a log-based dashboard reading
  e.g. `retention.deleted` will see `'skipped'` on most ticks; and a task still
  running from an earlier tick is no longer started a second time when the
  liveness watchdog releases the overlap guard. Intervals are start-to-start and
  held in process memory — persisting them would cost a database round-trip per
  task per tick, which is the cost this change exists to remove. Every throttled
  task is idempotent, so on a multi-instance deployment the failure mode is
  "runs more often than intended", never "misses work".

- **`runStructuredCompletion`'s non-persistence is now contractual** (#472). The
  module writes nothing — no database client imported, no row created, no prompt
  or completion logged — but that was only *incidentally* true. Its docstring
  promised layering neutrality ("no evaluation coupling, no Next.js imports"),
  which says nothing about writes, while a downstream fork's user-facing privacy
  claim (calendar-event titles categorised into aggregate buckets, only the
  totals stored) depended on the stronger property. Adding prompt logging for
  debugging or completion persistence for eval replay would have been consistent
  with everything the file said about itself and would have broken that claim
  without touching the fork's code. The guarantee is now stated explicitly and
  enforced by `structured-completion-no-persistence.test.ts`, which fails on a
  database/storage import or a `prisma.*` call. Cost metadata (token counts, USD)
  is still returned to callers and is outside the guarantee — aggregate counts
  carry no prompt content. Persisting here in future is a breaking change to a
  documented guarantee: opt-in flag defaulting to off, CHANGELOG entry, and a
  deliberate test update rather than a deletion.

- **BREAKING: `HookEventType` is open to fork-owned events** (#465).
  `HOOK_EVENT_TYPES` was a closed list, so a fork could neither emit its own
  domain event through the hook registry nor subscribe a webhook to one — it had
  to add entries to a platform array, conflicting on every sync and risking a
  collision with a name a future release takes. `HookEventType` is now
  `CoreHookEventType | \`app.${string}\` | \`framework.${string}\``, matching
  the reserved tiers in CUSTOMIZATION.md, and the admin hook routes accept the
  wider set so a fork can subscribe through the same API. **Forks:** an
  exhaustive `switch` over `HookEventType` with an `assertNever` default now
  fails to compile. That is the intended failure — a compile-time prompt to
  decide what your code does with an event it doesn't know, instead of a silent
  runtime fall-through. The core enum is kept as one arm of the Zod union rather
  than replaced with `z.string()`, because that schema also validates
  `AiEventHookDelivery.payload` read back from the database.
  A namespaced union rather than a registration seam, deliberately: these schemas
  are built at module load, before any `initApp()` runs, and #462 showed boot
  order across module realms isn't guaranteed under Turbopack.
  `WEBHOOK_EVENT_TYPES` stays **closed** and is now documented as such — a hook's
  only action type *is* a webhook, so the hook registry already gives a fork the
  whole path, and those values are rendered straight into `<select>` options and
  cross-referenced against `WIRED_WEBHOOK_EVENT_TYPES`, where a fork-namespaced
  value would have no label and no wired-ness answer.

- **A fork can now ADD an email kind, not just override one** (#468).
  `EmailPropsMap` is an `interface`, so declaration merging already worked in
  principle — but `defaultTemplates` was a total mapped type over `EmailKind`,
  which made every fork-added kind a compile error in a platform file the fork
  can't edit without a conflict. It is now `Partial`, and `resolveEmailTemplate`
  throws naming the kind when there is neither an override nor a default. Throwing
  rather than rendering `undefined` is deliberate: a blank email is far harder to
  diagnose than a failed send. The interface now documents the `declare module`
  recipe and recommends namespacing keys `app.` / `framework.`. No runtime change
  for the four platform kinds.

- **`prisma/schema/app.prisma` is now genuinely fork-reserved and ships empty**
  (#429). It shipped three platform models — `ContactSubmission`, `FeatureFlag`,
  `AuthBootstrap` — while the fork-facing docs described it as the place for a
  fork's own models, "clearly separate from the platform's". The three model
  definitions move verbatim into the existing `prisma/schema/platform.prisma`.
  Because the schema is multi-file, moving a model block between files changes
  no table and produces **no migration** — the models, their `@@map` names, and
  the generated client are unchanged. This makes the leaf tier symmetric with
  the framework tier's `prisma/schema/framework-*.prisma`. Forks that already
  added models to `app.prisma` need no action.

- **Error-boundary log message is now `'Route error boundary triggered'` for all
  four route groups** (#434), replacing the four per-group messages
  (`'Root error boundary triggered'`, `'Admin route error boundary triggered'`,
  …). The boundary is still identified by the structured `boundaryName` field,
  which is what log queries should key on. `app/global-error.tsx` keeps its own
  `'Global error boundary triggered'` message.

- **CI heap ceiling is now the `CI_NODE_HEAP_MB` repo variable** (default
  `5120`, unchanged). Forks whose lint job dies with exit 134 raise it in repo
  settings instead of editing `ci.yml`, so the fix survives an upstream sync.
  ([#452])

- **`tests/unit/lib/app/defaults.test.ts` is table-driven.** Filling a
  `lib/app/*` seam is expected to fail one row; pin the new value rather than
  deleting the row. Coverage also rose from 9 seams to 14. ([#480])

- **Vitest `testTimeout` raised to 30s** (from 10s) for forks with heavier
  component and integration tests. ([#454])

- **`streamChat` batches its three pre-token reads** (context, user memories,
  capability definitions) into one `Promise.all`, cutting the delay before the
  first token from three serial database round trips to one. No behavioural
  change. ([#449])

[#444]: https://github.com/human-centric-engineering/sunrise/issues/444
[#445]: https://github.com/human-centric-engineering/sunrise/issues/445
[#446]: https://github.com/human-centric-engineering/sunrise/issues/446
[#449]: https://github.com/human-centric-engineering/sunrise/issues/449

- **`CostSummaryModelRow` carries `provider`.** `GET /costs/summary`'s `byModel[]`
  rows are now `{ model, provider, monthSpend }`, grouped by both columns of
  `AiCostLog`. Consumers resolving a spend row to a catalogue entry must key on
  `provider::modelId` — `components/admin/orchestration/costs/model-index.ts`
  (`buildModelIndex` / `lookupModel`) is the shared helper. ([#436])

- **The Azure `gpt-4o` seed row ships inactive.** It shares a model id with the
  OpenAI row; an unconfigured example provider shouldn't compete for that id.
  Applied on create only, so a re-seed never deactivates a row an operator
  turned on. ([#436])

### Fixed

- **`upload(file, { public: false })` is no longer silently ignored** (#490). The
  option was accepted by every provider and honoured by roughly one: S3 dropped
  it unless `S3_USE_ACL=true`, Vercel Blob dropped it always, and the local
  provider wrote the file into `public/uploads/` where Next serves it statically
  to anyone who can guess the key. A fork storing a user's document rather than a
  public avatar got private storage, a public CDN URL, or a world-readable file
  with no way to tell which apart from sniffing `provider.name`. Each provider
  now declares what it can do, S3 warns once per process when it cannot enforce
  the request, and Vercel Blob refuses outright.

- **Local storage deletes now sweep the private root as well as the public one**
  (#490). `delete()` and `deletePrefix()` only ever touched `baseDir`. With the
  private root added, that would have made `eraseUser()` — which clears a user's
  blobs via `deleteByPrefix('avatars/<userId>/')` — a partial delete, leaving
  private files on disk after erasure. Both roots are swept, and a failure in
  either is reported rather than masked by the other's success.

- **The retention sweep reads the settings row once instead of eight times**
  (#442). `resolveRetentionDays()` fetched the same singleton row per prune, so
  one sweep spent eight round-trips retrieving six columns — 1,440 times a day at
  the documented tick cadence, and all of it wasted on a default install where
  every window is `null` and every prune no-ops. `enforceRetentionPolicies()` now
  calls the new `loadRetentionWindows()` once and passes each window down. The
  individual `pruneX()` functions are unchanged for direct callers, but their
  first parameter widens to `number | null | undefined`: `undefined` still means
  "resolve it yourself", an explicit `null` now means "skip". The coherence
  warning reads from the same loaded windows rather than issuing its own query.

- **The MCP config cache no longer collides with the maintenance-tick interval**
  (#442). `CACHE_TTL_MS` was 60s — exactly the tick cadence — so the retention
  sweep's `getMcpServerConfig()` call was a coin-flip between a hit and a miss,
  and the miss path is an `upsert`, i.e. a write taking a row lock, roughly every
  other tick. Raised to 5 minutes; invalidation on admin mutation was already
  explicit, so nothing goes stale that wasn't already.

- **The embedding backfill's anti-join has an index to use** (#442). It filters
  `AiMessage` on `role` and orders by `createdAt`, but the table was indexed on
  `role` alone, so proving the backlog empty meant a scan plus a sort that grew
  with the table — every tick, forever. Adds `@@index([role, createdAt])` and
  drops the now leading-column-redundant `@@index([role])`. **Migration:**
  `20260730140000_add_message_role_createdat_index`.

- **Tab titles and legal-page metadata now route through the `BRAND` seam**
  (#432). `SETTINGS_TAB_TITLES` and `KNOWLEDGE_TAB_TITLES` hardcoded `"Sunrise"`,
  and `useUrlTabs` writes them straight to `document.title` — so a fork with
  `NEXT_PUBLIC_APP_NAME` set still showed "Sunrise" in the browser tab on
  `/settings` and the admin knowledge base, overriding correct layout metadata.
  The static metadata on `app/(public)/{privacy,terms,contact}` had the same
  hardcode. All now interpolate `BRAND.name`. `about/` is deliberately left
  alone — its copy describes the template itself and is fork-replaced body copy.

- **The protected error boundary's "Session Expired" card now actually renders
  when a session expires.** The session check tested `authClient.getSession()`
  for truthiness, but better-auth always resolves that call to a
  `{ data, error }` envelope — never `null` — so the condition never fired and
  the sign-in prompt only appeared when the request itself threw. The check now
  destructures `{ data: session }`, matching the other call sites in the repo.
  Pre-existing on `main` (`app/(protected)/error.tsx`), carried into the shared
  boundary by this release's refactor and fixed there.

- **Route-group error boundaries no longer double-log and double-report on
  session expiry** (#433). The logging effect included `isSessionExpired` in its
  dependency array while also setting it, so a session-expiry error re-ran the
  effect and produced two `logger.error` lines and two Sentry events. The shared
  boundary reports once per error (deps `[error]`) and drops `isSessionExpired`
  from the Sentry `extra` — it was always `false` at report time anyway.

- **`next/font/google` and `next/font/local` now resolve under Vitest.** Font
  loaders run at module scope, so a fork adding brand typography previously saw
  every test importing that layout fail at import time. Loader names are derived
  from Next's own declarations, so no fork edits a platform test file. ([#455])

- **Secret scanning keeps `--results=verified,unknown`** and ships a
  fixture/docs path allowlist instead, so forks do not have to trade away the
  unverifiable-secret class to stop false positives on example DSNs. ([#453])

[#435]: https://github.com/human-centric-engineering/sunrise/issues/435
[#451]: https://github.com/human-centric-engineering/sunrise/issues/451
[#452]: https://github.com/human-centric-engineering/sunrise/issues/452
[#453]: https://github.com/human-centric-engineering/sunrise/issues/453
[#454]: https://github.com/human-centric-engineering/sunrise/issues/454
[#455]: https://github.com/human-centric-engineering/sunrise/issues/455
[#480]: https://github.com/human-centric-engineering/sunrise/issues/480

- **MCP tool dispatch warms the capability registry.** A process that had only
  served MCP — no chat or workflow request yet — had an empty in-memory
  registry, so every MCP tool call failed with `Unknown capability`, built-ins
  included, while `tools/list` still listed them. ([#457])

- **Boot-registered context contributors and capability handlers survive to
  request time.** Both registries are now backed by `globalThis`, as the Prisma
  client already was. Under Next 16 + Turbopack `instrumentation.ts` runs in a
  separate module graph from route handlers, so a framework tier registering at
  boot silently vanished on the request path. ([#462])

[#437]: https://github.com/human-centric-engineering/sunrise/issues/437
[#457]: https://github.com/human-centric-engineering/sunrise/issues/457
[#462]: https://github.com/human-centric-engineering/sunrise/issues/462
[#466]: https://github.com/human-centric-engineering/sunrise/issues/466
[#476]: https://github.com/human-centric-engineering/sunrise/issues/476
[#489]: https://github.com/human-centric-engineering/sunrise/issues/489
[#502]: https://github.com/human-centric-engineering/sunrise/issues/502

- **`LlmOptions.timeoutMs` and `signal` reach the provider SDKs.** Both were
  documented but dropped, so a call that needed longer than the client default
  died at the default with no indication the option had been ignored. All four
  adapter paths (`chat` and `chatStream` on Anthropic and OpenAI-compatible)
  now forward them; setting neither leaves the provider default in charge.
  ([#444])

- **PDF parsing survives serverless file tracing.** The pdfjs worker is
  registered on `globalThis` from a literal import specifier, so it ships in the
  function bundle — previously every PDF upload on Vercel failed with "Setting
  up fake worker failed", while working locally. ([#446])

- **`chatStreamEventSchema` models `budget_exceeded_per_turn`.** The variant was
  missing, so `parseChatStreamEvent` returned null and consumers dropped the
  frame — and on the tool-loop-abort path it is the last frame sent, leaving an
  empty assistant turn with no explanation. ([#461])

- **Per-model cost rows no longer borrow another provider's label.** Spend served
  by OpenAI's `gpt-4o` could render as `microsoft` / "GPT-4o (Azure)". ([#436])

- **`costLogRetentionDays` below `executionRetentionDays` is rejected** at all
  three write paths (settings form, Zod schema, PATCH route against the persisted
  row). Cost logs must outlive the executions that reference them or the
  drill-down empties out under a retained execution. Installs already in that
  state get a warning per retention sweep. ([#456])

- **`prisma/schema/orchestration-agents.prisma` is formatted per the pinned
  Prisma, and CI now enforces it** (#482). `model AiAgent`'s attribute column was
  one short of what `prisma format` produces, so every fork's first `prisma format`
  dirtied a core file it never edited. Prettier doesn't touch `.prisma`, so
  `format:check` couldn't see the drift; the `lint` job now runs `prisma format`
  and fails on a non-empty diff. Whitespace only — no schema or client change.

## [0.7.0] — 2026-07-09

> **Alpha release.** Ninth tagged Sunrise release. **MINOR bump** — adds new
> public surface: seven fork-facing seams and primitives requested by Daybreak
> under the fork-first pattern, all additive and inert in vanilla Sunrise until
> a fork opts in. Two chat guard seams — **`registerGuardFloorContributor`**
> (raise an inline input/output/citation guard to a per-turn minimum; raise-only)
> and its post-detection sibling **`registerGuardEventContributor`**
> (fire-and-forget observation of a guard firing). Context + conversation —
> **per-user `buildContext`** (`ContextRequest { userId? }` threaded to
> contributors + a user-partitioned cache) and **`findResumableConversation`**
> (resume a surface's conversation by its `(contextType, contextId)` tuple).
> Capability + chat carriers — **`CapabilityContext.customConfig` + `isEnabled`**
> surfaced from the resolved binding, and a bounded **consumer chat `scope` map**
> on the public route. Plus **`runStructuredCompletion` relocated** to a neutral
> `lib/orchestration/llm/` home with an open `phase` tag. No breaking changes.

### Added

- **Chat guard-event seam — a fork can OBSERVE an inline guard firing
  (post-detection) and react** (#414). New `registerGuardEventContributor(key,
  contributor)` (exported from `@/lib/orchestration/chat`, with types
  `GuardEventContext` / `GuardEvent` / `GuardEventContributor`). When an inline
  guard (input / output / citation) flags, the handler calls `emitGuardEvent`
  **fire-and-forget** to contributors keyed on the turn's `(contextType,
  contextId, agentId, userId, conversationId)` with `{ guard, outcome }`, so a
  fork can notify / log / escalate without editing the guard sites. Fire-and-forget
  — it never delays or breaks the turn (contributors run on a microtask; a
  throwing/rejecting contributor is swallowed), it fires before the `block`
  short-circuit so a block is still observed, and an empty registry is inert.
  Observation only — it cannot change detection or the guard's action (use the
  guard-floor seam for that). Fork-owned scaffold
  `lib/app/guard-event-contributors.ts`. The post-detection sibling of the
  guard-floor seam (#413).
- **Chat guard-floor seam — a fork can RAISE an inline guard to a minimum for a
  turn** (#413). New `registerGuardFloorContributor(key, contributor)` (exported
  from `@/lib/orchestration/chat`, with types `GuardKind` / `GuardMode` /
  `GuardFloors` / `GuardFloorRequest` / `GuardFloorContributor`). A contributor
  keyed on the turn's `(contextType, contextId, agentId)` returns a per-guard
  **minimum** mode for the three inline guards (input / output / citation), and
  the handler raises each guard to the strictest registered floor. **A floor
  only ever RAISES a guard, never lowers it** (`none` < `log_only` <
  `warn_and_continue` < `block`); an empty registry leaves guard-mode resolution
  byte-for-byte unchanged, and a throwing contributor is skipped. Fork-owned
  scaffold `lib/app/guard-floor-contributors.ts` (`initAppGuardFloorContributors()`).
- **`CapabilityContext` now carries the resolved binding's `customConfig` +
  `isEnabled`** (#411). The dispatcher populates `context.customConfig`
  (`AiAgentCapability.customConfig`, normalised to an object or `null`) and
  `context.isEnabled` from the per-agent binding it already resolves at step 4,
  so a capability can read its own per-binding config inside `execute()` without
  re-querying `AiAgentCapability`. Both are set on a shallow copy (the caller's
  context object is untouched) and stay opaque carriers alongside `scope` — core
  sets `customConfig` but reads no keys, so consumers must still validate it
  (e.g. Zod). `AgentCapabilityBinding` gains a matching `customConfig` field.
  Inert for existing capabilities (they may adopt it to drop their own lookup);
  no behaviour change.
- **Consumer chat request accepts an opaque `scope` map** (#415).
  `consumerChatRequestSchema` (`POST /api/v1/chat/stream`) now takes an optional
  `scope: Record<string, string>`, threaded verbatim into every capability
  dispatch for the turn as `CapabilityContext.scope` — the same carrier the
  internal chat handler already threads. Inert in vanilla Sunrise (no built-in
  reads it); a fork can surface-scope a consumer conversation without shadowing
  the route. Because it arrives on an untrusted end-user request it is bounded
  (≤ 32 entries, keys ≤ 100 chars, values ≤ 500 chars), and a fork reading it
  for access decisions must re-validate against the user's entitlements — a
  consumer-supplied scope is a hint, not an authorization grant.
- **`findResumableConversation` — resume a surface's conversation by its context
  tuple** (#416). New helper (exported from `@/lib/orchestration/chat`, with type
  `ResumableConversationQuery`) that resolves a user's most-recent-active
  conversation for a `(userId, agentId, contextType, contextId)` surface, ordered
  by `updatedAt` desc, or `null` if none. Core already **binds** that tuple onto a
  conversation at creation and **injects** entity context for it (`buildContext`)
  but had no resume-by-tuple path — a "surface" (a stable place a user returns to)
  had to re-derive the query. The lookup is always scoped to `userId` + `agentId`
  + `isActive`, so centralising it also removes the risk a hand-rolled copy omits
  `userId` (a cross-user leak). Deciding *when* to resume stays the caller's job
  (the handler never resumes by tuple on its own); the existing
  `@@index([contextType, contextId])` supports it — no migration. Inert in vanilla
  Sunrise (no core surface calls it).

### Changed

- **Context builder threads per-request `userId` + partitions its cache by
  user** (#412). `buildContext` and `invalidateContext` take an optional third
  argument — a generic `ContextRequest { userId? }` (new exported type) — passed
  through to each `ContextContributor` (its loader signature widens to
  `(id, request) => Promise<string>`), and the 60 s result cache now keys on
  `(type, id, userId)` instead of `(type, id)`. Lets a fork return **per-user**
  prompt context without risking a cross-user cache leak. An empty/absent
  `userId` collapses to a single shared partition — byte-for-byte the previous
  behaviour — and a loader that ignores the new arg (`(id) => …`) stays valid.
  The streaming handler passes the turn's `userId` at all three call sites.
- **LLM structured-completion runner relocated to a neutral home** (#410). Moved
  `runStructuredCompletion` (with `StructuredCompletionOptions` /
  `StructuredCompletionResult`) out of
  `lib/orchestration/evaluations/parse-structured.ts` into
  `lib/orchestration/llm/structured-completion.ts` — it is a general LLM utility
  with no evaluation coupling, so a non-evaluation caller no longer imports
  through an eval-shaped path. The `phase` option widens from the closed
  `'summary' | 'scoring'` union to an open `string`, letting a caller tag its own
  span/cost phase (e.g. `'slot-extraction'`). No behaviour change: the OTEL
  attributes (`gen_ai.operation.name`, `sunrise.evaluation.phase`) and the
  omitted-`phase` default (`'evaluation'`) are unchanged. The `tryParseJson` /
  `stripCodeFence` JSON parse helpers remain in `parse-structured.ts` (every
  caller is an evaluation grader).

## [0.6.0] — 2026-07-06

> **Alpha release.** Eighth tagged Sunrise release. **MINOR bump** — adds new
> public surface, all fork-facing seams that stay inert in vanilla Sunrise: the
> capability `register()` **slug override + pre-execute `guard`**
> (`CapabilityRegisterOptions` / `CapabilityGuard` / `CapabilityGuardDecision`;
> guard runs as dispatch step 4a, fail-closed), the **knowledge
> access-contributor** seam (`registerAgentAccessContributor` — a fork widens a
> restricted agent's document set live), the reserved **`/framework` namespace
> tier** + generic `initApp()` boot seam (`lib/app/bootstrap.ts`), the fork-owned
> **ESLint config + `app:ci-checks`** seams, MCP **`tools/list` agent scoping**
> (with the `callMcpTool()` caller-object signature change), and
> `send_notification` **`to` interpolation**. Plus fixes: workflow
> `{{trigger.*}}` template resolution, the admin MCP key-hash audit leak
> (Security), and spurious `updatedAt` audit-diff noise across nine admin routes.
> Both new dispatcher/knowledge seams are byte-for-byte inert until a fork opts
> in.

### Security

- **Admin MCP API-key audit no longer records the key hash.** The
  `PATCH /api/v1/admin/orchestration/mcp/keys/:id` handler diffed a full-row
  `existing` against a narrower `select`-ed `updated`, so `computeChanges`
  recorded every column present only on `existing` — including `keyHash` (the
  SHA-256 of the key), which `SECRET_PATTERN` did not redact — as a spurious
  `→ undefined` change on **every** PATCH, writing the hash into
  `AiAdminAuditLog.changes`. Both rows are now fetched through the same
  projection (which omits `keyHash`/`scopedAgentId`/`createdBy`), and
  `SECRET_PATTERN` additionally redacts `key`/`token` digest fields (`keyHash`,
  `tokenHash`) as defense in depth — without over-redacting non-secret digests
  like `fileHash`/`contentHash`. The hash is not the key and the log is
  admin-only, so impact is low — but a credential-derived value no longer sits
  in the audit table. (#388)

### Added

- **Capability `register` options — `slug` override + pre-execute `guard`.**
  `capabilityDispatcher.register(capability, options?)` and
  `registerAppCapability(capability, options?)` now accept an optional
  `{ slug?, guard? }` (new exported types `CapabilityRegisterOptions`,
  `CapabilityGuard`, `CapabilityGuardDecision`). `slug` overrides the in-memory
  handler key so a fork can mount one capability class under a namespaced slug;
  `guard` is an async-capable predicate run as dispatch **step 4a** (after the
  per-agent binding, before the rate limiter) that reads the generic
  `CapabilityContext.scope` and returns `{ allow, reason? }` — `{ allow: false }`
  (or a throw) denies with the new `capability_guard_denied` code, failing
  **closed**. Together they let a fork mount and scope-gate a capability
  **without wrapping it** — a wrapper would have defeated `register()`'s
  PII-redaction own-property check, so both options keep that guard inspecting
  the real subclass. Hard contract: an override `slug` must map to an **active
  `AiCapability` row** or dispatch dies at `capability_inactive` before the
  handler/guard runs. Both fields are opt-in; core attaches no guards and uses
  no slug overrides, so vanilla behaviour is byte-for-byte unchanged. (#398)
- **`lib/app/knowledge-access-contributors.ts` — fork-owned knowledge
  access-contributor seam.** A new `lib/app/**` seam mirroring
  `registerContextContributor`: a fork registers
  `registerAgentAccessContributor(key, (agentId) => Promise<{ documentIds?, tagIds? }>)`
  to **widen a restricted agent's searchable document set** from a relationship
  it owns (module membership, team ACL, per-tenant grant), composed **live** by
  `resolveAgentDocumentAccess()` instead of materialising derived grants onto the
  per-agent pivot (which has no provenance column, making copy-down
  clobber-or-leak). Contributors run only in the `restricted` branch (a `full`
  agent is never touched) and can only **widen**; contributed `tagIds` expand to
  their documents like a tag grant; a contributor that throws is logged and
  ignored; an empty registry is byte-for-byte the previous behaviour. When the
  data a contributor reads changes, the subsystem calls the existing
  `invalidateAgentAccess(agentId)`. (#403)
- **`lib/app/eslint.config.mjs` + `app:ci-checks` — fork-owned ESLint & CI
  seams.** A fork can now add its own ESLint import-boundary rules and CI checks
  without editing platform-owned files (which would conflict on every
  `git merge vX.Y.Z`). The root `eslint.config.mjs` imports and spreads the
  reserved `lib/app/eslint.config.mjs` (ships `export default []`) as its **last**
  argument, so fork blocks land after core and win for their own `files`; the
  seam header documents the load-bearing spread order and the flat-config
  `no-restricted-imports` **replace-not-merge** footgun (restate the `@/`-alias
  ban per glob). The CI `lint` job runs `npm run app:ci-checks --if-present`, so
  a fork adds an `app:ci-checks` script to `package.json` with **no `ci.yml`
  edit** (no-op in vanilla Sunrise). Both default to inert. (#382)
- **`lib/app/bootstrap.ts` — fork-owned server boot seam (`initApp`).** A new
  `lib/app/**` seam: `instrumentation.ts` `register()` calls the reserved,
  empty-by-default `initApp()` once per server process for one-time startup work
  (warm a cache, start a worker, boot a framework tier). It runs in **every**
  environment (placed above the dev-only maintenance-ticker guards) and is
  isolated in a try/catch, so a fork's boot failure is logged but never crashes
  instrumentation or stops the dev ticker arming. Core imports only
  `@/lib/app/bootstrap`; a fork imports its own tier **dynamically** from there
  (a static `@/lib/framework` specifier breaks `next build` in vanilla Sunrise).
  Also **reserves a second fork-namespace tier, `/framework`**, for
  framework-layer forks that sit between Sunrise and their own leaf forks
  (`lib/framework/`, `.context/framework/`, `prisma/schema/framework-*.prisma`,
  the `framework_` table prefix) — Sunrise core never creates files or tables
  there, generalising #371's `/app` (leaf) reservation to two tiers. Default
  (empty `initApp`) is unchanged behaviour. (#385)
- **`lib/app/protected-routes.ts` — fork-owned protected-route registry.** A new
  `lib/app/**` seam: a fork lists extra authenticated route prefixes in
  `appProtectedRoutes` (ships empty) and the proxy **merges** them with the core
  prefixes (`/dashboard`, `/settings`, `/profile`) for the edge redirect-to-login,
  instead of editing the `proxy.ts` literal. Append semantics (core prefixes always
  stay protected); malformed entries not starting with `/` (e.g. an empty string
  that would match every path) are dropped. This is only the "is-logged-in-at-all"
  edge gate — per-resource authorisation stays in the `withAuth`/`withAdminAuth`
  guards. Default (empty list) is unchanged behaviour.
- **Payload-derived inbound scope — `NormalisedTriggerPayload.scope`.** An inbound
  adapter's `normalise()` may now return an optional `scope` (a flat string→string
  map) computed from the verified request body, letting an event-triggered run be
  scoped by what the caller sent (e.g. a fork's GitHub adapter mapping a
  `pull_request` repo to `{ projectId }`). The inbound route runs the
  adapter-returned value through the shared `resolvePersistedScope` validate-on-read
  guard (adapters aren't trusted to return well-formed data — malformed drops to
  unscoped) and shallow-merges it **under** the static `AiWorkflowTrigger.scope`,
  so the operator's config wins on key conflicts. Core's built-in adapters leave it undefined; derivation is
  fork-specific. Completes the `CapabilityContext.scope` trigger-entry population
  (the static half shipped alongside).
- **`AiWorkflowSchedule.scope` + `AiWorkflowTrigger.scope` (nullable JSON) —
  trigger-entry scope population.** Scheduled and inbound-triggered workflow runs
  can now carry a static application-level `scope` (a flat string→string map),
  stamped onto the created `AiWorkflowExecution.scope` so capabilities inside the
  run enforce it. A schedule/trigger's `scope` is settable as opaque JSON via the
  admin schedule/trigger create + PATCH endpoints (clearing uses the
  `Prisma.DbNull` sentinel); the admin `POST /workflows/:id/execute` +
  `execute-stream` routes accept an optional `scope` for a manual run. Persisted
  values are validated on read via a new shared helper `resolvePersistedScope`
  (`lib/orchestration/scope.ts`) — a malformed row is dropped to unscoped (never
  wedges a run) — which also now backs the engine resume path. The generic
  webhook trigger is deliberately left unscoped: scoped event triggers use the
  inbound-adapter seam. Core names no keys; `NULL`/unset is unchanged behaviour.
  The second populator of the `CapabilityContext.scope` carrier (after the MCP
  key); payload-derived (dynamic) scope for inbound adapters is tracked
  separately.
- **`McpApiKey.scope` (nullable JSON) — per-key scope population.** An MCP API
  key may now carry an optional application-level `scope` (a flat string→string
  map, distinct from the coarse protocol `scopes` array). It is validated on read
  (`mcpKeyScopeSchema`) and folded into `CapabilityContext.scope` for every
  `tools/call` made with the key (the dormant `callMcpTool` param from the MCP
  `tools/call` work is now populated), so an external MCP caller's tool calls are
  automatically scoped without passing scope on each call. Settable as opaque JSON
  via the admin key create/PATCH endpoints (clearing uses the `Prisma.DbNull`
  sentinel); a malformed stored value is dropped at auth (key treated as unscoped)
  rather than failing authentication. Core names no keys; `NULL`/unset is
  unchanged behaviour. First populator of the `CapabilityContext.scope` carrier;
  workflow trigger entry points are tracked separately.
- **`AiWorkflowExecution.scope` (nullable JSON) + workflow `tool_call` scope
  threading.** Completes the `CapabilityContext.scope` seam (0.5.0) on the
  workflow path. A run started via `OrchestrationEngine.execute` may now carry
  an optional `scope` (`ExecuteOptions.scope`); it is persisted on the execution
  row so it survives crash-resume (the resume path reads it back, validated by
  `workflowScopeSchema`, and rethreads it into the rebuilt `ExecutionContext`),
  and every capability dispatch forwards it — the `tool_call` executor and the
  `agent_call` tool-use loop (so `orchestrator` delegations are scoped too).
  Core names
  no keys and no built-in capability reads it; `NULL`/unset leaves behaviour
  unchanged. With the MCP `tools/call` path (above), `scope` now reaches
  capability `execute()` on all three dispatch paths (chat, MCP, workflow).
  The execution **rerun** endpoint inherits the original run's `scope`
  (alongside its inputData / budget / version), and the `run_workflow`
  capability inherits the parent run's `scope` into a sub-workflow — so
  a capability at any workflow depth sees the run's scope.

### Changed

- **MCP `tools/list` is scoped to the key's agent (list/call parity).** When an
  MCP API key is bound to an agent (`scopedAgentId`), `tools/list` now hides
  capabilities **explicitly disabled** for that agent (an `AiAgentCapability`
  row with `isEnabled = false`) — so a scoped key can no longer *discover* a
  tool it would then be refused on *call* (since #380, `tools/call` dispatches
  under the scoped agent). Scoping stays **default-allow**: capabilities with no
  binding row remain listed and callable; only explicit disables are honoured.
  Unscoped keys see the full global list, unchanged. The shared
  `capability_disabled_for_agent` dispatcher error message no longer embeds the
  internal agent cuid (it's surfaced verbatim to MCP clients); the id stays in
  server logs only. (#381)
- **`send_notification` step interpolates the `to` recipient.** The email
  recipient(s) are now run through the same `{{…}}` interpolation as `subject`
  and `bodyTemplate`, and the **resolved** value is validated as an email at
  runtime (a template resolving to a non-email fails the step non-retriably with
  `INVALID_RECIPIENT`). A literal `to` is still validated as an email when the
  step config is parsed at execution start (`INVALID_CONFIG` on a mistyped
  literal) and behaves identically. This lets a per-user scheduled workflow
  template the recipient (`to: '{{input.userEmail}}'`) with the built-in step
  instead of a bespoke `sendEmail` capability. The exported
  `sendNotificationConfigSchema` relaxes `to` accordingly: a plain string with no
  template token is still validated as an email; a `{{…}}` template is accepted
  and validated on resolution.
- **`callMcpTool()` signature** — the third parameter changed from
  `userId: string | null` to a caller object
  `{ userId: string | null; scopedAgentId?: string | null; scope?: Record<string, string> }`.
  This lets an MCP tool call run under the API key's scoped agent and carry the
  optional per-dispatch `scope` carrier (`CapabilityContext.scope`, added in
  0.5.0) through to `execute()`. Direct callers passing a bare `userId` must
  wrap it as `{ userId }`.

### Fixed

- **Workflow template namespace `{{trigger.*}}` did not resolve.** The engine's
  `interpolatePrompt` had no `trigger.` branch, so a documented, widely-used token
  like `{{trigger.conversationId}}` / `{{trigger.text}}` (the default config for
  inbound-triggered `chat_turn` steps, and what the step's own error messages tell
  you to use) silently expanded to the empty string — an inbound-triggered
  `chat_turn` would fail with `missing_conversation_id` / `missing_message` on
  every real run. `{{trigger.<dotted.path>}}` now reads an inbound run's data —
  the verified adapter payload (`inputData.trigger`) with a fallback to the
  resolved envelope (`inputData.triggerMeta`), so `{{trigger.text}}` reads the
  payload and `{{trigger.conversationId}}` the envelope where the resolved id
  actually lives. It also works inside `{{#if …}}` conditionals. The bug was
  masked because the `chat_turn` unit + inbound integration suites **mocked**
  `interpolatePrompt` with a stub that faked `trigger.` support (and fabricated a
  `trigger.conversationId` shape production never emits); both now exercise the
  real interpolator against the real inbound shape. Also corrected the workflow-builder editors'
  help text (`{{steps.<stepId>.output}}` → `{{<stepId>.output}}`; there is no
  `steps.` prefix) and stopped the builder's `send_notification` check from
  false-flagging a valid array-shaped `to` as "needs recipients".
- **MCP `tools/call` ignored the API key's `scopedAgentId`.** Tool calls always
  ran under the shared `mcp-system` agent, so cost/budget attribution and
  knowledge-base grant resolution (`resolveAgentDocumentAccess`) did not honour a
  scoped key — inconsistent with the `resources/read` path, which already
  resolved via `scopedAgentId`. `tools/call` now resolves the executing agent
  from the key's `scopedAgentId` when set, falling back to `mcp-system` for
  unscoped keys (unchanged behaviour for keys with no scoped agent).
- **Admin config-update audit diffs no longer record a spurious `updatedAt`
  change.** Nine admin orchestration PATCH routes (`settings`, `mcp/settings`,
  `triggers/:id`, `providers/:id`, `workflows/:id`, `knowledge/tags/:id`,
  `hooks/:id`, `webhooks/:id`, `agent-profiles/:id`) diffed the pre-update row
  against the post-update row without ignoring Prisma's `@updatedAt` column,
  which bumps on every `update()` — so `AiAdminAuditLog.changes` recorded a
  timestamp `from`/`to` on **every** edit, drowning the real field changes. All
  nine now pass `ignoreKeys: ['updatedAt', 'createdAt']` to `computeChanges`,
  matching the `agents/:id` route that already did. Signal-quality only — no data
  exposure. (#396)

## [0.5.0] — 2026-07-01

> **Alpha release.** Seventh tagged Sunrise release. **MINOR bump** — adds new
> public surface: two generic core seams a downstream framework layer needs, both
> inert in vanilla Sunrise. The per-dispatch **scope carrier**
> (`CapabilityContext.scope`, threaded verbatim from a new `ChatRequest.scope`;
> core names no keys and no built-in capability reads it) lets a consumer make a
> capability refuse to run outside its intended scope. The **context-contributor
> registry** (`registerContextContributor()` + the fork-owned empty scaffold
> `lib/app/context-contributors.ts` → `initAppContextContributors()`, a new named
> seam in [`VERSIONING.md`](./VERSIONING.md#covered)) lets a fork inject its own
> `LOCKED CONTEXT` block per turn without editing the core `buildContext` switch —
> with fork loader and one-time-init errors caught so they never fail a chat turn.
> Both were added so a fork can attach per-dispatch scope and pluggable
> prompt-context loaders without patching platform code. Ships in `0.x` per
> [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) — forks
> adopting this release should expect real merge work between any two `0.x`
> releases.

### Added

- **`CapabilityContext.scope?: Record<string, string>`** — an optional, free-form
  scope map the dispatcher's caller can populate; the dispatcher threads it
  verbatim into `execute()`. Generic by design: core names no keys and no
  built-in capability reads it. The chat handler threads it from a new
  `ChatRequest.scope`. Lets a downstream consumer make a capability refuse to run
  outside its intended scope. Inert (`undefined`) when unused. (#372)
- **`registerContextContributor(type, loader)`** (exported from
  `@/lib/orchestration/chat`) — registers a prompt-context loader for a new
  `buildContext` `contextType`, so a fork can inject its own `LOCKED CONTEXT`
  block per turn without editing the core switch. Built-in cases take precedence;
  the 60 s per-`(type, id)` cache and invalidation behaviour are preserved. A
  contributor (or the fork's one-time init) that throws is caught and degraded
  so a loader error never fails the chat turn; the errored-contributor
  placeholder alone is returned uncached, so a transient loader failure
  self-heals on the next turn. Auto-wired once via the new fork-owned empty
  scaffold
  `lib/app/context-contributors.ts` → `initAppContextContributors()` (mirrors
  `lib/app/capabilities.ts`). (#372)

## [0.4.1] — 2026-07-01

> **Alpha release.** Sixth tagged Sunrise release. **PATCH bump** — no change to
> the covered public surface (see [`VERSIONING.md`](./VERSIONING.md#covered)):
> one backward-compatible enhancement to an uncovered `lib/db/` helper plus
> routine dependency and CI maintenance. Cut as a clean forking point. Ships in
> `0.x` per [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design).

### Changed

- `executeTransaction()` (`lib/db/utils.ts`) now accepts an optional second
  argument forwarding Prisma's interactive-transaction options
  (`timeout`, `maxWait`, `isolationLevel`) to `prisma.$transaction`. Fully
  backward-compatible — existing callers keep Prisma's defaults (5000 ms
  timeout / 2000 ms maxWait). Lets forks raise the ceiling for genuinely heavy
  callbacks (e.g. bulk imports over remote/pooled Postgres) without patching the
  core utility. [#368]

## [0.4.0] — 2026-06-30

> **Alpha release.** Fifth tagged Sunrise release. **MINOR bump** — adds new
> public surface: the per-surface theming seam (`data-surface` + the fork-owned
> `classifySurface` / `DEFAULT_SURFACE` policy in `lib/app/surface.ts`,
> `<SurfaceSync>`, and the empty `app/brand-theme.css`), the agent field registry
> (`AGENT_FIELDS` + the `AgentFieldDescriptor` type and selectors, with the
> fork-owned `lib/app/agent-fields.ts` seam), the knowledge-document
> cross-environment export key (`AiKnowledgeDocument.slug` + the bundle/backup
> `knowledgeDocumentSlugs` grant round-trip), point-in-time agent versioning with
> system-agent restore, and the legal-name brand seam (`BRAND.legalName` /
> `NEXT_PUBLIC_LEGAL_NAME`) — plus fixes to backup import on a fresh target and the
> email-subject branding. Ships in `0.x` per
> [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) — forks
> adopting this release should expect real merge work between any two `0.x`
> releases. Note: existing pre-`0.x` agent version rows are reinterpreted under
> the new point-in-time model (see the Changed entry).

### Added

- **Legal-name brand seam (`BRAND.legalName` / `NEXT_PUBLIC_LEGAL_NAME`).** The
  public footer copyright now attributes to a fork's legal entity rather than its
  product name. `lib/brand.ts` gains `legalName`, defaulting to
  `NEXT_PUBLIC_LEGAL_NAME` → `NEXT_PUBLIC_APP_NAME` → `"Sunrise"`, so a fork that
  only renames the app is byte-for-byte unchanged; set `NEXT_PUBLIC_LEGAL_NAME`
  (registered in `lib/env.ts`) when the copyright holder differs from the product
  (e.g. product "ConQuest" © "All Too Human Ltd"). Deliberately broader than
  "copyright holder" so it can later drive other legal surfaces (Terms/Privacy
  boilerplate, email footers). See `CUSTOMIZATION.md` §2. (#363)

- **Per-surface theming seam (`data-surface`) + fork-owned `app/brand-theme.css`.**
  A fork can now repaint one rendering surface (e.g. its consumer-facing pages)
  with its own palette/typography while leaving others (e.g. `/admin`) on the
  Sunrise defaults — without editing `app/globals.css` or any platform layout.
  `proxy.ts` classifies each request via the fork-owned `classifySurface(pathname)`
  policy seam (`lib/app/surface.ts`, exporting the `Surface` type) and forwards an
  `x-surface` request header; the root layout renders `<html data-surface>`; the
  new `<SurfaceSync>` client component (`components/surface-sync.tsx`) keeps that
  attribute correct across App Router navigation. The fork's per-surface CSS-variable
  overrides live in `app/brand-theme.css`, which **ships empty** — vanilla Sunrise
  is visually unchanged until a fork fills it. Documented (including the six
  design constraints — `<html>`-level marker for portals, the client re-sync, the
  subtree pin, the two dark-mode selector forms, the `:has()` backdrop, and
  unlayered overrides) in
  [`.context/ui/surface-theming.md`](.context/ui/surface-theming.md).
- **Agent field registry + fork-owned `lib/app/agent-fields.ts` seam.** A single
  declarative descriptor per `AiAgent` config field
  (`lib/orchestration/agents/agent-field-registry.ts`, exporting `AGENT_FIELDS`,
  the `AgentFieldDescriptor` type, and the `versionedFieldNames` /
  `snapshotFieldNames` / `fieldLabels` / `fieldToTab` / `fieldOrder` selectors)
  replaces the ~15 disconnected hand-maintained field lists that previously had
  to be kept in lockstep. The scalar set is exhaustiveness-checked against
  Prisma's generated `AiAgentScalarFieldEnum`, so adding a column without a
  descriptor is a compile error rather than a silent runtime gap. Forks add
  their own agent fields in the empty fork-owned scaffold `lib/app/agent-fields.ts`
  (`appAgentFields`) without editing a platform list. The registry is the source
  of truth (derived) for the versioning, snapshot, diff, restore, PATCH, and
  clone surfaces; parity tests keep the create/update validation schemas and the
  export bundle / full-backup schemas in lockstep with it, so adding a field to
  one without the other is a loud test failure. Documented in
  [`.context/orchestration/agent-fields.md`](.context/orchestration/agent-fields.md).
- **`AiKnowledgeDocument.slug` — stable cross-environment export key** (`@unique`,
  added by migration `20260629120000_add_knowledge_document_slug` with a
  deterministic backfill). Mirrors `KnowledgeTag.slug`: the slug is
  `slugify(name) + '-' + first8(fileHash)` (helper
  `lib/orchestration/knowledge/document-slug.ts` — `buildDocumentSlugBase`,
  `generateUniqueDocumentSlug`), so the same document keys identically in any
  environment. This is the prerequisite that lets **agent→document grants
  round-trip** through export/import and backup/restore (#338). `slugify` is now
  exported from `lib/orchestration/knowledge/chunker.ts`. Documented in
  [`.context/orchestration/knowledge.md`](.context/orchestration/knowledge.md).
- **Newly-exported validation surfaces** (`lib/validations/orchestration.ts`):
  `createAgentObjectSchema` / `updateAgentObjectSchema` (the agent create/PATCH
  field shapes without their cross-field refinement, so other call sites — e.g.
  version restore — can reuse the same per-field validators) and
  `bundledAgentSchema`; plus `agentBackupSchema` from
  `lib/orchestration/backup/schema.ts`. Exported to anchor the registry parity
  tests.

### Changed

- **Agent version snapshots are now point-in-time** (`AiAgentVersion.snapshot`
  holds the config _as of_ that version, the post-save state — previously it held
  the pre-update state). "Restore to vN" now reproduces the agent exactly as it
  was at vN, so version labels match their content and the newest row equals the
  live agent. Every agent now gets an explicit **`v1` ("Initial configuration")**
  at create and clone, a new seed unit (`020-agent-initial-versions`) backfills
  one for pre-existing agents, and the first edit of a legacy agent with no rows
  backfills its pre-edit state as `v1` — so a single later edit is always
  recoverable. New shared helper `lib/orchestration/agents/agent-versioning.ts`
  (`buildAgentSnapshot`, `nextAgentVersionNumber`, `INITIAL_VERSION_SUMMARY`).
  _Existing pre-`0.x` version rows are reinterpreted under the new model; during
  `0.x` alpha this is acceptable (forks expect migration work between releases)._
- **System agents are now version-restorable.** `POST /agents/:id/versions/:versionId/restore`
  no longer returns 403 for `isSystem` agents; it applies the snapshot while
  skipping the read-only fields (`slug`, `systemInstructions`, `isActive`),
  mirroring the PATCH route's guards. (Resolves the open question in #330.)
- **Agent→document grants now round-trip through export/import and backup** (#338).
  The agent bundle (`bundledAgentSchema`) carries a new `knowledgeDocumentSlugs`
  array; `POST /agents/export` emits it and `POST /agents/import` reconnects it by
  `AiKnowledgeDocument.slug`, **failing the whole import** with an actionable
  message when a referenced document is absent (matching the existing
  profile/tag behaviour). The full backup schema bumps to **`schemaVersion: 3`**:
  document grants move from `grantedDocumentHashes` (`fileHash`) to
  `grantedDocumentSlugs` (`slug`); v2 bundles still import (the importer falls back
  to `fileHash` lookup when no slugs are present, and document misses there remain
  warn-skip, consistent with the backup importer's leniency).

### Fixed

- **Backup import to a fresh environment no longer crashes on `knowledgeCategories`.**
  The full-config backup importer's agent CREATE branch spread the parsed agent
  into `prisma.aiAgent.create`, leaking the wire-only `knowledgeCategories` field
  (kept for old-bundle back-compat) whose column was dropped in Phase 6. Prisma
  rejected the unknown argument and rolled back the entire import — exactly the
  primary disaster-recovery / new-environment restore path (the UPDATE/overwrite
  path was unaffected). The field is now stripped before the spread, and a
  regression test exercises the CREATE path against a create that rejects unknown
  arguments (the prior tests mocked it away). (#353)

- **Agent version restore now reconnects knowledge grants and `knowledgeAccessMode`.**
  Restore previously left an agent's tag/document grants and access mode at their
  current values (the grants were captured in the snapshot but never reapplied,
  and `knowledgeAccessMode` was deliberately skipped to avoid pairing it with
  stale grants — see #333). Restore now reapplies the snapshot's grants (dropping
  any tag/document deleted since, so a stale id can't FK-fail the restore) and
  mode together, then invalidates the access-resolver cache so the next chat turn
  sees the restored scope.

- **Email subject lines now honor the `BRAND.name` seam.** Five transactional
  email subjects (contact-form notification, welcome on signup, welcome after
  verification, user invitation, admin webhook test) hardcoded the literal
  `"Sunrise"` while their bodies already used `BRAND.name` — so a fork setting
  `NEXT_PUBLIC_APP_NAME` got branded bodies but stale subjects (and a
  subject/body mismatch on the invitation). All five now interpolate
  `BRAND.name`. Vanilla Sunrise is unchanged (the name defaults to `"Sunrise"`).
- **Full-config backup no longer silently drops agent fields.** The
  backup/restore agent schema, exporter, and importer had drifted from the
  `AiAgent` model and omitted `kind`, `reasoningEffort`, `persona`, `guardrails`,
  the three inheritance `*Mode` fields, the three attachment toggles, and the two
  runtime-prompt fields — so exporting and re-importing a config reset a `judge`
  agent to `chat` and lost persona/guardrails/toggles. All are now serialized and
  restored (additive, optional-with-default schema fields, so older bundles still
  import unchanged). A registry parity test now fails if any config field is
  missing from the bundle or backup schema.
- **Agent version history no longer silently loses fields.** `persona`,
  `guardrails`, `personaMode`, `voiceMode`, and `guardrailsMode` were treated as
  versioned (editing them logged a "changed" version) but were never written to
  the snapshot, so the change was unrecoverable; `reasoningEffort` and
  `maxCostPerTurnUsd` were captured but invisible in the diff viewer. All are now
  snapshotted, diffed, and restored. Version **restore** likewise applies the
  full versioned field set (previously its hand-maintained apply-list dropped
  persona/guardrails/modes and the knowledge/runtime-prompt fields) and validates
  the stored snapshot against the same per-field rules a PATCH uses.

## [0.3.0] — 2026-06-26

> **Alpha release.** Fourth tagged Sunrise release. **MINOR bump** — adds new
> public surface (the `<BrandMark>` header/footer brand slot, the public-nav /
> footer override seam — `publicNavItems` / `footerNavItems` / `footerLegalItems`
> with the `PublicNavItem` type and `DEFAULT_*` lists — and the email-template
> resolver `resolveEmailTemplate` with the `EmailKind` / `EmailPropsMap` /
> `EmailOverrides` contract) on top of the anonymous-visitor observability seam
> (`visitorId` log context, `getVisitorId()`, the `LogContext.visitorId` /
> `ChatRequest.visitorId` fields, and the `LOG_VISITOR_ID` / `LOG_HTTP_ACCESS`
> env flags). Ships in `0.x` per
> [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) — forks
> adopting this release should expect real merge work between any two `0.x`
> releases.

### Added

- **Fork-readiness seams — header/footer brand, public nav, and auth emails.**
  Three near-universal fork customizations no longer require editing
  Sunrise-core files in place (which conflicts on every upstream sync); each is
  now a **fork-owned scaffold** the platform auto-resolves against, with a
  platform default. New public surface: the `<BrandMark>` slot
  (`components/brand/brand-mark.tsx`) — the header/footer brand is a render
  concern (image/wordmark/text), so the seam is a component; `AppHeader` renders
  it where it previously hardcoded `'Sunrise'`, and `logoText` becomes an
  optional caller override with no default. The public-nav override
  (`lib/app/public-nav.ts`) exports `publicNavItems` / `footerNavItems` /
  `footerLegalItems` (`PublicNavItem[] | null`, default `null` = platform
  default; a non-null array **replaces** it wholesale), with the shared
  `PublicNavItem` type and `DEFAULT_PUBLIC_NAV` / `DEFAULT_FOOTER_NAV` /
  `DEFAULT_FOOTER_LEGAL` in `lib/public-nav/types.ts`; the footer's **Cookie
  Preferences** consent control is always rendered regardless of the legal
  override. The email resolver (`lib/email/registry.ts`) adds
  `resolveEmailTemplate(kind, props)`, the `EmailKind` union, the typed
  per-kind `EmailPropsMap` props contract, and `EmailOverrides`; forks register
  per-kind overrides in `lib/app/emails.ts` and platform call sites
  (`lib/auth/config.ts`, `app/api/v1/users/invite/route.ts`) resolve through it.
  Changing an email kind's props is a versioned public-surface change. Vanilla
  Sunrise output is unchanged when no override is set. See
  [`CUSTOMIZATION.md`](./CUSTOMIZATION.md) §2 and §4. [#347]
- **Anonymous visitor observability — durable signed `visitorId` in server logs.**
  The proxy now issues a durable, HMAC-signed `sunrise_vid` cookie (HttpOnly,
  SameSite=Lax, Secure in production, 180-day TTL) and folds a `visitorId` into
  the log context alongside `requestId`, so an anonymous visitor's journey
  (page load → contact form → chat) can be correlated across requests for error
  reproduction — where the per-request `requestId` cannot. New public surface:
  the `LogContext.visitorId` field; `getVisitorId()` and the `visitorId` field
  on `getRequestContext()` / `getFullContext()` in `lib/logging/context.ts`; the
  `ChatRequest.visitorId` field threaded through `streamChat()`; the
  `lib/logging/visitor-id.ts` signing module; and two env flags — `LOG_VISITOR_ID`
  (default **on**, set `false` to disable) and `LOG_HTTP_ACCESS` (default **off**,
  opt-in per-request proxy access log). The signing key is derived from
  `BETTER_AUTH_SECRET` via HKDF with domain separation; the cookie is
  tamper-verified and the proxy strips any spoofed inbound `x-visitor-id`
  header. The `visitorId` is pseudonymous and covered by log-retention windows,
  not the `eraseUser()` cascade. See
  [`.context/logging/visitor-tracing.md`](./.context/logging/visitor-tracing.md)
  and [`.context/privacy/visitor-id.md`](./.context/privacy/visitor-id.md). [#341]

## [0.2.0] — 2026-06-25

> **Alpha release.** Third tagged Sunrise release. **MINOR bump** — adds new
> public surface (the `transcribeStream` streaming speech-to-text provider seam
> with the `TranscribeChunk` / `TranscribeAudio` types, optional
> provider-enforced structured output on `runStructuredCompletion`, and the
> `AiAgent.runtimePromptManaged` / `runtimePromptNote` honesty flag) on top of
> the Anthropic structured-output hardening and the agent export/import bundle
> fidelity fix below. Ships in `0.x` per
> [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) — forks
> adopting this release should expect real merge work between any two `0.x`
> releases.

### Added

- `AiAgent.runtimePromptManaged` (Boolean, default `false`) and
  `AiAgent.runtimePromptNote` (nullable String) — an advisory, behaviour-neutral
  honesty flag for agents dispatched for their provider/model binding only,
  whose system prompt is assembled in application code per call (the capability
  pattern) rather than read from the stored `persona` / `systemInstructions` /
  `guardrails` / `brandVoiceInstructions` fields. When set, the admin agent
  form's Instructions tab shows a non-dismissible callout and re-labels the
  "Effective prompt preview" as **not** what the LLM receives, so an operator
  isn't misled into tuning inert instruction fields. App-populated; round-trips
  through the agent create/GET/PATCH API and is captured in version snapshots.
  The runtime never reads it — no execution-path change. (#304)
- `runStructuredCompletion` (`lib/orchestration/evaluations/parse-structured.ts`)
  accepts optional `responseSchema` / `responseSchemaName` / `responseSchemaStrict`
  on `StructuredCompletionOptions`. When `responseSchema` is supplied it is
  forwarded as a `json_schema` `responseFormat` on both the first attempt and
  the temp-0 retry, so supporting providers enforce the output shape
  (OpenAI-compatible `response_format`; Anthropic forced-tool extraction)
  instead of relying on the prompt's prose alone. Purely additive — callers
  that don't opt in are unchanged, and providers without support ignore the
  field (the `parse` + retry path remains the cross-provider safety net). (#307)
- Streaming speech-to-text provider seam: optional `transcribeStream?()` on the
  `LlmProvider` interface (the streaming analogue of `transcribe()`), a new
  `TranscribeChunk` union (`partial` / `final` / `done` with `audioSeconds`) and
  `TranscribeAudio` type, and a `streamTranscription()` / `batchTranscribeAsStream()`
  helper (`lib/orchestration/llm/transcribe-stream.ts`) that prefers native
  streaming, falls back to adapting a batch `transcribe()` into a single
  `final` + `done` stream, and raises `ProviderError` `not_supported` when the
  provider can transcribe by neither path. Billed by `audioSeconds`, identical
  to the batch path. Platform seam only — the client transport and live
  `MicButton` mic layer remain a follow-up (the transport spike); the batch
  `transcribe()` path is unchanged and stays the default. (#308)

### Fixed

- Anthropic structured-output (forced-tool extraction) robustness on the
  `json_schema` `responseFormat` path: (1) the extraction tool name derived
  from `responseFormat.name` is now slugified + length-capped to satisfy
  Anthropic's `^[a-zA-Z0-9_-]{1,64}$` tool-name rule (a name with spaces or
  over the cap previously 400'd on Anthropic only); (2) a `max_tokens`
  truncation during extraction now raises the actionable `truncated_no_output`
  error instead of degrading into a malformed-JSON parse failure (the partial
  tool input was non-empty content, so the prior empty-output guard missed it);
  (3) a non-object-rooted schema is now rejected with a clear `invalid_schema`
  error rather than being silently coerced to `object` and sent as an
  incoherent `input_schema`. Behaviour change: callers passing a non-object
  root schema to Anthropic now get a local error (previously a provider-side
  failure). (#335)
- Agent export/import bundle now round-trips the full agent configuration.
  Previously the bundle silently dropped many `AiAgent` fields on export/import
  (`kind`, `persona`, `guardrails`, `personaMode`/`voiceMode`/`guardrailsMode`,
  `knowledgeAccessMode`/`knowledgeRetrievalMode`/`knowledgeTriggerKeywords`,
  `enableVoiceInput`/`enableImageInput`/`enableDocumentInput`,
  `runtimePromptManaged`/`runtimePromptNote`) and never wrote `maxCostPerTurnUsd`
  on import. The bundle now also carries the linked **profile** and granted
  **knowledge tags** by slug and re-links them on import; a referenced profile
  or tag missing in the target environment fails the import with an actionable
  message (rather than silently dropping the agent's identity / knowledge
  scoping). Agent→document grants are intentionally still not carried —
  documents lack a stable cross-environment key (tracked in #338). Older bundles
  remain importable (all new fields are optional/defaulted). (#332)

## [0.1.0] — 2026-06-24

> **Alpha release.** Second tagged Sunrise release. **MINOR bump** — adds new
> public surface (the `registerAppDriftProbe` drift-probe seam, the
> `User.accountType` field, and the `NEXT_PUBLIC_APP_NAME` brand seam) on top of
> the auth-bootstrap hardening and the orchestration fixes below. Ships in `0.x`
> per [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) —
> forks adopting this release should expect real merge work between any two `0.x`
> releases; the strict SemVer contract activates at `1.0.0`.

### Added

- **App-extensible database drift-probe seam — `lib/app/db-drift.ts`** (issue
  #284). A new auto-wired `lib/app/*` seam exporting `registerAppDriftProbes()`,
  so a fork can register its **own** Prisma-unmodelled DB objects (hand-written
  FK constraints, custom indexes, CHECK constraints) and have
  `npm run db:drift-check` (CI + `/pre-pr`) probe them alongside Sunrise's
  A-series — without editing the platform-owned `scripts/db/check-drift.ts`. New
  module `lib/db/drift-probes.ts` exposes the probe primitives (`indexExists`,
  `constraintExists`, `columnExists`) and registry (`registerAppDriftProbe`,
  `getAppDriftProbes`, `mergeDriftProbes`). `constraintExists`'s optional
  definition-substring argument is the documented home for a manual-FK `onDelete`
  policy (assert `ON DELETE CASCADE`/`SET NULL`), which the schema-level
  `onDelete` rule can't see. Registering a duplicate name, or one that shadows an
  A-series probe, throws. See `CUSTOMIZATION.md` §5 and
  `.context/database/prisma-unmodelled-objects.md`.
- **`AccountType` enum + `User.accountType` field** (`HUMAN` | `SERVICE`,
  default `HUMAN`) — a first-class axis, orthogonal to `role`, distinguishing
  real login users from non-login machine/system principals (the seeded
  config-owner). Migration `20260531115829_add_account_type`. New shared
  predicates `humanWhere` / `humanAdminWhere` / `serviceAccountWhere` in
  `lib/auth/account.ts` — the single source of truth every admin
  count/list/guard uses to exclude SERVICE principals.
- **`AuthBootstrap` Prisma model** (`auth_bootstrap` table) — a singleton marker
  recording that the one-time first-user-is-admin bootstrap has completed.
  Migration `20260531100706_add_auth_bootstrap`. New export: `AUTH_BOOTSTRAP_ID`
  from `lib/auth/constants.ts`.
- **`prisma/seeds/019-reconcile-legacy-seed-users.ts`** — one-time, idempotent
  upgrade reconciliation for databases seeded under v0.0.1: erases the legacy
  credential-less `admin@example.com` / `test@example.com` artifacts (preserving
  real users), re-points orphaned config ownership to the SERVICE owner, and
  marks the bootstrap complete on established instances.
- **`NEXT_PUBLIC_APP_NAME` brand seam** (issue #305) — a single optional env var
  renames the app's display name across page-title metadata (root + route-group
  layouts and the auth pages) and the email templates, with no file edits.
  Consumed via the new `lib/brand.ts` (`BRAND.name`), which reads
  `process.env.NEXT_PUBLIC_APP_NAME` directly so it is safe on both server and
  client; registered in `lib/env.ts` and `.env.example`. Defaults to `"Sunrise"`
  — unset leaves every surface byte-for-byte unchanged. Marketing-page body copy
  is intentionally out of scope (a separate content concern); `SUNRISE_VERSION`
  and internal platform identifiers deliberately do not use this seam.

### Changed

- **Auth bootstrap — first account on a fresh database becomes `ADMIN`.**
  `userCreateBeforeHook` (`lib/auth/config.ts`) promotes the first real account
  created on an empty database (email/password **or** OAuth) to `ADMIN`; every
  subsequent account is a regular `USER`. The promotion is one-time (gated on the
  `AuthBootstrap` marker, self-healing if a write is missed) and fails open — a
  DB error in the check never blocks signup. The seed unit formerly at
  `prisma/seeds/001-test-users.ts` is renamed to
  `prisma/seeds/001-system-owner.ts` and provisions a single non-login
  `system@sunrise.local` config-owner (`role: ADMIN`, `accountType: SERVICE`, no
  credential) instead of the login-able `admin@example.com` / `test@example.com`
  users. New export: `SYSTEM_USER_EMAIL` from `lib/auth/constants.ts`.
- **Orchestration seeds resolve the config owner deterministically** via
  `serviceAccountWhere` (the SERVICE account) rather than the first `ADMIN` row.

### Fixed

- **`PATCH /api/v1/admin/orchestration/settings` now accepts DB-managed model
  ids in `defaultModels`** (issue #302, Bug A). The handler hydrates the
  in-memory model registry from the `AiProviderModel` matrix before validating,
  so a discovery-added model (e.g. a date-stamped `gpt-5.5-pro-2026-04-23` that
  exists only in the DB, not the static registry) that the settings form offers
  in its dropdown is no longer rejected on save with `VALIDATION_ERROR` (400).
  Mirrors the other model-id paths (workflow execute, cost estimation) that
  already hydrate first.
- **`AiConversation` inbound unique key no longer triggers a phantom
  `ALTER INDEX ... RENAME` on every `prisma migrate dev`** (issue #283). The
  `@@unique([agentId, channel, fromAddress])` now pins its DB name with
  `map: "ai_conversation_inbound_key"`; Prisma 7's `migrate diff` ignored the
  `name:` argument for the DB object and re-derived the default name, injecting
  a spurious rename into every fork's generated migration. The Client-API
  compound key (`name:`) is unchanged, and existing deployed databases diff
  clean (no migration required).
- **Model discovery no longer mis-tiers date-stamped frontier models** (issue
  #302, Bug B). The name heuristics in `lib/orchestration/llm/model-heuristics.ts`
  now strip a trailing date stamp (`gpt-5.5-pro-2026-04-23`,
  `claude-3-5-sonnet-20241022`) before classifying, and recognise the flagship
  suffixes `pro` / `ultra` / `max` as frontier signals alongside `opus` and the
  o-series. A frontier "pro" model surfaced by discovery is now suggested as the
  `thinking` tier (→ `frontier` display) instead of falling through to
  `infrastructure` (→ `budget`). New export `stripModelDateStamp` from the same
  module. Operator review/override of a suggested tier is unchanged.
- **Knowledge document parsers no longer crash in a production build** (issues
  #315, #320). HTML and PDF ingestion threw only in the bundled production server
  (`next build && next start`) — invisible under `npm run dev` — so **any**
  production deployment (not just Vercel, where it first surfaced) returned a 500
  when ingesting those formats. Two independent bundling causes: jsdom ≥27's ESM
  `@exodus/bytes` fails to load under Next's production `require` path (pinned to
  `jsdom@^26`, with a Dependabot ignore for ≥27), and `pdf-parse` expects canvas
  globals (`DOMMatrix` et al.) that aren't present in the server bundle (now
  polyfilled). Parsers are also lazy-imported so a fork that doesn't ingest those
  formats never loads the browser-coupled deps.

### Security

- **Removed the documented-but-nonfunctional default seed credentials.** The
  README previously advertised `admin@example.com` / `test@example.com` with
  `password123`, but the seed never created the better-auth credential records,
  so those logins never worked. Sunrise now ships **zero default login
  credentials**; admin access is bootstrapped by the first-signup rule above.
- **Closed an admin re-bootstrap privilege-escalation window and related
  miscounts.** "Real human admin" is now a single predicate (`accountType:
  'HUMAN'`) routed through every admin count/list/guard — the last-admin
  self-delete guard, the bootstrap human-count, the admin dashboard stats, and
  the admin user list — so the non-login SERVICE config-owner can never be
  miscounted as an operator (which previously let the last human admin
  self-delete to zero and re-open the bootstrap). The SERVICE account is also
  immutable via the user-management API (`CANNOT_MODIFY_SYSTEM_ACCOUNT` /
  `CANNOT_DELETE_SYSTEM_ACCOUNT`), the bootstrap is gated on the persisted
  `AuthBootstrap` marker, and `SYSTEM_USER_EMAIL` is reserved at signup.

---

## [0.0.1] — 2026-05-30

> **Alpha release.** First tagged Sunrise release. Ships in `0.x` per
> [`VERSIONING.md`](./VERSIONING.md#0x-alpha-semantics--loose-by-design) —
> forks adopting this release should expect real merge work between any two
> `0.x` releases. The strict SemVer contract activates at `1.0.0`.

The entries below are the fork-readiness pass — the work that makes
Sunrise safe to fork and to merge upstream releases into.

### Added

- **Versioning infrastructure** — `lib/sunrise-version.ts` (`SUNRISE_VERSION`
  constant), `lib/app-version.ts` (`APP_VERSION` — the fork-owned counterpart
  derived from `package.json.version` via a direct import, eliminating the
  brittle `process.env.npm_package_version` detour), `VERSIONING.md`
  (public-surface contract), this `CHANGELOG.md`, and a `sunrise` field on
  the public `/api/health` response so any deployment exposes which Sunrise
  it's running. Includes `lib/validations/monitoring.ts` (Zod schema for
  runtime validation of the health-response shape at the client boundary).
- **Fork-extension seams** (the registries batch) — auto-wired `lib/app/`
  surface for forks to register their own capabilities, admin nav sections,
  rate-limit tiers/rules, and environment variables without touching platform
  code. Includes an ESLint app-boundary that keeps `lib/app/**` portable.
- **GDPR data erasure** — `eraseUser()` service with cascade / `SetNull`
  policies on every `User` FK, a last-admin guard, and an erasure-hook
  registry for app-side residual cleanup that the schema-level cascade can't
  reach (`lib/privacy/erasure-hooks.ts`). The seed of the full data-erasure
  pattern; see [`.context/privacy/data-erasure.md`](./.context/privacy/data-erasure.md).
- **Multi-tenancy playbook** — opt-in playbook with a `TENANCY_MODE`
  environment seam and an inert `lib/tenancy/client.ts` so a fork can retrofit
  Postgres RLS without forking the platform. Sunrise stays single-tenant by
  default. See [`.context/architecture/multi-tenancy.md`](./.context/architecture/multi-tenancy.md).
- **Public fork-onboarding guide** — `CUSTOMIZATION.md` at repo root, covering
  the app/platform model, the `lib/app/` extension surface, the `package.json`
  dependency/script policy, the database-schema split (your models go in
  `prisma/schema/app.prisma`), and the upstream-sync recipe.
- **Schema-folder split** — Prisma schema split into domain files under
  `prisma/schema/`, with `prisma/schema/app.prisma` reserved for fork-owned
  models. Keeps platform vs app models visually separable on every diff.
- **Migration baseline squash** — 106 dev-history migrations folded into a
  single fork-ready `prisma/migrations/` baseline. Forks adopting this
  release inherit a clean, reviewable migration history rather than the full
  pre-fork churn. See `.context/database/migrations.md` for the reconciliation
  recipe and `npm run db:drift-check` for the drift-detection tooling.
- **Capability quarantine / emergency-disable** — admin orchestration API
  surface for disabling a misbehaving capability without redeploying or
  unbinding it from agents. Includes quarantine-attribution metadata, a
  quarantined-capabilities banner on affected agent pages, and an active-
  quarantines dashboard panel under `/admin/orchestration`. See the
  orchestration admin API reference and `.context/admin/orchestration.md`.
- **Orchestration admin list endpoints — pagination, search, sort** —
  admin list endpoints under `/api/v1/admin/orchestration/**` (agents,
  knowledge documents) now accept paged/search/sorted query parameters,
  with corresponding admin tables wired to use them. Reduces the
  rehydration cost for forks running large agent/knowledge inventories.
- **Agent profiles** — shared persona / voice / guardrails library that
  multiple agents can attach, with override / append composition modes
  resolved at runtime. See `.context/admin/orchestration-agent-profiles.md`
  (admin UI) and `.context/orchestration/agent-profiles.md` (resolver).

### Changed

- **Rate limiting is middleware-driven.** Section caps for `/api/v1/**` are
  enforced by `proxy.ts` via the policy table at
  `lib/security/rate-limit-policy.ts` — new routes inherit the `api` cap
  automatically. Per-flow sub-caps (chat-stream, audio, upload, etc.) remain
  in the handlers. See [`.context/security/rate-limiting.md`](./.context/security/rate-limiting.md).
- **Knowledge-base default seeding is self-healing.** `npm run db:seed`
  re-derives the `kb_default` row when missing rather than failing fast on a
  pre-existing database that's lost the seed — relevant for forks pulling the
  squashed baseline into an existing dev environment.

---

[Unreleased]: https://github.com/human-centric-engineering/sunrise/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/human-centric-engineering/sunrise/releases/tag/v0.0.1
