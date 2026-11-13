# LLM Privacy Layer

Finds personal data in what Sunrise sends to external LLM providers, replaces
it with placeholders before the call, and restores it in the reply and in
tool-call arguments. It runs locally, with no external service and no per-use
cost. Every stage is an adapter an app can add to or replace. This is the
binding spec for §127 (`f-llm-privacy-layer`); tasks point here.

**It lowers exposure. It is not anonymisation.** Pseudonymised data is still
personal data under UK GDPR, so provider data processing agreements are still
needed. Say so wherever the layer is surfaced to an admin.

## Status

Built in pieces. A section below describes the design whether or not its task
has merged; this table says what exists.

| Part                                                                                   | Task   | State     |
| -------------------------------------------------------------------------------------- | ------ | --------- |
| Adapter contracts, registry, span validation, overlaps, runner, `lib/app/` seam        | t-988  | **Built** |
| Local detection tiers A–C, synthetic UK corpus and its precision/recall gate           | t-989  | **Built** |
| Placeholders: stateless token strategy, mask and restore, streams, tool-call arguments | t-990  | **Built** |
| The Proxy stage in `detect` mode, the privacy scope, global settings, per-type counts  | t-991  | **Built** |
| `pseudonymise`, `redact` and `block`; embeddings policy; output-guard change           | t-992  | **Built** |
| Agent mode, org floor (minimum mode), protected terms                                  | t-1010 | **Built** |
| A turn refused under `block` is left out of later history                              | t-1014 | **Built** |
| A `block` caused by an earlier message, the summary or the setup: placed and told      | t-1017 | **Built** |
| A `block` caused by a memory: the memory is deleted, and the user carries on           | t-1018 | **Built** |
| A reply whose embedding fails or is refused no longer holds the backfill back          | t-1016 | **Built** |
| Running a local embedding model: checked end to end, documented                        | t-1011 | **Built** |

## Quick Reference

| Need                           | Use                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| Register an app's adapters     | `initAppPrivacyAdapters()` in `lib/app/privacy-adapters.ts`                         |
| Add a detector                 | `registerPrivacyDetector(detector, { required?, timeoutMs?, replace? })`            |
| Replace the token strategy     | `registerPrivacyTokenStrategy(strategy)`                                            |
| Tighten policy for some calls  | `registerPrivacyPolicyResolver(resolver)`                                           |
| Receive per-call counts        | `registerPrivacyObserver(observer)`                                                 |
| Read everything registered     | `getPrivacyAdapters()` — `lib/privacy/adapters/registry.ts`                         |
| Run the detectors over text    | `runPrivacyDetectors(text, ctx)` — `lib/privacy/adapters/run.ts`                    |
| Apply the policy resolvers     | `resolvePrivacyPolicy(base, input)` — `lib/privacy/adapters/run.ts`                 |
| Notify observers               | `notifyPrivacyObservers(event)` — `lib/privacy/adapters/run.ts`                     |
| The contracts                  | `lib/privacy/adapters/types.ts` (type-only, safe to import from `lib/app/`)         |
| Sunrise's own default adapters | `lib/privacy/adapters/core-defaults.ts`                                             |
| Mask detected spans            | `maskText(text, spans, session, declaredTypes)` — `mask.ts`                         |
| Restore a reply, or tool args  | `restoreText()`, `restoreValue()` — `lib/privacy/pii/restore.ts`                    |
| Restore a stream               | `new StreamRestorer(session)` — `lib/privacy/pii/stream-restore.ts`                 |
| The stage on every vendor call | `applyPrivacyStage()` — `lib/orchestration/llm/privacy-stage.ts`                    |
| Mask a call, restore its reply | `maskMessages()`, `CallRestorer` — `lib/orchestration/privacy/call-masking.ts`      |
| Tell a local-only refusal      | `isLocalOnlyEmbeddingRefusal(err)` — `lib/orchestration/llm/privacy-stage.ts`       |
| Enter a scope for some work    | `withPrivacyScope()` / `runInPrivacyScope()` — `lib/orchestration/privacy/scope.ts` |
| Run one named agent's calls    | `runInPrivacyScope(agentPrivacyScope(agent.id), …)` — `scope.ts`                    |
| The agent's and org's settings | `scopePrivacySettings()` — `lib/orchestration/privacy/scope-settings.ts`            |
| Read a scope's counts          | `privacySummary(scope)` — the `PrivacySummary` written to metadata                  |

## What it protects

A turn can carry three kinds of risk, and they need different treatment:

| Kind                 | Examples                                                                 | Treatment                                                      | Where                             |
| -------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------- |
| Identifiers          | names, emails, phones, addresses, NI and NHS numbers, bank details, keys | Replaced with placeholders                                     | **This feature**                  |
| Confidential content | "signed off with depression", "30 redundancies in March"                 | Detected and routed to a local provider, or warned, or blocked | Sensitive-content routing feature |
| Media                | screenshots, scanned letters, PDFs                                       | Read locally, then masked or refused                           | Attachments feature               |

Replacing identifiers already helps with confidential content: "PERSON_1 has
been signed off" tells a provider much less than the original.

### What it does not protect

State these plainly in the admin UI and in `llm-providers.md`:

- **Embedding calls are counted but never masked.** A masked name cannot be
  searched for, and apps search knowledge by client and project name. Under
  `embeddingsPolicy: local_only` an embedding call to a provider that is not
  `isLocal` is refused instead. See [Embeddings](#embeddings).
- **Transcription is not covered.** Audio cannot be masked. Use a local
  transcription provider when protection matters.
- **Fork code that builds a provider object directly bypasses the layer**, as it
  already bypasses the eligibility gate (`llm-providers.md` § outbound-egress
  guarantee). Only providers from `getProvider()` pass through the Proxy.
- **Provider-side tools** (web search, code execution) receive placeholders and
  may give worse results.
- **Names without a cue, a list entry or a suffix are missed** by tiers A–C
  ("we're switching from Acme to Globex"). The optional local model is a
  separate feature.

## How a call flows

The stage sits in the provider-manager Proxy (`withInFlightTracking` in
`lib/orchestration/llm/provider-manager.ts`), after
`assertProviderCallPermitted` and `assertWithinSpendCaps`. Every vendor call
Sunrise core makes already passes through it, so no caller changes.

1. Resolve the policy: global settings, then the agent's mode and the org
   floor (core's resolver, `core.scope-settings`), then any app resolver —
   each can only tighten.
2. `off`: forward the call untouched. Local providers are skipped unless the
   policy protects them.
3. Detect: run every detector over the outbound text (messages, system prompt,
   tool results).
4. Act per mode: count (`detect`), replace and later restore (`pseudonymise`),
   replace for good (`redact`), or refuse (`block`).
5. Restore placeholders in the streamed reply and in tool-call arguments before
   dispatch, so a capability runs with real values (`pseudonymise` only).
6. Record per-type counts, never values, in message and execution metadata, and
   notify observers.

The privacy scope (org, conversation or execution, agent, known values,
resolved policy) is an AsyncLocalStorage store **on `globalThis`**, like the
tenant store (`lib/tenancy/context.ts`, #1188). The capability dispatcher runs
the instrumentation graph's code, so a per-graph store would read empty for a
model call a capability makes mid-turn, which would then lose the agent's
policy. A call with no scope gets an ephemeral one whose policy is the global
mode tightened by the org floor, never looser.

### What is built (t-991)

The stage runs in `off` and `detect`.

- **Which methods.** `PRIVACY_COVERAGE` in `provider-manager.ts` classifies
  every `LlmProvider` method, exhaustively like `METHOD_DISPOSITION`: `chat`
  and `chatStream` are scanned and acted on; `embed` and `embedMany` are
  scanned and counted, never altered; `transcribe` and `transcribeStream` are
  not covered; `listModels` and `testConnection` send no user content.
- **What is scanned.** Every message's text, text content parts, and every
  string inside an assistant message's tool-call arguments, joined into one
  input so a name tier C learns in one message is found in the others. Images,
  documents and provider reasoning blocks are not.
- **The scopes.** A chat turn enters one in `StreamingChatHandler.run()`; its
  agent and conversation are bound once loaded. A workflow execution enters
  one in `OrchestrationEngine.execute()`, and each step, sequential or a
  parallel branch, runs in a child of it whose counts also roll up into the
  execution's. A chat turn or a workflow run started inside other work (a step's
  `judge_call`, an agent another agent called, an agent's `run_workflow`) is a
  child of that work's scope, so its calls count there too. Known values are the user's own name and email
  (`userKnownValues()`), loaded once per scope and only when a call is
  actually scanned, so mode `off` reads nothing; a failed load is logged.
- **Where counts land.** `privacySummary()` writes per-type counts, the
  number of calls scanned, embedding counts apart, and any degraded call, to
  the assistant message that ends the turn's `metadata.privacy` (the answer,
  a pause for approval, a cost-cap stop or an error marker) and to each step's trace
  entry `privacy`. The conversation trace and the execution trace show them
  (`PrivacyCounts`). Values are never stored. **A count is how many times a
  type was sent**, not how many distinct values there were: every call
  resends the conversation so far, so a value in the history counts once per
  call that carried it, and again on a failover to another provider, which
  was sent it too. A call made outside any scope (knowledge ingestion, a
  background job) records nowhere, so it is not scanned at all unless an
  observer is registered or the policy says `block` on a detector failure.
- **Stricter modes** arrived with t-992, below. An embedding call is only
  ever counted.
- **Cost.** One detection pass over the joined text, per call. Measured on
  the development corpus, the median pass took 3 ms for 2 KB, 8 ms for 10 KB,
  26 ms for 50 KB, 112 ms for 200 KB and about 1 s for 2 MB, with no detector
  timing out. A tool loop re-scans the history on each call. The pass is
  bounded by `PRIVACY_PASS_DEADLINE_MS` (5 s), and by the call's own
  `options.signal` when the caller abandons it; detectors still running then
  are reported `aborted`, and the call goes ahead degraded unless the policy
  says `block`.

### What is built (t-1010)

An agent and an org can each require more protection than the install gives.

- **Only tighter.** An agent's mode (`AiAgent.privacyMode`) and an org's
  floor (`Org.settings.privacy.minimumMode`) are each one of `detect`,
  `pseudonymise`, `redact` or `block`, or `null` to inherit; `off` is not a
  choice, because it would say nothing (`PRIVACY_TIGHTENING_MODES`). A call
  runs under the strictest of the install's mode, the agent's and the org's,
  in any order. The agent field is called an override elsewhere in this spec;
  it overrides the install's mode only upward. An HR agent beside a public
  FAQ agent is the install in `detect` and the HR agent in `pseudonymise`.
- **Through the registry.** Core's first policy resolver,
  `core.scope-settings` (`scopeSettingsResolver()`), registered in
  `core-defaults.ts`, raises the mode from the call's `PolicyInput.agentId`
  and `orgId`. An app cannot replace or remove it: the registry refuses a
  `core.` id from an app, and resolvers have no `replace` as detectors do.
  An app's own resolvers run beside it and can only tighten further. The
  protected terms are not the resolver's: the stage gathers them. Its timeout is 5 s
  (`SCOPE_SETTINGS_RESOLVER_TIMEOUT_MS`), not the default 1 s: it reads the
  database on a scope's first call, and a resolver that times out refuses
  the call. The install's own mode needs no
  resolver: it is the base the stage starts from.
- **Read once per scope.** The agent's column and the org's slice are read on
  the first call in a scope and kept on it (`PrivacyScope.scopeSettings`),
  like the token session; nothing is cached at module level. A change applies
  from the next turn or step, and a turn never changes mode partway through
  its tool loop. A call with no scope reads each time. The stage runs the
  resolvers inside the call's scope, ephemeral or not, so the resolver and
  the protected-terms read share one read.
- **Fails closed.** A stored agent mode that is not one of those four, or an
  org slice that does not parse, throws inside the resolver, so the call is
  refused (`policy_resolver_failed`), `off` included. The warning names the
  agent or org and where to save it again; never the value.
- **Protected terms** are names an org always wants protected, each a
  `PERSON` or an `ORG`, at least three characters (tier B skips shorter), at
  most 500, the same name twice kept once. The stage adds them to the scope's
  known values, so tier B finds them and the ways people write them, and the
  mode decides what happens: counted, masked or refused. A type the install
  ignores is not ignored for an org that protects names of it: its own terms
  would otherwise be dropped, and fewer ignored types is the stricter
  policy.
- **The org is the install org at `single`** when nothing else names one:
  the stage takes the scope's org, else the tenant context's, else at
  `single` `INSTALL_ORG_ID`, as the spend caps do. A request on an admin API
  key enters no org, and its calls would otherwise skip the install org's
  floor and protected terms. At `multi` a call with no org is refused before
  the stage.
- **A reply's embedding carries its agent.** It runs outside the turn's
  scope, so the turn's counts do not change after it wrote them, but in a
  scope of its own carrying the agent (`queueMessageEmbedding`), and the
  backfill reads each message's conversation agent: under `local_only` the
  agent's mode refuses a remote embedding of its replies as it would inside
  the turn, on the first try and on every backfill tick. Nothing reads that
  scope's counts (`recordsNowhere`), so the stage skips the scan it skips
  for a call with no scope. Any privacy refusal counts as `skipped`, not
  `failed`: the stage has already logged why.
- **No failed or refused reply can hold the backfill back** (t-1016;
  owner ruling 2026-11-12: back off everything). Any failure of a reply's
  embedding, on the first try or in the backfill, gives it a retry time
  (`AiMessage.embeddingRetryAt`) and counts it (`embeddingFailures`): a
  privacy refusal (the `local_only` policy, an agent's mode that is not a
  mode, an app's policy resolver), a provider refusal (an org's provider
  policy), or an error (a local model rejecting a long reply). The wait is
  15 minutes after the first, one backfill interval, so a one-off error (a
  provider's rate limit) is picked up by the next run as before; then it
  doubles each time, at most a week from the eleventh failure on
  (`embeddingRetryDelayMs()`; owner ruling 2026-11-13). The backfill reads replies that never failed
  first, newest first, and gives whatever room is left to those whose
  retry time has come, the earliest first, so none can fill the batch. A
  reply that can never be embedded settles to one attempt a week, so an
  install where nothing can be embedded does little: a run of only failures
  that did not fill its batch is not work for the maintenance tick's idle
  gate. That holds while such replies fit the weekly retries, about 16,800
  per org (a batch of 25 a quarter-hour); a larger backlog keeps every run
  busy, and the gate open. A reply embedded after failing starts its count
  again, and `npm run embeddings:reset` clears every reply's retry time.
  Once nothing refuses a reply (a local embedding model installed, say), it
  is tried again within its current wait, up to a week for one
  that has failed many times, and due replies are drained at up to one
  batch (25) a run, in the room fresh replies leave. The backfill copies
  none of the stage's rules: until t-1016 it left out in SQL the two
  refusals it knew of, and could not see any other.
- **Every named-agent run carries its agent.** A workflow `agent_call` step
  (and so an orchestrator's delegation, which runs one) and a `chat_turn`
  step run the agent's provider calls in `agentPrivacyScope(agent.id)`: a
  child of the step's scope with the agent bound, whose counts roll up into
  the step's. A child, not the step's scope bound to the agent, because an
  orchestrator runs delegations to different agents at once on one step
  scope. A chat turn binds its agent on the turn's scope, as before.
- **Where it is set.** The agent form's Model tab (LLM privacy mode), through
  the core field registry; an org-owned field on a platform agent, so an
  org's choice survives every release. A stored value it cannot show is
  listed as not a mode this version knows, and a save keeps it until the
  admin chooses another, as the settings page does. The org page (`/admin/orgs/[id]`,
  "LLM privacy"), through `GET`/`PUT /api/v1/admin/orgs/[id]/privacy`:
  platform-admin only, like the provider policy, with both keys required on a
  replace. The form suggests the org's own name as a first term until the
  org saves; saving an empty set is stored, so the suggestion does not come
  back. The admin audit log keeps the floor and how many terms, never the
  names. An unreadable slice is shown with what still parses of it
  (`salvageOrgPrivacy()`), so the save that fixes it keeps that. Under a
  `block` floor the form warns that a protected term in an agent's own
  instructions, the org's name most often, refuses every call that agent
  makes.
- **Export and erasure.** The org export reads the org row whole
  (`exportOrgData()`, no `select`), so `settings.privacy` leaves with the
  org; `eraseOrg()` deletes the row. A config backup and an agent export carry
  the agent's mode; a stored value that is not a mode is left out, as the
  settings' mode is, so restoring it keeps the target's own. A version
  restore and a config restore take any stored string, so a version or a
  backup holding a mode this release does not know stays restorable and
  leaves that agent refusing until a mode is chosen. A restore or an agent import from before
  t-1010 has no mode for the agent, and an overwrite then keeps the agent's
  own, as the settings' mode is kept: an omission never loosens it.

### What is built (t-992)

The stage acts in every mode.

- **Masking.** Under `pseudonymise` and `redact` the detection pass is the
  same one input as in `detect`: every message's text, then the strings in
  its tool-call arguments, keys included, joined by a blank line. The spans
  are mapped back onto those pieces (one reaching across a separator is
  split, so every character stays masked). **Every exact copy** of a value
  found anywhere in the call, or masked by an earlier call in the scope, is
  masked too, where it stands on its own (not inside a longer word): a
  detector that needs context, such as a phone number only after a phone
  word, would otherwise leave a second copy in plaintext beside the
  placeholder for the first. A value that is one word of letters ("Will",
  "Grace") is not extended: elsewhere it is likelier an ordinary word, and
  tier C already finds the other mentions of a name it learns. Each piece
  is masked in order with the **scope's** token session (`maskMessages()`,
  `lib/orchestration/privacy/call-masking.ts`). The caller's messages are
  never changed: it keeps the real conversation and the next call masks it
  again. Options, tool definitions, images, documents and reasoning blocks
  go out as they came. `PLACEHOLDER_INSTRUCTION` is appended to the system
  prompt (the first system message that is not a turn instruction), or sent
  as a system message of its own when there is none, on **every** call under
  a masking mode, masked or not: added only once a value appeared, it would
  change the system prompt, the provider's cache prefix, partway through a
  conversation.
- **Restoring** (`pseudonymise` only) happens in the Proxy, so no caller and
  no capability changes: `chat` returns its response through
  `CallRestorer.response()`, `chatStream` its chunks through
  `CallRestorer.stream()`. Text is restored with `restoreText()`; a reply to a
  call with `responseFormat` is parsed and restored with `restoreValue()`
  (a streamed one is held whole and restored the same way at its end, so
  a restored quote or newline cannot break it); tool-call arguments with
  `restoreValue()`, keys included, before the caller dispatches them. A
  stream's text and its display reasoning each have a `StreamRestorer`, and
  what one holds back is released before any other chunk, so order is kept.
  Reasoning blocks are never touched. A placeholder no session issued is
  left visible and counted as `unresolved` on the trace.
- **`redact`** masks with `escapeLookAlikes: false` and never restores, so
  the reply, and any tool call the model makes, carries placeholders.
- **`block`** refuses a chat call with anything found (`content_blocked`,
  code `privacy_blocked`); a call with nothing found goes out untouched. The
  refused turn is left out of later history (t-1014, below), and so is
  whatever earlier held the details (t-1017, below), so the reader is told
  to ask again in the same conversation. When the details are in the
  assistant's setup, they are told to ask an administrator.
- **A required detector that fails under `pseudonymise`, `redact` or
  `block` refuses a chat call** (`detector_failed`), whatever
  `onDetectorFailure` says: sent, it would carry in plaintext what that
  detector would have found. For the masking modes this is the owner's
  ruling of 2026-11-11, after walking an HR grievance pack, a long tool loop
  and an app's external detector being down: a silent, irreversible leak in
  exactly the case protection was chosen for outweighs a rare refused turn.
  `block` follows from it (t-992 code review): without the refusal, a call
  whose detector failed would go out unrefused for want of a span, looser
  than `pseudonymise`. `detect` keeps going ahead degraded. An app that does
  not want refusal on its own detector registers it optional.
- **Unscoped calls** (a background job, a summariser outside a turn): a chat
  call is always scanned under a stricter mode, since the scan is what
  protects it. An unscoped embedding call (knowledge ingestion, a reply's
  embedding) is sent without a scan in every mode when nothing reads the
  result: it is never masked, so the scan would change nothing, and an
  external detector would be sent whole documents for nothing. The
  `local_only` check runs before this, so it still refuses one.
- **Embeddings policy.** See [Embeddings](#embeddings).
- **On the trace.** A refusal records its reason in the scope, so the
  `PrivacySummary` on the turn's error marker or the step's trace entry
  carries `refused`, and `PrivacyCounts` names it. Counts read "found": the
  summary's mode is the strictest any call in the scope ran under, so
  "masked" would overclaim for a scope that mixed modes.

### What is built (t-1014)

A chat turn refused under `block` no longer stops the conversation.

- **The problem.** The user message was saved before the first provider
  call, for the audit trail. So were any tool-call and tool-result rows from
  earlier passes of the tool loop. Every later turn resent them and was
  refused again.
- **The turn marks its own rows.** `streamChat` keeps the id of every row
  the turn persists. On `privacy_blocked` it sets
  `metadata.excludedFromHistory: 'privacy_blocked'` on each. The error marker
  is not marked: error markers are left out of history already.
  - It reads each row's metadata back first, so anything set since the turn
    wrote it is kept, and it updates only the rows that read finds, so one
    removed before it is skipped. The read and the update are not atomic: a
    write or removal in the moment between them is lost, or rolls the batch
    back. Nothing in core writes a message after creating it.
  - The write is confined to the caller's conversation (the owner layer).
  - It is best effort, like the error marker. If it fails, nothing retries
    it then. Nothing is sent while the rows are resent, and the next
    refusal that can say where it found the details (a chat call the handler
    made) finds the rows still in the prompt and marks them (t-1017).
  - No other refusal marks anything: `privacy_refused` is the operator's to
    fix, and the message did not cause it.
- **Every reader that resends a conversation leaves the rows out**, through
  `isLeftOutOfHistory()` (`lib/orchestration/chat/message-builder.ts`), the
  one check for both kinds of row a later call must not resend: these, and
  error markers (`metadata.error`):
  - the chat handler's history reads, which feed both the message builder and
    the summariser, so a summary never carries the details forward;
  - the `chat_turn` workflow step, which until now resent error markers too.

  The check is made in code, not as a Prisma JSON-path `NOT`, which would
  also drop every row with null metadata. Any `excludedFromHistory` value
  leaves a row out, so a
  reason added later is not let back in by a reader that does not know it.

- **The transcript keeps them.** The consumer and admin message routes, the
  evaluation log and the exports filter on nothing but the conversation.
- **Not changed:**
  - **Completing or rescoring an evaluation session** sends its logs,
    refused input included, to the judge. That is an analysis of everything
    that happened, not a conversation going on, and under `block` it is
    refused with the same code.
  - A `block` caused by something outside the turn was placed by t-1017,
    below.

### What is built (t-1017)

A `block` caused by something outside the current turn no longer refuses
every turn after it. Before t-1017 the turn's own rows were marked, which
were innocent, and the reader was told to ask again, which could not work.
That happened when the details were in:

- an earlier message or the stored summary, written before the mode was
  `block` (an agent's mode or an org's floor raised on a live
  conversation is enough);
- an earlier refused turn whose own marking failed;
- the assistant's setup.

- **The stage says where, never what.** A `content_blocked` refusal of a chat
  call carries `PrivacyRefusedError.found`: how many messages the call
  carried, and the indices of the ones that held a finding
  (`messagesHoldingSpans()`, `call-masking.ts`, which maps the spans back
  onto the messages the way masking does). Never a value, a type, or how
  many were found.
- **The handler knows where each message came from.**
  `buildMessagesAndBreakdown()` returns a source per message: the system
  prompt, the entity context, the memories' heading, a memory (by its index,
  t-1018), the summary, a note the builder wrote, a history row (by its
  index in what it was given), an opening turn or the user's message. A message past those was added by the tool loop
  this turn. The handler trusts a location only from a refusal of a call it
  made itself, for as many messages as it sent; otherwise it does what
  t-1014 does (`lib/orchestration/chat/privacy-refusal.ts`).
- **What is left out, and what the reader is told:**

  | Where the details were                               | Left out of later history                                        | Code                      | The reader is told                 |
  | ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------- | ---------------------------------- |
  | This turn: the message, or a tool result             | The turn's rows                                                  | `privacy_blocked`         | Ask again without them             |
  | An earlier row, or the stored summary                | Those rows' exchanges and the turn's; the summary becomes a note | `privacy_blocked_earlier` | Ask again; it may not remember all |
  | One of the user's memories (t-1018, below)           | The turn's rows; the memory is deleted                           | `privacy_blocked_memory`  | Ask again; it has forgotten it     |
  | The system prompt, entity context or an opening turn | The turn's rows                                                  | `privacy_blocked_setup`   | Ask an administrator               |

  **One case wins, and only it acts**: this turn, then the setup, then
  anything earlier, then a memory (t-1018). The rest are placed by the next
  attempt, if they still hold details. **A message is named only for
  details of its own** (t-1018): detection runs over the whole call, and
  tier C marks a surname or a company's short form wherever it appears once
  it has seen the full name, but the location leaves those learned matches
  out (`DetectedSpan.learned`, see _Spans_). So a name this turn introduces
  does not blame earlier rows, and a full name in a memory does not blame a
  persona that only repeats the surname, which would refuse every turn
  with nothing for an administrator to find. A known first name standing
  alone is a finding of its own (tier C reports it at 0.5), so a persona
  "You are Max" is the setup's to change. The log line ("Chat turn refused
  for personal details") names the kinds of source and how many rows,
  never a value.

- **An earlier row takes its exchange with it**: from where it begins to
  where the next one does. An exchange begins at a user message, or at an
  assistant row straight after a finished reply, one with text and no tool
  calls (a turn the agent opened, which persists no user row). An empty
  assistant row, such as a pending approval's marker, is not a finished
  reply. So no reply is resent without its question,
  or a question without its reply.
- **The summary is forgotten** (owner ruling 2026-11-12: the conversation
  carries on and forgets). Under `block` it can never be sent again, and it
  cannot be rebuilt from itself: the summariser's call would carry it and
  be refused. Its text becomes the gap note alone ("up to N earlier
  messages may not be described in this summary", N counting every row up
  to the pin), and the pin stays:
  - the rows it covered are never read again. Re-read, any that held
    details would be refused again, in the prompt or, past the cap, in a
    summariser call nothing can place;
  - the model is told what it no longer has, and later folds carry the note
    forward as they carry any gap;
  - only if the pin is still the one the turn read, so a summary a
    concurrent turn wrote is kept. A summary whose pin row has gone is
    cleared.
- **A judge** (`judge_call`) does not retry `privacy_blocked_setup`; it
  does retry `privacy_blocked_earlier`, since the refusal left out what
  caused it.
- **Not changed:**
  - **A refused summariser call names no row.** The summariser sends every
    row in one message, so its refusal (which it treats as a fallback)
    cannot say which. The stored summary is kept, the rows the cap drops are
    announced as omitted, and the summary does not move while those rows
    hold details. Degraded, not locked.
  - **The embed widget** shows its own fixed words for every error, as it
    did for `privacy_blocked`.
  - **Memories that hold details** were placed as the setup, so they refused
    every turn that user had with that agent and named no remedy. They have
    their own case now: see t-1018, below.
  - **An earlier exchange is left out without a note** in the prompt, as a
    refused turn is (t-1014). The transcript keeps it, and the reader is
    told the assistant may not remember everything.

### What is built (t-1018)

A memory that holds personal details no longer locks its user out of the
agent. A memory (`AiUserMemory`, written by the `write_user_memory`
capability) is sent in every conversation the user has with that agent. One
written before the mode was `block` (an agent's mode or an org's floor
raised after it remembered a name is enough) refused every turn, as
`privacy_blocked_setup`. That told the reader to ask an administrator, who
had nothing to change: no page or API deletes a memory, and the capability
that writes one needs an LLM call `block` refuses.

- **Each memory is its own message.** The builder sends the fixed heading
  ("[User memories] …"), then one system message per memory, so the
  stage's location names the memory. The text is the block the model was
  always sent, split at its lines, and the token breakdown counts the
  joined text; each part is framed as a message of its own. Anthropic
  takes them as separate system text blocks (the cache breakpoint is on the
  first), and OpenAI-compatible providers as separate system messages.
- **The memory is deleted** (owner ruling 2026-11-12: carry on and forget,
  as with the summary in t-1017). The turn is refused once as
  `privacy_blocked_memory`. The reader is told the assistant has forgotten
  something it remembered about them, and to ask again, and asking again
  works. The other memories are kept. If the mode is lowered later, the
  agent does not get the memory back; it learns it again if the user says
  it. Nothing needs to be stored to make this work, so the model, the
  export and the erasure are unchanged.
- **It is a compare-and-set** on when the memory was last written, so a
  memory a concurrent turn rewrote since this turn read it is kept. The
  delete is scoped to the user and the agent. It is best effort, like the
  marking: if it fails, the next refusal finds the same memory. A delete
  that fails, or that keeps a memory rewritten since, is logged with
  counts only.
- **It comes last**: this turn, then the setup, then anything earlier, then
  a memory. Deleting can't be undone and reaches every conversation, so
  while the setup holds details of its own nothing is deleted (it would
  not help until an administrator changes the setup), and an earlier row
  that holds them is left out first. A conversation raised to `block` with
  the name in both an earlier message and a memory is refused twice, as
  `privacy_blocked_earlier` and then `privacy_blocked_memory`, and goes on.
- **Only a memory that holds details of its own is deleted.** A surname
  or company short form the detector only learned from another message is
  left out of the location, so a memory that merely repeats a name found
  elsewhere is kept, and a persona that only repeats a remembered surname
  does not lock the user out (`DetectedSpan.learned`).
- **The log** counts memories, and names no key or value.
- **The setup's copy** now names only the setup ("The assistant's setup
  contains personal details …"): memories have their own.
- **A judge** (`judge_call`) retries `privacy_blocked_memory`, since the
  refusal deleted what caused it.
- **Not changed:**
  - **A memory older than the 50 newest** is not sent with the turn, so
    nothing places it. Read back by `read_user_memory`, its result is a
    tool result, placed as this turn (`privacy_blocked`). Degraded, not
    locked: the model has to ask for that memory by key again.

### Modes

| Mode           | Sends                                | Restores | Use                                                |
| -------------- | ------------------------------------ | -------- | -------------------------------------------------- |
| `off`          | the call, untouched                  | —        | the default on upgrade                             |
| `detect`       | the call, untouched; counts recorded | —        | the default on a new install; see what agents meet |
| `pseudonymise` | placeholders                         | yes      | protection with normal answers                     |
| `redact`       | placeholders                         | no       | the reply never needs the real value               |
| `block`        | nothing, if anything was found       | —        | refuse rather than send                            |

Strictness runs in that order (`PRIVACY_MODES_BY_STRICTNESS`).

## Adapters

Every stage is an adapter behind the registry, and **core uses the same
interfaces it exposes**: Sunrise's local implementation of each is registered
as a default adapter through the registry an app uses. If an app cannot do
something through an adapter, neither can core.

| Slot                    | Does                                               | Many or one          | Core default (task)                                          |
| ----------------------- | -------------------------------------------------- | -------------------- | ------------------------------------------------------------ |
| `PrivacyDetector`       | finds spans in text                                | many; results merged | `core.rules`, `core.known-values`, `core.lists`              |
| `PrivacyTokenStrategy`  | what a placeholder looks like and how it maps back | exactly one          | numbered, rebuilt per call (t-990)                           |
| `PrivacyPolicyResolver` | tightens the policy for a call                     | many; strictest wins | `core.scope-settings`: agent mode, org floor (t-1010)        |
| `PrivacyObserver`       | receives counts and ids per call                   | many                 | none: core's counts reach metadata through the scope (t-991) |

Two more slots arrive with the features that use them: `SensitivityClassifier`
(sensitive-content routing) and `MediaProcessor` (attachments). They are not
defined yet on purpose: an interface forks build on is public surface, and one
defined before anything consumes it is the one that turns out wrong.

### Loading

`getPrivacyAdapters()` installs core's adapters (`corePrivacyAdapters()`) once,
then runs the app's `initAppPrivacyAdapters()` once through
`createAppInitGate`, lazily, at the top of every read. Core's ids start with
`core.`; the registry refuses that prefix from an app.

**A throwing app init is rolled back and remembered.** `getPrivacyAdapters()`
then reports `appInitFailure`, and the stage refuses **every** call until the
init is fixed, mode `off` included, because a rolled-back resolver may have
been what raised the mode from `off`. This is the opposite of the degrade-style
seams on purpose: falling back to core alone would leave an app's required
detector, or its stricter resolver, missing with nothing saying so. A core
adapter that fails to install is reported separately as `coreFailure` and
refuses every call too, because the install stops at the first throw and core's
own policy resolvers may be among what is missing. Keeping the two apart means
neither message hides the other. See `fork-init-seams.md` § "The seams that do more
than degrade".

### Combining

- **Add** (the default): an app's detector runs alongside core's, and the spans
  are merged.
- **Replace**: `registerPrivacyDetector(d, { replace: 'core.<id>' })` turns one
  core detector off. It is the only way to, so it cannot happen by accident. The
  replacement is required unless it says `required: false`, because the core
  detector it stands in for was, and it runs and wins tie-breaks in that
  detector's place. A `replace` naming no registered core detector throws. The
  admin page shows replaced core detectors (`replacedCoreDetectors`).
- **Token strategy**: registering one displaces core's. A second app strategy
  throws.
- **Order**: `in_process`, then `self_hosted`, then `external`; registration
  order within each, core first. Detectors run one after another, so each sees
  what earlier ones found (`priorSpans`) — a service adapter can choose to run
  only where local checks found something.

### Writing a detector

```typescript
// lib/app/privacy-adapters.ts
import { registerPrivacyDetector } from '@/lib/privacy/adapters/registry';
import { policyNumberDetector } from '@/lib/app/privacy/policy-numbers';

export function initAppPrivacyAdapters(): void {
  registerPrivacyDetector(policyNumberDetector(), { required: true, timeoutMs: 400 });
}
```

A detector declares its `id`, its `egress` (`in_process` | `self_hosted` |
`external`), an optional `jurisdiction`, and every `entityTypes` value it may
report. `detect(input, ctx)` returns spans; `ctx.signal` aborts at the timeout.
`ctx.knownValues` carries what the layer already knows about the people in the
call, **except for an `external` detector, which gets none**: another processor
is sent the text it must scan and nothing more, because a known value may not
appear in the text at all.

**Don't** pass a service's offsets straight through:

```typescript
// ❌ Presidio counts code points; JavaScript counts UTF-16 code units.
return results.map((r) => ({
  type: r.entity_type,
  start: r.start,
  end: r.end,
  confidence: r.score,
}));
```

After any emoji the two disagree, the wrong text is masked, and the real value
goes out. **Do** convert at the adapter, and test it with astral characters
before the entity.

**Don't** register from `initApp()` (`lib/app/bootstrap.ts`) or make
`initAppPrivacyAdapters` async: the first fills a registry the stage never
reads, and the gate refuses the second as if it had thrown.

**Don't** put a value in an error message. The layer logs only the adapter's
id, the failure reason and the error's class name, but an observer or a log
line of your own is outside that.

### Egress

`external` is the case the layer exists to govern: it sends text to another
processor. In this feature the declaration is recorded and shown. The
service-adapters feature checks it against the org provider policy, so an org
that has not approved a service never has text sent to it.

## Spans

`validateSpans()` checks a detector's whole result before any of it is used. A
span is accepted when:

- `start` and `end` are integers with `0 <= start < end <= text.length`, as
  **UTF-16 code-unit** indices (what `String.prototype.slice` takes);
- `type` matches `ENTITY_TYPE_PATTERN` (`/^[A-Z][A-Z0-9_]{0,39}$/`) **and** is
  one the detector declared;
- `confidence` is a finite number in `[0, 1]`.

One bad span rejects the whole result: the detector is reported `malformed` and
contributes nothing. Extra fields are dropped, except `learned`, kept when it is
exactly `true` (t-1018).

**`learned`** says the detector matched a span only because it learned the value
from elsewhere in the same text: tier C sets it on a surname or a company's
short form marked after the full name. The span is masked and refused like any
other. A refusal under `block` leaves it out when it says which messages held
details, so the message the value was learned from is placed, not every message
that repeats it. Leave it out for a value found where it stands; anything but
`true` counts as that, so a wrong flag can only place as before it existed. A
merged span is learned only when every member was. The type pattern matters because
the type becomes part of the placeholder the model reads (`PERSON_1`); free text
there would be a prompt-injection path.

Core's types are `CORE_ENTITY_TYPES`. A detector may declare others (a fork's
country ID, say) provided they match the pattern.

### Overlaps

`resolveOverlaps()` merges overlapping spans into **their union**. Keeping only
the winner would leave the loser's non-overlapping part unmasked; the union costs
a few characters of context at most. The merged span takes the type of its most
specific member: highest confidence, then longest, then the adapter earliest in
run order (core before app within each egress), then the type name, so the result does not depend on arrival order.
Touching spans (`a.end === b.start`) stay separate.

**Ignored types are dropped before the merge, never after.** A merged span takes
one member's type, so filtering afterwards would let an ignored `LOCATION` that
overlaps an `ADDRESS` carry the whole address out unmasked. Pass the policy's
`ignoredEntityTypes` to `runPrivacyDetectors()`.

**Confidence doubles as specificity.** A checksum-valid match reports `1`, a
known value just below, a list guess well below. That is what makes a valid NHS
number beat a generic number, and a known value beat a list guess.

## When an adapter fails

The runner reports; the stage decides. Each adapter runs under its own timeout
(default `DEFAULT_DETECTOR_TIMEOUT_MS`, at most `MAX_DETECTOR_TIMEOUT_MS`),
enforced through its abort signal, and the run settles at the timeout even if
the adapter ignores the signal. Detectors run in sequence, so a per-detector
timeout bounds one detector, not the pass: the stage bounds the pass by passing
a deadline as the call's signal (`AbortSignal.timeout()`), and detectors left
when it fires are reported `aborted`.

| Failure                                                     | Reported as                            | What the stage does                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An optional detector fails or times out                     | `failures`, `required: false`          | Carries on; the call is marked degraded                                                                                                                          |
| A required detector fails (every core detector is required) | `failures`, `required: true`           | `onDetectorFailure: 'block'` refuses; `'fallback'` carries on, degraded                                                                                          |
| A policy resolver fails or returns a non-policy             | `failures` from `resolvePrivacyPolicy` | Refuses: the resolver may have tightened the policy                                                                                                              |
| An observer fails                                           | logged                                 | Nothing; observers are fire-and-forget                                                                                                                           |
| The app's init threw                                        | `appInitFailure`                       | Refuses every call, mode `off` included                                                                                                                          |
| A core adapter failed to install                            | `coreFailure`                          | Refuses every call, mode `off` included                                                                                                                          |
| The stored mode is not a mode                               | `settings_unreadable`                  | Refuses every call until a mode is chosen                                                                                                                        |
| A required detector fails under `pseudonymise` or stricter  | `detector_failed`                      | Refuses a chat call: sent, it would carry what was missed (owner ruling)                                                                                         |
| `block`, and something was found                            | `content_blocked`                      | Refuses with code `privacy_blocked`; the turn is left out of later history, and so is what earlier held it (t-1017) or a memory that held it is deleted (t-1018) |
| An external embedding call under `local_only`               | `embeddings_local_only`                | Refuses; each caller gives its own remedy (see Embeddings)                                                                                                       |
| An agent's mode or an org's privacy settings cannot be read | `policy_resolver_failed`               | Refuses every call for it; the log names the agent or org, not the value                                                                                         |
| A bug throws inside the stage, or settings cannot be read   | `stage_error`                          | Refuses. Never sends unmasked. The opposite of guard-floor, on purpose                                                                                           |
| The model mangles a placeholder                             | —                                      | Lenient restore; anything unresolved is left visible and counted                                                                                                 |

Every refusal ships its remedy: the user sees a plain message
(`privacy_refused` in `chat/error-messages.ts`), and the operator finds the
reason and its remedy (`refusalRemedy()`) in the refusal's log line. A refusal
is a `PrivacyRefusedError` with code `privacy_refused` and a `reason`; its
message is safe for anyone, because a workflow executor copies it to the SSE
client. It is a request fault: never retried (an `ExecutorError` with it in
its cause chain takes its code and is not retriable), never failed over to
another provider, never counted against a circuit breaker. A call the caller
abandoned while the stage runs is neither counted nor refused, and never
handed back: in any mode the stage throws the abort every provider throws
(`ProviderError`, code `aborted`). Handed back, a call abandoned during policy
resolution could go out under a policy missing the resolver that would have
raised it, to a provider that ignored its signal.

**Nothing logs request text or a found value.** Detectors and resolvers each get
a frozen copy of what they are handed, so none can change what the next one or
the caller reads. Observers get counts and ids only.

## Policy

`PrivacyPolicy` has four fields, and `tightenPolicy()` keeps the stricter value
of each:

| Field                   | Values                           | Stricter is                   |
| ----------------------- | -------------------------------- | ----------------------------- |
| `mode`                  | see [Modes](#modes)              | later in the strictness order |
| `ignoredEntityTypes`    | entity types left alone          | fewer (the intersection)      |
| `protectLocalProviders` | apply to `isLocal` providers too | `true`                        |
| `onDetectorFailure`     | `fallback` \| `block`            | `block`                       |

`ignoredEntityTypes` lists exclusions, not inclusions, so a type a new detector
introduces is protected by default. A resolver's answer is validated by
`privacyPolicyPatchSchema` (unknown keys refused: a misspelt field would be a
tightening that did nothing) and combined, never trusted to tighten by itself.

### Settings

| Setting           | Where                             | Values                                                          | Default                                                            | Task          |
| ----------------- | --------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ | ------------- |
| Mode              | global, agent override, org floor | the five modes globally; the four but `off` for an agent or org | `off` on upgrade, `detect` on a new install; agent and org inherit | t-991, t-1010 |
| Entity types      | global                            | per-type on or off                                              | identifiers on; `DATE` and `LOCATION` off                          | t-991         |
| Local providers   | global                            | protect or skip                                                 | skip                                                               | t-991         |
| Protected terms   | org (`Org.settings`)              | names always masked, each a person or an organisation           | empty; the form suggests the org's own name until the org saves    | t-1010        |
| Embeddings policy | global                            | `allow` \| `local_only`                                         | `allow`                                                            | t-992         |

The global values are columns on `AiOrchestrationSettings` (one row per
install): `privacyMode`, `privacyIgnoredEntityTypes`,
`privacyProtectLocalProviders`, and `privacyEmbeddingsPolicy` (t-992, `allow`
for every row). The migration that added the first three filled the row an
install already had with `off`, then made `detect` the column default for a row
created afterwards; it never writes a mode into a row. The settings API, the
settings page and a config restore accept the modes in
`PRIVACY_MODES_AVAILABLE`, all five since t-992; the page saves a stored mode it
cannot show only if the admin chooses another. A
stored mode that is not a mode reads as `null`, and the stage refuses every
call until one is chosen. The org floor and protected terms are the `privacy`
slice of `Org.settings` (`{ minimumMode, protectedTerms }`), read and written
through `lib/tenancy/org-settings.ts` (`readOrgPrivacy()`, `writeOrgPrivacy()`)
like the provider policy and quotas, and read whole, failing closed, like the
provider policy. The agent's mode is the `privacyMode` column on `AiAgent`,
declared in the core field registry
(`lib/orchestration/agents/agent-field-registry.ts`). Every field gets a
`<FieldHelp>`. See _What is built (t-1010)_.

## Detection

Three core detectors, all `in_process` and required, registered in
`lib/privacy/adapters/core-defaults.ts` and reached only through the registry.
They run in this order, and each is handed what the earlier ones found.

| Id                  | Tier              | Finds                                                                                       | File                              |
| ------------------- | ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------- |
| `core.rules`        | A. Rules          | identifiers with a fixed shape: the table below                                             | `lib/privacy/pii/rules.ts`        |
| `core.known-values` | B. Known values   | what the stage passes in `ctx.knownValues`, and the variants people write                   | `lib/privacy/pii/known-values.ts` |
| `core.lists`        | C. Lists and cues | other people's names, street addresses, companies with a legal suffix; English, capitalised | `lib/privacy/pii/lists.ts`        |

An app replaces one by id: `registerPrivacyDetector(mine, { replace: 'core.lists' })`.

### Tier A

| Type                 | Reported when                                                                                                                                                                                                                                                                                         | Confidence |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `EMAIL`              | address shape                                                                                                                                                                                                                                                                                         | 1          |
| `CARD_NUMBER`        | a scheme's prefix and length, and Luhn                                                                                                                                                                                                                                                                | 1          |
| `IBAN`               | ISO 13616 mod 97, and the country's length where known                                                                                                                                                                                                                                                | 1          |
| `NHS_NUMBER`         | mod 11, and printed 3-3-4 or with a health word before it                                                                                                                                                                                                                                             | 1          |
| `UK_VAT`             | HMRC mod 97 / 9755; without `GB`, only with "VAT" before it                                                                                                                                                                                                                                           | 1          |
| `UK_NINO`            | HMRC's letter rules and a suffix; without the suffix, or in lower case, only with context                                                                                                                                                                                                             | 1 / 0.9    |
| `SECRET`             | a published key prefix, a JWT or a PEM private key; a value assigned to a credential name, including `.env` names (`DB_PASSWORD=`) and quoted JSON keys — any value after a password name, a credential-shaped one after the others (`token`, `secret`, `api_key`) or after "is"; a PIN of 4–8 digits | 1 / 0.9    |
| `UK_DRIVING_LICENCE` | DVLA shape with a possible encoded date; certain with a licence word                                                                                                                                                                                                                                  | 0.95 / 1   |
| `POSTCODE`           | Royal Mail position rules; the space is required unless written in capitals                                                                                                                                                                                                                           | 0.95       |
| `SORT_CODE`          | with a banking word, or an account number beside it                                                                                                                                                                                                                                                   | 0.95       |
| `BANK_ACCOUNT`       | eight digits with an account word, or a sort code beside it                                                                                                                                                                                                                                           | 0.95       |
| `UK_UTR`             | ten digits with a tax word                                                                                                                                                                                                                                                                            | 0.95       |
| `UK_PASSPORT`        | nine digits with "passport"                                                                                                                                                                                                                                                                           | 0.95       |
| `IP_ADDRESS`         | IPv4 octets, not after "version" or "v"; IPv6 the URL parser accepts, with four groups or a real prefix (so not `cafe::1`)                                                                                                                                                                            | 0.95       |
| `PHONE`              | `libphonenumber-js` (full metadata) calls it valid; or possible, with a phone word before it                                                                                                                                                                                                          | 0.9 / 0.85 |
| `DATE_OF_BIRTH`      | a date with a birth word just before it ("born on the", "DOB -"): day first, year first, or US order when the day makes it plain; other dates are left alone                                                                                                                                          | 0.9        |

National phone numbers are read as UK. Phones sit low on purpose: the library
finds a number in many digit runs, so a UTR or NHS number overlapping one
names the span. A `SECRET` assigned to a name covers the value only, so the
model still sees that a password was there.

### Tier B

Exact matches report 0.98; a variant 0.9. Variants: for `PERSON`, with any
title or suffix set aside ("Dr. Jane Hart Jr." is Jane Hart), the first or
last name alone (three letters or more; a part that is also a word, such as
Will, only capitalised), an initial and surname, and surname first with or
without a comma; for `ORG`, the name without its legal suffix (capitalised
only when it is one word) and its first word (capitalised, not a common word
or first name); for `PHONE`, the number's own digits written nationally or
internationally with any separators. Every other type matches exactly, ignoring case and
spacing. Values under three characters are skipped, and so is a known value of
a type tier B does not declare (every core type): an undeclared type would
make the registry reject the whole result, and a required core detector
failing refuses the call. Gathering the values is the stage's job (t-991,
t-1010), not this tier's.

### Tier C

Confidence by how the guess was made: a company with a legal suffix 0.85, its
short form 0.75 and first word 0.7; a street address 0.8; a name after a title
0.8; a full name, or a name after a closing line, 0.75; a learned name part or
a name after a cue 0.7 (0.6 when no list has it); a known first name alone 0.5.

What it learns, it learns from one `detect` input and forgets after: a company
found with its suffix marks its short form elsewhere in that text, and a full
name marks its parts (matched capitalised). **The stage should therefore pass
a call's messages as one input**, or a name learned in one message will not
mark the next. Each match it learned is marked `learned` (see _Spans_).

A street word that is also a common surname (Green, Hill, Park) counts as part
of a name; numbered, or after an address cue, the street is still an address,
and the address names the merged span.

Stoplists keep names that are also words (May, Will, Grace), places (Reading,
Chelsea), nationalities, days and months out of the lone-name rule, and an
allowlist of public bodies, banks, brands and products (NHS, HMRC, Barclays,
Microsoft, Claude) out of every rule. A fork with names of its own to leave
visible replaces `core.lists`.

### Timing

The detectors are synchronous. Once 20 ms of work has passed since the last
turn, each gives the event loop a turn and then checks its signal, so a
timeout that expires during the work is reported as a timeout, never accepted
late. Quick work never waits: a turn costs at least a millisecond.

Each tier is linear in the text, and the cost of names and known values does
not multiply by it. Tier C marks learned names by token lookup. Tier B runs a
value's patterns only around occurrences of its rarest word, and skips a value
the text never mentions after one look-up. Measured on a laptop:

| Input                                            | Time              |
| ------------------------------------------------ | ----------------- |
| 111 KB with 2,000 distinct full names (tier C)   | 22 ms             |
| 111 KB, 200 known people all mentioned (tier B)  | 29 ms             |
| 111 KB, 200 known people none mentioned (tier B) | 4 ms              |
| 540 KB, about a 128k-token context (all three)   | 0.3 s             |
| 2 MB (all three)                                 | 1 s, tier A ≈ 1 s |

At around 2 MB, tier A nears its default 1 s timeout. **What the stage does
with it (t-991):** a required detector that times out marks the call
degraded, and it goes ahead under the default `onDetectorFailure: 'fallback'`;
only a policy that says `block` refuses it. In `detect` nothing is altered
either way, so refusing would protect nothing. **Under `pseudonymise`,
`redact` and `block` a chat call refuses (t-992)**, since a degraded call there
would send what the timed-out detector would have found. The binding limit is each detector's own
timeout (`DEFAULT_DETECTOR_TIMEOUT_MS`, 1 s), not the pass deadline. A timer cannot interrupt one piece of synchronous work, so a
single piece still blocks the process for as long as it takes.

### Bundled lists

Generated once and committed as `lib/privacy/pii/data/*.generated.json`
(Prettier-ignored); lower case, letters with internal apostrophes or hyphens.

| List        | Source                                                                  | Filter                      | Size   | Licence                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------- | --------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First names | ONS, _Baby names in England and Wales: 2024_, Table 6, boys and girls   | count ≥ 5                   | 11,914 | Open Government Licence v3.0. Attribution: "Source: Office for National Statistics licensed under the Open Government Licence v3.0." © Crown copyright 2025 |
| First names | US Census Bureau, 1990 census `dist.male.first` and `dist.female.first` | all (merged with the above) |        | Public domain (a US Government work, 17 U.S.C. §105)                                                                                                        |
| Surnames    | US Census Bureau, 2010 census surnames (`Names_2010Census.csv`)         | rank ≤ 15,000               | 15,001 | Public domain (a US Government work, 17 U.S.C. §105)                                                                                                        |

The Census lists drop apostrophes ("OBRIEN"), so lookups also try a name
without them, and a double-barrelled name counts when each part does
(`isFirstName()`, `isSurname()` in `lexicon.ts`). `lexicon.test.ts` pins the
sizes above, so a regeneration has to update this table too.

### Measured

`tests/unit/lib/privacy/pii/corpus.test.ts` runs the labelled corpus in
`tests/fixtures/privacy/pii-corpus/` through `runPrivacyDetectors()` and fails
when any type's recall or precision drops below
`tests/fixtures/privacy/pii-corpus/baseline.json`, or the corpus changes
without the baseline being re-recorded. Recall counts a value as found only
when every character is masked, by a span of any type; precision counts a
span as right when it overlaps a labelled value.

Two sets, recorded separately:

- **Development** (109 cases, 296 values): written alongside the detectors,
  across support, HR, health, finance and B2B, plus templates and an
  adversarial set. Every type is at recall 1 except `PERSON` (0.98), and
  every type at precision 1. These figures say the designed cases work; they
  do not say how the tiers do on text nobody tuned them for.
- **Held-out** (46 cases, 216 values): written by an author who never saw the
  detector code. The closer estimate: `PERSON` recall 0.76, precision 0.97;
  `ORG` recall 0.74; `ADDRESS` recall 0.86; `PHONE` recall 0.94, precision
  0.88; `IP_ADDRESS` precision 0.8; every other type 1. Seven defects it
  exposed were fixed before these were recorded: a phone written
  `(07700) 900184`; a known name written surname first; a known company by
  its first word; a password with no separator; contractions ("I've") and
  short acronyms ("NINO") taken for names; day abbreviations ("Thu") taken
  for names. Nothing else was changed in response to it. Later, `ORG` recall
  rose from 0.68 when a code review asked for "Co" as a legal suffix.

What it misses, by design or not yet:

- **Names in lower case** ("hi its sarah") and names no list has (many South
  Asian and West African first names are absent from both sources): tier C
  needs a capital or a list. Tier B still catches a known name in any case.
- **Nicknames** of a known person ("Gwil" for Gwilym).
- **Companies without a legal suffix** ("Brightwater Dental Group") unless
  they are known values.
- **A protected term written differently from its value** ("Kittiwake" for
  "Project Kittiwake"): a term is stored as the admin types it, so each form
  people write is a term of its own.
- **Two-letter names** ("Jo"): below the variant length, to keep ordinary
  words out.

## Placeholders

The default token strategy is `core.stateless` (`lib/privacy/pii/token-strategy.ts`).
An app replaces it with `registerPrivacyTokenStrategy()`.

- **Format: `[PERSON_1]`.** Typed and numbered, so the model can still tell
  who is who. Measured on 2026-11-11 with four shipped models (Claude Haiku
  4.5, Claude Sonnet 4.6, GPT-4o-mini, GPT-5-mini). Each was given a masked
  support message and asked to write a reply and a JSON object using six
  placeholders, three times for each of six styles. Every style was copied
  exactly every time a model used it (102–108 mentions per style). So the
  choice rests on collisions: `{{…}}` and `{…}` are Sunrise's own workflow
  template syntax; `<…>` reads as an HTML or XML tag, which a renderer may
  strip and which Claude prompts use for structure; bare `PERSON_1` collides
  with identifiers in code; `⟦…⟧` is unusual. `[…]` shows as written in
  Markdown, unless a `(url)` follows it.
- **Numbering by first appearance**, per type. One value gets one
  placeholder whatever type it is reported as. Values are compared exactly,
  so restoring gives back exactly what was masked. History is append-only,
  so earlier turns mask the same way on every call, and provider prompt
  caching keeps working. A property test checks this over growing histories.
- **No vault.** Every call sends the full conversation, and providers are
  called statelessly. The map lives in memory for one scope (a chat turn, a
  workflow step, or one unscoped call) and is discarded with it
  (`PrivacyScope.tokenSession`). Within a scope a value keeps its
  placeholder even when a later call detects a value an earlier one
  missed, which numbering by first appearance alone would renumber; a
  reasoning block replayed from the earlier call would then point at the
  wrong value. A new scope numbers by first appearance. The t-990 check found no `store: true`, no
  `previous_response_id` and no batch API in `lib/orchestration/llm/`; the
  Responses path sends `store: false`. A code-execution container is reused
  only within one reply's tool loop, where numbering is the same anyway. If
  Sunrise ever adopts provider-side state, that change must add a persistent
  strategy, with its `SUBJECT_DATA_SOURCES` row and erasure path.
- **Text that already looks like a placeholder is masked too**, as
  `[LITERAL_n]`. Otherwise a user who typed "PERSON_1", or a document that
  contains it, would have it restored into someone's name. The search runs on
  each stretch of text between spans on its own, so a span that cuts through
  one, or masking that would create one ("PERSON_1x" with "x" detected), is
  caught. The stage passes every type the registered detectors declare
  (`declaredTypes`, required), so a look-alike of a fork's own type is masked
  even before the first real value of that type appears. Look-alikes are
  counted in `literals`, apart from the per-type detection counts.
- **A replacement strategy must write `[TYPE_n]`** (`formatPlaceholder()`).
  Restoring, its leniency and look-alike masking all read that grammar. The
  registry tries a strategy that stores nothing once at registration, for
  `PERSON` and `LITERAL` and without an `orgId` (which is optional), and
  refuses one that writes another form or cannot map a placeholder back.
  A persistent strategy is not tried, because its sessions may write to its
  tables; it must follow the same form. `LITERAL` is reserved: a detector
  that declares it is refused.
- **A mode that never restores** (`redact`) passes `escapeLookAlikes: false`,
  so text that only looks like a placeholder, such as a template's
  "[PERSON_2]", reaches the model as written. A property test checks that `restoreText(maskText(x)) = x` over
  generated inputs.
- **Lenient restore.** `PERSON_1`, `[PERSON_1`, `PERSON_1]`, `[PERSON_1]'s`
  and a placeholder inside a JSON string all restore. Brackets are consumed
  only as a pair: a lone one is the model's own (`[Contact PERSON_1](mailto:…)`
  is a Markdown link), so it stays. A link whose text is exactly a
  placeholder, `[EMAIL_1](mailto:EMAIL_1)`, restores as plain text, because
  masked user text such as "James Hart(CEO)" looks the same. Values go in as they
  are: restore JSON by parsing it and using `restoreValue()`, never as raw
  text, because a value containing a quote would break it. Only a placeholder the
  session issued is replaced. Any other, such as a made-up `[PERSON_9]` or a
  renumbered `PERSON_01`, is left visible and returned in `unresolved`,
  never guessed. `MY_PERSON_1` and `PERSON_12` are not `PERSON_1`.
- **Streaming.** `StreamRestorer` holds back the end of the text while it
  could still become a placeholder: an opening bracket, or a run of capitals
  starting a word. It holds at most 64 characters. It carries one character
  of context, so a stream restores exactly as the whole text would however
  it was split. Tests split every fixture at every position. It looks at only
  the last 65 characters on each chunk. A placeholder-shaped run longer than
  64 characters is released, so its `unresolved` entry can differ from
  restoring the whole text; the emitted text does not.
- **Tool calls.** `restoreValue()` restores every string in the parsed
  arguments, at any depth, keys included, before the dispatcher runs them. A
  restored key that another key already spells keeps its placeholder and is
  reported. It runs on the parsed object, not on JSON text, so a value
  containing a quote cannot break the JSON. It returns `unknown`, because the
  capability validates its arguments as it always does. Tool results are
  masked on the next outbound call. Capabilities need not know the layer
  exists.
- **Prompt line.** `PLACEHOLDER_INSTRUCTION` (`mask.ts`) is the line the
  stage adds to every call under a masking mode: placeholders are
  stand-ins, and they should be copied exactly. Every call, not only those
  that masked something, so the system prompt never changes partway through
  a conversation and provider prompt caching keeps working.
- **Output guard.** Its identifier check runs `core.rules` (or the app
  detector that replaced it, unless that one is `external`: the guard runs in
  every mode, `off` included, and must not post replies to a service no
  setting sent them to) through the runner (`detectorIds`). It ignores an
  identifier one of the messages the call sent already contains, as people
  write it (separators allowed between characters) and standing on its own,
  so a sort code is not "supplied" by an order reference that contains its
  digits; and the types the settings ignore (`privacyIgnoredEntityTypes`). Tiers B and C are
  not used: a famous name would be flagged, and `block` discards the reply. A
  scan that could not finish flags nothing and logs which detector failed. See
  [Output Guard](../orchestration/output-guard.md).

A persistent strategy stores personal data: it declares `persistent: true` and
names its models in `storesIn`, and the registry refuses one that does not.
**The registry checks only that the list is non-empty**, not that each model is
in `SUBJECT_DATA_SOURCES` or the erasure path. A vault table with a `userId`
foreign key is caught by the export-sources schema test anyway; one keyed by
something else is not. No persistent strategy exists yet; checking each named
model against the manifests belongs with the service-adapters feature.

## Embeddings

Ruled at claim, 2026-11-11, from real deployments:

- Embedding calls (`embed`, `embedMany`) are detected and counted, **never
  altered**. Masking every input breaks search by name, which apps such as the
  Hub sidekick depend on; masking only the query protects little, because the
  knowledge base usually holds the same names from upload.
- `embeddingsPolicy: local_only` (column `privacyEmbeddingsPolicy`,
  install-wide, because the embedding provider is) refuses an embedding call
  to a provider that is not `isLocal` when the mode is `pseudonymise` or
  stricter (`embeddings_local_only`). Each caller recognises it with
  `isLocalOnlyEmbeddingRefusal()`: a reply's embedding
  (`queueMessageEmbedding`) is skipped and logged at info; a refused
  `search_knowledge_base` returns the tool error `embeddings_local_only`,
  which the model can relay; the admin search test answers 409
  `EMBEDDINGS_LOCAL_ONLY` and the MCP knowledge resource an error body, each
  with the reason; a `rag_retrieve` step fails with the refusal's message; a refused upload stores the refusal's own
  message, which names the setting, as the document's `errorMessage`. A
  stored value that is not a policy reads as `local_only`.
- The settings page warns when the mode is `pseudonymise` or stricter,
  embeddings go to a provider that is not `isLocal`, and the policy is
  `allow`. Whether the provider is local comes from
  `GET …/knowledge/embedding-status?providerOnly=true` (`providerIsLocal`,
  from `resolveEmbeddingStatus()`, without the chunk counts); when no
  provider resolves, it makes no claim. It also warns, the other way round,
  when the policy is `local_only` and that provider is not local: every
  embedding would be refused.

Pseudonymised chat plus a local embedding model keeps names off every third
party while search keeps full quality, because tool arguments are restored
before dispatch. **`isLocal` means the provider runs on infrastructure the
operator controls.** Marking a vendor's API `isLocal` already exempts it from
spend caps; it also exempts it from this layer. Setting one up, the two places
it can run, and what switching costs: [Running a local embedding
model](../orchestration/knowledge.md#running-a-local-embedding-model).

## Testing

- Detection and mask/restore are pure: unit and property tests
  (`restore(mask(x)) = x`; a stream split at every character position).
- A labelled synthetic UK corpus is the precision/recall gate; there are no live
  conversations to tune on. See _Detection — Measured_.
- `tests/unit/lib/privacy/pii/registry-only.test.ts` fails if any module but
  `core-defaults.ts` imports a detector, or anything but the runner calls
  `detect`.
- The stage is tested with a fake provider (`registerProviderInstance`),
  asserting on the exact request body (`provider-manager.privacy.test.ts`).
  `npm run smoke:privacy` (`scripts/smoke/privacy-leak.ts`) runs a chat turn
  with a tool loop and a workflow `llm_call` against the dev DB under
  `pseudonymise`, through recording fake providers: no seeded value reaches
  either, the reply and the step output come back restored, the tool runs
  with real values, and under `local_only` the search and the reply
  embedding are refused. It also runs `off` and checks the request is
  unchanged.
- `tests/unit/lib/orchestration/privacy/scope-settings.test.ts` runs every
  (global, agent, org) mode combination through the real stage and expects
  the strictest, by `PRIVACY_MODES_BY_STRICTNESS`, the one ordering; it fails
  if the floor replaces the mode instead of raising it.
- The registry and runner tests (`tests/unit/lib/privacy/adapters/`) mock both
  the app seam and core's defaults: their subject is the registry and the
  runner, not core's detectors, which have their own tests.

## Not in this feature

Each is its own feature, depending on this one: service adapters (a generic HTTP
detector, egress enforcement, the conformance kit, Presidio/Comprehend/Azure
recipes); attachments; sensitive-content routing; the optional local NER model;
a persistent pseudonym vault, the only way to mask embedding inputs and still
search by name.

## Related Documentation

- [Subject Access Export](./data-export.md) — the manifest a persistent token strategy's table must join
- [Account Deletion & Right to Erasure](./data-erasure.md) — the erasure path it must join too
- [Fork Init Seams](../architecture/fork-init-seams.md) — the gate, and why this seam refuses rather than degrades
- [LLM Providers](../orchestration/llm-providers.md) — the egress guarantee, `isLocal`, the Proxy
- [Output Guard](../orchestration/output-guard.md) — the reply-side PII check this layer changes
- [Org identity](../tenancy/identity.md) — `Org.settings`, where the org floor lives
