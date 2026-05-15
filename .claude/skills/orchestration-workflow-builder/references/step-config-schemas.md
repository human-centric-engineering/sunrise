# Step Config Schemas — Complete Reference

Default config values for every step type, as defined in `lib/orchestration/engine/step-registry.ts`.

## Agent Steps

### llm_call

```json
{ "prompt": "", "modelOverride": "", "temperature": 0.7 }
```

- `prompt` — the prompt template (supports `{{input}}`, `{{previous.output}}`, `{{stepId.output}}`)
- `modelOverride` — optional model slug; empty = use workflow's agent model
- `temperature` — 0.0-1.0

### chain

```json
{ "steps": [] }
```

- `steps` — array of sub-step objects (each with `prompt` and optional `validationPrompt`)

### reflect

```json
{ "critiquePrompt": "", "maxIterations": 3 }
```

- `critiquePrompt` — prompt for the critique phase
- `maxIterations` — max draft/critique/revise cycles (1-10)

### plan

```json
{ "objective": "", "maxSubSteps": 5 }
```

- `objective` — what the agent should plan for
- `maxSubSteps` — max sub-steps the agent can generate (1-20)

### agent_call

```json
{ "agentSlug": "", "message": "{{input}}", "maxToolIterations": 5 }
```

- `agentSlug` — slug of the agent to invoke (required, semantic-validated)
- `message` — message to send to the agent (supports templates)
- `maxToolIterations` — max tool call rounds before forcing a response
- `mode` — optional: `"single-turn"` (default) or `"multi-turn"`

## Decision Steps

### route

```json
{ "classificationPrompt": "", "routes": [] }
```

- `classificationPrompt` — prompt for intent classification
- `routes` — object mapping route keys to descriptions (min 2 required)

### human_approval

```json
{ "prompt": "", "timeoutMinutes": 60, "notificationChannel": "in-app" }
```

- `prompt` — required; displayed to the reviewer. **Supports `{{stepId.output}}` template interpolation** (same as `llm_call`) so the prompt can show accumulated outputs from earlier steps. **Rendered as markdown** in both the approvals queue and the execution detail view — headings, bulleted instructions, fenced code blocks all render as expected. Raw HTML is NOT rendered (no XSS surface).
- `timeoutMinutes` — how long before the approval times out
- `notificationChannel` — `"in-app"` or `"email"`

### guard

```json
{ "rules": "", "mode": "llm", "failAction": "block", "temperature": 0.1 }
```

- `rules` — safety rules to check against (required)
- `mode` — `"llm"` (LLM evaluates) or `"regex"` (regex pattern matching)
- `failAction` — `"block"` (stop workflow) or `"flag"` (continue with warning)

**`mode: 'llm'` authoring rules:**

- If a rule references a closed set ("must be a recognised X", "field name must be valid"), **enumerate the set in the prompt** — the LLM cannot read your schema. Source the list from the same constant the downstream apply step uses (`import { … } from '@/lib/orchestration/capabilities/built-in/…'`) so the two cannot drift.
- Backtick-wrap literal identifier values (`` `bestRole` ``) so the model parses them as strings, not natural-language nouns.
- For purely structural checks (enum-in-set, regex shape, presence/absence), prefer `mode: 'regex'` or a deterministic capability over an LLM guard. LLM mode is for fuzzy judgments (tone, on-topic, plausibility), not closed-set membership.

See `gotchas.md` → _"`guard` Steps in `mode: 'llm'` Cannot Validate Against An Implicit Closed Set"_ for the failure mode this guards against.

### evaluate

```json
{ "rubric": "", "scaleMin": 1, "scaleMax": 5, "threshold": 3 }
```

- `rubric` — evaluation criteria (required)
- `scaleMin`/`scaleMax` — scoring range
- `threshold` — minimum score to pass

## Input Steps

### tool_call

```json
{ "capabilitySlug": "" }
```

- `capabilitySlug` — slug of the capability to execute (required, semantic-validated)

### rag_retrieve

```json
{ "query": "", "topK": 10, "similarityThreshold": 0.8, "categories": [] }
```

- `query` — search query (supports templates)
- `topK` — number of results to return (default `10`)
- `similarityThreshold` — minimum cosine similarity, 0.0–1.0 (default `0.8`)
- `categories` — optional category filter; empty array = search all categories the agent has access to

### external_call

```json
{
  "url": "https://api.example.com/resource",
  "method": "POST",
  "headers": { "X-Source": "sunrise" },
  "bodyTemplate": "{ \"query\": \"{{input.query}}\" }",
  "timeoutMs": 30000,
  "authType": "bearer",
  "authSecret": "EXAMPLE_API_TOKEN",
  "idempotencyKey": "auto"
}
```

- `url` — endpoint URL (required). Supports `${env:VAR}` templates resolved at call time and `{{stepId.output}}` interpolation. **Avoid interpolating large step outputs into query parameters** — vendors typically cap individual params (Brave Search caps `q` at 400 chars; most APIs are stricter than the 2,048-char HTTP URL practical limit). For payloads that might exceed ~200 chars, use a `POST` with `bodyTemplate` or pre-summarise the upstream output in an `llm_call`. See `gotchas.md` → _"`external_call` URL Query Strings Respect Vendor Length Limits"_.
- `method` — `GET` / `POST` / `PUT` / `PATCH` / `DELETE`.
- `headers` — optional headers object. Values support `${env:VAR}` templating.
- `bodyTemplate` — optional string body (supports `{{stepId.output}}` templates). **Mutually exclusive with `multipart`.**
- `multipart` — optional `{ files: [{ name, filename?, contentType, data }], fields?: Record<string,string> }` for `multipart/form-data` bodies. File `data` is base64; per-file 8 MB cap and 25 MB total cap. **Mutually exclusive with `bodyTemplate`. Incompatible with `authType: 'hmac'` (rejected as `multipart_hmac_unsupported`).**
- `timeoutMs` — request timeout.
- `authType` — `none` / `bearer` / `api-key` / `query-param` / `basic` / `hmac`. (Note: hyphenated, not `api_key`.)
- `authSecret` — env var name containing the secret. The literal `${env:VAR}` stays in config; resolved on every call. Missing env var → `missing_env_var` at execute time.
- `apiKeyHeaderName` — header name when `authType: 'api-key'` (default `X-API-Key`). Set this for vendors whose contract requires a non-standard header. **Always read the vendor's docs** — getting it wrong yields a 401/403/422 with a body like `Field required: x-subscription-token`. Known examples:
  - Brave Search → `X-Subscription-Token`
  - Postmark → `X-Postmark-Server-Token`
  - SendGrid → uses `Authorization: Bearer <key>` (`authType: 'bearer'`, not `api-key`)
  - Anthropic / OpenAI → `Authorization: Bearer <key>` (`authType: 'bearer'`)
  - AWS SigV4 services → not directly supported; use `authType: 'hmac'` or a pre-signed URL.
- `authQueryParam` — query-param name when `authType: 'query-param'` (default `api_key`).
- `hmacHeaderName`, `hmacAlgorithm` (`sha256` / `sha512`), `hmacBodyTemplate` — HMAC config when `authType: 'hmac'`. Template tokens: `{method}`, `{path}`, `{body}`.
- `idempotencyKey` — `"auto"` generates a UUID per call; any other string is used verbatim. The crash-recovery dispatch cache derives a key automatically if you don't set one.
- `idempotencyKeyHeader` — header name for the idempotency key (default `Idempotency-Key`).
- `responseTransform` — optional JMESPath or Handlebars expression to extract data from the response.
- `errorStrategy` — per-step error behaviour. For optional enrichment calls (e.g. third-party search APIs that may be missing an env var) use `'skip'` so the workflow continues with `null` output instead of failing.
- `expectedSkip` — set `true` on optional steps that you actively expect to skip in normal operation (missing API key, vendor offline, etc.). When the `'skip'` strategy fires on such a step, the trace entry renders as `Optional step skipped: <reason>` in muted text rather than the standard skip styling, and the expanded view uses a slate "Skip reason" pane instead of the red "Error" pane. Default `false` — the flag only tones down styling, it never suppresses the diagnostic. Available on any step type that accepts an `errorStrategy`.

## Output Steps

### parallel

```json
{ "branches": [], "timeoutMs": 60000, "stragglerStrategy": "wait-all" }
```

- `branches` — array of arrays of step IDs (each inner array is a sequential branch)
- `timeoutMs` — max time for all branches to complete
- `stragglerStrategy` — `"wait-all"` or `"first-completed"`

### send_notification

```json
{ "channel": "email", "to": "", "subject": "", "bodyTemplate": "{{input}}" }
```

- `channel` — `"email"` or `"webhook"`
- Email mode: `to` (recipient), `subject` (subject line)
- Webhook mode: `webhookUrl` (target URL)
- `bodyTemplate` — notification body (supports templates)

## Orchestration Steps

### orchestrator

```json
{
  "plannerPrompt": "",
  "availableAgentSlugs": [],
  "selectionMode": "auto",
  "maxRounds": 3,
  "maxDelegationsPerRound": 5,
  "timeoutMs": 120000
}
```

- `plannerPrompt` — instructions for the AI planner
- `availableAgentSlugs` — agent slugs the orchestrator can delegate to (semantic-validated)
- `selectionMode` — `"auto"` (AI picks) or `"round-robin"`
- `maxRounds` — max planning/delegation rounds
- `maxDelegationsPerRound` — max agents per round
- `timeoutMs` — total orchestration timeout
