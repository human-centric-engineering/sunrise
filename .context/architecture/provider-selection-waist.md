# Outbound provider selection: is there a narrow waist?

**Spike deliverable for t-660.** Answers whether Sunrise has a single place
where _"which vendor is about to receive this request"_ is decided, or whether
the provider-eligibility seam is condemned to a hand-maintained list of call
sites.

**Short answer: a per-call waist exists and is already in the tree** — the Proxy
in `withInFlightTracking` (`lib/orchestration/llm/provider-manager.ts`), built
for in-flight counting. It is not complete as it stands, and the gaps are
specific and tracked rather than open-ended.

## Why this document is short on citations

An earlier draft argued the same conclusion with dense evidence: exact file and
line references for every provider-selection site, counts of files scanned,
"exactly two production files". Two review rounds found **sixteen** defects in
it. Nine were the citations themselves — wrong line numbers, a miscount, a
silently narrowed scope. Seven were places where the code turned out to be
_less_ guarded than the prose claimed.

That is the same failure this document exists to describe, committed by the
document. It is left in as evidence rather than quietly fixed, because it is the
strongest data point available: **three independent attempts to enumerate where
Sunrise selects a provider, plus one to enumerate the enumeration, all ran
short.** The argument below therefore rests on structural facts — a cache
exists, a Proxy exists, one module bypasses both — which are stable, and not on
a census, which is not.

Where a specific line matters, read the code. Line numbers are deliberately
omitted; function and module names are not.

## The three enumerations, and why they failed

| Attempt         | Method                             | Result                               |
| --------------- | ---------------------------------- | ------------------------------------ |
| t-656 review    | manual reading                     | named four paths, missed two         |
| t-658           | grep for `getProvider(`            | found those two, missed the embedder |
| t-658, 3rd pass | grep for `getDefaultModelForTask(` | found the embedder                   |

Each method was blind to what the others caught, because provider selection is
written in several shapes: some sites resolve a model then take its provider,
one walks a matrix of rows, one builds its own HTTP client. There is no common
syntactic tell to grep for. That is the finding — not that the greps were
careless.

## Finding 1 — selection is diffuse, transmission is not

The "seven sites" were seven **model-selection** sites. They converge:
every provider instance that application code can obtain is built inside
`provider-manager.ts`, and every LLM call made through such an instance is a
method call on it.

One module genuinely bypasses that: `lib/orchestration/knowledge/embedder.ts`
resolves its own destination and runs its own `fetch`, never touching the
provider manager. Its fallback chain ends by reaching OpenAI directly off a bare
`OPENAI_API_KEY`, with no provider row and therefore no slug for a policy to key
on.

## Finding 2 — the obvious chokepoint is wrong, and dangerously so

Gating at credential resolution (`resolveApiKey`) looks right and is not.
`getProvider` **caches** provider instances, so credential resolution runs once
per process per provider. A policy check there would be skipped for every
subsequent request, including one from a different org.

A control that looks enforced, passes its own tests, and is not evaluated on the
request that matters is worse than no control. Recorded as rejected.

## Finding 3 — the per-call waist, and what it does not yet cover

`withInFlightTracking` wraps provider instances in a Proxy that fires on every
call with the provider slug in hand. That is the right shape and the right
place: it is per-call, it cannot be forgotten by a new call site, and it needs
no list.

Three things stop it being a complete boundary today. Each is tracked work, not
an open question:

- **Not every cached instance is wrapped.** `getProvider` returns a cache hit
  before it reaches the Proxy, and `registerProvider` / `registerProviderInstance`
  write unwrapped instances into that cache. Nothing in `lib/` or `app/` calls
  them — only smoke scripts — but the invariant a gate would rest on is
  currently true by convention rather than by construction.
- **The Proxy intercepts a fixed method set** (`chat`, `embed`, `transcribe`,
  `chatStream`). `testConnection` and `listModels` fall through; both are
  defensible omissions, since their callers act on a provider an admin named.
  **`transcribeStream` also falls through, and is not defensible** — it carries
  user audio and is reached from the voice path, not from an admin naming a row.
- **The embedder is outside it entirely**, per Finding 1.

## Finding 4 — the waist gives completeness, not provenance

At the Proxy you know the slug and the method. You cannot tell an operator's
explicit `agent.provider` from one Sunrise auto-picked — and never rerouting a
recorded human decision is the entire design of the seam.

So a gate there cannot make policy alone; provenance has to ride along with the
request. `AsyncLocalStorage` is the established answer in this tree — see
`lib/auth/signup-mode.ts`, which solves the same shape and documents why not a
parameter.

## Finding 5 — the streaming path needs care

`trackStream` returns its `AsyncIterable` synchronously; the work starts when
the iterator is first pulled. An async gate can be awaited there, but a denial
must surface as a rejected `next()` rather than a synchronous throw at iterator
construction, or callers that build the iterable before consuming it will see
the error in the wrong place.

## Recommendation: two layers, doing different jobs

Treating "constrain the provider" as one job is what produced a hand-maintained
list in a security-adjacent document. It is two:

| Layer                                              | Job                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Selection-time filtering** (t-656, t-658, t-659) | _Choose well_ — pick a permitted provider, so a caller gets service rather than a refusal |
| **Call-time gate** (proposed, `f-mt-external`)     | _Cannot escape_ — no vendor call proceeds against policy, whatever chose it               |

Both are wanted, and the second is what makes the first optional rather than
load-bearing. Without selection-time filtering the audio loop would pick a
barred row and fail instead of skipping to a permitted one. Without a gate,
assurance rests on a list that has never once been complete.

**The decisive consequence: with a gate, the coverage table in
[`../orchestration/llm-providers.md`](../orchestration/llm-providers.md) stops
being a security artefact.** It becomes a description of where Sunrise chooses
well. That retires the thing that keeps being wrong; a more careful list would
not.

## Verdict on t-658 and t-659

**Merge as built — do not close them.** They are the selection layer: correct,
tested, behaviour-neutral at `TENANCY_MODE=single`. The gate makes them the
_quality_ layer rather than the _assurance_ layer; closing them would trade
working behaviour for nothing.

The gate itself is `f-mt-external` work (#109, "External plane: storage, export,
provider policy"). It needs the provenance plumbing, the embedder brought inside
the waist, and the three Finding 3 gaps closed.

## Scope of this spike

**Covered:** where Sunrise selects an LLM vendor, and whether a single
enforcement point exists.

**Not covered, and each has been raised as its own tracked item rather than left
in this prose** — see the feature board: the agent form pinning a denied
provider as an explicit choice; `transcribeStream` being ungated; the unwrapped
registration path; and whether the webhook and event-hook planes having no
destination allowlist is deliberate.

**Out of scope entirely:** storage, email and webhook destinations. They resolve
their own targets and answer a different question — "which third parties see our
data" rather than "which LLM vendors". If tenancy needs the broader one, it
needs its own pass, and this document should not be read as having done it.
