# LLM Provider Abstraction

Platform-agnostic interface for calling any LLM — cloud (Anthropic, OpenAI), OSS hosts (Together, Fireworks, Groq), or local servers (Ollama, LM Studio, vLLM) — through one API. Implemented in `lib/orchestration/llm/`.

## Quick Start

```typescript
import { providerManager, costTracker } from '@/lib/orchestration/llm';

// Resolve a provider by slug (loaded from AiProviderConfig).
const provider = await providerManager.getProvider('anthropic');

// Non-streaming chat.
const response = await provider.chat(
  [
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: 'Say hi in 3 words.' },
  ],
  { model: 'claude-sonnet-4-6' }
);

// Log the cost — safe even if the DB write fails (returns null).
await costTracker.logCost({
  agentId: 'agent-1',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  inputTokens: response.usage.inputTokens,
  outputTokens: response.usage.outputTokens,
  operation: 'chat',
});
```

## Public Surface

Everything is exported from `@/lib/orchestration/llm`:

| Export                                                                                  | Kind      | Purpose                                                                                             |
| --------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `LlmProvider`                                                                           | interface | Contract every provider implements                                                                  |
| `ProviderError`                                                                         | class     | Structured error with `code`, `status?`, `retriable`                                                |
| `AnthropicProvider`                                                                     | class     | Claude family via `@anthropic-ai/sdk`                                                               |
| `OpenAiCompatibleProvider`                                                              | class     | Any OpenAI-compatible host via `openai` SDK                                                         |
| `providerManager`                                                                       | namespace | `getProvider`, `registerProvider`, `listProviders`, `testProvider`, `clearCache`                    |
| `modelRegistry`                                                                         | namespace | `refreshFromOpenRouter`, `getModel`, `getModelsByTier`, `getModelsByProvider`, `getAvailableModels` |
| `costTracker`                                                                           | namespace | `calculateCost`, `logCost`, `getAgentCosts`, `checkBudget`                                          |
| `LlmMessage`, `LlmOptions`, `LlmResponse`, `StreamChunk`, `ModelInfo`, `ProviderConfig` | types     | Message/option/response dialect                                                                     |

Internal helpers (`fetchWithTimeout`, `withRetry`, the static fallback map) are **not** exported — they are implementation details.

## The `LlmProvider` Interface

```typescript
interface LlmProvider {
  readonly name: string;
  readonly isLocal: boolean;

  chat(messages: LlmMessage[], options: LlmOptions): Promise<LlmResponse>;
  chatStream(messages: LlmMessage[], options: LlmOptions): AsyncIterable<StreamChunk>;
  /** @deprecated — use embedMany. Removed at the next MAJOR. */
  embed(text: string): Promise<number[]>;
  // Optional — the knowledge embedder's call (t-740). Caller picks the model and
  // whether to request a dimension; returns plain number[] vectors in input
  // order, and inputTokens only when the vendor reported it.
  embedMany?(texts: string[], options: EmbedManyOptions): Promise<EmbedManyResult>;
  listModels(): Promise<ModelInfo[]>;
  testConnection(): Promise<{ ok: boolean; models: string[]; error?: string }>;

  // Optional — providers that don't expose a transcription API simply omit this.
  // Routing (`getAudioProvider`) filters by `AiProviderModel.capabilities` so the
  // method is only ever called on providers that implement it.
  transcribe?(audio: TranscribeAudio, options: TranscribeOptions): Promise<TranscribeResponse>;

  // Optional streaming analogue of `transcribe` (mirrors chat → chatStream).
  // Rarely implemented natively — callers go through `streamTranscription`,
  // which falls back to the batch path. See "Streaming transcription" below.
  transcribeStream?(
    audio: TranscribeAudio,
    options: TranscribeOptions
  ): AsyncIterable<TranscribeChunk>;
}
```

`LlmMessage` supports roles `system | user | assistant | tool` with content as `string | ContentPart[]` for multimodal input. Assistant messages can carry `toolCalls`. `StreamChunk` is a discriminated union: `{ type: 'text' }`, `{ type: 'reasoning', text }` (the model's readable reasoning: Claude's summarized thinking, or an OpenAI-compatible provider's `reasoning_content` / `reasoning` delta), `{ type: 'tool_call' }`, or `{ type: 'done', usage, finishReason }`.

### `LlmOptions`

Key options passed to `chat()` and `chatStream()`:

| Field               | Type                | Description                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`             | `string`            | Model identifier (e.g., `claude-sonnet-4-6`)                                                                                                                                                                                                                                                                                                                                                                             |
| `temperature`       | `number`            | Sampling temperature. The Anthropic provider leaves it out for models that refuse one (Opus 4.7+, Sonnet 5+, Haiku 5+, Fable, Mythos; per `acceptsSamplingTemperature()`)                                                                                                                                                                                                                                                |
| `maxTokens`         | `number`            | Max output tokens                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tools`             | `LlmToolDef[]`      | Tool definitions for function calling                                                                                                                                                                                                                                                                                                                                                                                    |
| `responseFormat`    | `LlmResponseFormat` | Request structured output (see below)                                                                                                                                                                                                                                                                                                                                                                                    |
| `stopSequences`     | `string[]`          | Text that ends the reply, at most `MAX_STOP_SEQUENCES` (4). Anthropic `stop_sequences`; OpenAI-compatible `stop`, left out on reasoning models                                                                                                                                                                                                                                                                           |
| `topP`              | `number`            | Nucleus sampling, 0–1. Anthropic: only where `acceptsSamplingTemperature()` and no thinking, and sent **instead of** `temperature` (Sonnet 4.5, Haiku 4.5, Opus 4.1+ refuse both). OpenAI-compatible: non-reasoning models only                                                                                                                                                                                          |
| `verbosity`         | `Verbosity`         | `low` / `medium` / `high`. GPT-5 family only (`acceptsVerbosity()`); dropped elsewhere                                                                                                                                                                                                                                                                                                                                   |
| `parallelToolCalls` | `boolean`           | `false` = at most one tool call per turn. Anthropic `tool_choice.disable_parallel_tool_use` (not with `none`); OpenAI `parallel_tool_calls`, off the o-series, which refuses it (`reasoningModelAcceptsParallelToolCalls()`). Sent only with tools                                                                                                                                                                       |
| `serviceTier`       | `ServiceTier`       | `auto` / `default` / `flex` / `priority`. Sent only when the base URL is `api.openai.com`, and `flex` only to models that offer it (`acceptsFlexTier()`: the GPT-5 base, mini, nano and numbered models, o3, o4-mini — not `-chat-latest`, `-pro` or `-codex`). The tier the response reports (`LlmUsage.serviceTier`) is priced by `calculateCost`: flex 0.5×, priority 2×                                              |
| `providerTools`     | `ProviderTools`     | Tools the provider runs itself, keyed by tool: `webSearch` (`{ maxUses?, replyLimit?, allowedDomains?, blockedDomains? }`) and `codeExecution` (`{}`), on Anthropic (see [Provider tools (web search)](#provider-tools-web-search) and [(code execution)](#provider-tools-code-execution)) and on OpenAI itself through the [Responses API path](#responses-api-path-openai-web-search). Every other provider ignores it |
| `signal`            | `AbortSignal`       | Cancellation signal                                                                                                                                                                                                                                                                                                                                                                                                      |

Agents store `stopSequences` to `serviceTier` as columns, and an `llm_call` step as config; `modelParamOptions()` (`lib/orchestration/llm/model-params.ts`) turns either into these options, dropping unset and unrecognised values. Every one is dropped, never a 400, where the model can't take it. `providerTools` is an agent's JSON column only — a step has no setting for it — and `modelParamOptions()` passes it through when it parses (`narrowProviderTools()`).

### Structured Output / JSON Mode

The `responseFormat` option requests structured JSON responses from LLMs:

```typescript
type LlmResponseFormat =
  | { type: 'json_object' } // any valid JSON
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean }; // constrained
```

**Provider implementations:**

- **OpenAI-compatible**: passes `response_format` directly to the API (native support)
- **Anthropic**: two paths, chosen by `acceptsNativeStructuredOutput()`.
  - **Native** (Fable, Mythos, Opus 4.1 / 4.5 / 4.8 / 5+, Sonnet 5+, Haiku 4.5+): sends `output_config.format: { type: 'json_schema', schema }`, with the schema rewritten by `toNativeOutputSchema` (`additionalProperties: false` on every object, `oneOf` as `anyOf`, and keywords native output rejects — numeric and length constraints, patterns, unknown formats — moved into the node's description; `enum` and `const` are kept, which is why this isn't the SDK's `transformJSONSchema`, which moves those too). The JSON comes back as ordinary text. No tool is involved, so it can't clash with thinking or with the models that refuse a forced `tool_choice` (Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1).
  - **Extraction tool** (Opus 4.0 / 4.6 / 4.7, Sonnet 4.x, unrecognised ids, and any schema native output would change the meaning of or may reject: an open object (no `properties`, or a non-`false` `additionalProperties`, which closing would silently empty), a union `type` array, a `$ref`, a tuple `items`, or a node with no `type`. Those log `Anthropic: structured output sent through the extraction tool`): defines a single tool with the schema and reads the result from its arguments. The tool is forced unless thinking is on or the model refuses a forced tool, where it would be a 400; there it is offered with `tool_choice: auto` (logged as `Anthropic: forced tool choice sent as auto`) and the system prompt asks for it — safe because a structured-output request is a single turn with no tool loop. Any text the model writes alongside the tool call is dropped (and held back rather than streamed), since the tool's arguments are the whole result; if it never calls the tool, that text is returned instead. The tool name derived from `responseFormat.name` is slugified + length-capped to fit `^[a-zA-Z0-9_-]{1,64}$`.

  On both paths the schema must be **object-rooted** (a non-object root is rejected with `invalid_schema` rather than silently coerced).

A caller-supplied forced `toolChoice` (`{ name }`) is sent as `auto` when thinking is on or the model refuses forced tool choice, and logged as `Anthropic: forced tool choice sent as auto`. No instruction is added to the system prompt there: in a tool loop the next request would carry a different system prompt, which invalidates the thinking blocks it replays.

Both adapters treat a token-cap stop on any JSON-shaped request (`json_schema` or `json_object`) as `truncated_no_output` — the partial output would otherwise look like ordinary non-empty content and degrade into a parse failure. See [Truncation guard](#truncation-guard-truncated_no_output).

**Usage in agents:** Set `responseFormat` on `AiAgent` config for agents that always return structured data. In workflows, the `llm_call` step config supports `responseFormat` for structured extraction steps.

**Validation:** When `json_schema` is used, the response is parsed and validated against the schema before returning. Invalid responses emit an `error` event.

## Concrete Providers

### AnthropicProvider

Backed by `@anthropic-ai/sdk`. Splits leading system messages into Anthropic's `system` field (one text block per system message), converts `tool` role into `user` messages with `tool_result` blocks, and aggregates streamed `input_json_delta` fragments into a single `tool_call` chunk.

**Prompt caching is always on.** `addCacheBreakpoints` puts up to two explicit `cache_control` marks on a request: the first system block (the agent's composed prompt; tools render before it, so they are covered too — with no system prompt the last tool takes the mark), and, when the request has earlier turns, the last block of the last message, so the next request of a conversation or tool loop reads the whole history back. A one-message request (an `llm_call` step, a summary, an enrichment) gets no tail mark: it is rarely re-sent inside the cache lifetime, and the mark would cost the 1.25× write every time. The per-turn system blocks after the first (knowledge context, memories, summary) are deliberately outside the first mark, so a change in them does not invalidate the agent's prompt. There is no top-level automatic `cache_control`: the legacy Bedrock integration and some gateways refuse it, and this provider can sit behind `ANTHROPIC_BASE_URL`. A prefix below the model's minimum (512–4096 tokens) is not cached and costs nothing extra. Moving a mark between requests is not a history edit, so it does not invalidate replayed thinking blocks.

**Usage.** Anthropic reports cache reads and writes apart from `input_tokens`; the provider adds them back in, so `LlmUsage.inputTokens` is the whole input on every provider, with `cacheReadTokens` / `cacheWriteTokens` as the subsets billed at cache rates. The OpenAI-compatible provider reads `prompt_tokens_details.cached_tokens` (OpenAI caches automatically) into `cacheReadTokens`.

#### Provider tools (web search)

`LlmOptions.providerTools.webSearch` adds Anthropic's `web_search_20250305` server tool after the agent's own tools, with `max_uses` and `allowed_domains` / `blocked_domains` (Anthropic takes one list or the other; `providerToolsSchema` in `model-params.ts` refuses both). It is dropped, and logged as `Anthropic: web search dropped, model does not offer it`, on a model `acceptsWebSearch()` (`model-heuristics.ts`) rejects: the Claude 3.0 models and ids it can't parse. It is also left off a structured-output request answered through the extraction tool, whose handlers key on that tool being the only one.

- **What comes back.** The `server_tool_use` and `web_search_tool_result` blocks are returned on `LlmResponse.reasoning` / the `done` chunk's `reasoning`, in order with any thinking blocks, as `LlmReasoningBlock`s (`{ type: 'server_tool_use', id, name: 'web_search', input }` and `{ type: 'web_search_tool_result', toolUseId, results, errorCode? }`). A tool loop already puts those on the assistant message it appends, so the searches go back unchanged on the request that continues the turn. Each result keeps its `encryptedContent`, which Anthropic needs to cite the page later. The search input never surfaces as a `tool_call`. Like thinking blocks, they are not persisted, so a later user turn rebuilt from the database carries only the text.
- **A paused turn.** Anthropic stops a long server-tool loop with `stop_reason: 'pause_turn'` and expects the paused turn back. Both `chat()` and `chatStream()` send it back as an assistant message (a second pause extends the same message), up to `MAX_PAUSE_CONTINUATIONS` (3) times, and return the segments as one response with their usage summed. Past the limit the call returns what it has, finishing `stop`.
- **Cost.** `LlmUsage.webSearchRequests` carries Anthropic's `usage.server_tool_use.web_search_requests`. `calculateCost` adds `WEB_SEARCH_USD_PER_REQUEST` ($0.01) a search to `totalCostUsd` (not to the input or output cost) and reports it as `webSearchCostUsd`, whatever the model's token pricing. `logCost` stamps `metadata.webSearchRequests` and `metadata.webSearchCostUsd` on the row.
- **Not available everywhere.** An Anthropic organisation admin has to turn web search on in the Console, and a gateway behind `ANTHROPIC_BASE_URL` (Bedrock, Vertex) may not offer it; either way the request fails with the provider's error. Citations Anthropic attaches to the answer text are not mapped to Sunrise `Citation`s, which describe knowledge-base chunks and drive the citation guard.

#### Provider tools (code execution)

`LlmOptions.providerTools.codeExecution` adds Anthropic's `code_execution_20260521` server tool beside the others, the latest version, as Anthropic recommends. The model runs shell commands and file operations (the `bash_code_execution` and `text_editor_code_execution` sub-tools) in a container Anthropic hosts, with no internet. What this version adds over `20250825`, programmatic tool calling and its REPL state, Sunrise doesn't turn on; without it the models send only the two sub-tools (measured on claude-haiku-5-5 and claude-sonnet-5-5). A direct `code_execution` call or `code_execution_tool_result` isn't mapped: it is left out of the replay and logged (`Anthropic: code execution block not mapped, left out of the replay`), so a change in that is seen. It is dropped and logged (`Anthropic: code execution dropped, model does not offer it`) on a model `acceptsCodeExecution()` rejects: anything before Opus, Sonnet and Haiku 4.5, except Fable and Mythos. It is also left off a structured-output request, as web search is.

- **What comes back.** Each run's `server_tool_use` block and its result come back on `LlmResponse.reasoning` / the `done` chunk, as `{ type: 'server_tool_use', name: 'bash_code_execution' | 'text_editor_code_execution', … }` and `{ type: 'code_execution_tool_result', tool, toolUseId, content, containerId, durationMs, fileNames? }`. `content` is Anthropic's result in its wire shape, a shell command's `stdout` / `stderr` / `return_code` and the ids of the files it left in `$OUTPUT_DIR`, or a file view, create, edit or error. A tool loop replays them unchanged; a stored error code Anthropic no longer has goes back as `unavailable`.
- **The container.** Anthropic reports the container on the message (`container.id`). A later call of the same reply sends `container` from the latest run in the replayed blocks (`latestContainerId()`), so the earlier runs' files are still there, and a paused turn carries on in the container it started in. The next reply starts a new one: the blocks are not persisted. Only Anthropic's own runs name the container, so after a fallback from OpenAI its `cntr_…` id isn't sent. A request that won't carry the tool (a fallback to a model without it) leaves the turn's code blocks out of the replay, which would otherwise be a 400, and logs `Anthropic: code runs left out of replay`. A result shape the SDK doesn't type is kept as that sub-tool's `unavailable` error.
- **Files.** A run's files go to the organisation's Anthropic Files storage, where they stay until deleted. Sunrise reads each new file's name (`files.retrieveMetadata`) for the trace, then deletes them (`files.delete`) straight after the call that made them, before the truncation guard can throw, so a reply cut short (a budget stop, an error) leaves none behind. A later call that replays a block naming a deleted file still succeeds (measured on claude-haiku-5-5). A call that fails part-way deletes the files of the runs it had made too, and carries their cost on `ProviderError.usage`. The deletes aren't awaited but are kept running after the response is sent (`keepRunningAfterResponse`), each name read is held to 5 seconds and the caller's signal, and nothing is raised: a failure is logged (`Anthropic: generated file name not read` / `generated files not deleted`). Files are not delivered to users (owner ruling, t-956).
- **Cost.** Anthropic bills code execution by container time, $0.05 an hour after 1,550 free hours a month per organisation, with a 5-minute minimum, and reports none of it. So each run carries its measured duration: on a stream, from its call's input ending to its result arriving; on a call that isn't streamed, an equal share of the request's time. Each container a reply uses is costed at the larger of its run time and 5 minutes, and a call is billed what its runs add (`billCodeExecution()`, `code-execution.ts`), as `LlmUsage.codeExecution` (`{ runs, billedSeconds, usdPerHour }`). The free hours aren't deducted, since Sunrise can't see them (owner ruling, t-956). Code execution is free beside the `web_search_20260209` tool, which Sunrise doesn't send.
- **Not covered by zero data retention** on Anthropic's side; the field help says so.

**`embed()` throws** — Anthropic has no first-party embeddings API. Use an OpenAI-compatible provider for embeddings.

### OpenAiCompatibleProvider

A single class covering every OpenAI-compatible chat completions host:

- OpenAI (`https://api.openai.com/v1`)
- Ollama (`http://localhost:11434/v1`)
- LM Studio (`http://localhost:1234/v1`)
- vLLM (`http://localhost:8000/v1`)
- Together (`https://api.together.xyz/v1`)
- Fireworks (`https://api.fireworks.ai/inference/v1`)
- Groq (`https://api.groq.com/openai/v1`)

Local servers get a `'not-needed'` sentinel API key (the OpenAI SDK rejects empty strings, local hosts ignore the `Authorization` header) and a shorter 10s default timeout.

**Default embedding models** are picked automatically: `text-embedding-3-small` for cloud, `nomic-embed-text` for local. Override via `embeddingModel` option.

#### Responses API path (OpenAI web search)

OpenAI runs its web search and code interpreter on the Responses API, and every other call here goes to Chat Completions. So `chat()` and `chatStream()` take the Responses API (`lib/orchestration/llm/openai-responses.ts`) when `usesResponsesApi()` says the base URL is `api.openai.com` (the same test `serviceTier` uses), the request is not structured output (`responseFormat`), and OpenAI would take at least one of the provider tools it turns on (`takenProviderTools()`). Web search is taken when:

- `providerTools.webSearch` is set;
- the model offers the tool (`acceptsOpenAiWebSearch()`: GPT-5 and its numbered releases, gpt-4.1 and -mini, gpt-4o and -mini, o3, o4-mini; not gpt-4.1-nano or o3-mini, nor the search, audio, realtime, speech or transcription variants, such as gpt-4o-mini-search-preview, which the Responses API refuses);
- when a site list is set, the model also takes site filters (`acceptsOpenAiWebSearchFilters()`: not gpt-4o-mini or gpt-4.1-mini, which 400 on them);
- it would not send `minimal` reasoning effort, which GPT-5 refuses beside web search.

Code interpreter is taken when `providerTools.codeExecution` is set, the model offers it (`acceptsOpenAiCodeInterpreter()`, the same models as web search; measured on gpt-5-mini, gpt-4.1, gpt-4.1-mini, gpt-4o and gpt-4o-mini), and the request would not send `minimal` effort (a 400, measured). Only the tools taken are sent.

Any other request stays on Chat Completions, unchanged. A tool the request turns on but can't take is logged as `OpenAI: web search dropped, the request cannot take it` (a `reason` from `webSearchRefusal()`: `model`, `site_filters` or `minimal_effort`) or `OpenAI: code interpreter dropped, the request cannot take it` (`codeInterpreterRefusal()`: `model` or `minimal_effort`), whichever API the request then takes. A reply's tool loop stays on one API, because the route never depends on how much of the search limit is left. Making Responses the OpenAI default was rejected at planning (`f-orch-llm-providers`).

- **Stateless.** Every request sends `store: false`, so the conversation is not kept on OpenAI's side, as on Chat Completions. The output's `reasoning` items (with their `encrypted_content`, asked for via `include` on reasoning models) and `web_search_call` items come back on `LlmResponse.reasoning` / the `done` chunk as `{ type: 'openai_reasoning', id, encryptedContent, summary }` and `{ type: 'openai_web_search_call', id, status, action }`. A tool loop replays them unchanged on the call that continues the turn. Measured live, leaving the search items out makes the model write raw citation markup into its answer. A search item's `action` is parsed before it goes back, since it can come from a stored `agent_call` checkpoint, and one that doesn't parse is left out and logged (`OpenAI: web search item left out of replay, action not recognised`). OpenAI also returns sources its SDK doesn't type, such as `{ type: 'api', name: 'oai-weather' }`; only the `url` sources go back, which OpenAI accepts (measured). The Anthropic adapter leaves these blocks out, and this path leaves out Anthropic's.
- **Reasoning OpenAI can't decrypt.** A replayed reasoning item whose `encrypted_content` OpenAI can't verify is a 400 `invalid_encrypted_content` (measured, with changed content), and `withRetry` won't retry a 400. The provider then runs the request once more with the `openai_reasoning` blocks left out (`withoutOpenAiReasoning()`), keeping the search and code-interpreter items: measured, OpenAI answers the same, and the code runs in the same container. It is logged as `OpenAI could not decrypt replayed reasoning; retrying without it`, with OpenAI's error text, which names the item. A second refusal, or any other error, is raised. The ids left out are remembered on the provider instance (one per credential, cached 5 minutes), and left out of the tool loop's later requests up front, so each later call isn't refused first and doesn't lose the reasoning this credential has since returned. This is for a damaged `agent_call` checkpoint, or a fallback onto an OpenAI provider under another organisation. Whether another organisation's content gets this 400 wasn't measured, since that takes two organisations' keys (t-959). Nor was what a fallback under another organisation does with a code-interpreter item naming the first organisation's container: a container OpenAI can't find is a 404 (measured on a deleted one), which this retry doesn't cover, so such a turn still fails.
- **Request mapping.** System messages stay as `system` input messages, in place. Function tools go as `strict: false`, since the Responses API defaults function tools to strict, which refuses most capability schemas. `max_output_tokens` takes the token cap. `reasoning.effort`, `text.verbosity`, `service_tier`, `parallel_tool_calls` and `tool_choice` follow the same per-model rules as Chat Completions. `stopSequences` is dropped: the Responses API has no `stop`.
- **Sites are hosts.** OpenAI refuses a filter domain with a path (`400 Invalid domain`). So `docs.example.com/guides` goes as `docs.example.com`: a block list blocks the whole host, and an allow list allows it (owner ruling, t-955). Logged as `OpenAI: web search site paths sent as hosts`.
- **The search limit caps each call, not the reply.** Each call gets the agent's whole limit as `max_tool_calls`, which counts built-in tool calls only. Every `web_search_call` item is one, so on a reasoning model a page it opens or searches within (`open_page`, `find_in_page`) uses up the limit as a search does, though only searches are billed. `spendWebSearches()` keeps it on `WebSearchOptions.replyLimit` once it has taken a reply's searches off `maxUses`. The search tool stays on: the call after a capability call usually searches again to cite its sources, and taking the tool away, or barring it with `allowed_tools`, made the answers lose what the earlier searches found (owner ruling, t-955). So a reply that calls tools can run past the limit.
- **Reasoning summaries.** Reasoning models are sent `reasoning.summary: 'auto'`. The stream yields `response.reasoning_summary_text.delta` as `reasoning` chunks, with a blank line between summary parts. An organisation OpenAI hasn't verified gets a 400 ("must be verified to generate reasoning summaries"). The provider then retries once without summaries (`isSummaryVerificationError()`) and stops asking for as long as the instance is cached (5 minutes, per credential), logging `OpenAI refused reasoning summaries`.
- **Streaming.** Text and summary deltas are yielded as they arrive. A response can carry more than one message (text before a search, then the answer); each starts a new paragraph, in the stream and in a non-streaming result's `content` alike. Function calls, the replayable blocks and usage are read from the `response.completed` (or `response.incomplete`) event's response, so the stream is mapped by the same code as a non-streaming result. `response.failed` and `error` events throw `ProviderError`, and so does a stream that ends without a final response (`empty_response`).
- **Usage and cost.** `input_tokens` already includes the search content. `cached_tokens` becomes `cacheReadTokens`. `webSearchRequests` counts the `web_search_call` items whose action is `search` and whose status isn't `failed`, including one cut short by `max_tool_calls`. `open_page` and `find_in_page` read pages already found and aren't billed. OpenAI's `web_search` costs $10 per 1,000 calls, the same `WEB_SEARCH_USD_PER_REQUEST` as Anthropic. On a non-streaming call, a `max_output_tokens` stop with no text and no tool call raises `truncated_no_output`; a stream ends with `finishReason: 'length'` instead. Both as on Chat Completions.
- **Code interpreter.** The tool goes as `{ type: 'code_interpreter', container: { type: 'auto', network_policy: { type: 'disabled' } } }`, with `include: ['code_interpreter_call.outputs']`. Each `code_interpreter_call` item comes back as `{ type: 'openai_code_interpreter_call', id, status, containerId, code, outputs, durationMs, fileNames? }` and is replayed unchanged; measured live, `auto` then reuses the container the item names, so a later call of the reply finds the earlier runs' files and variables, and makes a new one once that has expired (20 minutes idle; also measured), so an `agent_call` step resumed long after still runs. A container deleted outright through OpenAI's Containers API is a 404 instead; Sunrise never deletes one. A run is timed on a stream from its `response.code_interpreter_call.interpreting` event (or `in_progress`) to `completed`, which leaves out the model writing the code; a call that isn't streamed shares the request's time between its runs. Files the code makes are cited in the reply's text as `container_file_citation` annotations; their names go on the container's last run for the trace, and the files themselves expire with the container. The reply's text links them as `sandbox:/mnt/data/<name>`, which nobody can open: files aren't delivered (owner ruling, t-956). With code interpreter on, `max_tool_calls` isn't sent: OpenAI counts code runs against it beside the searches, so the search limit would cut data work off without a word. Searches go uncapped on such a request, each still costed and traced (owner ruling, t-956). OpenAI bills the container $0.03 per 20 minutes at its default 1 GB, by the minute with a 5-minute minimum, and reports nothing about it, so it is costed as on Anthropic: `billCodeExecution()` at `CODE_EXECUTION_USD_PER_HOUR.openai`.
- **Citations.** OpenAI's `url_citation` annotations are not mapped to Sunrise `Citation`s, the same as Anthropic's (see above).

### Audio transcription (`transcribe`)

`OpenAiCompatibleProvider` implements `transcribe()` via the OpenAI SDK's `audio.transcriptions.create({ file, model, response_format: 'verbose_json' })`. The verbose response carries duration (seconds, converted to `durationMs`) and the auto-detected language. Works for OpenAI proper and any compatible host that exposes `/v1/audio/transcriptions` (Groq Whisper). Hosts that don't expose this endpoint (Ollama, vLLM, LM Studio in their default configs) won't be picked by `getAudioProvider()` because no `'audio'`-capability `AiProviderModel` row will exist for them — but if one is configured anyway the SDK call returns 404 and the route surfaces `TRANSCRIPTION_FAILED`.

`AnthropicProvider` does not implement `transcribe()` — Anthropic has no first-party audio API.

#### Streaming transcription (`transcribeStream` + `streamTranscription`)

`transcribeStream?()` is the optional streaming analogue of `transcribe()`, mirroring the `chat()` → `chatStream()` split. It yields a `TranscribeChunk` discriminated union: `{ type: 'partial' }` (interim, never billed), `{ type: 'final' }` (a stable transcript segment, optional `language`), and `{ type: 'done', audioSeconds, model }` (terminal, billed by `audioSeconds` exactly like the batch path; `0` means "duration unknown").

Callers should **not** call `provider.transcribeStream` directly — go through **`streamTranscription(provider, audio, options)`** in `lib/orchestration/llm/transcribe-stream.ts`, which resolves the best available path:

1. native `transcribeStream` when the provider implements it (true word-level interim text);
2. otherwise **`batchTranscribeAsStream`** — adapts a single `transcribe()` call into one `final` chunk plus a `done`, so every batch-capable provider satisfies the streaming contract (no interim text, but a uniform consumer shape);
3. a `ProviderError` with `code: 'not_supported'` when the provider has neither method — surfaced on first iteration of the returned `AsyncIterable`, not synchronously at call time.

**`streamTranscription` has no production caller today**, and neither voice route uses it — `embed/speech-to-text` and `admin/orchestration/chat/transcribe` both call `provider.transcribe()` directly. Were it called, it would always resolve to the batch fallback: the only STT provider (`OpenAiCompatibleProvider`/Whisper) has no streaming transcription API. A genuinely streaming provider (Deepgram, AssemblyAI, …) would implement `transcribeStream` directly to emit `partial` chunks as audio arrives. This is the platform-side seam only — the client→server audio transport and the live `MicButton` / `useStreamingTranscription` mic layer are a separate follow-up (the transport spike in issue #308); the batch `transcribe()` path is unchanged and remains the default for every current consumer.

**`getAudioProvider()` (in `provider-manager.ts`)** is the entry point used by both the admin and embed transcribe routes. Selection runs in two stages:

1. **Operator-pinned default.** Reads `AiOrchestrationSettings.defaultModels.audio` first. When set, the matching `(providerSlug, modelId)` matrix row is attempted ahead of the registry-ordered loop — voice input uses the model the operator chose in settings, not whichever matrix row happened to seed first. Each resolution logs `source: 'operator_default'` so the path is visible in logs.
2. **Matrix fallback.** Walks every other active `AiProviderModel` row whose `capabilities` array contains `'audio'`, ordered by `isDefault desc, createdAt asc`. Logs `source: 'matrix_fallback'`. The pinned-then-fallback design keeps voice working even when the operator's pin is temporarily unreachable: if the pinned row's breaker is open, its provider lacks `transcribe()`, or `getProvider()` throws, the resolver falls through to the next-best matrix row rather than returning `null`. Same fallback applies when the pinned `modelId` no longer exists in the active audio rows (e.g. the row was deactivated after the setting was saved).

Returns `null` only when both stages exhaust without finding a usable provider. Callers translate that to a `NO_AUDIO_PROVIDER` user-facing error (rather than a thrown exception, because "voice not configured" is an expected deployment state).

The `'audio'` capability value is inferred for `whisper-*` / `tts-*` (OpenAI, Azure) and `*whisper*` / `*distil-whisper*` (Groq, Together, Fireworks, openai-compatible) model ids by `lib/orchestration/llm/capability-inference.ts`. Inference is limited to providers whose backing class (`OpenAiCompatibleProvider`) implements `transcribe()` — bespoke audio providers like Deepgram or AssemblyAI need a dedicated `transcribe()` implementation before being added to the inference list, otherwise the runtime would silently skip those rows.

The settings PATCH route validates `defaultModels.audio` against the matrix (the chosen `modelId` must exist in an active `AiProviderModel` row whose `capabilities` contains `'audio'`) — distinct from the chat/reasoning slots which validate against the hardcoded chat-model registry. Audio support is matrix-driven, so the matrix is the authoritative source.

Operators can now add audio rows directly from the admin UI (`/admin/orchestration/provider-models/new` and the Discover Models dialog both surface an `Audio` capability checkbox). Pre-Phase-1 the matrix's Zod enum (`MODEL_CAPABILITIES` in `types/orchestration.ts`) rejected anything outside `['chat', 'embedding']`, so adding a Whisper row required hand-editing the DB. The 009-provider-models seed ships a default Whisper row, so a fresh checkout has voice input working as soon as an OpenAI key is set.

### Vision and document capabilities

`'vision'` and `'documents'` are engine-invoked `ModelCapability` values that gate per-agent attachment input. Unlike `'audio'`, they do not resolve to a separate model — they are intrinsic capabilities of the chat model that handles the turn. `assertModelSupportsAttachments(providerSlug, modelId, kinds)` (in `provider-manager.ts`) is called from `streaming-handler.ts` before any provider invocation: when a request carries `image/*` attachments the resolved model must carry `'vision'`; when it carries `application/pdf` the model must carry `'documents'`. Missing capability throws `CAPABILITY_NOT_SUPPORTED`, which the chat handler maps to a user-facing SSE event (`IMAGE_NOT_SUPPORTED` / `PDF_NOT_SUPPORTED`) referencing model selection.

Capability truth lives on `AiProviderModel.capabilities`. The 009-provider-models seed is the current snapshot:

- **Vision** (image input) is seeded on multimodal chat models from the major providers. To see exactly which rows qualify in your deployment, query `AiProviderModel` for rows with `'vision'` in `capabilities`, or open the provider-models matrix in the admin UI and filter by the Vision chip.
- **Documents** (native PDF input) is seeded on rows whose upstream provider accepts native PDF parts in chat completions. Operators can add the capability to other rows when their provider gains support, or remove it from rows where it stops working. Rejection (`PDF_NOT_SUPPORTED`) is preferable to silent drop because the model would otherwise respond as though it had read a file it never saw.

#### Per-provider wire format for attachments

| Provider                                                                                   | Image input     | PDF input       | Mechanism (image / PDF)                                                        | Sunrise impl                             |
| ------------------------------------------------------------------------------------------ | --------------- | --------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| **Anthropic** Claude 4.x family (incl. Bedrock)                                            | yes             | yes             | `image` block (base64) / `document` block (base64)                             | `AnthropicProvider.toAnthropicBlocks`    |
| **OpenAI** GPT-4o family + GPT-4.1 + GPT-5                                                 | yes             | yes             | `image_url` part (data URI) / `file` part (`file_data` data URI)               | `OpenAiCompatibleProvider.toOpenAiParts` |
| **Azure** GPT-4o                                                                           | yes             | yes             | same as OpenAI (proxies the same wire format)                                  | `OpenAiCompatibleProvider`               |
| **OpenRouter** Auto                                                                        | route-dependent | route-dependent | `image_url` / `file` part (passes through to upstream)                         | `OpenAiCompatibleProvider`               |
| **Google** Gemini 2.5 Pro/Flash                                                            | yes             | not yet         | `image_url` part (OpenAI-compat adapter) / no inline support via OpenAI-compat | `OpenAiCompatibleProvider` (vision only) |
| **xAI** Grok 3                                                                             | yes             | not yet         | `image_url` part / not verified for PDFs                                       | `OpenAiCompatibleProvider` (vision only) |
| Mistral, Cohere, DeepSeek, Perplexity, Groq, Together, Fireworks, Meta Llama, Alibaba Qwen | no              | no              | text-only chat completions in their current adapters                           | `OpenAiCompatibleProvider` (text only)   |
| **Voyage**                                                                                 | —               | —               | embeddings only (no chat)                                                      | `VoyageProvider`                         |

OpenAI's inline-PDF support landed in Chat Completions in late 2024. The provider conversion at `lib/orchestration/llm/openai-compatible.ts:481` branches on `part.source.mediaType`: `application/pdf` becomes a native `file` part with `data:application/pdf;base64,...`; other documents (txt, csv, md) still fall back to a text part with the file decoded as UTF-8.

When a provider gains PDF support in its OpenAI-compatible adapter, flipping `'documents'` on for its seed row is enough — the provider class already emits the right shape. When a provider uses a non-OpenAI wire format (e.g. native Gemini `inlineData`), a dedicated provider class is needed; see the deferred work in `meta/improvement-priorities.md`.

Distinct from `'image'`, which is a separate `MODEL_CAPABILITIES` value meaning image _generation_ (DALL·E, gpt-image, Imagen). `'image'` is storage-only — the engine has no runtime path. The `MODEL_CAPABILITIES` constant treats `'vision'` / `'documents'` as engine-invoked and `'image'` / `'moderation'` as storage-only via `STORAGE_ONLY_CAPABILITIES`.

The per-agent `enableImageInput` / `enableDocumentInput` toggles (on `AiAgent`) and the global kill switches `imageInputGloballyEnabled` / `documentInputGloballyEnabled` (on `AiOrchestrationSettings`) bound when the attach affordance is surfaced. Effective state for image input is `agent.enableImageInput && settings.imageInputGloballyEnabled && resolvedModel.capabilities ⊇ ['vision']`; documents follow the same shape with `'documents'`.

## Provider Manager (DB-Backed Factory)

`providerManager.getProvider(slug, context?)` is the single entry point. It:

1. Checks the in-memory cache. Each entry is a provider row with the clients built from it, one per credential identity, and is evicted after **5 minutes** (`CACHE_TTL_MS`). This ensures config changes in the database (e.g. switching API keys, toggling `isActive`) take effect without a restart.
2. Loads the matching `AiProviderConfig` row: a row with that **slug** first, and only if there is none, a row with that **name**. (One unordered `findFirst` over both used to let a caller holding row A's slug be handed row B, whose name equals it.)
3. Throws `ProviderError` with `code: 'provider_not_found'` / `'provider_disabled'` if missing or inactive.
4. Resolves the API key through the credential seam — by default `process.env[config.apiKeyEnvVar]` — and reuses the client built for that credential's identity, or builds one (see _Provider credentials_).
5. Instantiates `AnthropicProvider` or `OpenAiCompatibleProvider` based on `providerType`.
6. Caches with timestamp and returns the Proxy for `context` — see _The call-time gate_ below for what `context` is and why to pass it.

**Do:**

```typescript
const provider = await providerManager.getProvider('ollama');
```

**Don't:**

```typescript
// Never construct SDK clients directly.
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

For tests or scripts that bypass the database, use `providerManager.registerProvider(config)` which accepts a plain `ProviderConfig` object.

`clearCache()` evicts one or all cached instances — call it for immediate invalidation (e.g. after an admin updates a provider config). Without manual invalidation, stale entries expire naturally after 5 minutes.

### Every instance is wrapped in a Proxy

Between steps 5 and 6, `getProvider` passes the new instance through
`withInFlightTracking(provider, slug, context)`, which returns a `Proxy`. It
keeps the in-flight counter accurate, it is where the call-time gate runs, and it
is the only place in the tree where **every** LLM call through a manager-built
provider can be observed in one spot.

`registerProvider()` and `registerProviderInstance()` wrap too, so _everything
`getProvider` hands back has been through the Proxy, whichever of the three
routes put it in the cache_. That is a property of the cache rather than of one
way into it. It is also why a check at the read would not have worked: deciding
whether an arbitrary object is "already wrapped" is precisely what a `Proxy` is
built to make unanswerable.

**Consequence for tests and smoke scripts:** `getProvider(name)` no longer
returns the object you injected — it returns a Proxy over it. Calls, spies and
`instanceof` all still work; object identity (`expect(retrieved).toBe(fake)`)
does not. Assert on behaviour.

#### The disposition map

Interception is driven by one exhaustive table, `METHOD_DISPOSITION` in
`provider-manager.ts`:

| Disposition   | Methods                                    | Effect                                                                        |
| ------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `track`       | `chat`, `embed`, `embedMany`, `transcribe` | gated, then `track(slug, …)` — holds a gauge for the life of the promise      |
| `trackStream` | `chatStream`, `transcribeStream`           | gated before the first chunk, then `trackStream(slug, …)` until it settles    |
| `passthrough` | `listModels`, `testConnection`             | forwarded bound to the target, deliberately **not** counted and **not** gated |

Symbol-keyed accesses and non-function properties pass through unwrapped,
deliberately: proxying `Symbol.toPrimitive` as though it were a tracked method
corrupts JSON serialisation. `constructor` and everything inherited from
`Object.prototype` is forwarded too — test runners, structured logging and
`util.inspect` all reach for those, and refusing them would fail on the observer
rather than on the thing observed.

**Anything else throws on access.** A function property that is neither
classified nor host machinery raises `ProviderError`
(`code: 'unclassified_provider_method'`, non-retriable). Throwing on _access_
rather than on call is the point: feature detection
(`if (provider.newThing) …`) is how such a method gets called, so it has to fail
there too.

#### Why it is an allowlist rather than two `Set`s

The previous shape was `TRACKED_METHODS` and `STREAM_METHODS`, and anything in
neither was silently forwarded. So adding a method to `LlmProvider` created a
vendor-reaching operation that nothing counted, nothing could gate, and nothing
announced. `transcribeStream` sat in exactly that state from the day it was
added — latent only because no shipped provider implements it.

Two things changed, and both matter:

- **`Record<ProviderMethodName, MethodDisposition>` is derived from
  `LlmProvider` itself.** Adding a method to the interface is a _type error_
  here until somebody classifies it. That is the primary mechanism: a build
  failure the moment the surface widens, not a runtime hole found later.
- **`passthrough` is a decision, written down.** "We reach the vendor and chose
  not to count it" and "nobody looked" used to be the same state. They are now
  different rows.

The Proxy is created once per cache entry and call context, not per call; the
closures it returns run per call.

### The call-time gate

Every `track` / `trackStream` call asks the provider eligibility rule first
(`assertProviderCallPermitted` in `provider-eligibility.ts`, §120 t-741). It is
what makes the policy complete for core: the selection sites below decide which
provider to choose, and the gate refuses any call the rule does not permit,
wherever the provider came from — including a site nobody has listed yet.

| Property                   | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **When**                   | On every call, inside the returned closure — never once per cached instance, so a rule whose answer changes applies on the next call rather than after the 5-minute TTL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Which slug**             | The built row's `config.slug` (or a registrar's name), never the string the caller asked for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **What the rule is told**  | The `context` the caller passed to `getProvider`, or the binding provenance passed to `getProviderWithFallbacks` (`ResolvedAgentBinding.provenance`: the primary is `'primary'` or `'explicit'`, fallbacks `'explicit'` or `'system'`, and a fallback carries the primary's slug). `primarySlug` keeps the seam's contract, `null` only for `'primary'`: an explicit primary, or an unrecorded call asked as `'explicit'` / `'system'`, carries its own slug. Every core caller passes one.                                                                                                                                                                                                         |
| **No recorded provenance** | Permitted only if the rule permits the provider both as Sunrise's pick (`'primary'`) and as an operator's (`'explicit'`), the two things a lone provider fetched by name can be. Whichever way a rule treats those two, an unrecorded call gets the stricter answer; recording provenance can only relax a refusal. It is not asked as `'system'`, the fill drawn beside a different primary. An unrecorded FALLBACK (`getProviderWithFallbacks` with no provenance, past the primary) is asked as both kinds of fallback instead, `'explicit'` and `'system'`, with the real primary's slug. Its `task` comes from the method: `embed*` → `embeddings`, `transcribe*` → `audio`, otherwise `chat`. |
| **The org**                | The rule runs in the caller's async context and can read `getTenantContext()`. At `single`, no context is the install org. At `multi`, a call with no org scope, or inside `runAsSystem`, is refused before the rule is asked — there is no org whose policy could permit it.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Explicit choices**       | Gated. Selection never reroutes an explicit `agent.provider`, step `modelOverride`, pinned embedding default or `EVALUATION_*` env var; the gate refuses one the rule refuses (as `source: 'explicit'`, with `primarySlug` set to that provider). Refusing a recorded choice is not rerouting it. The pinned audio default is the exception: it is asked when chosen and falls through to the matrix when refused, as it does when unreachable.                                                                                                                                                                                                                                                     |
| **Refusal**                | `ProviderCallRefusedError` (a `ProviderError`, code `provider_not_permitted`, non-retriable, `reason` `'policy'` or `'no_org_scope'`), thrown before `track` counts anything or a stream is opened. Its message names no provider (executors forward `ProviderError` messages to clients); the slug is on `providerSlug`, and the log records the exact context the rule was asked.                                                                                                                                                                                                                                                                                                                 |
| **After a refusal**        | `isRequestFault` counts it, so chat does not fail over and no circuit breaker records a failure — one org's policy must not open the circuit for every org on that slug. A workflow step whose `ExecutorError` wraps it within ten levels of `cause` fails with code `provider_not_permitted` and is not retried (`ExecutorError` derives both from the cause chain; the engine's `executor_threw` wrapper keeps its code, whose raw message is never shown, and only becomes non-retriable). Chat surfaces `provider_not_permitted`; the admin Test-model action and the retroactive-review route report it as such, not as a failure.                                                             |
| **Not gated**              | `listModels` and `testConnection`. They send no prompt or document text, and providers are platform-admin configuration: gating them by the admin's active org would stop a platform admin testing a provider before granting it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The gate binds what core sends through the manager. It does not bind a fork's
own direct construction of a provider class — see the next two sections.

### The spend gate

Right after the eligibility gate, every `track` / `trackStream` call is held to
the monthly spend caps that are not about any one agent: the org's
(`Org.settings.quotas.monthlyBudgetUsd`) and the global one
(`globalMonthlyBudgetUsd`). This is `assertWithinSpendCaps` in
`lib/orchestration/llm/spend-caps.ts` (§110 t-788). It is what holds workflow
steps, the orchestrator, evaluations, judges, knowledge ingestion and scheduled
or webhook runs to those caps. Before it existed, only the chat handler checked
them. See [Costs → Per-org monthly budget cap](../admin/orchestration-costs.md#per-org-monthly-budget-cap)
for the caps themselves.

| Property            | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local providers** | Never refused (`isLocal` on the provider instance). They cost nothing, so a cap of `0` means "no paid calls", not "no calls".                                                                                                                                                                                                                                                                                                                                                                                                         |
| **The org**         | The tenant context's org, or the install org at `single` when none was entered.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Order**           | The global cap first, then the org's, as in chat: the global cap is the one nobody in the org can lift.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Refusal**         | `SpendCapExceededError` (a `ProviderError`, code `org_budget_exceeded`, `global_budget_exceeded` or `budget_exceeded`, non-retriable, `cap` `'org'`, `'global'` or `'agent'`), thrown before `track` counts anything or a stream is opened. `spendCapRefusal()` answers the same question without throwing.                                                                                                                                                                                                                           |
| **After a refusal** | The codes are request faults (`isRequestFault`): not retried, and no circuit breaker records a failure. A local provider is the one failover that can help, so provider selection makes it: `getProviderWithFallbacks` and chat's mid-stream failover pass over every paid candidate the caps refuse. With no local candidate left, the refusal itself is thrown, not a retriable `all_providers_exhausted`. `ExecutorError` keeps the cap's code, so a trace says which cap stopped the step.                                        |
| **A failed read**   | Logged and that cap skipped (`globalCapStateOrSkip` / `orgCapStateOrSkip`, which `checkBudget()` and the agents list use too), so a settings read that fails does not stop every AI call on the install.                                                                                                                                                                                                                                                                                                                              |
| **Cost per call**   | The month-to-date totals are cached for 10 seconds (`SPEND_TOTAL_TTL_MS`), and `logCost` adds each row it writes to them at once. Another process's spend is seen when the entry expires, which bounds how far it can carry a cap past its limit. An org's cap is cached for 30 seconds (`CAP_SETTING_TTL_MS`), and the orgs API clears it with `forgetOrgCap`. The global cap is read from `getOrchestrationSettings()`, whose 30-second cache the settings PATCH and the backup importer clear. A warm call makes no database read. |
| **Not gated**       | `listModels` and `testConnection`, as for the eligibility gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Chat still checks the caps before a turn starts (`checkBudget()`), so its user
is told which cap stopped the turn, and it adds the agent's own cap, which only
it knows. An agent whose primary provider is local is not refused there. The
turn runs inside `withPaidCallHold`, and it sets the hold instead, so from then
on this gate refuses every paid call the turn makes with the cap's code: a
paid fallback or failover, and the summarizer, embeddings and tools as well as
the main stream. The hold is an `AsyncLocalStorage` carried across the turn's
yields, so work the turn starts and leaves running sees it too, and a nested
turn (an agent calling another) runs under its own.

### What bypasses the Provider Manager

One route reaches a vendor without a manager-built, Proxy-wrapped instance. It
is not a defect on its own, but it surprises people:

| Route               | What it skips                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct construction | `AnthropicProvider` and `OpenAiCompatibleProvider` are exported from `@/lib/orchestration/llm` and listed under Public Surface, so any caller — a fork especially — can `new` one and skip the manager, the cache and the Proxy entirely. |

The knowledge embedder used to be a second route: it built its own request from
`AiProviderConfig` rows and called `fetch` itself. Since t-740 it chooses the
row and model and then calls `getProvider(slug).embedMany(…)`, so embedding is
counted by the Proxy like chat. See _The embedder chooses; the provider manager
calls_ below.

`fetchWithTimeout` (`llm/provider.ts`) is a shared helper rather than a bypass —
`model-registry.ts` uses it to GET OpenRouter's public model list, which reaches
no vendor with anyone's data.

If you are adding anything cross-cutting to LLM calls — metering, tracing, a
policy check — direct construction is what stops "wrap the Proxy" from being
sufficient on its own, and only for code that constructs a provider itself.

### What the outbound-egress guarantee covers, and what it does not

**Sunrise tells you every place its own code sends your data, and fails loudly
when that set changes. It cannot police what you build on top.**

That sentence is the whole of the promise, and the second half is not a
disclaimer — it is a design decision, taken deliberately (2026-09-07) rather
than arrived at by omission.

**Why core only.** A fork owns the source. Any guard Sunrise writes below
construction can be deleted in the fork that inherits it, so a boundary
presented as unavoidable would be a boundary that can be edited away — worse
than no boundary, because someone would rely on it. The provider classes are
published API precisely so forks can build on them.

**What that buys instead, and it is the useful half.** Three real situations
were tested against this: a regulated customer asking a fork to demonstrate that
data reaches only approved processors; Sunrise widening the egress surface
underneath a fork in a later release; a fork's DPA sub-processor list going
stale against the code. **None of them wants the guard to be unavoidable. Every
one of them wants the set of doors to be enumerable, and loud when it widens.**
That is what `METHOD_DISPOSITION` delivers and what two hand-maintained `Set`s
could not.

**So, concretely, for a fork engineer:**

- Reaching a vendor through `getProvider` inherits counting, the disposition
  map and the call-time gate. Pass `getProvider` a context saying where the
  provider came from; without one, the call is held to the rule's strictest
  answer.
- `new OpenAiCompatibleProvider({…})` in your own code reaches the vendor
  directly. That is supported and will keep working. It is outside every
  guarantee on this page, and nothing will tell you so at runtime.
- Adding a method to `LlmProvider` will not compile until you classify it. Take
  that as the signal it is: you have widened the egress surface, and anything
  downstream that enumerated it is now short.

### The privacy stage on every vendor call

After the eligibility gate and the spend gate, the Proxy runs the LLM privacy
layer's stage (`applyPrivacyStage()` in `lib/orchestration/llm/privacy-stage.ts`,
§127). What it does to each method is a second exhaustive record,
`PRIVACY_COVERAGE`, so a method added to `LlmProvider` will not compile until
someone decides whether its input is scanned:

| Method                           | Coverage                                  |
| -------------------------------- | ----------------------------------------- |
| `chat`, `chatStream`             | scanned and acted on per the privacy mode |
| `embed`, `embedMany`             | scanned and counted, never altered        |
| `transcribe`, `transcribeStream` | not covered: audio cannot be masked       |
| `listModels`, `testConnection`   | not covered: no user content              |

In this version the mode is `off` or `detect`. `detect` sends the call
unchanged and records per-type counts, never values, on the chat turn's
assistant message (`metadata.privacy`) and on each workflow step's trace entry
(`privacy`). A local provider is skipped unless the settings protect local
providers. The stage refuses a call (`PrivacyRefusedError`, code
`privacy_refused`, a request fault: never retried, never failed over, never
counted against a breaker) when it cannot say what the policy is: a failed app
privacy init or core install (mode `off` included), an unreadable stored mode,
a failed policy resolver, or an error inside the stage itself.

It covers what this page's guarantee covers and no more: a provider object a
fork builds directly never passes through it. See
[LLM Privacy Layer](../privacy/llm-privacy-layer.md).

## Model Registry

Dynamic catalogue of models with pricing, context windows, and capabilities. Four layers:

1. **Static fallback map** — always available. Covers Claude Opus/Sonnet/Haiku 4.x, GPT-4o family, Llama 3.3 70B on Together/Fireworks/Groq, and a `local:generic` placeholder.
2. **OpenRouter refresh** — `modelRegistry.refreshFromOpenRouter()` pulls 300+ live entries from `https://openrouter.ai/api/v1/models`, cached 24h. No API key required. Concurrent callers share one in-flight fetch. OpenRouter writes Anthropic versions with a dot (`anthropic/claude-haiku-5.5`) where Anthropic's API uses a dash, so each Anthropic entry takes its API id (`claude-haiku-5-5`) as its own and keeps OpenRouter's dotted id as an alias; an entry OpenRouter lists under the dashed id itself wins.
3. **Per-provider discovery** — `modelRegistry.refreshFromProvider(provider)` marks entries as `available: true` when a configured provider lists them (e.g. Ollama returns only locally-pulled models).
4. **DB hydration from `AiProviderModel`** — operator-curated rows added via the admin Model Matrix. Lives in a separate server-only module at `lib/orchestration/llm/model-registry-db-hydrate.ts` to keep the registry itself platform-agnostic (the registry is reachable from client components via `lib/validations/orchestration.ts`; pulling Prisma into it broke the browser bundle with "Module not found: Can't resolve 'dns'"). The hydration runs wherever a model is about to be looked up or priced: inside `getProvider` / `getProviderWithFallbacks` (every LLM call resolves its provider before its cost is computed), at the top of `resolveAgentProviderAndModel` (the chat handler reads the model's context window for its history budget before it fetches a provider), in the workflow engine's `runLlmCall` (which scheduled and triggered runs reach without the admin route), keyword enrichment and the retroactive execution review (each looks the model up first), and at the start of every `prepareWorkflowExecution`. Next bundles the registry per route, so each module graph hydrates its own copy. It is throttled to one SELECT per 60 s per process (one per 10 s while it fails, once one has landed), with rows read oldest first so a model id two providers share settles on the same entry every time, and an OpenRouter refresh re-applies the last hydrated rows. It has concurrent-call dedup so a parallel-execution burst doesn't fan out N queries. On a same-provider key conflict the DB row wins on descriptive fields (name, tier, capabilities) but a positive input/output rate or context window already in the registry is kept — a matrix row's prices are hand-entered and its context a coarse bucket, so it only fills a price or window the registry has at zero. A row's rates come from `dbModelToModelInfo`: its split `inputCostPerMillionTokens` / `outputCostPerMillionTokens` when set, otherwise its blended `costPerMillionTokens` for both (t-774); a row missing either rate is `pricingUnknown`. A figure the matrix itself supplied (a model the registry never knew) stays editable: the next hydrate applies the row's current value. A row with no price registers at 0/0 marked `pricingUnknown`, so its turns are recorded as unpriced rather than free; the mark is never set over a registry entry, and clears once anything prices the model. The matrix stays the operator-authoritative source for "is this model usable right now". Without this layer, a workflow step that sets `modelOverride: 'gpt-5'` semantic-validates to `UNKNOWN_MODEL_OVERRIDE` even though the operator added gpt-5 in the UI, because the registry's hardcoded fallback doesn't know about it.

```typescript
await modelRegistry.refreshFromOpenRouter();

modelRegistry.getModel('claude-opus-4-6');
modelRegistry.getModelsByTier('frontier');
modelRegistry.getModelsByProvider('anthropic');
modelRegistry.getAvailableModels('ollama');
```

Tiers are classified by input cost: `local` (≤0), `budget` (≤\$0.50/M), `mid` (≤\$5/M), `frontier` (>\$5/M).

If OpenRouter is unreachable, accessors continue serving the fallback map silently — a warning is logged.

## Model lifecycle

Providers retire models on days they announce. A catalogue row records that with two nullable columns on `AiProviderModel` (§136 t-1064):

- **`retiresAt`** — the day the vendor stops serving the model, stored as the UTC midnight that begins it.
- **`replacementId`** — the successor whatever uses the model should move to: another catalogue row.

The state is derived from the date, at read time, by `modelLifecycleState()` in `lib/orchestration/model-lifecycle/state.ts`. Nothing flips it on a schedule:

| State      | When                    | What it means                                                 |
| ---------- | ----------------------- | ------------------------------------------------------------- |
| `current`  | `retiresAt` is null     | No retirement known.                                          |
| `retiring` | `retiresAt` is to come  | The vendor still serves it; move what uses it before the day. |
| `retired`  | `retiresAt` has arrived | Calls to it fail at the vendor.                               |

**Independent of `isActive`.** `isActive` says whether Sunrise offers the model in its pickers. A retiring model stays active on purpose: an inactive row is left out of the model registry's DB hydration, so deactivating early would lose its pricing while agents still call it.

**The replacement rule** is `checkReplacement()`, the one check every writer runs (and the move, which must not trust a stored replacement, since either row can change after it was written). A replacement must be:

- **on the same provider** (owner ruling, 2026-11-19). An org's provider approval and its own key are both per provider, so a same-provider move never changes what an org may use or who pays. Moving to another provider is a provider switch, made per agent in the agent form;
- **not the model itself**, **active**, and **not itself retiring or retired** (which also rules out a cycle of two);
- **able to do everything the model does**: every capability it has.

The database cannot express a rule across two rows, so the foreign key only keeps `replacementId` pointing at a row that exists (`ON DELETE SET NULL`). The PATCH route checks the rule when a save changes the replacement, or the model's provider or capabilities. It does not re-check the models that name this one as their replacement when this one changes, so a stored replacement can go stale (turned off, retiring itself); the move checks again before it writes.

**Who writes it:**

- **The provider model audit.** A deactivation proposal may carry `retiresAt` (`YYYY-MM-DD`) and `replacedBy` (the successor's vendor model id, e.g. `gpt-5.1`, looked up on the retiring model's own provider). The `deactivate_provider_models` capability then records the retirement. A day still to come leaves the model active (`retiring`); a day already here also deactivates it (`retired`). A successor that fails `checkReplacement` is left out, and the result's `replacementNote` says why; the retirement is still recorded. Without `retiresAt` the capability deactivates as it always has; a `replacedBy` given without a day is not recorded and `replacementNote` says so. An empty string in either field reads as none, and neither field can fail the audit's `validate_proposals` guard: a day that is not `YYYY-MM-DD` makes only that entry `invalid`. A successor the same batch is retiring is refused, and so is one whose lookup fails; the retirement is still recorded and the rest of the batch applies. `add_new_models` runs first, so the successor can be a model the same audit has just added.
- **An admin** (who keeps the Active switch: a past day leaves the model on until they turn it off, where the audit turns it off itself), on the model's edit page (Retirement section) or `PATCH /api/v1/admin/orchestration/provider-models/:id` with `retiresAt` (`YYYY-MM-DD` or `null`) and `replacementId` (a row id or `null`). A replacement without a day is refused, and clearing the day clears the replacement.

**Every catalogue change is in the admin audit log** (entity type `provider_model`): an admin's create (`provider_model.create`), bulk add (`provider_model.bulk_create`, one row per batch), edit (`provider_model.update`, each field's old and new value) and delete (`provider_model.delete`), and each write the audit applies (`provider_model.update`, `.create`, `.deactivate`, `.retire`, with `metadata.source: 'model_audit'` and the run's `workflowExecutionId`). That row is how a price change is noticed; there is no separate "repriced" state.

**What uses a model** (§136 t-1065) is `modelUses()` in `lib/orchestration/model-lifecycle/uses.ts`, which composes two halves:

- **Agents and workflows**, from `providerModelUsage` (`lib/orchestration/admin/global-config-usage.ts`, the one module that counts across orgs): active agents bound to the `(provider, model)` pair and active workflows pinning the model id in a step's `modelOverride`. The caller's org's are named; every other org's are counted, and only for a platform admin (`acrossOrgs: false` for anyone else). An agent is marked `followsPlatform` when its binding follows the platform's pick (`bindingFollowsPlatform`: a platform agent whose definition picks its own binding, with `bindingOwner: 'platform'`). The reconcile ranks a retiring model last and never picks a retired or turned-off one, so the agent moves off a retiring model on its own whenever the org can reach another strong chat model (see [Platform agents](./platform-agents.md)). A platform agent whose definition picks nothing inherits the defaults, which moving the defaults covers; one whose binding the org has taken over (`bindingOwner: 'org'`) stays where it is, like any other agent.
- **The install settings** that name it, from `settingsPinsFor()` (`settings-pins.ts`): each task default (`routing`, `chat`, `reasoning`, `embeddings`, `audio`), marked `saved` or `suggested` (the system's pick for an unsaved slot, which an agent without a model inherits just the same), the model for confidential messages, and the active embedding model. The same matching rule gives the models list its `defaultFor`. Agents name provider and model, and so does a task default or a workflow's `modelOverride` (a `chat_turn` step's included) saved as a pair ([§ A pin names its provider](#a-pin-names-its-provider-136-t-1068)); those uses are exact. A pin by model id alone (`byIdOnly` on a settings pin and on a workflow) — saved before t-1068, the system's suggestion, or the `embeddings` slot — can be any provider's row with the id (`gpt-4o` under OpenAI and Azure). It cannot say which it runs on, and it is not guessed (owner ruling, 2026-11-19): it counts as a use of every row with the id, `uses.sharedWith` names the other providers, and the page marks such uses with `*`. Config health narrows it the safe way: a by-id-only use raises a model's alert only when every row with the id is dated.

`GET /provider-models/:id` returns them as `uses`, beside `lifecycle` (`state` and the `replacement`), and the model's edit page shows them in **Retirement and uses**. The models matrix shows a **Retiring** or **Retired** badge beside a dated model's name. Config health has two checks over every dated model (`retiringModelsInUse()`): `retired_model_in_use` (critical) and `retiring_model_in_use` (warning).

A stored replacement can stop qualifying after it was chosen (turned off, or retiring itself); the page says so beside it. `DELETE /provider-models/:id` also refuses (409) while a saved setting names the model, not only an agent or workflow: a saved default or the confidential-message model would name a missing row, and the active embedding model would be cleared. A default the system only suggests does not block it.

### Moving every use to the replacement (§136 t-1066)

The **Move uses** dialog on the model's page moves everything that uses the model to a replacement on the same provider in one action, from `moveModelUses()` in `lib/orchestration/model-lifecycle/move.ts`. It is also exposed as two routes, for a platform admin only:

| Route                                         | What it does                                                                                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /provider-models/:id/move-uses/preview` | `{ replacementId }` → what would move, org by org (counts, never another org's names), what would be left and why, and the settings. Changes nothing and sends nothing to a vendor.                                |
| `POST /provider-models/:id/move-uses`         | `{ replacementId }` → moves it, and answers every org's outcome: `moved`, `skipped` (with the reason) or `failed` (rolled back, with the reason), plus totals. From the install org only (`writesSharedSettings`). |

Both re-check the replacement with `checkReplacement()` first (`loadMoveTarget`), since a stored one can have stopped qualifying, and refuse with 400 (`replacementId`) a model on another provider, one turned off or itself retiring, or one missing a capability.

**One org at a time, in its own scope and transaction.** Each active org is read and written inside `runAsOrg`, and each read and write also names the org, so row isolation and the query agree. Never the system bypass. Suspended orgs are not entered, as `forEachOrg` skips them; the answer counts them. **An org's changes are one transaction**: its agents and workflows move together or not at all, and one org failing rolls back that org alone, is reported as `failed` with a reason (a database error's text is never shown), and leaves the orgs before and after it moved. The transaction first takes erasure's locks for everyone its workflows name, for the creators of every row it writes (an erasure's delete cascades onto those) and for the acting admin (`lockRepinSubjects`), before any row lock, the order every workflow-definition writer keeps, so the move cannot deadlock with an erasure; its timeout allows for waiting out an erasure first. A workflow changed or removed during the move fails its org with a reason that says so. An org with nothing the move can change, only uses it leaves, is reported as `left`. At `single` there is one pass over every row.

**What moves**:

- **Agents** bound to the `(provider, model)` pair, active or turned off (a turned-off agent turned back on would otherwise be on a retired model), not soft-deleted. The model id changes and the provider stays. Each change is a new agent version (`ensureBaselineVersion` and `recordAgentVersion`, label "Model … moved to … (retiring model)"). An agent changed off the model between the read and the write is left as its editor left it. **An agent whose binding follows the platform's pick** (`bindingFollowsPlatform`) is not moved, and is counted as `agentsFollowingPlatform`: the platform-agent reconcile re-picks its model, ranking a retiring one last, and would undo a model the move wrote.
- **Workflows** pinning the model in a step's `modelOverride`: the draft in place, and a **new published version** that differs from the old one only in the pins (`repinWorkflow` in `workflows/version-service.ts`). The published snapshot is never edited, so an execution keeps running what it started on. A workflow saved, published or scrubbed between the move's read and its row lock is refused (412), failing that org's move until it is run again; a builder opened before the move is refused its next save the same way, because the definition version moved. The new version is checked against the schema and the DAG rules, but not the publish-time semantic check: only a pin changed, to a model the move checked, and anything else that check could say was equally true of the version running today. **A workflow whose published version fails those checks** (published before they changed) is left whole, draft included, with the reason `published_invalid`, and the rest of its org still moves.
- **Settings**: the task defaults (`routing`, `chat`, `reasoning`, `audio`) and the confidential-message model, written before the orgs (one quick write that holds even if the walk over the orgs is cut off), planned from the settings row as read under its lock, so neither a settings save nor a cached read can make it miss or overwrite a slot. A default the system only suggests is **saved** as the replacement, since agents with no model inherit it. **When any org's own key failed its test** (below), the settings are left, every slot reported as `own_key_refused`: an agent with no model of its own follows them, in that org as in any other.

**Every moved pin is written as a pair** (`provider::model`), since the replacement's id may be one another provider also offers. **What is left, and why** (`move-plan.ts`, shared by the preview and the move):

| Left                                                             | Why                                                                                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A pin by the id alone, when another active provider offers it    | It may be running on that provider's model; the move does not guess (the t-1065 ruling). Unshared, it moves, as a pair.    |
| A `chat_turn` step's override by the id alone                    | It runs on its agent's provider, which the definition does not say, and a pair there would also drop the step's fallbacks. |
| A workflow whose published version fails the schema or DAG rules | It is left whole (`published_invalid`): fix and publish it in the builder, then run the move again.                        |
| A settings slot, when an org's own key failed its test           | `own_key_refused`: fix that key, or choose another replacement, then run the move again.                                   |
| The `embeddings` default and the active embedding model          | Changing the embedding model means re-embedding every org's documents (§132), so the move never does it.                   |

**An org on its own key** for the provider (§137) has the key tested against the replacement before anything moves, whether or not the org uses the model directly (its agents with no model of their own follow the settings) (`testProviderKeyOnModel` in `provider-manager.ts`): t-1056's key test, then, for a chat model, a short message to the replacement sent with that key, since a vendor can restrict a key to some models and the key test names none. A reply that spent its small budget thinking and showed nothing (`truncated_no_output`, a reasoning model) passes: the vendor served the model on the key. If either fails, or the key will not open, the org is **skipped** with the reason and nothing in it changes. The message is billed to the org's key (a few tokens), which is why the preview does not send it. No org is skipped for policy: a same-provider move never changes what an org may use. The vendor's message is logged with the key cut out (`withoutKey`) and never returned.

**The audit trail**: one row per agent (`agent.model_moved`) and per workflow (`workflow.model_moved`) in its org, written once the org commits; `settings.model_moved` for the install settings; and a summary row, `provider_model.uses_moved` on the model, with the moved, skipped and failed counts and every org not moved with its reason.

What is left is answered as counts by reason, never another org's workflow or step ids. The move runs inside one request (`maxDuration` 300 seconds), so a very large install (many orgs, each with an own-key test) may take a while to answer; nothing is lost if it is cut off, since each org that finished has committed and a second run finds only what is left. The dialog offers the move whenever something uses the model, and on any retiring or retired model, since its only uses may be turned-off agents and workflows, which the uses list leaves out.

### An app's own model pins (§136 t-1067)

An app built on Sunrise may name models in its own code and tables, which Sunrise cannot read. The `lib/app/model-pins.ts` seam (ships empty; `initAppModelPins()`) lets it register three things, in `lib/orchestration/model-lifecycle/app-pins.ts`:

- **A reporter** (`registerModelPinReporter`), asked `{ model, orgId, signal }` once per org, **inside that org's scope** (`runAsOrg` at `multi`; the install org once at `single`), so its reads stay under row isolation. It answers `{ label, where }[]`; Sunrise stamps the org. Each org's report has 10 seconds (`APP_MODEL_PIN_REPORT_TIMEOUT_MS`), up to four orgs are asked at once (a reporter should honour its `signal`: one that runs on after its timeout holds a database connection), every org is asked, suspended ones too (as agents are counted in every org), and one report over every org has 20 seconds in all (`APP_MODEL_PIN_REPORT_BUDGET_MS`): orgs not asked by then count as failed, so a slow reporter delays a page by that much at most.
- **A check** (`registerModelMoveCheck`), asked `{ model, replacement, pins, phase, signal }` with every org's reported pins, in the admin's scope. It answers `{ allow: true }` or `{ allow: false, reason }`. `phase` is `preview` while an admin looks at the move (asked on every replacement they pick) and `move` just before the move writes, so a check should answer from what the app already knows (an evaluation run ahead of time) rather than run anything slow or billed. The move's request has 300 seconds in all (`maxDuration`), its reports and check included.
- **A mover** (`registerModelPinMover`, t-1088), asked `{ model, replacement, orgId, tx, signal }` once per org the move enters, **inside that org's scope and the org's own transaction** (`tx`), to move the app's pins to the replacement with the app's own code. It answers `{ moved: { label, where }[], left?: { label, where, reason }[] }`. It runs after the move has taken erasure's locks for the org's workflows and their people, and before any agent or workflow is written. So the org's app pins, agents and workflows move together or not at all. Write through `tx`: a write through `prisma` is not rolled back with the org. If your rows name a person the move's own rows do not, take their lock (`lockSubjects` in `lib/privacy/erased-subjects.ts`) before your first write, so the subject locks still come before every row lock. With a mover, every active org the move enters is offered to it, one with no agent or workflow on the model included. An org skipped because its own key failed is not offered to it, and suspended orgs are never entered. Each org's mover has 30 seconds (`APP_MODEL_PIN_MOVE_TIMEOUT_MS`), added to the org transaction's timeout.

**Where the app's pins show.** `modelUses()` adds `appPins` (the caller's org's, named), `otherOrgAppPins` (every other org's, counted, by the same rule as agents and workflows) and `appPinsUnavailable` (some org's report failed: the list may be short). The model's page lists them under **In the app**; the delete refuses (409, `MODEL_IN_USE`) while the app reports a use, and (409, `MODEL_USES_UNREADABLE`) while its report failed, since a delete cannot be undone; config health counts a dated model the app alone uses, asking the reporter only about a dated model no use of the platform's already counts (an exact one, or a by-id-only one that alerts), all such models at once under one report's budget; a model whose report failed is counted as `unknown` for its state, and that state's check reports that it could not run unless a model in that state is known to be in use (never a false alert, never an all-clear); and the move's preview counts them per org (`appPins`), listing an org with nothing but app pins apart, under the app's heading. The **Move uses…** trigger is not offered for the app's uses alone (`modelHasMovableUses`), since the move would change nothing, unless the app registered a mover (`appPinsMovable`), when the move does change them. **Sunrise never writes them itself**: with a mover the app's code moves them inside the move; without one the app moves its own pins after the move. The preview answers `app.mover` and says which.

**The check, at the preview and the move.** The preview answers `app: { pinsUnavailable, refused }`, `refused` being the app's reason, and the dialog then shows it and offers no move. The move asks again, first of all: a refusal throws `ConflictError` (409, `details.refusedBy: 'app'`) **before any org's key is tested or anything is written**, and no audit row is written for it (it is logged). With no check registered the move reads no app pins at all.

**It fails closed.** A check that throws, runs past two minutes (`APP_MODEL_MOVE_CHECK_TIMEOUT_MS`) or answers anything else refuses the move, because the app asked to be consulted. So does an `initAppModelPins()` that throws (the gate rolls back both registrations, and which check it meant to register is unknown), and a report that failed while a check is registered, since the check cannot be asked with every pin. A reporter failing with no check registered does not refuse a move: it marks the uses as unreadable, and refuses the delete. A mover fails closed too: one that throws, runs past its 30 seconds or answers anything the schema refuses fails its org's transaction (`AppModelPinMoveError`). That org is rolled back, its agents and workflows included, and reported `failed` with "The app's own uses in it could not be moved. Nothing in it moved." The move goes on to the next org, as it does for any org's failure. What a mover moved is counted per org (`appPins: { moved, left }`) and in `totals.appPins`, and audited in its org as `app.model_pins_moved` (the counts, and up to 50 of the pins it moved and left). With nothing registered no org is entered for the app and every answer is as it was before the seam.

## Cost Tracking

Every provider call should be followed by `costTracker.logCost(...)`. Local models cost \$0 but their token counts are still recorded for benchmarking (`isLocal: true`).

| Function                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calculateCost(modelId, inTok, outTok, cached?)` | Pure math; returns `{ inputCostUsd, outputCostUsd, totalCostUsd, isLocal, unpriced? }`. A model with no rate (not in the registry, or registered from a matrix row whose cost is null) logs a warning and resolves to \$0 with `unpriced: true`; a free model resolves to \$0 without it. `cached` (`{ cacheReadTokens?, cacheWriteTokens? }` — an `LlmUsage` fits) prices those subsets of `inTok` at the model's cache rates: its own when OpenRouter published them (`ModelInfo.cacheReadCostPerMillion` / `cacheWriteCostPerMillion`), Anthropic's 0.1× read / 1.25× write for a Claude model without, and the full input rate otherwise. |
| `logCost(params)`                                | Writes an `AiCostLog` row, with `cacheReadTokens` / `cacheWriteTokens` when the call reported cache use (priced into `inputCostUsd`), `metadata.webSearchRequests` / `webSearchCostUsd` when it ran provider web searches, and `metadata.codeExecutionRuns` / `codeExecutionBilledSeconds` / `codeExecutionCostUsd` when it ran provider code (both priced into `totalCostUsd` only, the code runs as an estimate). **Forgiving**: returns `null` on DB failure so chat responses are never lost to accounting errors. An `unpriced` turn is stamped `metadata.pricing = 'unknown'`, which is what tells it apart from a free one on the row. |
| `getAgentCosts(agentId, dateRange?)`             | Returns a `CostSummary` (matches `types/orchestration.ts`) with totals and breakdowns by provider / model / operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `checkBudget(agentId)`                           | Sums the current UTC calendar month and compares to `AiAgent.monthlyBudgetUsd`. Returns `{ withinBudget, spent, limit, remaining }`. Null budget means unlimited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

```typescript
// Before a chat turn, make sure the agent can still spend.
const budget = await costTracker.checkBudget('agent-1');
if (!budget.withinBudget) {
  throw new Error(`Agent over monthly budget ($${budget.spent} / $${budget.limit})`);
}
```

## Tokenisation

LLMs split text into tokens, not characters. The mapping is dense for English prose (~4 chars/token), much denser for code, and much sparser for non-English / CJK text (~1–2 chars/token). Each provider family ships its own tokeniser; the same string yields different counts on OpenAI vs. Anthropic vs. Google.

Sunrise resolves the right tokeniser per model **before** an LLM call, so context-window truncation drops the right amount of history (no silent provider-side rejections, no over-aggressive trimming). Cost accounting is unaffected — providers report exact `usage.inputTokens` after the call.

### Public surface

```typescript
import { tokeniserForModel, type Tokeniser } from '@/lib/orchestration/llm';

const t = tokeniserForModel('claude-haiku-4-5');
t.id; // 'anthropic-approx'
t.exact; // false  — calibrated approximator
t.count('Hello world'); // synchronous, no network
```

### Strategy per family

| Family                                           | Strategy                                  | Source             |
| ------------------------------------------------ | ----------------------------------------- | ------------------ |
| OpenAI gpt-4o, o1, o3, o4, gpt-4.1               | Exact via `o200k_base`                    | `gpt-tokenizer`    |
| OpenAI gpt-4 / gpt-3.5 / davinci (legacy)        | Exact via `cl100k_base`                   | `gpt-tokenizer`    |
| Anthropic (Claude)                               | `o200k_base` × **1.10** calibration       | local approximator |
| Google Gemini                                    | `o200k_base` × **1.10** calibration       | local approximator |
| Llama-family (Together, Fireworks, Groq, Ollama) | `o200k_base` × **1.05** calibration       | local approximator |
| Unknown model id                                 | Llama-family approximator (defensive)     | local approximator |
| Missing / null modelId                           | `chars / 3.5` heuristic (legacy fallback) | none               |

The multipliers are **conservative on purpose** — over-counting drops history slightly early; under-counting overflows the context window. Anthropic publishes that Claude tokenisers run roughly 10% denser than OpenAI's modern tokeniser for English; the multiplier captures that without a network call.

### Routing layers

`tokeniserForModel(modelId)` resolves the right tokeniser through three layers, in priority order:

1. **Registry by `provider`** — if `getModel(modelId)` returns a model whose `provider` field matches a known family (`openai`, `anthropic`, `google` / `gemini`, `together` / `fireworks` / `groq` / `ollama` / `lmstudio` / `vllm` / `meta-llama`), route by that. This is the default path in production.
2. **Model-id pattern** — if the registry is missing the entry (brand-new id, refresh in flight) or the provider field is a custom human-readable label (e.g. a provider config named "OpenAI Production"), infer the family from the id itself: `claude-*` → Anthropic, `gpt-*` / `o1-*` / `o3-*` / `o4-*` → OpenAI, `gemini-*` → Gemini, `llama` / `mistral` / `qwen` substring → Llama-family. Defensive net.
3. **Llama-family approximator** — final default for any modern BPE model not caught by the first two layers; under-counts by at most a few percent versus the truth, which is far better than the chars-only heuristic.

The heuristic tokeniser is only returned when the caller passes a missing / empty model id — production callers should always supply one.

### Why local-only

Anthropic exposes a network `count_tokens` endpoint and Google's SDK has `countTokens()`. Both add 200–500 ms per chat turn — unacceptable on a streaming hot path. Sunrise's tokeniser layer is **synchronous and local** by contract; if a future feature wants exact pre-flight counts (e.g. budget enforcement before a long generation), it can opt in to the network path independently.

### Where it's used

| Caller                                        | What it does                                           |
| --------------------------------------------- | ------------------------------------------------------ |
| `lib/orchestration/chat/token-estimator.ts`   | Estimates token counts for individual strings / arrays |
| `lib/orchestration/chat/message-builder.ts`   | Drops oldest history rows that don't fit before send   |
| `lib/orchestration/chat/streaming-handler.ts` | Threads the agent's `model` in as `modelId`            |

The chunker (`lib/orchestration/knowledge/chunker.ts`) keeps a separate, simpler `chars / 4` heuristic — embedding-time chunk sizing tolerates more slack and the embedding tokenisers differ from chat tokenisers.

### Re-calibrating the multipliers

Multipliers ship as constants in `lib/orchestration/llm/tokeniser.ts`. To re-measure:

1. Pick a corpus of representative strings (English prose, code, non-English, CJK).
2. For each provider, send each string with `max_tokens: 1` and read back `usage.inputTokens`.
3. Compute the ratio against `encodeO200k(text).length` from `gpt-tokenizer`.
4. Round up and bump the constant. Treat the change as a forward-only adjustment — old conversations have already been accounted for via the `usage.inputTokens` provider report.

## Error Handling & Resilience

Uniform across every provider via `withRetry` + `fetchWithTimeout` (internal helpers):

| Concern         | Cloud provider                               | Local provider              |
| --------------- | -------------------------------------------- | --------------------------- |
| Default timeout | 120s (overridable via `timeoutMs`)           | 60s (overridable)           |
| Retry 429       | Yes (exp backoff)                            | Yes                         |
| Retry 5xx       | Yes (exp backoff)                            | **No** — restart won't help |
| Max retries     | 2 (overridable via `maxRetries`)             | 2 (overridable)             |
| Backoff         | 500ms → 1s → 2s + ±25% jitter, capped at 10s | same                        |

Two timeout levels exist and they are not the same knob. The table above is
the **provider-level** default, fixed when the client is constructed from
`AiProviderConfig.timeoutMs`. A single call can override it via
`LlmOptions.timeoutMs`, which both adapters forward to the SDK as a per-request
option (`buildRequestOptions` in `provider.ts`) — use it for the occasional call
that genuinely runs long, e.g. document extraction on a reasoning model, rather
than raising the provider default for everything. `LlmOptions.signal` rides
along the same path, so a caller's abort cancels the in-flight HTTP request on
the streaming paths too, not just between retries. Set neither and nothing is
sent, leaving the provider-level default in charge.

Note the per-request timeout bounds each attempt, not the retry sequence: pass
a `signal` (e.g. `AbortSignal.timeout(...)`) when you need an absolute ceiling
across retries, which is what `structured-completion.ts` does.

Worst-case wall time on retriable failures: 3 attempts × 120s + ~3s of
backoff ≈ 6 min for cloud, ~3 min for local. Workflow `llm_call` /
`agent_call` steps run inside engine-level step timeouts that further
bound this — the orchestrator step's default is also 120s.

`ProviderError` carries `code` (stable short string), `status?` (HTTP code when known), `retriable` (consulted by `withRetry`), and `cause?`. SDK errors are narrowed via `toProviderError()` which extracts the `status` field that both `@anthropic-ai/sdk` and `openai` expose.

Every long-running call accepts an `AbortSignal` via `LlmOptions.signal`. Aborts surface as non-retriable `ProviderError('aborted')`.

### Truncation guard (`truncated_no_output`)

Both providers fail loudly when the model hits its token cap **without producing usable output**. Two rules, because what counts as usable differs:

| Call shape                                     | Fires when                                            | Where                           |
| ---------------------------------------------- | ----------------------------------------------------- | ------------------------------- |
| Ordinary completion                            | cap hit **and** content empty **and** no tool calls   | `chat()` only                   |
| **`json_object`** (either adapter)             | cap hit **and** the text is not a complete JSON value | `chat()` **and** `chatStream()` |
| **`json_schema`** — OpenAI-compatible          | cap hit **and** the text is not a complete JSON value | `chat()` **and** `chatStream()` |
| **`json_schema`** — Anthropic, native          | cap hit **and** the text is not a complete JSON value | `chat()` **and** `chatStream()` |
| **`json_schema`** — Anthropic, extraction tool | cap hit, **alone** (see below)                        | `chat()` **and** `chatStream()` |

Both adapters implement these rules (`finish_reason: 'length'` on OpenAI-compatible, `stop_reason: 'max_tokens'` on Anthropic) and raise `ProviderError('truncated_no_output')`.

**Why Anthropic's extraction-tool row has no completeness test.** There the payload is rebuilt with `JSON.stringify` from the forced extraction tool's already-parsed input, so even a truncated one serialises to _valid_ JSON — a parse gate would silently disable the guard entirely. That reasoning is specific to the extraction path: a native `json_schema` response and a `json_object` one are raw model text and **are** checkable, and it gets the same completeness test as OpenAI. Without that split the two adapters disagreed about the same response — a complete object followed by trailing prose, cut off at the cap, was returned by one and rejected by the other.

The shared test lives in `lib/orchestration/llm/json-completeness.ts` precisely so the two cannot drift.

**The guards key on `responseFormat.type`, never on truthiness.** `agent.metadata` permits only primitive values (`metadataSchema`), so an agent configured through the admin API stores `metadata.responseFormat` as the **string** `"json_object"`, which `streaming-handler` forwards unvalidated. A guard testing `!!options.responseFormat` arms itself on that string — and since `buildBaseParams` keys on `.type`, nothing is sent to the API, the model returns ordinary prose, and every capped turn becomes a hard error that wipes the user's streamed text via `content_reset`. Both adapters test the discriminant, and there are regression tests for the bare-string case on each.

The second rule covered `json_schema` only until #594, which meant the orchestrator's planner — it requests `json_object` — sailed through with partial JSON, failed `JSON.parse`, spent a clarifying retry into the same cap, and surfaced as `planner_parse_failed` with `retriable: true`. A caller asking for `json_object` wants parseable JSON just as much as one supplying a schema, and truncated JSON is unusable under either, so the rule now asks the wider question. Because the adapter raises before the caller's parse, that also removes the wasted retry, and `isRequestFault` marks the code non-retriable so the engine does not re-run the step at the same cap. Note the asymmetry in the last column, which is about the FIRST rule: the empty-output check is `chat()`-only, so an ordinary streaming turn that produces nothing before hitting the cap still ends with an empty `done` chunk rather than an error. Every JSON-shaped rule covers both call shapes.

The first rule catches a class of silent corruption unique to reasoning models (gpt-5, o-series, Claude with extended thinking). For these models the `max_completion_tokens` / `max_tokens` cap is shared between **reasoning tokens** and **visible output tokens**; when reasoning consumes the whole budget the SDK returns an empty `content` string. Without this guard the engine would happily store `""` as a "successful" step output and downstream guards/validators would invent confused failures.

The second rule exists because the far more common shape is reasoning eating _most_ of the budget, not all of it: a few hundred tokens of an object arrive, cut off mid-string. Content is non-empty, so the first rule cannot see it — but truncated JSON is not usable at any cap, and left alone it fails the caller's parse and reads as a **schema** violation, sending the operator to fix a schema that was never wrong (#587).

It tests the payload rather than the stop reason alone, so an object that _closed_ just as the cap was reached is returned normally — including one wrapped in a single code fence, matching what `tryParseJson` accepts, because a guard stricter than the parser it protects is its own bug — the caller can use it, and `finishReason: 'length'` still says the model wanted more room. **On Anthropic that test is deliberately absent**: there the extraction payload is rebuilt with `JSON.stringify` from the tool-use block's already-parsed input, so even a truncated one serialises to valid JSON and a parse gate would disable the guard entirely. Anthropic keys on `stop_reason` alone and must keep doing so.

Every one of these messages includes the model id and the current cap, so the operator's first move ("raise maxTokens") is obvious from the trace. The **reasoning-token count** is narrower: only the OpenAI-compatible non-streaming guard has it, because `completion_tokens_details` arrives with the batch response. The streaming guard and the runner's own error do not.

The error is **non-retriable** — retrying with the same cap will hit the same wall. Bump the agent's or step's `maxTokens` to address it (16384 is a reasonable headroom for reasoning-heavy workloads producing structured JSON).

Callers act on that through **`isRequestFault(err)`**, not through `ProviderError.retriable`. The two are easy to confuse and the flag is much broader than it looks: `toProviderError` only sets it when it can read a retriable HTTP status, so a connection reset or a read timeout — no status — arrives as `provider_error` with `retriable: false`. Gating on the flag would stop a workflow step retrying an ordinary network blip and stop a chat turn failing over from a provider whose key had gone stale. `isRequestFault` is a narrow **code** list (`truncated_no_output` today) for failures that are deterministic for the request itself. `streamChat` uses it to end the turn instead of failing over; `llm_call`, `chat_turn` and `agent_call` use it to mark the `ExecutorError` non-retriable.

Each guard also attaches **`ProviderError.usage`** — the tokens the provider billed before it gave up. A truncation is a full cap's worth of output, so losing it under-reports the most expensive turn shape there is; `streamChat` cost-logs from it and `runStructuredCompletion` folds it into its returned totals.

Short-but-non-empty responses that hit the cap are **not** flagged **outside** structured extraction — the visible content is meaningful, and we surface `finishReason: 'length'` so callers that care (e.g. continuation flows) can detect it. A turn that carries tools is treated as ordinary even with a `responseFormat` set: a `length` stop there is the normal partial-output case for the tool loop to handle.

### The runner-level backstop

`runStructuredCompletion` (`lib/orchestration/llm/structured-completion.ts`) repeats the check on the response it gets back, and throws the same `truncated_no_output` code. It is not redundant with the adapters: they can only act on structured extraction they know about, and a caller may be relying on the prompt's prose contract with no `responseSchema` at all, or talking to a provider that ignores one.

A truncation **still gets the retry**, and the error is raised only once both attempts are spent. Two tempting shortcuts are deliberately not taken:

- **"A second call at the same cap cannot succeed."** It can. The retry says "respond ONLY with a JSON object" at temperature 0, which fixes the commonest truncation of all — a chatty model spending the budget introducing its answer before starting the JSON.
- **"Skip the retry when a `responseSchema` was supplied, since the output was constrained."** `responseSchema` records what was **sent**, not what the server **honoured**, and `OpenAiCompatibleProvider` explicitly targets hosts that ignore it (Ollama, LM Studio, vLLM, older gateways). Using it as a proxy hard-fails calls the retry would have recovered. One wasted call on the doomed case is the cheaper error.

(And not because the retry appends a message: `max_tokens` / `max_completion_tokens` bound the **completion** on both providers, so a longer prompt does not shrink the output budget.)

Because the adapters raise `truncated_no_output` before returning, the runner treats that throw on a first attempt as identical to a `'length'` finish it noticed itself — it is caught, the retry runs, and only a second truncation ends the call. Either route keeps the first attempt's tokens: the adapters attach `ProviderError.usage` when they raise, so the full cap it billed still reaches the totals. The exception is a host that reports no usage at all, where there is nothing to carry.

The caller's `onFinalFailure` hook is deliberately **not** consulted on a truncation, because that hook exists to phrase "the model broke my contract" and on a truncation that premise is false.

`StructuredCompletionResult.finishReason` carries the finish reason of the attempt that produced the value. Check it for `'length'` even on success: a lenient `parse` can accept content that happened to be well-formed where it was cut — a truncated array of results reads as a complete short one. Caveat: on an Anthropic model that takes the extraction tool, a `responseSchema` call can never read `'length'`, because that adapter reports `'stop'` for a structured extraction (having already thrown on the truncating case).

### Reasoning-token observability

For OpenAI reasoning models, `LlmResponse.usage` exposes an optional `reasoningTokens` count — the subset of `outputTokens` consumed by internal reasoning. Captured from `completion.usage.completion_tokens_details.reasoning_tokens`. Useful when tuning `maxTokens` for a new agent or diagnosing the truncation guard above. Undefined for non-reasoning models and providers that don't report the breakdown.

### Reasoning-effort knob

`LlmOptions.reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'` (the list is `REASONING_EFFORTS` in `types.ts`) controls how much reasoning the model does before producing visible output. Set per-agent via `AiAgent.reasoningEffort` (Model tab on the agent form). Per-provider mapping:

| Provider class      | When honoured                                                                               | Wire mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai-compatible` | Resolved `paramProfile === 'openai-reasoning'` (gpt-5, o-series)                            | Sends `reasoning_effort: <value>`, with `xhigh` / `max` clamped to `high` by `openAiReasoningEffort()` (OpenAI takes them on some models only and publishes no per-id list) — filtered through `supportedReasoningEfforts(modelId, provider)` first. o-series models reject `'minimal'` (the bucket gpt-5 added), so picking `'minimal'` on `o3-mini` drops the field silently rather than 400. Caller intent is still on the trace's `requestParams.reasoningEffort`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `anthropic`         | Claude Opus 4+, Sonnet 4.5+, Haiku 4.5+, Fable and Mythos (per `supportsReasoningEffort()`) | **Opus 4.7+ / Sonnet 5+ / Haiku 5+ / Fable / Mythos** (where `acceptsThinkingBudget()` is false — they 400 on `budget_tokens`): `low` / `medium` / `high` / `xhigh` / `max` → `thinking: { type: 'adaptive', display: 'summarized' }` (Opus 4.7+ otherwise defaults `display` to `'omitted'`, which leaves the thinking text empty and gives the stream no `reasoning` chunks) plus `output_config: { effort: <same name> }` (all five are accepted by every adaptive model); `minimal` → `output_config: { effort: 'low' }` and no `thinking` field, because Opus 5.5 and Sonnet 5.5 can't turn thinking off. **Opus 4.0–4.6 / Sonnet 4.x / Haiku 4.5:** `minimal` → no thinking. `low` / `medium` / `high` / `xhigh` / `max` → `thinking: { type: 'enabled', budget_tokens: 1024 / 4096 / 16384 / 32768 / 65536 }`. Budget is clamped to `min(requested, max_tokens − 1024)` so visible output always has ≥ 1024 tokens of room. **Anthropic API requires `budget_tokens ≥ 1024`**, so the provider drops thinking entirely when `max_tokens < 2048` (no way to fit the minimum budget alongside the visible-output floor). Temperature is omitted when thinking is enabled (Anthropic locks it to default). |
| Any other           | —                                                                                           | Field dropped silently. No 400. Caller intent still recorded on the trace's `LlmRequestParamsSnapshot.reasoningEffort`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

The model-registry resolution path is the same as `paramProfile`: DB-backed `AiProviderModel.paramProfile` is authoritative; when null, `deriveParamProfile()` derives a fallback. `supportsReasoningEffort()` then layers the per-model thinking-capability check on top (id-pattern match for the Claude thinking families).

**Thinking blocks in a tool loop.** With thinking on, Anthropic requires the assistant turn's `thinking` / `redacted_thinking` blocks back unchanged, signatures included, on the request that continues it. The provider returns them as `LlmResponse.reasoning` (and on the stream's `done` chunk, assembled from `thinking_delta` / `signature_delta`); the chat tool loop and `agent_call` put them on the assistant message they append (`LlmMessage.reasoning`), and `splitSystemMessages` sends them ahead of that turn's text and `tool_use` blocks. They are not persisted on chat messages: a later user turn rebuilds history from the database without them, which is allowed because dropping every earlier thinking block is not an edit the API rejects. An `openingTurn` after a trailing tool-call row would be the exception, so `splitSystemMessages` sends a `turnInstruction` system message as a user turn and on a thinking request first turns a trailing tool call that carries no thinking into a text note (see `.context/orchestration/chat.md`, "`openingTurn`"). `agent_call` keeps them on its checkpoint turn so a resumed tool loop can replay them; they stay on the running-step row (which outlives the step only while it is paused for approval or still running) and are left out of `executionTrace` and of the org export's `workflowRunningSteps`. A malformed stored value fails the checkpoint parse, so the resume logs it and starts the step fresh rather than replaying the turn without its thinking. Other providers ignore the field.

Anthropic thinking blocks are stripped from response content in both `chat()` and `chatStream()` — callers see only the final answer. Exposing the thinking trail to callers is intentionally out of scope; it's a richer integration than this knob warrants.

## Configuration

`AiProviderConfig` rows (see `prisma/schema/`) drive the provider manager. Fields used here:

| Field          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `slug`         | Primary lookup key for `getProvider`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `name`         | Fallback lookup key; human label                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `providerType` | `'anthropic' \| 'openai-compatible'` — dispatch key                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `baseUrl`      | Required for `openai-compatible`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apiKeyEnvVar` | Name of the `process.env` var holding the key                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `isLocal`      | Shorter timeouts, no 5xx retries, allows empty API key. **Means the provider runs on infrastructure the operator controls**: it also exempts the provider from spend caps, from the LLM privacy layer's `local_only` embeddings refusal, and, while `privacyProtectLocalProviders` is off (its default), from the privacy layer altogether. A vendor's API marked local would receive personal data unprotected. See [Running a local embedding model](./knowledge.md#running-a-local-embedding-model) |
| `isActive`     | `false` → `getProvider` throws `provider_disabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `timeoutMs`    | Per-provider timeout override (1,000–300,000 ms). Resolution: `timeoutMs` → `LOCAL_TIMEOUT_MS` (if local) → `DEFAULT_TIMEOUT_MS`                                                                                                                                                                                                                                                                                                                                                                       |
| `maxRetries`   | Per-provider retry override (0–10). Passed to the SDK constructor                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `jurisdiction` | Where the vendor processes data (`EU`, `US`, …), upper-cased; nullable. Read by the per-org provider policy below                                                                                                                                                                                                                                                                                                                                                                                      |

## Provider credentials (fork seam)

By default a provider row's API key is the environment variable it names
(`apiKeyEnvVar`). A fork that keeps keys in a gateway, behind a vault reference
or behind workload federation, or that gives each org its own key, registers a
resolver from the fork-owned `lib/app/provider-credentials.ts` (§120 t-744):

```typescript
import { registerProviderCredentialResolver } from '@/lib/orchestration/llm/provider-credentials';

export function initAppProviderCredentials(): void {
  registerProviderCredentialResolver(async (config, { orgId }) => {
    // Local rows are asked too, and usually need no key.
    if (config.isLocal) return { apiKey: undefined, identity: '' };
    const key = await vault.read(`llm/${orgId}/${config.slug}`); // cache this
    return { apiKey: key, identity: `org:${orgId}` };
  });
}
```

The resolver is asked when a provider is fetched; the key builds a client held
in memory for the instance cache's TTL. Sunrise writes what a resolver returns
nowhere. It stores a tenant's own key only when the install switches on
[organisations' own keys](#organisations-own-keys), and that lookup comes
**before** your resolver: at `multi`, an org that has saved a key for the row
never reaches it while the key is in use.

| Property                  | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Default**               | Nothing registered: `process.env[config.apiKeyEnvVar]`, identity `''`. Byte-identical to before the seam.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **When it runs**          | Every `getProvider` — every chat turn, workflow step and embedding batch — in the caller's async context, so `orgId` is the org the call acts for (the install org at `single`; `null` at `multi` outside an org scope, where the call-time gate refuses the call anyway). Cache whatever the resolver looks up.                                                                                                                                                                                                                                                                                        |
| **The identity**          | A stable, non-secret name for the credential. The client cache, the circuit breakers and the in-flight counter key on `credentialKey(slug, identity)` (`credential-key.ts`): the bare slug for `''`, `slug#identity` otherwise. Different keys need different identities, or two orgs share one client and one key.                                                                                                                                                                                                                                                                                     |
| **Reachability**          | Auto-pick, the agent form's preview, the clean-up agent's pin and the admin model routes ask `hasProviderCredential` rather than reading the env var, so a fork whose keys are not in the environment still has reachable providers. The resolver is asked about every row, local ones included: a local row needs no key, but one the resolver throws for is unreachable, because `getProvider` would fail on it.                                                                                                                                                                                      |
| **Breakers, admin views** | Every path that picks a provider — `getProviderWithFallbacks`, the audio matrix walk, chat's mid-stream failover — fetches it through `getProviderIfBreakerClosed`, which checks the credential's breaker and skips to the next candidate when it is open. `getBreaker` takes `breakerKeyOf(provider)` / `getProviderWithFallbacks().breakerKey`, so one org's failing key does not pause another's. The admin provider list and health route show the worst breaker across a provider's credentials, and a reset resets all of them. The live-engine dashboard lists in-flight counts by the same key. |
| **On a resolver throw**   | The provider is unavailable for that call (`ProviderError`, `credential_unavailable`). **No fallback to the env var**: a fork that moved keys out of the environment did not mean the environment's key, possibly the platform's own, to be used for its orgs. `filterProvidersWithCredential` leaves such a row out. `classifyProvidersByCredential` returns it separately, with its error (t-819), so a caller that records its answer — a platform agent's binding pick — can tell "no key" from "could not ask". The clean-up pick waits only when such a row would have won.                       |
| **On an init throw**      | Rolled back and logged by the shared gate (`fork-init-seams.md`), then every credential is refused until it is fixed, for the same reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Registrar entries**     | `registerProvider` / `registerProviderInstance` carry their own key and bypass the resolver, on the shared identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Organisations' own keys

At `TENANCY_MODE=multi` an org can send its calls on its own vendor account
(§137 t-1044): it saves its own key for a provider row, and while the
install's switch is on, its calls on that row go out with that key. The vendor
bills the org, and the org's own agreement with the vendor applies. Every
other org is unaffected.

| Part             | Where                                                                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The switch**   | `AiOrchestrationSettings.orgProviderKeysEnabled`, off by default, set on Settings → "Organisations' own AI keys" (shown at `multi` only) or `PATCH /settings`. Turning it on is refused while no sealed-secret master key is configured. Platform admins only. |
| **The keys**     | `AiOrgProviderKey`: one per org per provider row, tenant-owned (isolated by `org_isolation`), sealed with `sealSecret()` for `org-provider-key:<orgId>:<providerConfigId>`.                                                                                    |
| **The lookup**   | `resolveOrgProviderKey()` in `lib/orchestration/llm/org-provider-keys.ts`, asked by `resolveProviderCredential()` ahead of the app's resolver, for an org in scope at `multi`. Nothing is read at `single`.                                                    |
| **Saving a key** | `saveOrgProviderKey()` / `removeOrgProviderKey()`, for the org in scope. They check neither the switch nor the approval: both are checked when the key is used. The org's page and API (below) check both before a save.                                       |
| **Master key**   | `.context/security/sealed-secrets.md`. Orgs' keys are core's sealed store `org-provider-keys`, so `npm run secrets:reseal` moves them onto a new master key.                                                                                                   |

**An org with a key is never moved to another key.** Once an org has saved a
key for a row, that row's calls for it go out on that key or are refused with
`credential_unavailable`. They are never sent on the install's key or handed
to your resolver:

| The org's key…                                                     | Answer                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| is usable                                                          | the key, identity `org-key:<orgId>:<keyRowId>:<version>`         |
| exists, and the switch is off                                      | refused: `switched_off`                                          |
| is for a provider the org isn't approved for                       | refused: `not_approved`. Saving a key never approves a provider. |
| will not open (master key gone, or the envelope is not this org's) | refused: `will_not_open`                                         |
| could not be looked up                                             | refused: `lookup_failed`                                         |
| does not exist                                                     | resolves as before: your resolver, or the env var                |

Each refusal is logged with its reason and a fix, never the key, at most once a minute per org, row and reason: the lookup also runs on every reachability check. An org with its own key is not skipped when the install key's breaker opens; its breaker is its own.
Removing its key is how an org returns to the install's key. A permanent delete of a provider row is refused while any org holds a key for it, since the cascade would silently take the keys with it. Turning the
switch off with keys saved refuses those orgs until it is back on; the
settings page says how many orgs that is before it is saved. Config Health
flags the switch on with no master key configured.

**The identity changes whenever the key does.** `version` rises on every save
over an existing key, and a key removed and saved again gets a new row id, so
the client cache, the breaker and the in-flight counter never serve a
replaced key, even inside the client cache's five minutes.

**Freshness.** The lookup is cached for 60 seconds per org and row
(`ORG_PROVIDER_KEY_TTL_MS`), because it runs on every fetch and every
reachability check. A save or removal through the module clears this
process's entry, so the next fetch in the writing process uses the new key or
the install's. In **another** process a removed or replaced key may still be
used for up to 60 seconds, and a new one not yet used; the switch itself
reaches another process within the settings cache's 30 seconds. A write that
does not go through the module must call `forgetOrgProviderKey()`.

**Never select `sealedKey`** outside the module. Readers that are not the call
path use `ORG_PROVIDER_KEY_SUMMARY_SELECT` (or `omit: { sealedKey: true }`), as
the org export does. The key is in no backup, no log line and no response.

### The org's page and API (§137 t-1045)

An org's OWNER or ADMIN manages its keys on **AI keys** (`/admin/provider-keys`,
org-tier, shown at `multi` only) over `/api/v1/orgs/[id]/provider-keys`:

| Verb                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /provider-keys`                           | Every active provider the org is approved for that takes a key (not a local one), and every provider it holds a key for, whatever has become of the row since. Each provider: `approved`, and `takesKey` (active and not local: false only for a keyed row kept so its key can be removed). Each key: `hint` (last four characters, `''` under 16), `version`, `savedAt`, `savedBy`, and `state`: `in_use`, `provider_off` (the row is inactive), `switched_off`, `not_approved` or `will_not_open`. Plus `saveBlocked` (`switched_off`, `master_key_missing`, `support_session` or `null`) and `readOnly` (a READ_ONLY support session, which can change nothing). |
| `PUT /provider-keys/[providerId]` `{ apiKey }` | Save, or replace the saved key. Tests the key first with a call the vendor authenticates (`testProviderKey()`, below), on a client built for that call and never cached. A key that fails is not stored: 422 `KEY_TEST_FAILED`. 201 for a first key, 200 for a replacement.                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /provider-keys/[providerId]/test`        | Re-test the saved key: `{ ok, reason? }`, with `reason` `test_failed` or `will_not_open`. Runs while the switch is off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DELETE /provider-keys/[providerId]`           | Remove the saved key. The org's calls go back to the install's key, if it is approved for the provider. 404 with no key; 409 `key_changed` when the key was replaced while it was being removed (the new key is left).                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Who.** The authorization policy decides, about the resource
`{ kind: 'org.providerKeys', id, orgId }`: the default policy admits the org's
OWNER and ADMIN while they act in it. A fork that wants another role to manage
keys answers that kind in its own policy (`canRead`'s `unattributed` arm), and
the routes follow. Four rules sit on top of any policy: the install must be at
`multi` (409 `single_tenant`: no org's key is used at `single`); the caller must be
**acting in the org** (the default policy admits a platform admin to every org;
here that is their own org only, and they reach a customer's keys through a
support session); a **browser session**; and **not the install org**, which
runs on the install's keys (409 `install_org`). A **support session** can read,
test and remove, but cannot save or replace a key (403): the vendor's staff do
not handle a customer's secret. A READ_ONLY grant refuses test and remove, as
it does every write.

**Save is refused** while the switch is off (409 `switched_off`: the key would
refuse every one of the org's calls), for a provider the org is not approved
for (409 `not_approved`, before any vendor call), for an inactive or local
provider (404), and with no master key (409 `master_key_missing`), each
before any vendor call. Test is refused the same way for a provider the org is
not approved for, or an inactive one; remove never is. Surrounding whitespace from a paste is trimmed; anything inside the key that is
not printable ASCII (a space, a line break, a zero-width space) is refused (400).
Two first saves at once both succeed: the later replaces the earlier.

**What the test proves (t-1056).** That the vendor accepted the key, on a call
it authenticates: each provider's `testKey()`, not the connection check the
platform's provider test uses.

| Type              | The call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic         | Its model list (`GET /v1/models`) with the key and with a known-wrong one, together. It proves the key where the list answers the key and fails the wrong one with a 4xx, as Anthropic's does: nothing billed, and no fixed model the key must reach. Anything else (a gateway behind `ANTHROPIC_BASE_URL` with no list, whatever it answers for the route, or a list open to any key; a key the list refuses) falls back to the one-token message the key must pass.                                                                                                                                     |
| Voyage            | One embedding of one word, at the row's host. Billed, a token or two. Voyage has no model list (`GET /v1/models` answers 404 to any key); its embeddings call refuses a wrong key with 401. It passes only on an embeddings answer, so a proxy that answers anything with 200 does not pass a key. The platform's own provider test for a Voyage row makes the same call, so the providers page's check bills a token or two per Voyage row each time it runs; that spend has no cost-log row.                                                                                                            |
| OpenAI-compatible | The model list with the key and with a known-wrong one, together. It proves the key where the list answers the key and fails the wrong one with a 4xx (OpenAI, Mistral 401; Groq 403; Gemini, xAI 400). Anything else (a list open to anyone, as OpenRouter's is; none, as Perplexity has; a body that is not a list; a list that refuses the key, which may only lack the scope to read models) goes on to a chat request no host will run (no model, no messages), sent with each key: 401 or 403 for the key fails it, and any other answer passes it if the wrong key was refused. Nothing is billed. |

Every call, the reading of its answer included, is held to 15 seconds
(`KEY_TEST_TIMEOUT_MS`), and Voyage reads at most 256 KB of its answer.

A host that checks keys on neither call fails the test, with a message saying
so: it cannot tell whether the key works. So does one that does not answer. A
key the host answers exactly as it answers the wrong one is reported that way. A key that passes can still fail
later for reasons the check does not reach, such as a model its account
cannot use or a spending limit at the vendor.

**Rate limit.** `providerKeyTestLimiter` caps saves and tests at 10 a minute per
org each (`RATE_LIMIT_PROVIDER_KEY_TEST`): each one makes vendor calls on the key
(up to four for an OpenAI-compatible host and three for Anthropic, above).
The buckets are separate, so testing (support's, or another admin's) never
uses up the org's chance to replace a leaked key.

**Audit.** Every save (`org_provider_key.save`), replacement
(`org_provider_key.rotate`), test (`org_provider_key.test`, also for a key
that failed during a save, with `stored: false`) and removal
(`org_provider_key.remove`) is a `logAdminAction` row with the provider, the
hint and the result, never the key.

**The key never leaves the server.** The vendor's error from a failed test can
repeat the key, so the browser is told only that the test failed, and the log
line has the whole key cut out. A vendor's own masked echo of it (a prefix and
the last four characters, say) is left in the log: no more than the hint
shows. A database error is logged by its name and code only, since its message
can carry the sealed key.

### What an own-key call costs, and which caps hold it (§137 t-1046)

The vendor bills a call on an org's own key to the org, not to the platform
(owner ruling, 2026-11-18). So:

| Cap or report                                       | An own-key call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The agent's monthly budget** (`monthlyBudgetUsd`) | Counts, and refuses it once reached in a chat turn: in chat's check at the start of a turn and between tool calls, and through the turn's paid-call hold (`PaidCallHold.agentCapReached`) for every call the turn makes. Outside chat (a workflow, an evaluation, a job) the agent's budget is not enforced, as before, so **nothing caps an own-key call made there**: the org pays its vendor for it.                                                                                         |
| **The org's cap** (`settings.quotas`)               | Neither counted nor refused. `getMonthToDateOrgSpend` sums `ownKey: false` rows only, and `logCost` adds no own-key row to the running total.                                                                                                                                                                                                                                                                                                                                                   |
| **The global cap**                                  | Neither counted nor refused (`globalSpendSince` sums `ownKey: false` rows only).                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Cost reports**                                    | The row is marked `AiCostLog.ownKey`. Every total still includes it, and says how much of it was on own keys: the summary's `ownKey`, each trend point's and each `GET /costs` row's `ownKeyCostUsd`, each model row's `ownKeyMonthSpend` (t-1058), and the org usage's `ownKeyCostUsd`. The costs page, the dashboard, the per-org table and the org page show the platform's spend, with own-key spend apart. The summary's per-agent rows keep it with no split, as the agent's budget does. |

The gate (`assertWithinSpendCaps(slug, isLocal, { ownKey })`) and provider
selection (`spendCapRefusal(..., { ownKey })`) are told by the provider
manager: `usesOrgOwnKey(provider)` for a provider `getProvider` returned, and
`providerUsesOrgOwnKey(slug)` before one is fetched, as chat asks at the start
of a turn. With a cap reached, chat holds the turn's paid calls and, once
confidential routing has said where the turn goes, asks the gate
(`spendCapRefusal(..., { quiet: true })`, so the ask is not logged as a
refused call) about the provider it is bound for (t-1057): the agent's,
or the model for confidential messages it was moved to. The turn is answered
if that provider is local, or on the org's own key with the agent's cap not
reached. Otherwise it is refused before anything is saved or sent, naming the
agent's cap when the provider was on the org's own key. A fallback is not
asked: chat sends whichever provider serves the turn the bound model's id,
which a local model or another vendor does not serve, so a turn let in on a
fallback would fail after its message was saved. Any call the turn makes
on the platform's keys (a fallback, the summarizer, an embedding on another
row) meets the org's and the global caps at the gate. Only
core's own store makes a key the org's own: whatever a registered resolver
returns is the platform's, since nothing says whose account it bills.

**How a cost row is marked.** The caller that writes a call's cost row says
which key the call used: `logCost({ ..., ownKey: usesOrgOwnKey(provider) })`,
for the provider the call was made on. Omitted, the row is the platform's.
`tests/unit/lib/orchestration/llm/cost-log-own-key.test.ts` holds every
`logCost` call in the tree to a roster, so a new one fails until it passes
`ownKey` or says why it makes no vendor call (a capability's own cost, a
channel send, a marker row). A chat turn's rows ask the provider serving the
turn, which moves on a failover; its attachment row asks the provider the turn
picked, which it is billed with. A batched embedding run writes one row, marked only
if every batch went out on the org's own key. **A fork's own `logCost` calls**
are not on the roster: pass `ownKey` from the provider you called, or the
org's own spend counts against the platform's caps.

## Per-org approved providers (core, at `multi`)

At `TENANCY_MODE=multi` core holds each org to the providers it has been
approved for (§120 t-742; design Q15, owner ruling 2026-09-30):

- **The install org may use every provider.** It has no set, and a `PUT`
  naming it is refused.
- **Every other org may use only the providers in its approved set**, which
  starts empty: a new org can call no provider until a platform admin grants
  one.
- **An org may also be held to jurisdictions.** A provider is then permitted
  only if its `jurisdiction` is one of them. A provider with no jurisdiction
  recorded matches no restriction: an org held to the EU is not sent to a
  provider nobody has said is in the EU.

At `single` none of this runs: nothing is read and nothing is filtered.

The set lives in the org's `settings.providers` slice
(`lib/tenancy/org-settings.ts`) as `{ approved: string[], jurisdictions?: string[] }`,
where `approved` holds provider **row ids**. Providers stay global (design Q3),
so it is a permission over the operator's provider rows, not a list of the
org's own. A platform admin reads and replaces it through the API, naming
providers by slug:

| Route                                   | Body / response                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/admin/orgs/[id]/providers` | `{ orgId, unrestricted, enforced, approved, jurisdictions }`, with each grant in `approved` as `{ id, slug }` (`slug` is `null` if the row was deleted). `unrestricted` is true for the install org; `enforced` is whether the install is at `multi`.                                                                                                                                                                                                                                                 |
| `PUT /api/v1/admin/orgs/[id]/providers` | `{ approved: string[], jurisdictions: string[] \| null }` replaces the whole policy, and `jurisdictions` is required (`null` lifts the restriction), so a replace that only adds a provider cannot lift it by omission; `[]` revokes every grant. An unknown slug is a 400 naming it (`details.unknownProviders`); a clash with a concurrent write to the org's settings is a 409 `CONFLICT`, and nothing is written. Each replace writes an `org.providers.replace` audit row with before and after. |

Both are platform-admin only (`withAdminAuth`). Org admins do not administer
providers: they are platform-ops configuration.

**In the admin UI** (§120 t-745): a platform admin edits the set on the org's
page, `/admin/orgs/[id]` (Management → Organisations), which says when the
policy is not enforced (`single`) and that the install org is unrestricted.
The agent form offers a provider the org is not approved for disabled, with
the reason, as primary and as fallback — unless the agent already holds it.
An agent stranded by a later change shows a "Not approved" badge in the agents
list and a banner on its edit page. The data comes from the list endpoints:
`approvedForOrg` on each row of `GET /providers`, and `_unapprovedProviders`
on each agent from `GET /agents` and `GET /agents/:id` (`null` when that is
unknown — no org in scope, or a policy that could not be read; a read is
decorated, never failed, by it).

How it is applied:

| Property              | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Where**             | Inside `resolveEligibleProviders`, so in every selection site and in the call-time gate on every vendor call. An auto-picked primary, an explicit `agent.provider`, either fallback list and every embedding or audio arm are all held to it.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Composition**       | Core's rule runs first; a fork's registered rule is handed only what it permitted, and its answer is intersected with that. A fork rule can narrow the org's set and never widen it, the floor-not-ceiling shape of the `admin` key scope (Q6).                                                                                                                                                                                                                                                                                                                                                                                                       |
| **The org**           | Read from tenant context, as the gate already does. `ProviderEligibilityContext` does not carry an `orgId`. No org in context at `multi` (none entered, or `runAsSystem`) permits nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Unreadable policy** | Fails closed. A malformed slice is read as approving nothing, with a warning. A policy that cannot be loaded denies every candidate, logged as `org provider policy could not be read`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Freshness**         | Each org's policy and each provider's jurisdiction are cached for 60 seconds. A `PUT` clears that org's entry in the process that served it, and any provider-row write clears the jurisdiction (via the provider manager's `clearCache`). Another process may answer from a revoked grant for up to 60 seconds.                                                                                                                                                                                                                                                                                                                                      |
| **Renamed provider**  | A grant names the row's id, resolved from the slug at `PUT`. Renaming a provider keeps its grants; deleting one and creating another under its slug does not hand the new row the old one's grants. The policy caches which row a slug names for 60 seconds, so a delete-and-recreate made in another process, or by a seed, can be judged against the old row for up to that long. A grant for a deleted row is inert. A provider registered in code (`registerProvider`) has no row, cannot be granted, and at `multi` serves the install org only. A candidate given by provider name is judged by the row it names, as `getProvider` resolves it. |

## Provider eligibility (fork seam)

`resolveAgentProviderAndModel` attaches up to **three** other configured
providers as automatic fallbacks whenever an agent has no explicit
`fallbackProviders` list. On a single-tenant install that is a helpful default.
On a shared one it is a leak: an org's prompts can reach a provider that org
never approved, and nobody asked for any of them.

`registerProviderEligibility` (`lib/orchestration/llm/provider-eligibility.ts`),
registered from the fork-owned `lib/app/llm-providers.ts`, constrains every
provider Sunrise picks on a caller's behalf — the auto-picked primary, both
fallback lists, and the task-default model's provider on the two paths that
read the model registry directly:

```typescript
import { registerProviderEligibility } from '@/lib/orchestration/llm/provider-eligibility';

export function registerAppProviderEligibility(): void {
  registerProviderEligibility(async (candidates, ctx) => {
    const approved = await approvedProviderSlugs(); // cache this
    // Filter EVERY source. A rule that answers for only some of them is
    // fail-open for the rest, and `'primary'` matters most: a provider-less
    // agent (the four system-seeded ones ship that way) would otherwise reach
    // whichever provider sorts first while the policy looks enforced.
    return candidates.filter((slug) => approved.has(slug));
  });
}
```

| Property                 | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Default**              | At `single`, no resolver registered → `candidates` returned unchanged. Single-tenant behaviour is byte-identical; there is no dormant second code path. At `multi` core's per-org rule (above) applies first, and a registered rule narrows what it permitted.                                                                                                                                                                                                                                                                                                                                               |
| **Applied at**           | Every vendor call through the provider manager, by the call-time gate (above). And, so that Sunrise chooses well, at the selection sites: both of the resolver's return paths — the early exit for a fully-configured agent AND the candidates path — plus the five paths that never reach the resolver. See the coverage table below.                                                                                                                                                                                                                                                                       |
| **`ctx.source`**         | `'primary'` when Sunrise is CHOOSING the provider — the agent left it blank, or a workflow step / enrichment run has no explicit model — `'system'` for the automatic fallback fill, `'explicit'` for an operator's recorded choice: the agent's own fallback list at selection, and at the gate also an explicit primary (`agent.provider`, a step `modelOverride`, a pinned default). A fork may answer differently for each.                                                                                                                                                                              |
| **No eligible provider** | Fail-closed everywhere, in each path's own vocabulary: `NoEligibleProviderError` (`code: no_eligible_provider`) from the resolver, `ExecutorError` (`code: provider_not_permitted`, non-retriable) from a workflow step, `ProviderNotPermittedError` → 403 from keyword enrichment, and `ProviderCallRefusedError` (`code: provider_not_permitted`) from the gate on any call. All distinct from `NoProviderConfiguredError`, which means "nothing is set up" and sends an operator to the setup wizard — a different fix in a different place.                                                              |
| **Cannot widen**         | The result is intersected with `candidates` and returned in the resolver's order — fallbacks are tried in sequence, so order is load-bearing and does not come from the rule.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **On throw**             | Logged as an error and treated as "nothing is eligible" — a restriction that cannot be evaluated must not be read as permission. An agent that names its provider keeps working and loses only its fallbacks; one that does not gets `NoEligibleProviderError`. A caller that records the answer rather than acting on it — a platform agent's binding pick — passes `onFailure: 'throw'` (t-819): a resolver throw, a failed registrar or an unreadable policy then throws `ProviderSeamUnavailableError` (cause attached, nothing logged), so the caller can leave its last answer in place and ask again. |

**Within the agent-binding resolver it filters every choice Sunrise makes on
the caller's behalf — the auto-picked primary and both fallback lists — but
never an explicit `agent.provider`.** That is an operator's recorded decision,
and silently rerouting it would make an agent answer from a provider its own
configuration does not name: harder to diagnose than a refusal, and a worse
failure than the one being prevented. The call-time gate does not reroute it
either. It refuses the call, which is the difference.

The enforcement for an explicit choice is at the point of **choosing**, and at
`multi` it is in place for every route that saves one (§120 t-743):

| Write                                                                                 | At `multi`, naming a provider the org is not approved for                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent create, update, clone, version restore                                          | **Refused**, 400 `VALIDATION_ERROR`, `details.unapprovedProviders` and a per-field `details.errors` entry                                                                                                             |
| Agent bundle import, backup import                                                    | **Imported, with a warning** naming the agent and providers — skipping would drop what other rows reference                                                                                                           |
| Workflow step `modelOverride` (create, save-as-template, publish, rollback, validate) | **Refused**, semantic error `PROVIDER_NOT_APPROVED`; publish and rollback only for a provider the new version introduces. Not at execution or dry-run, where the gate refuses the step and its error strategy applies |
| Workflows in a backup import                                                          | **Imported, with a warning** naming the steps                                                                                                                                                                         |

Only what a write **introduces** is checked: a provider an agent already holds,
as primary or fallback, is not re-checked, so an agent stranded by a later policy change can still be
edited. The check is core's org policy (`unapprovedProviders` in
`org-provider-policy.ts`), not a fork's eligibility rule, which answers per
call and may depend on a backend a save should not wait on. At `single`, and
for the install org, nothing is refused.

**Both layers are needed** — write-time validation cannot reach agents
configured while a provider was permitted and stranded when the policy later
changed, and it does not see writes that bypass the routes (seeds, the
platform-agent reconcile, direct database writes). The call-time gate is the
runtime backstop for those.

### Per-path coverage: where Sunrise chooses

This table is about **choosing well**, not about where data can go. The
security boundary for core is the call-time gate: every vendor call through the
provider manager is refused when the rule says no, whatever this table says
about the site that chose the provider — including the rows marked **No**, which
are the operator's own choices and are refused rather than rerouted. What the
table records is the earlier, softer layer: where Sunrise consults the rule
while CHOOSING, so it picks a permitted provider instead of picking one and
having the gate refuse it.

The rule is consulted while choosing at **six** places: the agent-binding
resolver, and the five paths that never reach it and call `isProviderEligible`
directly (`llm-runner.ts`, `keyword-enricher.ts`, the retroactive-review route,
audio resolution in `provider-manager.ts`, and the embedding fallback chain in
`knowledge/embedder.ts`). The list is derived by hand and was short every one of
the three times anyone checked it — the t-656 review named four paths and missed
two; a `grep getProvider(` found those two and missed the embedder; a
`grep getDefaultModelForTask(` found the embedder. That is why the boundary moved
to the gate (§120 t-741): a site missing from this table now chooses less well,
and still cannot send a call the rule refuses.

The limit on all of it is the one in **What the outbound-egress guarantee
covers**: code that constructs a provider class itself.

| Path                                                                                                                                                  | Resolves via                                                                                                                                             | Covered?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat turns, `chat_turn` / `agent_call` steps, evaluation completion                                                                                   | `resolveAgentProviderAndModel`                                                                                                                           | **Yes**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A workflow step's `modelOverride` (`llm_call`, `route`, `evaluate`, `reflect`, `guard`, `supervisor`, `orchestrator`)                                 | `getModel(override).provider` in `llm-runner.ts`                                                                                                         | **No** at selection — an override is an operator's recorded choice in the workflow definition, the same category as an explicit `agent.provider`, and is not rerouted. The call-time gate refuses one the rule refuses (`source: 'explicit'`), with the same `ExecutorError` code, `provider_not_permitted`, non-retriable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The same steps with NO override                                                                                                                       | `getDefaultModelPinForTask('chat')` in `llm-runner.ts`                                                                                                   | **Yes** — `source: 'primary'`. Refused with `ExecutorError` code `provider_not_permitted`, non-retriable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Knowledge keyword enrichment                                                                                                                          | `getModel(...).provider` in `keyword-enricher.ts`                                                                                                        | **Yes** — `source: 'primary'`. Refused with `ProviderNotPermittedError` before any chunk is read; the admin route answers 403 / `provider_not_permitted`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Retroactive execution review, when the request sets no `modelOverride` **and** neither `EVALUATION_JUDGE_MODEL` nor `EVALUATION_DEFAULT_MODEL` is set | `getDefaultModelForTask('chat')` in `executions/[id]/review/route.ts`                                                                                    | **Yes** — `source: 'primary'`. Answers 403 / `provider_not_permitted` before the judge runs, so the execution's step outputs never reach the barred provider.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A review request's own `modelOverride`, or `EVALUATION_JUDGE_MODEL` / `EVALUATION_DEFAULT_MODEL`                                                      | the same line, first two arms — `JUDGE_MODEL` in `evaluations/judge-model.ts` falls back to `EVALUATION_DEFAULT_MODEL`, so setting either takes this row | **No** at selection — both are an operator's recorded choice. The call-time gate refuses one the rule refuses, and the route answers the same 403 / `provider_not_permitted` as the task-default arm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Audio transcription's matrix fallback, when no default is pinned or the pinned row is unreachable                                                     | `tryAudioRow(row, 'matrix_fallback')` in `provider-manager.ts`                                                                                           | **Yes** — `source: 'primary'`, `task: 'audio'`. A barred row is skipped like any other unusable row and the loop tries the next; if none is permitted, `getAudioProvider()` returns `null` and speech-to-text is unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| An operator's pinned audio default                                                                                                                    | `tryAudioRow(row, 'operator_default')` in `provider-manager.ts`                                                                                          | **Yes**, as `source: 'explicit'`. A refused pin is treated like an unreachable one: `tryAudioRow` returns `null` and the matrix rows are tried, each asked as `'primary'`. Left to the call-time gate, a refused pin resolved, `transcribe()` was refused, and a permitted row further down was never reached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Knowledge embedding, whenever `resolveActiveEmbeddingConfig()` returns `null` — no pin, **or** a pin that no longer resolves                          | the Voyage → openai-compatible chain in `knowledge/embedder.ts` (never a local row, t-1011)                                                              | **Yes** — `source: 'primary'`, `task: 'embeddings'`. A refused arm is skipped and the chain tries the next, the audio loop's shape. Every arm is a provider row: the bare-`OPENAI_API_KEY` arm and its `env:openai` slug were retired in t-740. If everything available is refused the call fails with a message distinct from "nothing is configured". The call itself goes through the Proxy — see _The embedder chooses; the provider manager calls_ below.                                                                                                                                                                                                                                                                                                                                                                       |
| An operator's pinned `activeEmbeddingModelId`, **while it still resolves**                                                                            | `resolveActiveEmbeddingConfig()` in `knowledge/embedder.ts`                                                                                              | **No** — an operator's recorded choice. But the pin is not sticky: it drops through to the gap row above on **five** conditions — the model is missing or inactive, lacks the `embedding` capability, has no `dimensions`, has no active `AiProviderConfig`, or is non-Voyage with no `baseUrl`. Each of those five drop-throughs is logged at `warn` inside `resolveActiveEmbeddingConfig`, which is where the transition happens and is visible at production's default `INFO` level. The arm the chain then lands on is `debug` — per-call provenance, fired once per search query and once per chat message on any unpinned install, so it is not the place to carry a transition signal.                                                                                                                                        |
| `provider.testConnection()` / `provider.listModels()`                                                                                                 | admin provider routes                                                                                                                                    | **No, and not gated at call time either** — they reach the vendor but send no prompt or document text. Out of scope because every caller is an admin acting on platform-level provider configuration — but note `providers/test-bulk` pings **every** configured row rather than one an admin named, so the justification is "operator-initiated", not "operator-named". The admin **Test model** action is different: it calls `chat` / `embedMany` / `transcribe`, which are gated as an explicit choice, and runs those calls as the install org whichever org the admin is acting in. The provider itself is fetched in the admin's own context, so a fork's per-org credential is the one tested. The probe carries no org data, and at `multi` a platform admin must be able to test a provider before granting it to any org. |
| `provider.transcribeStream()`                                                                                                                         | `streamTranscription` in `llm/transcribe-stream.ts` — which has **no production caller**; both voice routes call `provider.transcribe()`                 | **Not a provider _choice_ at all** — by the time it is called the provider is resolved, so there is nothing here for the eligibility seam to filter. It is now `trackStream` in the disposition map, so it is counted and interceptable like `chatStream`. An earlier version of this row said it was "from the voice path" and carried user audio today: it does not.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `EVALUATION_DEFAULT_PROVIDER` / `_MODEL`                                                                                                              | env vars read in `complete-session.ts`                                                                                                                   | **No** — an operator pinned these deliberately; environment is trusted operator configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

#### The second chokepoint, and why each path refuses differently

The five non-resolver rows share a shape: Sunrise picks a model (or a matrix
row, or an arm of a preference chain) and uses whatever provider it names,
without passing through the resolver. They call `isProviderEligible(slug, ctx)`
— the single-candidate form of the same rule, with the same fail-closed
semantics — because there is no list to filter: one provider is named at a time.
The audio loop and the embedding chain are the two that do have somewhere to
fall through to, and both use the same answer for a denial as for any other
unusable candidate: skip it, try the next.

They all reuse **`source: 'primary'`** rather than introducing a fourth value,
and that is deliberate. An unanswered `source` fails open, so a new value would mean
every rule already written in a fork silently does not cover the paths it was
added for. Reusing `'primary'` extends an existing rule to them for free, and
the category is honestly the same one: Sunrise chose, nobody's intent is being
overridden.

What they do **not** share is the refusal, because the events are not alike:

| Path                | Refusal                                                                                                 | Retriable?                                                                                           | Where it surfaces                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow step       | `ExecutorError`, code `provider_not_permitted`                                                          | **No.** A policy denial is deterministic; a `retry` strategy would spend its whole budget re-asking. | The step's `errorStrategy` applies — `fail` stops the run, `continue` skips it.                                                                                                          |
| Keyword enrichment  | `ProviderNotPermittedError`, thrown before any chunk is read or sent                                    | n/a — the whole run is refused, so there is no partial-success state                                 | `POST …/enrich-keywords` → **403**, code `provider_not_permitted`                                                                                                                        |
| Retroactive review  | none — the route returns early, before `getProvider` and before the judge runs                          | n/a                                                                                                  | `POST …/executions/:id/review` → **403**, code `provider_not_permitted`                                                                                                                  |
| Audio resolution    | none — `tryAudioRow` returns `null`, exactly as it does for an open breaker or a missing `transcribe()` | n/a                                                                                                  | the loop tries the next matrix row; with none permitted, `getAudioProvider()` returns `null` and every caller reports speech-to-text unavailable                                         |
| Knowledge embedding | none per arm — the chain skips a refused provider and tries the next                                    | n/a                                                                                                  | with no arm permitted, `resolveProvider` throws "No permitted embedding provider", deliberately worded apart from the "not configured" error so the two send readers to different places |

Audio is the one that denies without an error, and that is the loop's own
convention rather than a softening: `tryAudioRow` already returns `null` for
every other reason a row is unusable, the loop above it already falls through to
the next row, and all three callers of `getAudioProvider()` already handle
`null`. Throwing there would invent a failure mode the callers do not have, and
would lose the useful half of the behaviour — a permitted row further down the
matrix can still serve the request.

All five check **before** the provider is constructed and before a token is
sent, so a refusal means nothing left the deployment. On the workflow path the
operator-facing detail — which provider, which model, which fix — is in the log
rather than the message, because `ExecutorError`'s message reaches the SSE
client and that path has no scrub of its own. The two 403 messages do name the
provider and model: both routes are admin-only, and both identifiers are already
shown throughout the orchestration admin. The audio skip is logged at `info`,
alongside the breaker and `transcribe()` skips it sits with.

One consequence worth knowing before writing a rule: because the primary is
fail-closed, **a rule that throws costs provider-less agents an outage** rather
than routing them somewhere unapproved. Agents that name their provider
explicitly keep working and merely lose their fallbacks. See
[multi-tenancy design → Q15](../architecture/multi-tenancy-design.md).

#### The embedder chooses; the provider manager calls

Until t-740 the embedding chain was the one covered row **outside** the
provider manager: it built its own request and called `fetch`, so the
eligibility seam constrained _which provider it chose_ while the in-flight Proxy
never saw the call. `LlmProvider.embed` could not express what ingestion needs —
a batch, a per-call model, a dimension, and usage for cost logging — which is
why it bypassed the contract.

Now `knowledge/embedder.ts` resolves `{ slug, model, dimensions, sendDimensions }`
and calls `getProvider(slug).embedMany(texts, { model, dimensions?, inputType? })`.
What that moves where:

- **Key resolution, SSRF check, redirect refusal** — the provider manager and the
  provider classes, the same as chat. The manager now also SSRF-checks a
  configured Voyage `baseUrl`, which the embedder used to check itself.
- **Which model, and whether to ask for a dimension** — still the embedder,
  because it knows the install's vector width and `schemaCompatible`.
- **A provider without `embedMany`** (Anthropic; a fork class written against the
  older contract) cannot do knowledge embedding. The embedder fails with
  `embedding_unsupported` rather than falling back to `embed`, which could return
  vectors of the wrong width.
- **Cost rows and provenance** still record `providerType`, not the slug.

The call is now counted by the Proxy and visible to anything hung off it. The
limit that remains is the one in _What bypasses the Provider Manager_: code that
constructs a provider itself.

## Anti-Patterns

**Don't** construct providers directly in application code — always go through `providerManager`:

```typescript
// Bad — bypasses cache, config, and env-var resolution
const p = new AnthropicProvider({ name: 'x', type: 'anthropic', apiKey: 'sk-...', isLocal: false });
```

**Don't** import Next.js modules from anywhere under `lib/orchestration/llm/`:

```typescript
// Will break the platform-agnostic contract
import { cache } from 'react';
import { headers } from 'next/headers';
```

**Don't** swallow `ProviderError.retriable` — use the built-in retry via `withRetry` (already wired into `chat`/`chatStream`/`embed`) instead of rolling your own loop.

**Don't** skip cost logging for local models — token counts are still valuable for benchmarking and showing up in `getAgentCosts` breakdowns.

## Task-type defaults and model pins

The task defaults live in the `AiOrchestrationSettings` singleton (`slug: 'global'`), in `defaultModels`, one value per `TaskType` (`routing | chat | reasoning | embeddings | audio`). `lib/orchestration/llm/settings-resolver.ts` reads them behind a 30-second in-memory cache, which the settings PATCH route clears with `invalidateSettingsCache()` so an edit takes effect on the next turn. The runtime is strict: an unsaved slot throws `NoDefaultModelConfiguredError` rather than falling back to a computed pick. `computeDefaultModelMap()` only supplies the _suggestion_ the settings form shows below an empty slot (cheapest budget tier for routing and chat, frontier for reasoning; nothing for `embeddings` and `audio`, which are matrix-driven).

### A pin names its provider (§136 t-1068)

Two providers can offer the same model id: `gpt-4o` under OpenAI and under Azure (`microsoft`), `whisper-1` under OpenAI and Groq. The catalogue keys a model on both (`@@unique([providerSlug, modelId])`), but the model registry holds one entry per id, so asking it for the provider of `gpt-4o` names one of them. A saved choice of model therefore names both (owner ruling, 2026-11-19: no possible confusion between OpenAI's GPT-4o and Azure's).

**The stored shape** is one string, `${providerSlug}::${modelId}`, written in the field the bare id used to occupy: `defaultModels.<task>` and a workflow step's `config.modelOverride` ([`workflows.md` § Step model pins](./workflows.md#step-model-pins)). The audio slot has used it since before the rest. The helpers are `lib/orchestration/llm/model-pin.ts`: `formatModelPin`, `parseModelPin` (split on the first `::`; an empty side reads the whole value as a bare id), `pinModelId`, `pinNames` (does this pin name that catalogue row, by `'pair'`, by `'id'`, or not) and `pinProvider`. `audio-default.ts` re-exports them under its old names. One string rather than a second field, so a pin is read and written in one place and no stored row needs migrating.

**A bare id is still a valid pin, and resolves exactly as before:** its provider is the one the registry gives the id. That covers everything saved before t-1068 (nothing is rewritten; a value becomes a pair when an administrator saves the slot again), the system's suggestion for an unsaved slot (registry provider names need not match a provider row's slug, so the suggestion stays bare), and a judge model with no provider set at its own level (`EVALUATION_JUDGE_*` or `EVALUATION_DEFAULT_*`).

**`embeddings` stays a bare id.** The embedding fallback chain chooses its own provider (Voyage first, then an OpenAI-compatible row), so a provider in that slot would be ignored; `validateTaskDefaults` refuses one. The provider-exact embedding pin is the active embedding model (`activeEmbeddingModelId`, a catalogue row id).

**Where a pin is called** — each takes the provider from the pin, else the registry:

| Caller                                                   | Pin                                                                          | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runLlmCall` (`engine/llm-runner.ts`) — every LLM step   | step `modelOverride`, else `chat` default                                    | `getProvider`, the eligibility check, telemetry and the cost row all use the pin's provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `resolveAgentProviderAndModel` (`llm/agent-resolver.ts`) | `chat` (or the task's) default, for an agent with neither provider nor model | the pinned provider while it is reachable and eligible, else the first eligible candidate as a bare id always got (logged); an agent naming its provider keeps it. `getEffectiveAgentDefaults` mirrors this (`provider-resolution-parity.test.ts`). An agent naming its provider but no model takes the default's model id on its own provider, as a bare id always did, even when the default names another provider; a pinned provider that cannot be used is likewise replaced by the first eligible one with the pin's model id. Both are as before t-1068 |
| `summarizeMessages` (`chat/summarizer.ts`)               | `routing` default                                                            | never leaves the conversation's provider and fallbacks (its agent's, an org's approved one, the one confidential routing judged): a pin naming another provider gives way to the conversation's own model; one naming the conversation's provider, or a bare id, supplies the model as before                                                                                                                                                                                                                                                                  |
| `chat_turn` step                                         | step `modelOverride`                                                         | a pin naming a provider runs there with no fallbacks, even the agent's own provider (its fallbacks would get the model id); a bare id replaces the model on the agent's binding, fallbacks and all, as before                                                                                                                                                                                                                                                                                                                                                  |
| keyword enrichment, retroactive review                   | `chat` default; the review's own override; `JUDGE_MODEL_PIN`                 | the supervisor step takes `JUDGE_MODEL_PIN` too: `EVALUATION_JUDGE_MODEL` joined to `EVALUATION_JUDGE_PROVIDER`, or the eval defaults joined to each other, never one level's model to the other's provider                                                                                                                                                                                                                                                                                                                                                    |

Pricing and cost estimation are by model id (`calculateCost`, `workflow-cost.ts`), as an agent's turns already were: the registry's rates for the id apply whichever provider served it.

**Validation.** `validateTaskDefaults` (sync, in the Zod schema) checks a pin's model id against the registry. The settings PATCH route then checks a chat, routing or reasoning pair against the catalogue: an active row with that provider and model, or a registry entry for the id that is that provider's. The semantic validator applies the same rule to step overrides.

**Who writes pairs.** The default-models form (its chat-like options are catalogue rows, one per provider's model, labelled with the provider; a stored bare id that matches none is shown as itself, and a bare suggestion is offered only when exactly one option has its id), the setup wizard and the provider-detection banner (the detected provider's suggestions), the workflow builder's model picker, and the built-in templates. Backup export and import carry the stored strings unchanged.

**What reads them by provider and id:** the model-lifecycle finder ([§ Model lifecycle](#model-lifecycle)) and a provider's model list (`defaultFor`) match a pair exactly and a bare id on the id alone.

See [`admin-api.md` § Orchestration settings](./admin-api.md#orchestration-settings-singleton) and [`../admin/orchestration-costs.md`](../admin/orchestration-costs.md) for the HTTP surface.

## Admin surface (Phase 3.2)

Admins manage `AiProviderConfig` rows through `/api/v1/admin/orchestration/providers` — full CRUD plus a live `POST /:id/test` (wraps `providerManager.testProvider`) and a per-provider `GET /:id/models` (wraps `provider.listModels()`). Every response hydrates rows with `apiKeyPresent: boolean`, derived via `isApiKeyEnvVarSet()` — the raw `process.env[apiKeyEnvVar]` value is **never** returned from a route, logged, or written to the response envelope. The aggregated `GET /models` endpoint returns the merged model registry and accepts `?refresh=true` to force an OpenRouter refresh. Full route reference lives in [`admin-api.md`](./admin-api.md#providers).

**SSRF guard on `baseUrl`.** `providerConfigSchema` / `updateProviderConfigSchema` both run `checkSafeProviderUrl()` (`lib/security/safe-url.ts`) via `.superRefine()`. As a defense-in-depth layer, `buildProviderFromConfig()` re-runs the same validator before constructing `OpenAiCompatibleProvider`, throwing `ProviderError({ code: 'unsafe_base_url' })` on reject — this catches PATCH merges that flip `isLocal` without re-sending `baseUrl`, plus any direct DB writes that bypass Zod. Blocked: non-`http(s)` schemes, cloud metadata hosts, RFC1918 / CGNAT / link-local / IPv6 unique-local, and loopback unless the row is marked `isLocal: true`. The `/test` and `/models` routes also strip raw SDK error messages before responding so the fetch error can't be used as a blind-SSRF oracle — the real error is logged server-side only. See [`admin-api.md` § SSRF safety](./admin-api.md#ssrf-safety-hard-guarantee) for the full contract.

## Testing

Unit tests live in `tests/unit/lib/orchestration/llm/` and mock `@anthropic-ai/sdk`, `openai`, and `@/lib/db/client`. Notable patterns:

- SDK mocks must be declared before the dynamic `await import(...)` of the module under test.
- `modelRegistry.__resetForTests()` clears cached state between cases.
- Browser-like vitest environment: both SDKs refuse to instantiate without `dangerouslyAllowBrowser: true`, so mock them in any test that imports `AnthropicProvider` / `OpenAiCompatibleProvider` (even indirectly via `provider-manager`).

Run just this module:

```bash
npx vitest run tests/unit/lib/orchestration/llm
```

## Provider Models & Decision Heuristic

Beyond runtime provider config, the platform maintains a **Provider Selection Matrix** — a DB-managed registry of individual model entries (`AiProviderModel`) with tier classification, capability ratings, and chat/embedding distinction.

The decision heuristic in `lib/orchestration/llm/provider-selector.ts` scores models against a task intent and returns ranked recommendations:

```typescript
import { recommendModels } from '@/lib/orchestration/llm';

const recs = await recommendModels('thinking', { limit: 3 });
// → [{ slug: 'anthropic-claude-opus-4-6', providerSlug: 'anthropic', score: 90, reason: '...' }, ...]

// Embedding-specific recommendations
const embedRecs = await recommendModels('embedding', { limit: 3 });
```

Models are cached with a 60-second TTL (same pattern as `settings-resolver.ts`). Cache is invalidated by the CRUD API routes.

See [Provider Selection Matrix](./provider-selection-matrix.md) for the full 6-tier classification, scoring algorithm, and API reference.

## Related Documentation

- [Orchestration Overview](./overview.md) — domain entry point
- [Provider Selection Matrix](./provider-selection-matrix.md) — tier classification, decision heuristic, model CRUD
- `.claude/docs/agent-orchestration.md` — architectural brief
- `types/orchestration.ts` — shared types (`CostSummary`, `CostOperation`, `ChatEvent`, ...)
- `prisma/schema/` — `AiProviderConfig`, `AiAgent`, `AiCostLog`, `AiProviderModel`
