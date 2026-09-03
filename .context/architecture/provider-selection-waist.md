# Outbound provider selection: is there a narrow waist?

**Spike deliverable for t-660.** Answers whether Sunrise has a single place
where _"which vendor is about to receive this request"_ is decided, or whether
the provider-eligibility seam is condemned to a hand-maintained list of call
sites.

**Short answer: the waist exists, it is not where the hypothesis predicted, and
it is already in the tree.** It is `withInFlightTracking` in
`lib/orchestration/llm/provider-manager.ts` — a Proxy that already wraps every
provider instance and fires on every vendor call. One path bypasses it
(`lib/orchestration/knowledge/embedder.ts`), and closing that is a bounded
refactor rather than an open-ended enumeration.

## Why the spike exists

The eligibility seam (t-656) asks each call site to consult a rule before
Sunrise picks a vendor on a caller's behalf. Making that complete means
enumerating every such site. That was attempted three times and was short every
time:

| Attempt         | Method                             | Result                             |
| --------------- | ---------------------------------- | ---------------------------------- |
| t-656 review    | manual reading                     | named 4 paths, missed 2            |
| t-658           | `grep -rn 'getProvider(' lib app`  | found those 2, missed the embedder |
| t-658, 3rd pass | `grep 'getDefaultModelForTask(' …` | found `knowledge/embedder.ts`      |

Three shortfalls in three attempts is a property of the method. The coverage
table in [`../orchestration/llm-providers.md`](../orchestration/llm-providers.md)
is the symptom: you only maintain a table like that when the code cannot answer
the question for you.

## Method

Five **independent** enumerations over 745 non-test source files in `lib/`,
`app/` and `scripts/`, cross-tabulated so each could be checked against the
others rather than trusted alone:

- **A** — vendor credential reads (`process.env[...]` keyed on an env-var name)
- **B** — provider class construction (`new AnthropicProvider|OpenAiCompatibleProvider|VoyageProvider`)
- **C** — `getProvider(` / `getProviderWithFallbacks(`
- **D** — reads of `AiProviderConfig` / `AiProviderModel`
- **E** — vendor base URLs

**B was the one that mattered**, and it is the method none of the three earlier
attempts used. It matched **two** production files.

## Finding 1 — there are two outbound vendor paths, not seven

The "seven sites" were seven **model-selection** sites. Selection is diffuse;
**transmission is not.** All seven converge on `provider-manager.ts`. Only one
genuine second path exists.

- **Construction.** Every provider instance reachable by application code is
  built in `provider-manager.ts` — `buildProviderFromConfig` (:541) from a DB
  row, or `buildProviderFromInMemoryConfig` (:634) via `registerProvider`, which
  no production code calls. `voyage.ts`'s `new OpenAiCompatibleProvider` is
  `VoyageProvider` building its own internal delegate, not a second entry point.
  `registerProviderInstance` is used only by `scripts/smoke/{chat,transcribe}.ts`.
- **Credentials.** Vendor keys are read in exactly two production files:
  `provider-manager.ts` (`resolveApiKey`, :661) and `embedder.ts` (:187, :252,
  :272, :290, :305). `provider-manager.ts:229` is a presence check, not a use;
  `evaluations/judge-model.ts:29` reads **model ids**, not credentials.
- **Transmission.** Raw `fetch()` reaching a third party happens in
  `anthropic.ts:142` and `openai-compatible.ts:177` (inside provider
  instances), in `embedder.ts:387`, and in the shared `fetchWithTimeout`
  helper at `provider.ts:365`. Every other `fetch()` in the orchestration tree
  targets a **customer** URL (webhooks, escalation, URL ingestion) under
  `ORCHESTRATION_ALLOWED_HOSTS`, a separate concern.

  **`fetchWithTimeout` is not confined to provider instances, and an earlier
  draft of this bullet said it was.** `voyage.ts:112` calls it from inside a
  provider, but `model-registry.ts:79` calls it from outside one, to
  `https://openrouter.ai/api/v1/models` (a hardcoded constant at
  `model-registry.ts:35`) — outside the Proxy and outside
  `ORCHESTRATION_ALLOWED_HOSTS`. It is an unauthenticated GET for model
  metadata, so no org data leaves and the credential claim above is unaffected;
  a provider-eligibility gate has nothing to say about it. It is recorded
  because **this document's own enumeration was short again**, on the pass
  written to argue that enumerations run short. That is the thesis surviving
  contact with its author, not a counterexample to it.

## Finding 2 — the credential hypothesis fails, and fails dangerously

The spike proposed gating at credential resolution. **That is wrong, because
provider instances are cached.**

`getProvider` (:86) serves from `instanceCache` under a TTL and only calls
`buildProviderFromConfig` on a miss. A policy check inside `resolveApiKey` would
therefore run **once per process per provider** and be skipped for every
subsequent request — including requests from a different org.

That is the worst available failure: a control that looks enforced, passes its
own tests, and is not evaluated on the request that matters. Worth recording as
a rejected option so nobody re-proposes it.

## Finding 3 — the per-call waist already exists

`withInFlightTracking` (:139) wraps every instance returned by `getProvider` in
a Proxy that intercepts `chat`, `embed`, `transcribe` and `chatStream`, **with
the provider slug in hand, on every call.** It was built for in-flight counting;
the interception point is general.

Every instance **built from a database row** is wrapped, so every method call on
one enters the Proxy's `get` trap. The completeness question — _can a vendor
call escape the policy?_ — therefore has a structural answer rather than a
list, but the invariant has to be stated precisely, and an earlier draft of this
paragraph stated it wrongly.

**It is not "everything `getProvider` hands out".** `getProvider` serves a cache
hit at `:88`, _before_ it ever reaches `withInFlightTracking` at `:110` — and
`registerProvider` (:172) and `registerProviderInstance` (:185) write
**unwrapped** instances straight into that cache. So `getProvider` itself will
hand back an unproxied provider for any name registered that way.
`scripts/smoke/{chat,transcribe}.ts` already do exactly this, and the chat
handler consumes the result with no Proxy around it.

Nothing in `lib/` or `app/` calls either function, so this is not a live hole
today — but it is a hole in **the invariant the proposed gate would rest on**,
which is a different and worse thing than a fork risk, and the earlier draft
filed it under "did not check" as though it were the latter. The fix is small
and belongs in the gate's scope: have `registerProvider` and
`registerProviderInstance` wrap too, so the invariant becomes unconditional
rather than true-by-convention. Until then the honest statement is _only by not
going through `buildProviderFromConfig`_ — and two exported functions plus the
embedder do that.

**One precision, because it is the kind of gap that becomes the next missed
path.** The Proxy _sees_ every method; it _intercepts_ only
`chat`/`embed`/`transcribe`/`chatStream`. `testConnection()` and `listModels()`
also reach the vendor and currently fall through to `fn.bind(target)` —
`provider-manager.ts:238`, `model-registry.ts:140`,
`providers/[id]/models/route.ts:64`, `discovery/models/route.ts:109`. A gate
must state which set it covers and why. The defensible line is that all four of
those callers act on a provider **an admin named explicitly** (testing a row,
discovering its models), which is an operator's recorded choice and out of scope
by the seam's own rule — but that is an argument to make in the design, not a
detail to leave to whichever method names someone happened to copy.

That bypass is a bounded refactor, not an open question: route `embedder.ts`
through a provider instance. It is not free — the embedder carries bespoke
`dimensions` / `schemaCompatible` handling and a Voyage/local/OpenAI preference
chain whose last arm reaches `api.openai.com` off a bare `OPENAI_API_KEY` with
no `AiProviderConfig` row at all. That last arm is the piece that needs a
decision rather than a port: on a multi-tenant install an unconfigured escape
hatch to a vendor is arguably a defect in itself.

## Finding 4 — the waist gives completeness, not provenance

At the proxy you know the slug and the method. You cannot tell an operator's
explicit `agent.provider` from one Sunrise auto-picked — and **that distinction
is the entire design of the seam**, which deliberately never reroutes a recorded
human decision.

So a gate in the proxy cannot make policy on its own. It needs provenance to
ride along with the request. `AsyncLocalStorage` is the established answer in
this tree: `lib/auth/signup-mode.ts` uses it for the same shape of problem and
carries a written rationale for why not a parameter. `lib/orchestration/tracing`
and the workflow engine already rely on ALS propagation.

## Finding 5 — the streaming path is feasible but not free

`trackStream` returns an `AsyncIterable` **synchronously**; the work begins in
`[Symbol.asyncIterator]()` and the first `next()`. An async gate can be awaited
inside the first `next()`, but a denial must surface as a rejected `next()`
rather than a synchronous throw at iterator construction, or callers that build
the iterable before consuming it will see the error in the wrong place. Named
here so it is designed rather than discovered.

## Recommendation: two layers, doing different jobs

The mistake was treating "constrain the provider" as one job. It is two, and
they want different mechanisms.

| Layer                                                   | Job                                                                                                       | Mechanism                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Selection-time filtering** (what t-656/658/659 build) | _Choose well_ — pick a provider the org permits, so the user gets a working request rather than a refusal | the seam, consulted at each selection site |
| **Call-time gate** (proposed)                           | _Cannot escape_ — no vendor call proceeds against policy, whatever chose it                               | the existing Proxy + ALS provenance        |

Both are wanted, and the second is what makes the first optional rather than
load-bearing:

- Without selection-time filtering, the audio matrix loop would pick a barred
  row and the call would fail, instead of skipping to a permitted row. The
  agent resolver would attach barred fallbacks that fail on use. Users get
  errors where they could have got service.
- Without a call-time gate, assurance rests on a hand-maintained list that has
  been wrong three times out of three.

**The decisive consequence: with a gate, the coverage table stops being a
security artefact.** It becomes a description of where Sunrise chooses _well_,
not a claim about where data can go. That retires the thing that keeps being
wrong, which no amount of more careful enumeration would.

## Verdict on t-658 and t-659

**Merge as built, with the framing corrected — do not close them.**

They are the selection layer, they are correct, tested and behaviour-neutral at
`TENANCY_MODE=single`, and the gate does not make them redundant: it makes them
the _quality_ layer rather than the _assurance_ layer. Closing them would trade
working behaviour for nothing.

Two conditions had to be met first, and **this PR meets them** — they are
recorded as history, not as outstanding work:

1. `llm-providers.md` had to stop presenting the coverage table as a boundary.
   On `main` it told a fork it "needs this list rather than an assurance", and
   the list was missing four paths. It now opens with "do not build an isolation
   boundary on the table below" and says how many times the enumeration has been
   short.
2. The table had to gain the missing rows and a pointer to this document, so the
   next reader learns the boundary comes from the gate rather than from the
   list. Done in the same commit.

(An earlier draft of this section claimed `llm-providers.md` "currently says the
enumeration has been short once". It never did — that string was on the
unmerged t-658/t-659 branch, and `main` said the opposite. Quoting a sibling
branch as though it were the shipped tree is the same altitude error this
document is about, so it is corrected in place rather than deleted.)

The gate itself is **`f-mt-external`** work (#109, "External plane: storage,
export, provider policy"), not groundwork: it needs ALS provenance plumbing and
the embedder refactor, and it is only enforceable once there is an org to
enforce against.

## What this spike did NOT check

- **Whether ALS actually propagates** through the workflow engine's promise
  forking in practice. `orchestration-engine.ts:1398` comments that it does
  (Node ≥ 18 forks per Promise), but this was read, not tested.
- **The cost of an async gate on the hot path.** `chat` is already async so a
  gate adds an await; the per-call overhead was not measured.
- **Whether `registerProvider` / `registerProviderInstance` should keep
  bypassing the Proxy.** The bypass itself is no longer unchecked — see Finding
  3, which states the corrected invariant. What was not decided is the remedy:
  wrap inside both functions, refuse to cache an unwrapped instance, or make
  them test-only. The smoke scripts that rely on them
  (`scripts/smoke/{chat,transcribe}.ts`) inject fakes precisely to avoid a real
  SDK, so wrapping must not assume a live vendor behind the instance.
- **Non-LLM outbound planes.** Storage, email and webhooks resolve their own
  destinations and were out of scope. If tenancy needs "which third parties see
  our data" rather than "which LLM vendors", they need their own pass.
- **Whether the embedder's bare-`OPENAI_API_KEY` arm should exist at all.**
  Flagged, not decided.
