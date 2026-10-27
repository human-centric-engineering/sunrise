/**
 * LLM Provider Types
 *
 * Platform-agnostic TypeScript types shared across the LLM provider
 * abstraction, with the few constants and helpers that belong to them.
 * No Next.js imports.
 *
 * These types are the common dialect spoken by every provider
 * (Anthropic, OpenAI, Ollama, vLLM, Together, Fireworks, Groq, ...);
 * each concrete provider is responsible for translating them to and
 * from its own wire format.
 */

/** Conversation message roles understood by every provider. */
export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A tool invocation the model asked us to perform. `arguments` is the
 * parsed JSON object supplied by the model — never the raw string form.
 */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A block a provider returned alongside an assistant turn that has to go
 * back with it:
 *
 * - Anthropic's `thinking` / `redacted_thinking` blocks, and the
 *   `server_tool_use` / `web_search_tool_result` / `code_execution_tool_result`
 *   blocks of a web search or code run it ran itself ({@link ProviderTools}).
 * - On OpenAI's Responses path (`openai-responses.ts`), its `reasoning`
 *   items (`openai_reasoning`), `web_search_call` items
 *   (`openai_web_search_call`) and `code_interpreter_call` items
 *   (`openai_code_interpreter_call`). That path stores nothing on OpenAI's
 *   side, so these are what lets the next request carry on the turn.
 *
 * A code run's block also carries the container it ran in and how long it
 * ran (`containerId`, `durationMs`): the next call of a tool loop reuses that
 * container, and bills only what its runs add to it (`billCodeExecution`).
 *
 * Opaque to everything but the provider that produced it: a tool loop
 * carries it on the assistant message and the provider sends it back
 * unchanged on the request that continues the turn, which Anthropic requires
 * when thinking is on and both need for the model to keep what a search
 * found. Every other provider, the other one included, leaves it out.
 */
export type LlmReasoningBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | {
      type: 'server_tool_use';
      id: string;
      name: AnthropicServerToolName;
      input: Record<string, unknown>;
    }
  | {
      type: 'web_search_tool_result';
      toolUseId: string;
      /** Empty when the search failed — `errorCode` then says why. */
      results: WebSearchResult[];
      errorCode?: string;
    }
  | {
      type: 'code_execution_tool_result';
      /** Which sub-tool ran: a shell command, or a file view / create / edit. */
      tool: 'bash' | 'text_editor';
      toolUseId: string;
      /** Anthropic's result, in its wire shape. */
      content: AnthropicCodeExecutionContent;
      containerId: string;
      durationMs: number;
      /** Names of the files the run made, for the trace. Not sent back. */
      fileNames?: string[];
    }
  | {
      type: 'openai_reasoning';
      id: string;
      /** Opaque reasoning OpenAI needs back to continue the turn. */
      encryptedContent: string;
      /** The reasoning summary's parts, when one was asked for. */
      summary: string[];
    }
  | {
      type: 'openai_web_search_call';
      id: string;
      /** `completed`, `failed`, or `searching` / `in_progress` when cut short. */
      status: 'in_progress' | 'searching' | 'completed' | 'failed' | 'incomplete';
      /**
       * What the model did: `{ type: 'search', queries?, sources? }`,
       * `open_page` or `find_in_page`. Sent back as it came.
       */
      action: Record<string, unknown>;
    }
  | {
      type: 'openai_code_interpreter_call';
      id: string;
      status: 'in_progress' | 'interpreting' | 'completed' | 'incomplete' | 'failed';
      containerId: string;
      code: string | null;
      /** What the code printed, and the images it drew (as URLs). */
      outputs: Array<{ type: 'logs'; logs: string } | { type: 'image'; url: string }>;
      durationMs: number;
      /**
       * Names of the files the reply cites from this run's container, for
       * the trace. Not sent back.
       */
      fileNames?: string[];
    };

/** The server tools whose `server_tool_use` blocks Anthropic returns here. */
export type AnthropicServerToolName =
  'web_search' | 'bash_code_execution' | 'text_editor_code_execution';

/**
 * A code execution result as Anthropic returns it: a shell command's output
 * (with the ids of the files it left in `$OUTPUT_DIR`), a file view, create
 * or edit, or an error. Error codes are kept as strings, as on web search.
 */
export type AnthropicCodeExecutionContent =
  | {
      type: 'bash_code_execution_result';
      stdout: string;
      stderr: string;
      return_code: number;
      content: Array<{ type: 'bash_code_execution_output'; file_id: string }>;
    }
  | { type: 'bash_code_execution_tool_result_error'; error_code: string }
  | {
      type: 'text_editor_code_execution_view_result';
      content: string;
      file_type: 'text' | 'image' | 'pdf';
      num_lines: number | null;
      start_line: number | null;
      total_lines: number | null;
    }
  | { type: 'text_editor_code_execution_create_result'; is_file_update: boolean }
  | {
      type: 'text_editor_code_execution_str_replace_result';
      lines: string[] | null;
      new_lines: number | null;
      new_start: number | null;
      old_lines: number | null;
      old_start: number | null;
    }
  | {
      type: 'text_editor_code_execution_tool_result_error';
      error_code: string;
      error_message: string | null;
    };

/** One page a provider's web search returned. */
export interface WebSearchResult {
  url: string;
  title: string;
  /** Opaque page content the provider needs back to cite the page later. */
  encryptedContent: string;
  pageAge?: string | null;
}

/**
 * A single content part in a multimodal message. When `LlmMessage.content`
 * is a `ContentPart[]`, the provider maps each part to the appropriate
 * wire format (e.g., Anthropic `source`, OpenAI `image_url`).
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; mediaType: string; data: string } | { type: 'url'; url: string };
    }
  | {
      type: 'document';
      source: { type: 'base64'; mediaType: string; data: string };
      name: string;
    };

/**
 * A message in a chat exchange. `content` may be a plain string (most
 * common), an empty string when the message carries only `toolCalls`,
 * or a `ContentPart[]` array for multimodal messages containing images
 * or document files.
 */
export interface LlmMessage {
  role: LlmRole;
  content: string | ContentPart[];
  /** Present when `role === 'tool'` — references the call this result answers. */
  toolCallId?: string;
  /** Present when the assistant decided to call one or more tools. */
  toolCalls?: LlmToolCall[];
  /**
   * The reasoning blocks the provider returned with this assistant turn
   * (`LlmResponse.reasoning`), replayed unchanged on the next request of a
   * tool loop. Not persisted: only the turn being continued needs them.
   */
  reasoning?: LlmReasoningBlock[];
  /**
   * On a `system` message: an instruction that steers the turn at this point
   * in the conversation rather than adding to the system prompt (the text of
   * an agent-opened turn). A provider whose API has no positional system
   * message sends it as a turn of its own; the others ignore the flag.
   */
  turnInstruction?: boolean;
}

/**
 * A function/tool advertised to the model. `parameters` is JSON Schema.
 */
export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** How the model should decide whether to call a tool. */
export type LlmToolChoice = 'auto' | 'none' | { name: string };

/**
 * Response format for structured output. `json_object` requests any valid
 * JSON; `json_schema` constrains the response to match a specific schema.
 */
export type LlmResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean };

/**
 * How much reasoning the model should do before producing visible output.
 * Only honoured by reasoning-capable models — the OpenAI reasoning /
 * gpt-5 families (`paramProfile === 'openai-reasoning'`) and Anthropic's
 * thinking Claude models (resolved via
 * `supportsReasoningEffort()` in `model-heuristics`). Silently dropped
 * by other models — no error.
 *
 * The four buckets map across providers (each provider class translates
 * to its wire-level shape):
 *
 *   - `minimal`  — OpenAI: `reasoning_effort: 'minimal'`.
 *                  Anthropic: no extended thinking (the field is omitted).
 *   - `low`      — OpenAI: `reasoning_effort: 'low'`.
 *                  Anthropic: `thinking: { budget_tokens: 1024 }`.
 *   - `medium`   — OpenAI: `reasoning_effort: 'medium'`.
 *                  Anthropic: `thinking: { budget_tokens: 4096 }`.
 *   - `high`     — OpenAI: `reasoning_effort: 'high'`.
 *                  Anthropic: `thinking: { budget_tokens: 16384 }`.
 *
 * Anthropic's `budget_tokens` is clamped below `max_tokens` by the
 * provider class — if `maxTokens` is small, the budget is reduced to fit.
 *
 * Claude models from Opus 4.7 / Sonnet 5 on refuse `budget_tokens`
 * (`acceptsThinkingBudget()` in `model-heuristics`). There `low` /
 * `medium` / `high` send `thinking: { type: 'adaptive' }` with
 * `output_config.effort` of the same name, and `minimal` sends
 * `output_config.effort: 'low'` with no `thinking` field — some of those
 * models can't turn thinking off, so they still think, at their lowest
 * effort.
 *
 * `xhigh` and `max` sit above `high`:
 *
 *   - Adaptive-thinking Claude models send them as `output_config.effort`
 *     of the same name (every one of them takes all five levels).
 *   - Budget-taking Claude models get a larger budget: 32768 for `xhigh`,
 *     65536 for `max`, clamped below `max_tokens` like the others.
 *   - OpenAI-compatible reasoning models get `high`. Which OpenAI models
 *     accept `xhigh` / `max` varies by model and is not published per id,
 *     so a sent value could 400; `high` is the nearest value they all take.
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Every {@link ReasoningEffort} value, lowest first. The validation schemas,
 * backup format and admin select are built from this list.
 */
export const REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[];

/**
 * How long a GPT-5 model's answers run (`verbosity`). Other models drop it.
 */
export const VERBOSITIES = ['low', 'medium', 'high'] as const;
export type Verbosity = (typeof VERBOSITIES)[number];

/**
 * Which OpenAI processing tier serves the request (`service_tier`). `flex` is
 * slower and half price on the models that offer it; `priority` is faster
 * and dearer. Sent only to OpenAI itself (`api.openai.com`); other providers
 * drop it. The tier the response reports is what `calculateCost` prices.
 */
export const SERVICE_TIERS = ['auto', 'default', 'flex', 'priority'] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/** Most stop sequences a request may carry — OpenAI's limit, the lower one. */
export const MAX_STOP_SEQUENCES = 4;

/** Per-call options passed to a provider. */
export interface LlmOptions {
  /** Model id understood by the target provider. */
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: LlmToolDefinition[];
  toolChoice?: LlmToolChoice;
  /** Request structured JSON output from the model. */
  responseFormat?: LlmResponseFormat;
  /**
   * How much reasoning the model should do before producing visible
   * output. Only honoured by reasoning-capable models — others drop the
   * field silently. See {@link ReasoningEffort} for the per-provider
   * mapping.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Text that ends the response when the model writes it (Anthropic
   * `stop_sequences`, OpenAI `stop`). At most {@link MAX_STOP_SEQUENCES}.
   * Dropped on OpenAI reasoning models, which refuse it.
   */
  stopSequences?: string[];
  /**
   * Nucleus sampling, 0–1. Sent only to models that still take sampling
   * parameters: older Claude models (`acceptsSamplingTemperature`), without
   * thinking, where it replaces `temperature` (several refuse both), and
   * non-reasoning OpenAI-compatible models. Dropped elsewhere.
   */
  topP?: number;
  /** GPT-5 answer length. Dropped by every other model. */
  verbosity?: Verbosity;
  /**
   * `false` asks for at most one tool call per turn (OpenAI
   * `parallel_tool_calls`, Anthropic `disable_parallel_tool_use`). Sent only
   * with tools. Unset leaves the provider default, which allows several.
   */
  parallelToolCalls?: boolean;
  /** OpenAI processing tier — see {@link ServiceTier}. */
  serviceTier?: ServiceTier;
  /**
   * Tools the provider runs on its own side rather than through the
   * capability dispatcher (web search and code execution, on Anthropic and
   * on OpenAI's Responses path). Sent only to providers and models that
   * offer them; dropped elsewhere.
   */
  providerTools?: ProviderTools;
  /** Override the provider's default request timeout. */
  timeoutMs?: number;
  /** Caller-supplied cancellation signal. */
  signal?: AbortSignal;
}

/**
 * The provider's own web search: the model searches as it answers, the
 * provider runs the search and bills it per search. Anthropic takes either
 * an allow list or a block list, not both.
 */
export interface WebSearchOptions {
  /**
   * Most searches one call may run, across every request it makes (Anthropic
   * counts its own limit per request, and a paused turn is sent again). A tool
   * loop passes what is left of the reply's limit (`spendWebSearches`); 0
   * means none is left, so the call runs no search. Unset leaves the
   * provider's limit.
   */
  maxUses?: number;
  /**
   * The agent's whole limit, kept by `spendWebSearches` when it takes a
   * reply's searches off `maxUses`. OpenAI caps each call with it instead:
   * taking its search tool away loses what earlier searches found, so it
   * can't hold a per-reply limit (owner ruling, t-955).
   */
  replyLimit?: number;
  /** Search only these domains. */
  allowedDomains?: string[];
  /** Never search these domains. */
  blockedDomains?: string[];
}

/**
 * A provider web search — USD per search, on top of the tokens the results
 * add to the input. Anthropic and OpenAI's `web_search` tool both charge $10
 * per 1,000. Here rather than in `cost-tracker`, which tests often mock whole.
 */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

/**
 * The provider's own code execution: the model runs code in a sandbox the
 * provider hosts (Anthropic's `code_execution`, OpenAI's `code_interpreter`).
 * No options yet; present means on. What the code prints reaches the model
 * and the trace. Files it makes are not delivered (owner ruling, t-956).
 */
export type CodeExecutionOptions = Record<string, never>;

/**
 * The least a code execution container is billed for, on both providers.
 * Neither reports billed time, so a container is costed at the larger of
 * this and its measured run time (owner ruling, t-956).
 */
export const CODE_EXECUTION_MIN_BILLED_SECONDS = 300;

/**
 * USD per container-hour. Anthropic charges $0.05 an hour after 1,550 free
 * hours a month per organisation, which Sunrise can't see, so they aren't
 * deducted. OpenAI charges $0.03 per 20 minutes for its default 1 GB
 * container, by the minute.
 */
export const CODE_EXECUTION_USD_PER_HOUR = { anthropic: 0.05, openai: 0.09 } as const;

/**
 * Built-in tools a provider runs itself, keyed by tool. A key that is absent
 * leaves that tool off. Stored as one JSON value on an agent
 * (`AiAgent.providerTools`).
 */
export interface ProviderTools {
  webSearch?: WebSearchOptions;
  codeExecution?: CodeExecutionOptions;
}

/**
 * The provider's code runs for one call, and what they are billed as: the
 * seconds this call adds to each container it used, at least
 * {@link CODE_EXECUTION_MIN_BILLED_SECONDS} for a container new to the reply.
 */
export interface CodeExecutionUsage {
  runs: number;
  billedSeconds: number;
  usdPerHour: number;
}

/** Why the model stopped generating. */
export type LlmFinishReason = 'stop' | 'tool_use' | 'length' | 'error';

/**
 * Tokens a provider reported for one call.
 *
 * `inputTokens` is every input token, cached or not, on every provider.
 * OpenAI reports it that way; Anthropic reports cache reads and writes
 * apart from `input_tokens`, and its provider class adds them back in.
 * The cache counts are the subsets of `inputTokens` billed at a
 * different rate (`calculateCost`), absent when the provider reported
 * none.
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * For reasoning models (OpenAI o-series, gpt-5), the subset of
   * `outputTokens` consumed by internal reasoning. Counts against
   * the same `max_completion_tokens` cap that bounds visible
   * output, so a high value with a low visible-content length
   * signals the cap was too tight. Undefined for non-reasoning
   * models and providers that don't report it.
   */
  reasoningTokens?: number;
  /** Input tokens served from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Input tokens written to the provider's prompt cache (Anthropic). */
  cacheWriteTokens?: number;
  /**
   * The processing tier that served the call, when the provider reported
   * one other than its standard tier (OpenAI `flex` / `priority`). Priced
   * by `calculateCost`.
   */
  serviceTier?: 'flex' | 'priority';
  /**
   * Web searches the provider ran for this call ({@link ProviderTools}),
   * billed per search on top of the tokens. Absent when it ran none.
   */
  webSearchRequests?: number;
  /**
   * Code the provider ran for this call ({@link ProviderTools}), billed by
   * container time on top of the tokens. Absent when it ran none.
   */
  codeExecution?: CodeExecutionUsage;
}

/** A complete, non-streaming response from a provider. */
export interface LlmResponse {
  content: string;
  toolCalls?: LlmToolCall[];
  usage: LlmUsage;
  /** Echo of the model id the provider actually used. */
  model: string;
  finishReason: LlmFinishReason;
  /**
   * Reasoning blocks returned with this turn, in order. A tool loop puts
   * them on the assistant message it appends (`LlmMessage.reasoning`).
   */
  reasoning?: LlmReasoningBlock[];
}

/**
 * A single chunk yielded by `LlmProvider.chatStream`.
 *
 * - `text` — incremental assistant text.
 * - `tool_call` — a fully-assembled tool invocation (we buffer streaming
 *   fragments and emit one chunk per call for consumer simplicity).
 * - `reasoning` — incremental, human-readable reasoning text as the model
 *   thinks: Claude's summarized thinking, or the `reasoning_content` /
 *   `reasoning` deltas some OpenAI-compatible providers send. For display
 *   only — the replayable blocks still arrive on `done`. A consumer that
 *   doesn't show reasoning ignores this chunk.
 * - `done` — terminal chunk with usage, finish reason and any reasoning
 *   blocks the turn produced.
 */
export type StreamChunk =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolCall: LlmToolCall }
  | { type: 'reasoning'; text: string }
  | {
      type: 'done';
      usage: LlmUsage;
      finishReason: LlmFinishReason;
      /** Reasoning blocks streamed this turn, in order — see `LlmResponse.reasoning`. */
      reasoning?: LlmReasoningBlock[];
    };

/**
 * In-memory provider configuration consumed by concrete providers.
 *
 * Note: the Prisma `AiProviderConfig.providerType` enum is only
 * `'anthropic' | 'openai-compatible'`. We keep `'openai'` as an
 * additional in-memory alias so callers can ask for "OpenAI directly"
 * without constructing a baseUrl; the provider manager collapses it to
 * an `OpenAiCompatibleProvider` pointing at `https://api.openai.com/v1`.
 */
export interface ProviderConfig {
  /** Human-readable label, typically `AiProviderConfig.name`. */
  name: string;
  type: 'anthropic' | 'openai' | 'openai-compatible' | 'voyage';
  /** Resolved API key value (not the env var name). */
  apiKey?: string;
  /** Required for `openai` / `openai-compatible`. */
  baseUrl?: string;
  isLocal: boolean;
  /** Override the default request timeout (ms). */
  timeoutMs?: number;
  /** Override the default retry count. */
  maxRetries?: number;
}

/**
 * Options for `LlmProvider.embed()`.
 *
 * Voyage AI (and a few others) distinguish between document and query
 * embeddings for optimal retrieval. Providers that don't support the
 * distinction simply ignore this.
 */
export interface EmbedOptions {
  /** Whether the text is a stored document or a search query. */
  inputType?: 'document' | 'query';
}

/**
 * Options for `LlmProvider.embedMany()` — the knowledge embedder's call.
 *
 * The caller chooses the model and whether to ask for a dimension, because it
 * is the caller that knows the install's vector width and whether the chosen
 * model accepts a `dimensions` parameter (`AiProviderModel.schemaCompatible`).
 * A provider sends `dimensions` only when it is given one.
 */
export interface EmbedManyOptions {
  /** The embedding model to call, e.g. `text-embedding-3-small`, `voyage-3`. */
  model: string;
  /** Output dimension to request. Omit for a model with a fixed native width. */
  dimensions?: number;
  /** Whether the texts are stored documents or search queries. */
  inputType?: 'document' | 'query';
}

/** Result of `LlmProvider.embedMany()`. */
export interface EmbedManyResult {
  /** One vector per input text, in input order, as plain `number[]`. */
  embeddings: number[][];
  /**
   * Input tokens the vendor reported, or `undefined` when it reported none
   * (Ollama and some self-hosted servers). Zero is a real count; absent is
   * "unknown", and the caller decides how to estimate it.
   */
  inputTokens?: number;
}

/** Audio input accepted by the transcription methods. */
export type TranscribeAudio = Blob | Buffer | ArrayBuffer | Uint8Array;

/**
 * Options for `LlmProvider.transcribe()` — speech-to-text.
 *
 * `model` is required and must reference a transcription-capable model
 * (e.g. `'whisper-1'`). `language` is an optional ISO 639-1 hint that
 * helps providers like OpenAI Whisper short-circuit language detection;
 * omit to let the provider auto-detect.
 */
export interface TranscribeOptions {
  model: string;
  /** ISO 639-1 language code hint (e.g. `'en'`, `'es'`). */
  language?: string;
  /** Free-text prompt to bias spelling / vocabulary. */
  prompt?: string;
  /** Override the provider's default request timeout. */
  timeoutMs?: number;
  /** Caller-supplied cancellation signal. */
  signal?: AbortSignal;
  /**
   * MIME type of the audio bytes — passed through to the upload as the
   * file's content type. Required when `audio` is a raw `Buffer`; ignored
   * when `audio` is a `Blob` (the blob's own type wins).
   */
  mimeType?: string;
  /**
   * Filename to advertise in the multipart upload. Some providers
   * dispatch the codec from the extension; default is `'audio.webm'`.
   */
  filename?: string;
}

/**
 * Result of a transcription call.
 *
 * `durationMs` is the audio duration in milliseconds when the provider
 * reports it (Whisper does, in seconds — we convert). Falls back to 0
 * when the provider's response shape lacks duration metadata, so cost
 * tracking should treat 0 as "unknown" not "free".
 */
export interface TranscribeResponse {
  text: string;
  /** Duration of the input audio in milliseconds, or 0 if unreported. */
  durationMs: number;
  /** ISO 639-1 language detected or echoed by the provider, when reported. */
  language?: string;
  /** Echo of the model id the provider actually used. */
  model: string;
}

/**
 * A single chunk yielded by `LlmProvider.transcribeStream` — the streaming
 * analogue of {@link TranscribeResponse}, modelled on {@link StreamChunk}.
 *
 * - `partial` — interim transcript text that may still change as more audio
 *   arrives (the live "words appearing as you speak" UX). Not authoritative
 *   and never billed.
 * - `final` — a finalized, stable transcript segment. Concatenate every
 *   `final` chunk in order for the complete transcript.
 * - `done` — terminal chunk carrying `audioSeconds` (audio duration in
 *   **seconds**, billed identically to batch `transcribe`) and an echo of the
 *   resolved model id. `audioSeconds` is `0` when the provider doesn't report
 *   duration (treat as "unknown", not "free"). Note the unit: the shared
 *   `calculateTranscriptionCost` takes **milliseconds**, so multiply by 1000
 *   (`audioSeconds * 1000`) before passing it through.
 */
export type TranscribeChunk =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; language?: string }
  | { type: 'done'; audioSeconds: number; model: string };

/** Extract the text content from a message's content field. */
export function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Coarse cost/capability band used for routing and display. */
export type ModelTier = 'budget' | 'mid' | 'frontier' | 'local';

/**
 * Canonical metadata for a single model.
 *
 * Pricing is USD per million tokens. Local models report zero pricing.
 * `available` is only set after a provider list-models call confirms
 * the model is reachable through a currently-configured provider.
 */
/**
 * Wire-level parameter convention required by the model.
 *
 * Determines which fields the runtime sends and which it omits:
 *
 *  - `openai-legacy`: `max_tokens`, free `temperature`, no
 *    `reasoning_effort`. Covers gpt-4o, gpt-4, gpt-3.5, and any Llama /
 *    Mixtral hosted via OpenAI-compatible APIs (Groq, Together, …).
 *  - `openai-reasoning`: `max_completion_tokens` instead of `max_tokens`,
 *    `temperature` locked to 1 (we skip the send), accepts
 *    `reasoning_effort`. Covers o-series and gpt-5.
 *  - `anthropic`: `max_tokens` required (not optional), supports `top_k`
 *    and `thinking`. Consumed by `anthropic.ts`, not openai-compatible.
 *  - `gemini`: `maxOutputTokens` (different field name). Reserved for a
 *    future Gemini provider class.
 *
 * Sourced from the `AiProviderModel.paramProfile` column when present.
 * When absent (OpenRouter-only entries, legacy rows, fine-tuned ids),
 * the runtime falls back to `deriveParamProfile()` in
 * `@/lib/orchestration/llm/model-heuristics`.
 */
export type ParamProfile = 'openai-legacy' | 'openai-reasoning' | 'anthropic' | 'gemini';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  tier: ModelTier;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  /**
   * USD per million input tokens read from the provider's prompt cache,
   * when the pricing source publishes one (OpenRouter's catalogue does).
   * Absent: `calculateCost` falls back to the provider's published
   * multiplier, or to the full input rate where it has none.
   */
  cacheReadCostPerMillion?: number;
  /** USD per million input tokens written to the prompt cache, as above. */
  cacheWriteCostPerMillion?: number;
  maxContext: number;
  supportsTools: boolean;
  /**
   * Wire-level parameter convention. Optional — when omitted, the
   * runtime resolves a fallback via `deriveParamProfile()`. Setting
   * this in the registry / DB is the authoritative path.
   */
  paramProfile?: ParamProfile;
  available?: boolean;
  /**
   * Capability strings carried on the matrix row (e.g. `'vision'`,
   * `'documents'`, `'chat'`, `'audio'`). Optional because the static
   * registry doesn't know about admin-curated capabilities — only the
   * DB-backed rows merged via `dbModelToModelInfo` populate this.
   *
   * Consumers (agent form, capability gate) treat absence as "unknown"
   * — the runtime gate is still the authoritative answer; the form
   * uses this to disable toggles pre-emptively.
   */
  capabilities?: string[];
  /**
   * Set when nothing has supplied a price: the entry came from a matrix row
   * whose cost is null and no registry figure filled it. Distinguishes "rate
   * unknown" from a genuinely free model, whose rates are also 0 — so
   * `calculateCost` can mark the turn unpriced instead of recording it as free.
   */
  pricingUnknown?: true;
}
