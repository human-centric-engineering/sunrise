# External calls

The `external_call` workflow step type makes HTTP requests to external APIs. Lives in `lib/orchestration/engine/executors/external-call.ts`.

## Quick reference

| Feature               | Path                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Executor              | `lib/orchestration/engine/executors/external-call.ts`                                    |
| Outbound rate limiter | `lib/orchestration/engine/outbound-rate-limiter.ts`                                      |
| Config schema         | `lib/validations/orchestration.ts` → `externalCallConfigSchema`                          |
| UI editor             | `components/admin/orchestration/workflow-builder/block-editors/external-call-editor.tsx` |
| Tests                 | `tests/unit/lib/orchestration/engine/executors/external-call.test.ts`                    |
| Rate limiter tests    | `tests/unit/lib/orchestration/engine/outbound-rate-limiter.test.ts`                      |

## Config fields

| Field              | Type                                               | Default     | Description                                                              |
| ------------------ | -------------------------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `url`              | `string`                                           | required    | Target endpoint. Host must be in `ORCHESTRATION_ALLOWED_HOSTS`           |
| `method`           | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'`  | `POST`      | HTTP method                                                              |
| `headers`          | `Record<string, string>`                           | `{}`        | Additional HTTP headers                                                  |
| `bodyTemplate`     | `string`                                           | —           | JSON template with `{{input}}` / `{{steps.stepId.output}}` interpolation |
| `timeoutMs`        | `number`                                           | `30000`     | Request timeout in ms                                                    |
| `authType`         | `'none' \| 'bearer' \| 'api-key' \| 'query-param'` | `'none'`    | Authentication scheme                                                    |
| `authSecret`       | `string`                                           | —           | Environment variable name holding the secret (never the raw value)       |
| `authQueryParam`   | `string`                                           | `'api_key'` | Query parameter name when `authType` is `'query-param'`                  |
| `maxResponseBytes` | `number`                                           | `1048576`   | Maximum response body size (1 MB)                                        |

## Security

### SSRF protection

All outbound URLs are validated against the `ORCHESTRATION_ALLOWED_HOSTS` environment variable (comma-separated hostnames). An empty or absent allowlist blocks all external calls. The parsed allowlist is cached in memory and refreshed when the env var value changes.

### Credential handling

Secrets are **never** stored in the database or workflow config. The `authSecret` field holds an environment variable _name_ (e.g., `EXTERNAL_API_TOKEN`), resolved at execution time via `process.env[authSecret]`.

If the env var is missing, the executor **fails fast** with a non-retriable `missing_auth_secret` error — it does not silently drop auth headers.

### Auth types

| Type          | Behavior                                        |
| ------------- | ----------------------------------------------- |
| `none`        | No auth headers added                           |
| `bearer`      | `Authorization: Bearer <secret>` header         |
| `api-key`     | `X-API-Key: <secret>` header                    |
| `query-param` | Appends `?<authQueryParam>=<secret>` to the URL |

## Resilience

### Outbound rate limiting

Per-host sliding-window rate limiting prevents workflows from overwhelming external APIs. Default: 60 requests/minute per host. Configurable via `ORCHESTRATION_OUTBOUND_RATE_LIMIT` env var.

When a `429` response includes a `Retry-After` header, the rate limiter records the backoff deadline. Subsequent requests to that host are blocked until the deadline passes.

Rate limiter state is per-instance in-memory (matching the circuit-breaker pattern). For coordinated rate limiting across containers, back with Redis.

### HTTP error classification

Non-2xx responses are classified as **retriable** or **non-retriable**:

| Status                   | Classification | Error code             |
| ------------------------ | -------------- | ---------------------- |
| 429                      | Retriable      | `http_error_retriable` |
| 502                      | Retriable      | `http_error_retriable` |
| 503                      | Retriable      | `http_error_retriable` |
| 504                      | Retriable      | `http_error_retriable` |
| 400, 401, 403, 404, etc. | Non-retriable  | `http_error`           |

Non-retriable errors skip the engine's `retry` error strategy entirely — there's no point retrying a 404. The `retriable` flag on `ExecutorError` controls this behavior.

### Response size limiting

Responses are capped at `maxResponseBytes` (default 1 MB). Both `Content-Length` header and actual body size are checked. Oversized responses produce a non-retriable `response_too_large` error.

### Per-step timeout

Every step config supports `timeoutMs` (on `stepErrorConfigSchema`). The engine wraps executor invocation in `Promise.race` against a timeout. Timeout produces a non-retriable `step_timeout` error.

For `external_call`, there are two timeout layers:

1. **Step-level timeout** (`config.timeoutMs` on `stepErrorConfigSchema`) — enforced by the engine, wraps the entire step including retries.
2. **HTTP-level timeout** (`config.timeoutMs` on `externalCallConfigSchema`) — enforced by the executor's `AbortController`, applies to the individual HTTP request.

## Abort signal linking

The external call executor links to the execution-level abort signal (`ctx.signal`). Before sending any HTTP request, the executor checks if `ctx.signal` is already aborted and fails fast with a non-retriable `request_aborted` error. During the request, the signal is forwarded to the `fetch` call's `AbortController` so that client disconnects or DB-side cancellations propagate to the outbound HTTP request. When the request completes (or fails), the abort listener is cleaned up to avoid memory leaks.


## Observability

The executor logs:

- **Before request**: `External call: sending request` with `stepId`, `method`, `hostname`, `path`, `timeoutMs`
- **On success**: `External call: success` with `stepId`, `method`, `hostname`, `status`, `latencyMs`
- **On non-2xx**: `External call: non-2xx response` (warning) with `status`, `retriable`, `latencyMs`, `bodyPreview` (first 200 chars)

Auth headers and secrets are never logged.

## Error codes

| Code                    | Retriable | Description                                   |
| ----------------------- | --------- | --------------------------------------------- |
| `missing_url`           | Yes       | Step config has no `url`                      |
| `host_not_allowed`      | No        | Hostname not in `ORCHESTRATION_ALLOWED_HOSTS` |
| `missing_auth_secret`   | No        | Auth env var is not set                       |
| `outbound_rate_limited` | Yes       | Per-host rate limit exceeded                  |
| `request_failed`        | Yes       | Network error or timeout                      |
| `request_aborted`       | No        | Execution's AbortSignal was already triggered |
| `http_error`            | No        | Non-retriable HTTP status (4xx except 429)    |
| `http_error_retriable`  | Yes       | Retriable HTTP status (429, 502, 503, 504)    |
| `response_too_large`    | No        | Response body exceeds `maxResponseBytes`      |
| `step_timeout`          | No        | Per-step timeout exceeded (engine-level)      |

## Environment variables

| Variable                            | Default             | Description                                          |
| ----------------------------------- | ------------------- | ---------------------------------------------------- |
| `ORCHESTRATION_ALLOWED_HOSTS`       | (empty = block all) | Comma-separated hostnames allowed for external calls |
| `ORCHESTRATION_OUTBOUND_RATE_LIMIT` | `60`                | Max outbound requests per minute per host            |
