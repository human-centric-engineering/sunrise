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
| Local detection tiers A–C, synthetic UK corpus and its precision/recall gate           | t-989  | Planned   |
| Placeholders: stateless token strategy, mask and restore, streams, tool-call arguments | t-990  | Planned   |
| The Proxy stage in `detect` mode, the privacy scope, global settings, per-type counts  | t-991  | Planned   |
| `pseudonymise`, `redact` and `block`; embeddings policy; output-guard change           | t-992  | Planned   |
| Agent override, org floor, protected terms                                             | t-1010 | Planned   |
| Running a local embedding model: checked end to end, documented                        | t-1011 | Planned   |

## Quick Reference

| Need                           | Use                                                                         |
| ------------------------------ | --------------------------------------------------------------------------- |
| Register an app's adapters     | `initAppPrivacyAdapters()` in `lib/app/privacy-adapters.ts`                 |
| Add a detector                 | `registerPrivacyDetector(detector, { required?, timeoutMs?, replace? })`    |
| Replace the token strategy     | `registerPrivacyTokenStrategy(strategy)`                                    |
| Tighten policy for some calls  | `registerPrivacyPolicyResolver(resolver)`                                   |
| Receive per-call counts        | `registerPrivacyObserver(observer)`                                         |
| Read everything registered     | `getPrivacyAdapters()` — `lib/privacy/adapters/registry.ts`                 |
| Run the detectors over text    | `runPrivacyDetectors(text, ctx)` — `lib/privacy/adapters/run.ts`            |
| Apply the policy resolvers     | `resolvePrivacyPolicy(base, input)` — `lib/privacy/adapters/run.ts`         |
| Notify observers               | `notifyPrivacyObservers(event)` — `lib/privacy/adapters/run.ts`             |
| The contracts                  | `lib/privacy/adapters/types.ts` (type-only, safe to import from `lib/app/`) |
| Sunrise's own default adapters | `lib/privacy/adapters/core-defaults.ts`                                     |

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

1. Resolve the policy: global settings, then the agent override, then the org
   floor, then any app resolver — each can only tighten.
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

| Slot                    | Does                                               | Many or one          | Core default (task)                        |
| ----------------------- | -------------------------------------------------- | -------------------- | ------------------------------------------ |
| `PrivacyDetector`       | finds spans in text                                | many; results merged | tiers A–C (t-989)                          |
| `PrivacyTokenStrategy`  | what a placeholder looks like and how it maps back | exactly one          | numbered, rebuilt per call (t-990)         |
| `PrivacyPolicyResolver` | tightens the policy for a call                     | many; strictest wins | settings, agent, org floor (t-991, t-1010) |
| `PrivacyObserver`       | receives counts and ids per call                   | many                 | message and execution metadata (t-991)     |

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
refuses every call whose mode is not `off`; keeping the two apart means neither
message hides the other. See `fork-init-seams.md` § "The seams that do more
than degrade".

### Combining

- **Add** (the default): an app's detector runs alongside core's, and the spans
  are merged.
- **Replace**: `registerPrivacyDetector(d, { replace: 'core.<id>' })` turns one
  core detector off. It is the only way to, so it cannot happen by accident. The
  replacement is required unless it says `required: false`, because the core
  detector it stands in for was. A
  `replace` naming no registered core detector throws. The admin page shows
  replaced core detectors (`replacedCoreDetectors`).
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
contributes nothing. Extra fields are dropped. The type pattern matters because
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
the adapter ignores the signal.

| Failure                                                     | Reported as                            | What the stage does                                                     |
| ----------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| An optional detector fails or times out                     | `failures`, `required: false`          | Carries on; the call is marked degraded                                 |
| A required detector fails (every core detector is required) | `failures`, `required: true`           | `onDetectorFailure: 'block'` refuses; `'fallback'` carries on, degraded |
| A policy resolver fails or returns a non-policy             | `failures` from `resolvePrivacyPolicy` | Refuses: the resolver may have tightened the policy                     |
| An observer fails                                           | logged                                 | Nothing; observers are fire-and-forget                                  |
| The app's init threw                                        | `appInitFailure`                       | Refuses every call, mode `off` included                                 |
| A core adapter failed to install                            | `coreFailure`                          | Refuses every call whose mode is not `off`                              |
| A bug throws inside the stage                               | —                                      | Refuses. Never sends unmasked. The opposite of guard-floor, on purpose  |
| The model mangles a placeholder                             | —                                      | Lenient restore; anything unresolved is left visible and counted        |

Every refusal ships its remedy: the user sees a plain message, and the admin
sees the reason on the trace.

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

| Setting           | Where                             | Values                  | Default                                     | Task          |
| ----------------- | --------------------------------- | ----------------------- | ------------------------------------------- | ------------- |
| Mode              | global, agent override, org floor | the five modes          | `off` on upgrade, `detect` on a new install | t-991, t-1010 |
| Entity types      | global                            | per-type on or off      | identifiers on; `DATE` and `LOCATION` off   | t-991         |
| Local providers   | global                            | protect or skip         | skip                                        | t-991         |
| Protected terms   | org (`Org.settings`)              | names always masked     | empty, with the org's own name pre-filled   | t-1010        |
| Embeddings policy | global                            | `allow` \| `local_only` | `allow`                                     | t-992         |

The global values are columns on `AiOrchestrationSettings` (one row per
install). The org floor and protected terms are a slice of `Org.settings` read
and written through `lib/tenancy/org-settings.ts`, like the provider policy and
quotas. Every field gets a `<FieldHelp>`; the agent field goes through the core
field registry (`lib/orchestration/agents/agent-field-registry.ts`).

## Detection (t-989)

Tiers A–C are core and add a few milliseconds per call. All are default
detector adapters, reached only through the registry.

| Tier              | Finds                                                                                                                                                                      | How                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A. Rules          | NI, NHS, postcode, sort code and account, IBAN, card, UTR, VAT, passport and driving licence (with context words), email, phone, IP, secrets, date of birth (with context) | Patterns plus checksums (NHS mod-11, IBAN mod-97, Luhn, NINO prefixes); `libphonenumber-js`                   |
| B. Known values   | the user's own details, memory values, inbound sender, the org's protected terms                                                                                           | Exact and variant matching (case, initials, first or last name alone)                                         |
| C. Lists and cues | other people's names, street addresses, companies with legal suffixes                                                                                                      | Bundled name lists, cue phrases, street patterns, suffixes; an allowlist of public bodies and common products |

A company found with its suffix ("Halden Logistics Ltd") teaches the call its
short form ("Halden"). Bundled lists record their licences here when added. The
synthetic corpus records per-type precision and recall in the repo, and a change
that lowers recall for any type fails CI.

## Placeholders (t-990)

- **Format.** Typed and numbered (`PERSON_1`, `ORG_2`), so the model can still
  tell who is who. The bracket style is chosen by testing which one the shipped
  providers reproduce most reliably, and recorded here.
- **Numbering by first appearance.** History is append-only, so earlier turns
  mask the same way on every call and provider prompt caching keeps working.
- **No vault.** Every call sends the full conversation, and providers are called
  statelessly (`store: false`; no `previous_response_id`, no batch API). The map
  is rebuilt from each call's own input and discarded. If Sunrise ever adopts
  provider-side state, that change must add a persistent strategy, with its
  `SUBJECT_DATA_SOURCES` row and erasure path.
- **Streaming.** A placeholder split across chunks is held back until complete.
- **Tool calls.** Arguments are restored before the dispatcher runs them; tool
  results are masked on the next outbound call. Capabilities need not know the
  layer exists.
- **Lenient restore.** Tolerates a missing bracket, a possessive, a placeholder
  inside JSON. An unresolved placeholder is left visible and counted, never
  guessed.
- **Prompt line.** When masking is active, a short line tells the model the
  placeholders are stand-ins to copy exactly.
- **Output guard.** It ignores values the conversation itself supplied, and uses
  tier A's recognisers instead of its own US-only patterns (t-992).

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
- `embeddingsPolicy: local_only` refuses an embedding call to a provider that is
  not `isLocal` when the mode is `pseudonymise` or stricter. A refused reply
  embedding is skipped and logged; a refused `search_knowledge_base` returns a
  tool error the model can relay; a refused upload fails with an admin-visible
  error naming the setting.
- The settings page warns when protection is on, embeddings go to a provider
  that is not `isLocal`, and the policy is `allow`.

Pseudonymised chat plus a local embedding model keeps names off every third
party while search keeps full quality, because tool arguments are restored
before dispatch. **`isLocal` means the provider runs on infrastructure the
operator controls.** Marking a vendor's API `isLocal` already exempts it from
spend caps; it also exempts it from this layer.

## Testing

- Detection and mask/restore are pure: unit and property tests
  (`restore(mask(x)) = x`; a stream split at every character position).
- A labelled synthetic UK corpus is the precision/recall gate; there are no live
  conversations to tune on.
- The stage is tested with a fake provider (`registerProviderInstance`),
  asserting on the exact request body, and a leak smoke test records the body
  and asserts no seeded value appears.
- The registry and runner tests (`tests/unit/lib/privacy/adapters/`) mock both
  the app seam and core's defaults, because core ships no adapters until t-989.

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
