# Resilience & Error Handling

Phase 7 Session 7.3 — circuit breaker, provider fallback, budget UX, input guard, error registry, and SSE resilience.

## Quick Reference

| Feature                 | Path                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| Circuit breaker         | `lib/orchestration/llm/circuit-breaker.ts`                                 |
| Provider fallback       | `lib/orchestration/llm/provider-manager.ts` → `getProviderWithFallbacks()` |
| Outbound rate limiter   | `lib/orchestration/engine/outbound-rate-limiter.ts`                        |
| Per-step timeout        | `lib/orchestration/engine/orchestration-engine.ts` → `runStepWithStrategy` |
| Non-retriable errors    | `lib/orchestration/engine/errors.ts` → `ExecutorError.retriable`           |
| External call hardening | `lib/orchestration/engine/executors/external-call.ts`                      |
| Input guard             | `lib/orchestration/chat/input-guard.ts`                                    |
| Error message registry  | `lib/orchestration/chat/error-messages.ts`                                 |
| Chat rate limiter       | `lib/security/rate-limit.ts` → `chatLimiter`                               |
| Warning ChatEvent       | `types/orchestration.ts` → `{ type: 'warning' }`                           |
| Client reconnect        | `components/admin/orchestration/chat/chat-interface.tsx`                   |

## Circuit Breaker

Tracks provider error rates and temporarily disables failing providers. Uses a sliding-window failure counter.

States:

- **closed** — healthy, requests pass through
- **open** — tripped after `failureThreshold` failures in `windowMs`; requests blocked for `cooldownMs`
- **half_open** — cooldown elapsed, one probe request allowed; success resets to closed, failure re-opens

Defaults: 5 failures / 60s window / 30s cooldown.

Per-instance in-memory state (matching `instanceCache` in `provider-manager.ts`). A multi-instance deployment would need Redis or a shared store for coordinated circuit breaking.

```typescript
import { getBreaker } from '@/lib/orchestration/llm/circuit-breaker';

const breaker = getBreaker('anthropic');
if (breaker.canAttempt()) {
  try {
    // call provider
    breaker.recordSuccess();
  } catch {
    breaker.recordFailure();
  }
}
```

### Observability

Circuit breaker state is exposed via the admin API:

- **Provider list** (`GET /providers`): each row includes `circuitBreaker: { state, failureCount, openedAt, config }`.
- **Dedicated health endpoint** (`GET /providers/:id/health`): detailed breaker status for a single provider.
- **Manual reset** (`POST /providers/:id/health`): resets the breaker to closed (rate-limited).

Public getters on `CircuitBreaker`: `failureCount` (prunes window first), `currentConfig` (copy), `openedAtTimestamp`. Module-level helpers: `getCircuitBreakerStatus(slug)` → status snapshot or `null`, `getAllBreakerSlugs()` → all registered slugs.

## Provider Fallback Chain

`getProviderWithFallbacks(primarySlug, fallbackSlugs)` resolves a provider by checking circuit breakers in order:

1. Build candidate list: `[primary, ...fallbacks]`
2. For each: check `getBreaker(slug).canAttempt()`
3. First passing candidate: resolve via `getProvider(slug)`, return `{ provider, usedSlug }`
4. All breakers open or providers not found: throw `ProviderError('all_providers_exhausted')`

Configure via `AiAgent.fallbackProviders` (Prisma `String[]`, max 5 entries, Zod-validated).

## Budget Enforcement

Pre-check via `checkBudget(agentId)` in `streaming-handler.ts`:

- **80% warning**: if `spent / limit >= 0.8`, yields `{ type: 'warning', code: 'budget_warning', message: '...' }` and logs. Stream continues.
- **Exceeded**: yields `{ type: 'error', code: 'budget_exceeded' }` with user-friendly message. Stream terminates.

### Budget Check Atomicity

`checkBudget()` reads a SUM aggregate; `logCost()` writes a new row after the LLM call completes. Without protection, concurrent requests for the same agent could all pass the budget check before any cost is logged.

**Solution:** `withAgentBudgetLock(agentId, fn)` in `lib/orchestration/llm/budget-mutex.ts` — an in-memory per-agent promise-chain mutex. Calls for the same `agentId` are serialised; calls for different agents proceed in parallel.

**Accepted over-run tolerance:** `logCost()` is fire-and-forget after streaming (not wrapped by the mutex, which would block the stream). The worst case is one LLM turn per concurrent in-flight request for the same agent — typically < $0.01.

**Multi-instance note:** This mutex is in-process only. If horizontal scaling is needed in future, replace with `SELECT pg_try_advisory_xact_lock(hashtext(agentId))` or a Redis-based lock.

## Input Sanitisation

`scanForInjection(message)` detects five pattern categories:

- `system_override` — "ignore/disregard/forget previous instructions"
- `role_confusion` — "you are now", "act as if you", "pretend you"
- `delimiter_injection` — `###`, `---`, `***`, `<system>`, `</system>`, etc.
- `output_manipulation` — "do not mention/reveal/disclose", "keep this secret"
- `encoding_evasion` — base64, atob/btoa, hex escapes, unicode escapes, HTML entities

**Configurable mode** via `OrchestrationSettings.inputGuardMode`:

| Mode                 | Behavior                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| `log_only` (default) | Log detection, continue — never blocks requests. Logs pattern labels only, not content |
| `warn_and_continue`  | Log + yield `{ type: 'warning', code: 'input_flagged' }` event to client               |
| `block`              | Yield `{ type: 'error', code: 'input_blocked' }`, stop processing                      |

Set via `PATCH /api/v1/admin/orchestration/settings` with `{ "inputGuardMode": "warn_and_continue" }`. Changes take effect within the 30s settings cache TTL.

## Error Message Registry

`getUserFacingError(code)` returns `{ title, message, action? }` for known error codes:

| Code                      | Title                    |
| ------------------------- | ------------------------ |
| `budget_exceeded`         | Monthly Budget Reached   |
| `all_providers_exhausted` | No Available Provider    |
| `agent_not_found`         | Agent Not Found          |
| `conversation_not_found`  | Conversation Not Found   |
| `tool_loop_cap`           | Processing Limit Reached |
| `internal_error`          | Something Went Wrong     |
| `stream_error`            | Something Went Wrong     |
| `rate_limited`            | Too Many Requests        |

Unknown codes fall back to `internal_error`. Static map — zero runtime cost.

## Chat Rate Limiting

Dual rate limiting on `POST /chat/stream`:

1. `adminLimiter` — 30/min per IP (existing, defense against scripted abuse)
2. `chatLimiter` — 20/min per user ID (new, catches runaway admin usage)

Both configured in `lib/security/rate-limit.ts` via `SECURITY_CONSTANTS.RATE_LIMIT.LIMITS`.

### Per-Agent Rate Limiting

Agents can have a custom `rateLimitRpm` (nullable Int on `AiAgent`). When set, the chat stream applies a per-agent limit keyed by `${agentId}:${userId}` instead of the global default. When null, the global `chatLimiter` applies.

Created via `createDynamicLimiter(namespace, defaultRpm)` in `lib/security/rate-limit.ts`. The dynamic limiter supports per-key custom RPM overrides.

API keys (`AiApiKey`) also support an optional `rateLimitRpm` field for per-key rate limiting on webhook triggers.

## Per-Agent Guard Mode Override

Both input and output guards support per-agent mode overrides via `AiAgent.inputGuardMode` and `AiAgent.outputGuardMode` (nullable strings). When set, the agent-level mode takes precedence over the global `AiOrchestrationSettings` default. When null, the global setting applies.

Valid modes: `log_only`, `warn_and_continue`, `block`.

Use case: A customer-facing FAQ bot may use `block` mode to prevent any flagged content, while an internal reasoning agent uses `log_only` to avoid false-positive interruptions.

## Mid-Stream Retry

If the LLM stream fails after starting (network error, provider crash), the streaming handler automatically retries with the next fallback provider:

1. Record whatever the failed call cost, if the error carries usage
2. Record a circuit breaker failure for the current provider
3. Emit `{ type: 'warning', code: 'provider_retry' }` SSE event
4. Reset accumulated content and tool calls
5. Resolve the next provider from `agent.fallbackProviders`
6. Restart the stream from the new provider

Maximum retries: 2 (`MAX_STREAM_RETRIES`). See [Streaming Chat Handler](./chat.md#mid-stream-retry--recovery) for details.

**Two failures are deliberately kept away from the breaker**, because it exists to route around a provider that is _unwell_ and neither is evidence of that:

- **A client abort** (stop pressed, tab closed, navigation mid-answer) bypasses retry — nobody is listening — and records **no** breaker failure. At `failureThreshold: 5`, five cancelled streams would otherwise open the circuit for that provider slug across **every** agent using it — one reader changing their mind five times taking a healthy provider offline for everybody.

  `isClientAbort()` decides, and it is consulted in two places: the inner stream catch, which is the one a cancellation actually reaches, and the outer crash catch as **defence** — both shipped adapters raise an in-flight abort as `ProviderError('request aborted', { code: 'aborted' })`, and the outer catch's `ProviderError` branch returns before the breaker line, so the outer guard exists for the shape a fork adapter can still produce (a raw `AbortError`, or anything not funnelled through `toProviderError`).

  The predicate asks, in order: is the caller's `AbortSignal` aborted (authoritative); is this a `ProviderError` (then its `code` is the answer — never its message); is it named `AbortError`; and only with no signal to consult, does the message contain "aborted". The `ProviderError` rule is what stops a 502 whose body echoes the word from being read as a cancellation on the signal-less path — the evaluation runner spreads `signal` conditionally.

- **A request fault** (`isRequestFault()`, currently `truncated_no_output`) neither fails over nor records a failure: the token cap travels with the agent config, not the endpoint, so every fallback rejects it identically.

**Cost on the error path.** `ProviderError.usage` carries what the provider billed for the call the error ended, and it is populated from two places: the truncation guards (what the provider reported) and `toProviderErrorWithUsage()` in the adapters' stream-iteration catch (what had accumulated by the time it died). Anthropic sets `inputTokens` at `message_start` and updates `outputTokens` on every `message_delta`, so its mid-stream failures carry real numbers; an OpenAI-compatible stream reports usage in a final chunk, so an error before that has nothing to attach.

The streaming handler folds the field into `AiCostLog` on the way into the catch, so it is recorded whichever exit is taken — request fault, failover, or terminal. **Zeroed usage is dropped, never written**: zero means "the provider never told us", and a zeroed row would report the turn as free, which is a worse answer than no row at all.

**It feeds the per-turn cap too.** The same fold adds to `turnCostUsd`, which `maxCostPerTurnUsd` is tested against — so a turn that lost a nearly-capped stream and then recovered on a fallback can stop the tool loop early with an `endedReason: 'budget_exceeded'` marker. That is the cap counting the money actually spent rather than only the spend that reached a `done` chunk, but it is a behaviour change worth knowing when tuning a cap.

## Guard Mode Fallback Logging

When the streaming handler fails to load `OrchestrationSettings` (e.g. DB outage) for either input or output guard mode resolution, it falls back to `log_only` and logs a `logger.warn` with a message like `'Failed to load orchestration settings for input guard mode, falling back to log_only'`. This ensures admins are alerted that their configured `block` or `warn_and_continue` mode isn't being enforced, rather than silently degrading.

## Tool Error Backoff

The streaming handler tracks per-tool consecutive failure counts. After a tool fails **2 consecutive times** (`TOOL_FAILURE_THRESHOLD`), the handler skips subsequent dispatch calls for that tool and returns a `{ success: false, error: { code: 'tool_unavailable' } }` result to the LLM. This prevents a broken tool from burning through all `MAX_TOOL_ITERATIONS` iterations. A successful dispatch resets the counter.

Applies to both single and parallel tool dispatch paths.

## Maintenance Tick Overlap Protection

The unified maintenance tick (`POST /api/v1/admin/orchestration/maintenance/tick`) uses a module-level `tickRunning` boolean flag to prevent concurrent execution. If a tick is still running when the next cron fires, the endpoint returns `{ skipped: true, reason: 'previous tick still running' }` without calling any maintenance functions.

The guard's lifetime extends past the HTTP response. The tick awaits `processDueSchedules()` synchronously and then kicks off the other six maintenance tasks as a fire-and-forget background chain (so the cron caller never times out on a slow retention sweep). The flag is cleared in the background chain's `.finally()` — meaning a follow-up tick that arrives while retention or embedding backfill is still running will see `tickRunning === true` and be correctly skipped, even though the previous HTTP response has already returned 202. See [Scheduling — Unified Maintenance Tick](./scheduling.md#unified-maintenance-tick-admin-auth-required-preferred) for the full response contract.

**Liveness watchdog.** A 5-minute `setTimeout` watchdog runs alongside the background chain. If the chain has not settled when the watchdog fires, it logs `Maintenance tick: background chain exceeded max duration; releasing guard` and force-clears `tickRunning` so subsequent ticks can proceed — preventing a single hung maintenance task (e.g. a stuck DB connection or an un-timed-out external call inside a sweep) from indefinitely blocking the platform's maintenance cycle. The hung chain itself still runs to completion in the background; the watchdog only releases the overlap guard. The warning log line is the operational signal that something inside one of the maintenance tasks is misbehaving.

**Token-based ownership.** Each accepted tick claims a fresh monotonic `currentTickToken` and tags its background chain + watchdog with it. Both the watchdog and the `.finally()` only release `tickRunning` if the current token still equals the tick's own token. This prevents a late-settling old chain (whose watchdog already force-released the guard, allowing a new tick to take over) from accidentally releasing the new tick's guard.

This is sufficient for single-server deployments. Multi-instance deployments would need a distributed lock (e.g. Postgres advisory lock or Redis) — on serverless in particular, `tickRunning` is **per-instance**, so two invocations landing on different instances do not see each other's flag and the "previous tick still running → skip" guarantee does not hold there. Every task the guard protects is idempotent, so the consequence is duplicated work, not corruption.

**Per-task in-flight latch.** Independently of the guard, each background task also has its own latch (`lib/orchestration/maintenance/job-clock.ts`): a task still running from an earlier tick is never started a second time in the same process. This matters most right after the watchdog fires — it releases the overlap guard while the hung chain is still running, and without the latch the next tick would start a second copy of the very task that hung.

**The idle gate is a separate mechanism.** `tickRunning` prevents _concurrency_; the idle gate (#442) prevents _repetition_ when there is nothing to do. They are checked in that order — gate first, so a skipped tick costs no database round-trips at all. `?force=1` overrides the gate and **not** the guard: forcing a sweep is a statement about work being due, never a licence to run two sweeps at once. See [Scheduling — The idle gate](./scheduling.md#the-idle-gate--a-tick-that-does-no-database-work-at-all).

## SSE Resilience

### Server-side

- `sseResponse()` sends 15s keepalive comment frames
- `streaming-handler.ts` persists partial responses before errors
- Error events are sanitized — raw provider errors never reach the client

### Client-side (`chat/chat-interface.tsx`)

- **Warning banner**: yellow alert above reply area for `warning` events
- **Structured errors**: error panel with title, message, and action from registry
- **Auto-reconnect**: on network failure (not HTTP error), retries up to 3 times with exponential backoff (`min(1000 * 2^attempt, 4000)`)

## Test Coverage

| Test File                                                                | Tests                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------- |
| `tests/unit/lib/orchestration/llm/circuit-breaker.test.ts`               | States, transitions, window pruning, registry   |
| `tests/unit/lib/orchestration/llm/provider-fallback.test.ts`             | Primary, fallback, exhaustion, DB failure skip  |
| `tests/unit/lib/orchestration/chat/input-guard.test.ts`                  | All patterns, edge cases, false positive checks |
| `tests/unit/lib/orchestration/chat/error-messages.test.ts`               | All codes, fallback, non-empty guarantees       |
| `tests/unit/components/admin/orchestration/chat/chat-interface.test.tsx` | Warning banner, structured errors, reconnect    |
