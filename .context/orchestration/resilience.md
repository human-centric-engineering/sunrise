# Resilience & Error Handling

Phase 7 Session 7.3 — circuit breaker, provider fallback, budget UX, input guard, error registry, and SSE resilience.

## Quick Reference

| Feature                | Path                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| Circuit breaker        | `lib/orchestration/llm/circuit-breaker.ts`                                 |
| Provider fallback      | `lib/orchestration/llm/provider-manager.ts` → `getProviderWithFallbacks()` |
| Input guard            | `lib/orchestration/chat/input-guard.ts`                                    |
| Error message registry | `lib/orchestration/chat/error-messages.ts`                                 |
| Chat rate limiter      | `lib/security/rate-limit.ts` → `chatLimiter`                               |
| Warning ChatEvent      | `types/orchestration.ts` → `{ type: 'warning' }`                           |
| Client reconnect       | `components/admin/orchestration/agent-test-chat.tsx`                       |

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

## Input Sanitisation

`scanForInjection(message)` detects three pattern categories:

- `system_override` — "ignore/disregard/forget previous instructions"
- `role_confusion` — "you are now", "act as if you", "pretend you"
- `delimiter_injection` — `###`, `---`, `***`, `<system>`, `</system>`, etc.

**Log-only** — never blocks requests. Logs pattern labels only, never message content.

## Error Message Registry

`getUserFacingError(code)` returns `{ title, message, action? }` for known error codes:

| Code                      | Title                           |
| ------------------------- | ------------------------------- |
| `budget_exceeded`         | Monthly Budget Reached          |
| `all_providers_exhausted` | Service Temporarily Unavailable |
| `agent_not_found`         | Agent Not Found                 |
| `conversation_not_found`  | Conversation Not Found          |
| `tool_loop_cap`           | Processing Limit Reached        |
| `internal_error`          | Something Went Wrong            |
| `stream_error`            | Something Went Wrong            |
| `rate_limited`            | Too Many Requests               |

Unknown codes fall back to `internal_error`. Static map — zero runtime cost.

## Chat Rate Limiting

Dual rate limiting on `POST /chat/stream`:

1. `adminLimiter` — 30/min per IP (existing, defense against scripted abuse)
2. `chatLimiter` — 20/min per user ID (new, catches runaway admin usage)

Both configured in `lib/security/rate-limit.ts` via `SECURITY_CONSTANTS.RATE_LIMIT.LIMITS`.

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
