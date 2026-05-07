# External calls

The `external_call` workflow step type makes HTTP requests to external APIs. Lives in `lib/orchestration/engine/executors/external-call.ts` — a thin adapter that handles workflow-step concerns (interpolation, `ExecutorError` mapping, `StepResult` shape) and delegates the actual HTTP machinery to `lib/orchestration/http/`. The `call_external_api` capability shares the same shared module so both surfaces stay consistent.

## Quick reference

| Feature               | Path                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Executor              | `lib/orchestration/engine/executors/external-call.ts`                                    |
| Shared HTTP module    | `lib/orchestration/http/` (allowlist, auth, idempotency, response, fetch)                |
| Outbound rate limiter | `lib/orchestration/engine/outbound-rate-limiter.ts`                                      |
| Config schema         | `lib/validations/orchestration.ts` → `externalCallConfigSchema`                          |
| UI editor             | `components/admin/orchestration/workflow-builder/block-editors/external-call-editor.tsx` |
| Tests                 | `tests/unit/lib/orchestration/engine/executors/external-call.test.ts`                    |
| Shared module tests   | `tests/unit/lib/orchestration/http/`                                                     |
| Rate limiter tests    | `tests/unit/lib/orchestration/engine/outbound-rate-limiter.test.ts`                      |

## Config fields

| Field                  | Type                                                                    | Default                    | Description                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                  | `string`                                                                | required                   | Target endpoint. Host must be in `ORCHESTRATION_ALLOWED_HOSTS`                                                                                    |
| `method`               | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'`                       | `POST`                     | HTTP method                                                                                                                                       |
| `headers`              | `Record<string, string>`                                                | `{}`                       | Additional HTTP headers                                                                                                                           |
| `bodyTemplate`         | `string`                                                                | —                          | JSON template with `{{input}}` / `{{steps.stepId.output}}` interpolation                                                                          |
| `timeoutMs`            | `number`                                                                | `30000`                    | Request timeout in ms                                                                                                                             |
| `authType`             | `'none' \| 'bearer' \| 'api-key' \| 'query-param' \| 'basic' \| 'hmac'` | `'none'`                   | Authentication scheme                                                                                                                             |
| `authSecret`           | `string`                                                                | —                          | Environment variable name holding the secret (never the raw value)                                                                                |
| `authQueryParam`       | `string`                                                                | `'api_key'`                | Query parameter name when `authType` is `'query-param'`                                                                                           |
| `apiKeyHeaderName`     | `string`                                                                | `'X-API-Key'`              | Header name when `authType` is `'api-key'`. Lets vendors with non-standard names (e.g. Postmark's `X-Postmark-Server-Token`) use the api-key path |
| `hmacHeaderName`       | `string`                                                                | `'X-Signature'`            | Header name for the HMAC signature when `authType` is `'hmac'`                                                                                    |
| `hmacAlgorithm`        | `'sha256' \| 'sha512'`                                                  | `'sha256'`                 | HMAC digest algorithm                                                                                                                             |
| `hmacBodyTemplate`     | `string`                                                                | `{method}\n{path}\n{body}` | Template for the signed string. Tokens: `{method}`, `{path}`, `{body}`                                                                            |
| `idempotencyKey`       | `string \| 'auto'`                                                      | —                          | `'auto'` for fresh UUID per call; explicit string used verbatim. Omit to skip                                                                     |
| `idempotencyKeyHeader` | `string`                                                                | `'Idempotency-Key'`        | Header name for the idempotency key                                                                                                               |
| `maxResponseBytes`     | `number`                                                                | `1048576`                  | Maximum response body size (1 MB)                                                                                                                 |
| `responseTransform`    | `{ type, expression }`                                                  | —                          | Transform the response body before returning (see below)                                                                                          |

## Response Transformation

The `responseTransform` config field lets you extract or reshape API response data before it becomes the step output. This avoids needing a downstream `llm_call` step just to parse a JSON response.

```jsonc
{
  "url": "https://api.example.com/users",
  "responseTransform": {
    "type": "jmespath",
    "expression": "data.items[?status=='active'].{id: id, name: name}",
  },
}
```

### Transform types

| Type       | Description                                                                                |
| ---------- | ------------------------------------------------------------------------------------------ |
| `jmespath` | [JMESPath](https://jmespath.org/) expression — structured extraction from JSON responses   |
| `template` | Simple `{{path.to.field}}` interpolation — produces a string with values from the response |

**JMESPath** is the recommended type for structured extraction. It supports filtering, projections, multi-select, and sorting — e.g., `data.items[?price > \`100\`].{name: name, price: price}`.

**Template** mode replaces `{{path}}` placeholders with values from the response body. Useful for constructing strings like `"User {{data.name}} ({{data.id}})"`. Missing paths resolve to empty strings; object values are JSON-serialized.

### Error handling

Transform failures are **non-fatal**. If the expression is invalid or the response shape doesn't match, the step returns the full original response with a `_transformError` field:

```json
{
  "status": 200,
  "body": { "original": "response" },
  "_transformError": "Invalid JMESPath expression: unexpected token"
}
```

This lets downstream steps detect and handle transform issues without failing the workflow.

## Security

### SSRF protection

All outbound URLs are validated against the `ORCHESTRATION_ALLOWED_HOSTS` environment variable (comma-separated hostnames). An empty or absent allowlist blocks all external calls. The parsed allowlist is cached in memory and refreshed when the env var value changes.

### Credential handling

Secrets are **never** stored in the database or workflow config. The `authSecret` field holds an environment variable _name_ (e.g., `EXTERNAL_API_TOKEN`), resolved at execution time via `process.env[authSecret]`.

If the env var is missing, the executor **fails fast** with a non-retriable `missing_auth_secret` error — it does not silently drop auth headers.

### Env-var templating in stringy fields

Beyond `authSecret`, certain fields whose values may themselves be credentials (e.g. an admin-pinned webhook URL on `forcedUrl`, a literal `Authorization` line on `forcedHeaders`) accept the `${env:VAR_NAME}` template syntax. The literal template stays in the DB; the value resolves on every call.

**Where it works.**

| Surface                                | Templated fields                                            |
| -------------------------------------- | ----------------------------------------------------------- |
| `call_external_api` capability binding | `customConfig.forcedUrl`, `customConfig.forcedHeaders`      |
| `external_call` workflow step config   | `config.url` (after prompt interpolation), `config.headers` |

**Where it doesn't.** Auth fields (`authSecret`, `auth.secret`) already use the env-var-name pattern — keep using that. The body / `bodyTemplate` carries workflow-context interpolation only.

**Pattern.** `${env:NAME}` where NAME matches `[A-Z][A-Z0-9_]*`. Multiple references per string and a mix of literal text + templates are both supported (`https://api.example.com/${env:REGION}/v1` is valid).

**Failure mode.** Same fail-closed posture as `readSecret()`:

| Surface              | Missing env var → error                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `call_external_api`  | Capability result `error.code = invalid_binding` (no outbound request)       |
| `external_call` step | `ExecutorError(stepId, 'missing_env_var')` — workflow error strategy applies |

**Save-time hint.** The capability binding API (`POST` / `PATCH /agents/:id/capabilities`) scans `forcedUrl` and `forcedHeaders` for env-var references and returns `meta.warnings.missingEnvVars: string[]` for any names not currently set in the running process. Soft warning — the binding still saves so admins can deploy the env var afterwards. The agent Capabilities tab renders this as an inline amber panel under the JSON editor.

### Auth types

| Type          | Behavior                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`        | No auth headers added                                                                                                                                                |
| `bearer`      | `Authorization: Bearer <secret>` header                                                                                                                              |
| `api-key`     | `X-API-Key: <secret>` header                                                                                                                                         |
| `query-param` | Appends `?<authQueryParam>=<secret>` to the URL                                                                                                                      |
| `basic`       | `Authorization: Basic base64(<secret>)`. Env var with `:` (e.g. `user:pass`) is base64-encoded; without `:`, treated as already-encoded                              |
| `hmac`        | Signs `${method}\n${path}\n${body}` (or custom `hmacBodyTemplate`) with the secret using SHA-256 or SHA-512; sets the digest as the `X-Signature` header (or custom) |

### Idempotency

When `idempotencyKey` is set, the executor attaches an `Idempotency-Key` header (or custom `idempotencyKeyHeader`). Use `'auto'` for a fresh UUID per call, or an explicit string for deterministic keys (e.g. tied to a business identifier). Essential for safe retries on payment APIs.

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

### Binary response handling

Responses with binary content types are detected and returned as a base64 wrapper rather than UTF-8-decoded (which would corrupt the bytes). The wrapper shape:

```json
{ "encoding": "base64", "contentType": "application/pdf", "data": "<base64-encoded body>" }
```

Detected binary content types: `application/pdf`, `application/octet-stream`, `application/zip`, and anything matching `image/*`, `audio/*`, or `video/*`. Other content types (JSON, text, anything not in the binary set) take the existing parse path.

The capability layer surfaces this wrapper directly as the `body` of `CapabilityResult.data` — consumers detect it via `isBinaryResponseBody(body)` (re-exported from `@/lib/orchestration/http`) and typically hand the bytes to a storage capability rather than letting the LLM see base64 inline.

### Per-step timeout

Every step config supports `timeoutMs` (on `stepErrorConfigSchema`). The engine wraps executor invocation in `Promise.race` against a timeout. Timeout produces a non-retriable `step_timeout` error.

For `external_call`, there are two timeout layers:

1. **Step-level timeout** (`config.timeoutMs` on `stepErrorConfigSchema`) — enforced by the engine, wraps the entire step including retries.
2. **HTTP-level timeout** (`config.timeoutMs` on `externalCallConfigSchema`) — enforced by the executor's `AbortController`, applies to the individual HTTP request.

## Abort signal linking

The external call executor links to the execution-level abort signal (`ctx.signal`). Before sending any HTTP request, the executor checks if `ctx.signal` is already aborted and fails fast with a non-retriable `request_aborted` error. During the request, the signal is forwarded to the `fetch` call's `AbortController` so that client disconnects or DB-side cancellations propagate to the outbound HTTP request. When the request completes (or fails), the abort listener is cleaned up to avoid memory leaks.

## Observability

The shared HTTP module logs:

- **Before request**: `HTTP request: sending` with `method`, `hostname`, `path`, `timeoutMs`, plus any `logContext` from the caller (the executor passes `stepId`)
- **On success**: `HTTP request: success` with `method`, `hostname`, `status`, `latencyMs`, plus `logContext`
- **On non-2xx**: `HTTP request: non-2xx response` (warning) with `status`, `retriable`, `latencyMs`, `bodyPreview` (first 200 chars), plus `logContext`

Auth headers and secrets are never logged.

## Error codes

| Code                    | Retriable | Description                                                              |
| ----------------------- | --------- | ------------------------------------------------------------------------ |
| `missing_url`           | Yes       | Step config has no `url`                                                 |
| `missing_env_var`       | No        | A `${env:VAR}` reference in `url` / `headers` points at an unset env var |
| `host_not_allowed`      | No        | Hostname not in `ORCHESTRATION_ALLOWED_HOSTS`                            |
| `missing_auth_secret`   | No        | Auth env var is not set                                                  |
| `outbound_rate_limited` | Yes       | Per-host rate limit exceeded                                             |
| `request_failed`        | Yes       | Network error or timeout                                                 |
| `request_aborted`       | No        | Execution's AbortSignal was already triggered                            |
| `http_error`            | No        | Non-retriable HTTP status (4xx except 429)                               |
| `http_error_retriable`  | Yes       | Retriable HTTP status (429, 502, 503, 504)                               |
| `response_too_large`    | No        | Response body exceeds `maxResponseBytes`                                 |
| `step_timeout`          | No        | Per-step timeout exceeded (engine-level)                                 |

## Environment variables

| Variable                            | Default             | Description                                          |
| ----------------------------------- | ------------------- | ---------------------------------------------------- |
| `ORCHESTRATION_ALLOWED_HOSTS`       | (empty = block all) | Comma-separated hostnames allowed for external calls |
| `ORCHESTRATION_OUTBOUND_RATE_LIMIT` | `60`                | Max outbound requests per minute per host            |
