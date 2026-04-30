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
| Client reconnect        | `components/admin/orchestration/agent-test-chat.tsx`                       |

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

1. Record a circuit breaker failure for the current provider
2. Emit `{ type: 'warning', code: 'provider_retry' }` SSE event
3. Reset accumulated content and tool calls
4. Resolve the next provider from `agent.fallbackProviders`
5. Restart the stream from the new provider

Maximum retries: 2 (`MAX_STREAM_RETRIES`). `AbortError` (client disconnect) bypasses retry — no point retrying if nobody's listening. See [Streaming Chat Handler](./chat.md#mid-stream-retry--recovery) for details.

## Guard Mode Fallback Logging

When the streaming handler fails to load `OrchestrationSettings` (e.g. DB outage) for either input or output guard mode resolution, it falls back to `log_only` and logs a `logger.warn` with a message like `'Failed to load orchestration settings for input guard mode, falling back to log_only'`. This ensures admins are alerted that their configured `block` or `warn_and_continue` mode isn't being enforced, rather than silently degrading.

## Tool Error Backoff

The streaming handler tracks per-tool consecutive failure counts. After a tool fails **2 consecutive times** (`TOOL_FAILURE_THRESHOLD`), the handler skips subsequent dispatch calls for that tool and returns a `{ success: false, error: { code: 'tool_unavailable' } }` result to the LLM. This prevents a broken tool from burning through all `MAX_TOOL_ITERATIONS` iterations. A successful dispatch resets the counter.

Applies to both single and parallel tool dispatch paths.

## Maintenance Tick Overlap Protection

The unified maintenance tick (`POST /api/v1/admin/orchestration/maintenance/tick`) uses a module-level `tickRunning` boolean flag to prevent concurrent execution. If a tick is still running when the next cron fires, the endpoint returns `{ skipped: true, reason: 'previous tick still running' }` without calling any maintenance functions. The flag is cleared in a `finally` block to guarantee reset even on errors.

This is sufficient for single-server deployments. Multi-instance deployments would need a distributed lock (e.g. Postgres advisory lock or Redis).

## SSE Resilience

### Server-side

- `sseResponse()` sends 15s keepalive comment frames
- `streaming-handler.ts` persists partial responses before errors
- Error events are sanitized — raw provider errors never reach the client

### Client-side (`agent-test-chat.tsx`)

- **Warning banner**: yellow alert above reply area for `warning` events
- **Structured errors**: error panel with title, message, and action from registry
- **Auto-reconnect**: on network failure (not HTTP error), retries up to 3 times with exponential backoff (`min(1000 * 2^attempt, 4000)`)

## Test Coverage

| Test File                                                            | Tests                                           |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| `tests/unit/lib/orchestration/llm/circuit-breaker.test.ts`           | States, transitions, window pruning, registry   |
| `tests/unit/lib/orchestration/llm/provider-fallback.test.ts`         | Primary, fallback, exhaustion, DB failure skip  |
| `tests/unit/lib/orchestration/chat/input-guard.test.ts`              | All patterns, edge cases, false positive checks |
| `tests/unit/lib/orchestration/chat/error-messages.test.ts`           | All codes, fallback, non-empty guarantees       |
| `tests/unit/components/admin/orchestration/agent-test-chat.test.tsx` | Warning banner, structured errors, reconnect    |
