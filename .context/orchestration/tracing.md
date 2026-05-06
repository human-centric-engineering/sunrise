# Orchestration tracing (OTEL plug-in)

Vendor-neutral tracing primitive for the orchestration layer. Lives in `lib/orchestration/tracing/`. Default registration is a **no-op** — zero allocations on the hot path, zero new dependencies for forks that don't enable tracing. One first-party adapter ships: an OpenTelemetry implementation that forks opt into by constructing their own `TracerProvider` and calling `registerOtelTracer()`.

## Quick start

By default, no tracer is wired. Every `withSpan` call site routes through the `NoopTracer` and produces zero spans. To enable OTEL ingestion in a fork:

```typescript
// instrumentation.ts (Next.js bootstrap file)
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerOtelTracer } from '@/lib/orchestration/tracing';

const sdk = new NodeSDK({
  serviceName: 'sunrise-orchestration',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  }),
});
sdk.start();

await registerOtelTracer();
```

Standard OTEL env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`) are honoured by the `NodeSDK` / `OTLPTraceExporter` directly — Sunrise does not read them.

`@opentelemetry/api` is transitively present in this codebase via Next.js + Sentry, so forks don't need to install anything extra. Forks that strip those upstream deps must `npm install @opentelemetry/api` (and a TracerProvider package such as `@opentelemetry/sdk-node` plus an exporter) before calling `registerOtelTracer()` — the helper throws a clear error if the runtime import fails.

## Module layout

```
lib/orchestration/tracing/
├── tracer.ts            # Tracer + Span interface (zero deps)
├── noop-tracer.ts       # NOOP_TRACER + NOOP_SPAN — singleton zero-cost defaults
├── registry.ts          # getTracer / registerTracer / resetTracer (module-level singleton)
├── attributes.ts        # GenAI semantic-convention keys + Sunrise extensions + span name constants
├── with-span.ts         # withSpan, withSpanGenerator, startManualSpan, setSpanAttributes/Status, recordSpanException — the single point of exception safety
├── otel-adapter.ts      # OtelTracer — implements Tracer against @opentelemetry/api
├── otel-bootstrap.ts    # registerOtelTracer() — server-only opt-in helper
└── index.ts             # barrel export
```

## Span tree

The orchestration layer emits the following span tree per workflow / chat invocation. Spans are gated by whether their entry point is reached at runtime — a workflow that never makes an LLM call produces no `llm.call` spans.

```
chat.turn                          (streaming-handler.ts → run())
├── llm.call (tool_iteration=1)    (currentProvider.chatStream — first turn)
│   └── capability.dispatch        (auto-attached when the LLM's tool call dispatches)
└── llm.call (tool_iteration=2)    (after the tool result is fed back)

workflow.execute                   (orchestration-engine.ts → execute())
├── workflow.step                  (one per single sequential step)
│   ├── llm.call                   (runLlmCall — for llm_call executors)
│   ├── agent_call.turn            (one per turn of an agent_call multi-turn loop)
│   │   ├── llm.call
│   │   └── capability.dispatch
│   └── capability.dispatch        (tool_call executor)
└── workflow.step (parallel)       (one per concurrent branch — siblings of workflow.execute)
```

`agent_call.turn` is opened once per iteration of `runSingleTurn` in `executors/agent-call.ts` — its `sunrise.tool_iteration` attribute distinguishes the iterations (1-indexed). Mid-stream provider failover in the chat handler does **not** open a new span tier; the failed `llm.call` span records `sunrise.provider.failover_from` / `sunrise.provider.failover_to` attributes plus a recorded exception, and the next attempt opens a fresh `llm.call` sibling.

The full tree above is what every OTLP backend (Honeycomb, Datadog, Tempo, Langfuse) sees — one trace per execution / chat turn, with all spans nested as a waterfall. Two helpers wire this up: `withSpan` for callback-shaped sites (LLM runner, capability dispatcher, agent-call turn) and `withSpanGenerator` for async-generator-shaped sites (engine `execute()` and `workflow.step`, chat handler `run()` and the streaming `llm.call`). Both activate the span as the OTEL active context via `AsyncLocalStorage`, so nested span creation sees the outer span as parent automatically.

## Span name constants

| Constant                   | Value                      | Where it's emitted                                                                                                        |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `SPAN_WORKFLOW_EXECUTE`    | `workflow.execute`         | `orchestration-engine.ts` — top-level workflow run                                                                        |
| `SPAN_WORKFLOW_STEP`       | `workflow.step`            | `orchestration-engine.ts` — per step (sequential + parallel)                                                              |
| `SPAN_LLM_CALL`            | `llm.call`                 | `llm-runner.ts`, `streaming-handler.ts`, `summarizer.ts`, `evaluations/parse-structured.ts`                               |
| `SPAN_AGENT_CALL_TURN`     | `agent_call.turn`          | `executors/agent-call.ts` — per turn                                                                                      |
| `SPAN_CAPABILITY_DISPATCH` | `capability.dispatch`      | `capabilities/dispatcher.ts` — single internal wrap                                                                       |
| `SPAN_CHAT_TURN`           | `chat.turn`                | `streaming-handler.ts` — top-level chat run                                                                               |
| `SPAN_TOOL_LOOP_ITERATION` | `chat.tool_loop_iteration` | _Reserved — not yet emitted (tool iteration is currently captured as a `sunrise.tool_iteration` attribute on `llm.call`)_ |

## Attribute reference

### GenAI semantic conventions

These align with [OpenTelemetry's GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) so any OTLP backend (Datadog, Honeycomb, Grafana Tempo, Langfuse-via-OTLP) renders Sunrise spans without custom mapping.

| Constant                     | Key                          | Type   | Where set                                                                                                      |
| ---------------------------- | ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `GEN_AI_OPERATION_NAME`      | `gen_ai.operation.name`      | string | every LLM/tool span. Values: `chat`, `tool_call`, `summary`, `evaluation`                                      |
| `GEN_AI_SYSTEM`              | `gen_ai.system`              | string | every LLM span — provider slug (`openai`, `anthropic`, …)                                                      |
| `GEN_AI_REQUEST_MODEL`       | `gen_ai.request.model`       | string | every LLM span at start                                                                                        |
| `GEN_AI_RESPONSE_MODEL`      | `gen_ai.response.model`      | string | every LLM span after response                                                                                  |
| `GEN_AI_REQUEST_TEMPERATURE` | `gen_ai.request.temperature` | number | every LLM span (when set)                                                                                      |
| `GEN_AI_REQUEST_MAX_TOKENS`  | `gen_ai.request.max_tokens`  | number | every LLM span (when set)                                                                                      |
| `GEN_AI_USAGE_INPUT_TOKENS`  | `gen_ai.usage.input_tokens`  | number | every LLM span after response                                                                                  |
| `GEN_AI_USAGE_OUTPUT_TOKENS` | `gen_ai.usage.output_tokens` | number | every LLM span after response                                                                                  |
| `GEN_AI_USAGE_TOTAL_TOKENS`  | `gen_ai.usage.total_tokens`  | number | every LLM span after response                                                                                  |
| `GEN_AI_TOOL_NAME`           | `gen_ai.tool.name`           | string | `capability.dispatch` — capability slug                                                                        |
| `GEN_AI_PROMPT`              | `gen_ai.prompt`              | string | **Opt-in only** — never set unless `SUNRISE_OTEL_RECORD_PROMPTS=true`. (Future opt-in; not currently emitted.) |
| `GEN_AI_COMPLETION`          | `gen_ai.completion`          | string | **Opt-in only** — same gating.                                                                                 |

### Sunrise extensions

| Constant                         | Key                              | Type    | Where set                                                         |
| -------------------------------- | -------------------------------- | ------- | ----------------------------------------------------------------- |
| `SUNRISE_EXECUTION_ID`           | `sunrise.execution_id`           | string  | `workflow.execute` + every `workflow.step` + nested LLM spans     |
| `SUNRISE_WORKFLOW_ID`            | `sunrise.workflow_id`            | string  | `workflow.execute`                                                |
| `SUNRISE_STEP_ID`                | `sunrise.step_id`                | string  | `workflow.step`, `llm.call` (via `runLlmCall`), `agent_call.turn` |
| `SUNRISE_STEP_TYPE`              | `sunrise.step_type`              | string  | `workflow.step` — values match `WorkflowStep.type`                |
| `SUNRISE_AGENT_ID`               | `sunrise.agent_id`               | string  | `chat.turn`, `llm.call`, `capability.dispatch`, `agent_call.turn` |
| `SUNRISE_AGENT_SLUG`             | `sunrise.agent_slug`             | string  | `chat.turn`, `llm.call`, `agent_call.turn`                        |
| `SUNRISE_CONVERSATION_ID`        | `sunrise.conversation_id`        | string  | `chat.turn`, `llm.call`, `capability.dispatch` (when set)         |
| `SUNRISE_CAPABILITY_SLUG`        | `sunrise.capability`             | string  | `capability.dispatch`                                             |
| `SUNRISE_CAPABILITY_SUCCESS`     | `sunrise.capability.success`     | boolean | `capability.dispatch` — application-level outcome flag            |
| `SUNRISE_USER_ID`                | `sunrise.user_id`                | string  | `workflow.execute`, `chat.turn`, `capability.dispatch`            |
| `SUNRISE_COST_USD`               | `sunrise.cost_usd`               | number  | `llm.call`, `agent_call.turn`                                     |
| `SUNRISE_TOOL_ITERATION`         | `sunrise.tool_iteration`         | number  | `llm.call` (chat handler), `agent_call.turn`                      |
| `SUNRISE_PROVIDER_FAILOVER_FROM` | `sunrise.provider.failover_from` | string  | failed `llm.call` in the chat handler when retry triggers         |
| `SUNRISE_PROVIDER_FAILOVER_TO`   | `sunrise.provider.failover_to`   | string  | same span as `from`                                               |
| `SUNRISE_EVALUATION_PHASE`       | `sunrise.evaluation.phase`       | string  | `llm.call` from `parse-structured.ts` — `summary` or `scoring`    |

### Attribute size cap

Every string attribute is truncated to `MAX_ATTRIBUTE_STRING_LENGTH` (1024 chars) at the wrap boundary by `truncateAttribute` in `with-span.ts`. This defends against megabyte-sized prompts blowing OTEL exporter buffers. Truncation applies to the value passed to `withSpan` / `setSpanAttributes` / `startManualSpan` — the underlying tracer never sees the full string.

## Span status semantics

Sunrise distinguishes **transport-level failure** (span status `error`) from **application-level outcome** (span status `ok` with an outcome attribute):

- `chat.turn` is `error` only when an exception is caught at the chat handler boundary (provider error, internal error, `ChatError`). User-facing error events emitted from inside the try block (budget exceeded, output guard block, conversation cap) are **application-level outcomes** and keep span status `ok` — equivalent to an HTTP 4xx response, not a 5xx.
- `capability.dispatch` is `ok` regardless of the dispatched capability's success. The `sunrise.capability.success` attribute carries the outcome. This matches OTEL's convention for per-call business outcomes.
- `workflow.step` is `error` when the step's `singleResult.failed` is true — including budget-exceeded mid-run, where the step itself returned a result successfully but the engine then failed the workflow.
- `workflow.execute` is `error` when the workflow ends with `failed=true` (any failed step under `fail` strategy, budget exceeded, deadlock, abort, etc.). `PausedForApproval` is **not** an error — the workflow continues after admin approval, so the span ends `ok`.

## Cost-log correlation

`AiCostLog` rows carry optional `traceId` and `spanId` columns (added in migration `20260505141318_add_cost_log_trace_correlation`) so external trace backends can join cost data back to the originating span:

```sql
SELECT cost.totalCostUsd, span.duration_ms
FROM ai_cost_log cost
JOIN otel_spans span ON cost.traceId = span.trace_id AND cost.spanId = span.span_id
WHERE cost.createdAt > now() - interval '1 hour';
```

The columns are populated automatically by `runLlmCall`, the chat handler's terminal + tool-call paths, the dispatcher, the summarizer, and the agent-call multi-turn executor. Empty-string IDs (returned by the no-op tracer) are normalised to `NULL` at the cost-tracker boundary — historical rows naturally have `NULL` for both columns.

The two evaluation `logCost` sites in `complete-session.ts` are intentionally not yet correlated (the spans live inside `parse-structured.ts` and would need to thread IDs back through `runStructuredCompletion`'s return type). Additive future change.

## Sampling

Sunrise's `Tracer` interface deliberately has no sampling concept — sampling is delegated entirely to OTEL's `TracerProvider`. Forks configure samplers the standard way:

```typescript
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

const sdk = new NodeSDK({
  // ...
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(0.1), // keep 10% of traces
  }),
});
```

Sunrise's instrumentation always calls `startSpan` for every reachable site; OTEL's sampler decides which spans actually export. The runtime cost of an unsampled span is negligible at the deployment scale Sunrise targets (single-tenant, small projects).

## Bootstrap recipes

### Datadog (via Datadog Agent's OTLP receiver)

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=sunrise-orchestration
DD_ENV=production
```

```typescript
// instrumentation.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerOtelTracer } from '@/lib/orchestration/tracing';

new NodeSDK({ traceExporter: new OTLPTraceExporter() }).start();
await registerOtelTracer();
```

### Honeycomb

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=YOUR_API_KEY
OTEL_SERVICE_NAME=sunrise-orchestration
```

Bootstrap as above — the env vars do all the work.

### Grafana Tempo (via Grafana Agent or directly)

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318
OTEL_SERVICE_NAME=sunrise-orchestration
```

### Langfuse (via OTLP)

Langfuse accepts OTLP traces; configure their OTLP endpoint per Langfuse docs. The GenAI semantic-convention attributes that Sunrise emits map directly onto Langfuse's observation schema.

## Anti-patterns

- **Don't register multiple tracers.** `registerTracer` warns when replacing a non-default tracer and atomically swaps. Multiple registrations in production usually indicate double-bootstrap (e.g. `instrumentation.ts` runs twice). Set the tracer once at startup.
- **Don't import `otel-bootstrap.ts` from a client component.** The dynamic `import('@opentelemetry/api')` is server-only. The module is listed in `next.config.js`'s `serverExternalPackages` to silence Next.js bundling warnings, but importing it client-side is a bug regardless.
- **Don't set `gen_ai.prompt` / `gen_ai.completion` without explicit consent.** Prompts often contain PII or secret data. The current code never sets these attributes; the constants exist for a future opt-in flag (`SUNRISE_OTEL_RECORD_PROMPTS=true`) that is not yet wired up.
- **Don't bypass `withSpan` / `startManualSpan` for new instrumentation sites.** The exception-safety guarantees rest on every span going through these helpers. Calling `getTracer().startSpan(...)` directly skips the tracer-failure fallback.
- **Use `withSpanGenerator`, not `startManualSpan`, in async generators.** `withSpan`'s callback shape doesn't compose with `yield`, but `withSpanGenerator` drives the inner generator inside `tracer.withActiveContext(span, …)` per iteration so the span is the active OTEL context across yields. Nested span creation between yields then sees the outer span as parent in OTLP backends. `startManualSpan` is still exported for fork-authors who want raw lifecycle control, but Sunrise's own engine and chat handler use `withSpanGenerator` so every span correlates correctly. If your inner needs to map application state (e.g. a step descriptor's `failed` flag) to span status without throwing, pass `manualStatus: true` and call `setSpanStatus(span, …)` from the inner.

## Testing

The tracing module has 129 unit tests covering: no-op tracer, registry, attribute constants, `with-span` exception safety (`withSpan` + `withSpanGenerator` happy paths, error paths, consumer early-exit including `gen.throw()` propagation, `manualStatus` semantics, `ThrowingTracer` and `FlakySpanTracer` resilience, `setSpanStatus` / `recordSpanException` swallow + warn behaviour), MockTracer's `AsyncLocalStorage`-based parent tracking (concurrent siblings, three-deep nesting, ALS isolation across tests, `assertSpanTree`), the OTEL adapter against a real `BasicTracerProvider` + `InMemorySpanExporter` (with regression tests for `withSpan` and `withSpanGenerator` parent/child propagation), and the bootstrap helper. Plus 4 integration test files (`tests/integration/orchestration/otel-*.test.ts`) verifying span emission end-to-end through the engine and chat handler — every nested span asserts its `parentSpanId` resolves to the expected outer span.

Test fixtures live in `tests/helpers/mock-tracer.ts` (`MockTracer`, `ThrowingTracer`, `assertSpanTree`, `findSpan`).
