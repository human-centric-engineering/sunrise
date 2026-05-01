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

- `prompt` — required; displayed to the reviewer
- `timeoutMinutes` — how long before the approval times out
- `notificationChannel` — `"in-app"` or `"email"`

### guard

```json
{ "rules": "", "mode": "llm", "failAction": "block", "temperature": 0.1 }
```

- `rules` — safety rules to check against (required)
- `mode` — `"llm"` (LLM evaluates) or `"regex"` (regex pattern matching)
- `failAction` — `"block"` (stop workflow) or `"flag"` (continue with warning)

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
{ "query": "", "topK": 5, "similarityThreshold": 0.7 }
```

- `query` — search query (supports templates)
- `topK` — number of results to return
- `similarityThreshold` — minimum cosine similarity (0.0-1.0)

### external_call

```json
{ "url": "", "method": "POST", "timeoutMs": 30000, "authType": "none" }
```

- `url` — endpoint URL (required)
- `method` — HTTP method
- `headers` — optional headers object
- `bodyTemplate` — optional body (supports templates)
- `timeoutMs` — request timeout
- `authType` — `"none"`, `"bearer"`, or `"api_key"`
- `authSecret` — env var name containing the secret (for bearer/api_key)
- `responseTransform` — optional JMESPath or Handlebars expression to extract data

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
