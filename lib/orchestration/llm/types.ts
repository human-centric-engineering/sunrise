/**
 * LLM Provider Types
 *
 * Platform-agnostic TypeScript types shared across the LLM provider
 * abstraction. No runtime code. No Next.js imports.
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
  /** Override the provider's default request timeout. */
  timeoutMs?: number;
  /** Caller-supplied cancellation signal. */
  signal?: AbortSignal;
}

/** Why the model stopped generating. */
export type LlmFinishReason = 'stop' | 'tool_use' | 'length' | 'error';

/** A complete, non-streaming response from a provider. */
export interface LlmResponse {
  content: string;
  toolCalls?: LlmToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /** Echo of the model id the provider actually used. */
  model: string;
  finishReason: LlmFinishReason;
}

/**
 * A single chunk yielded by `LlmProvider.chatStream`.
 *
 * - `text` — incremental assistant text.
 * - `tool_call` — a fully-assembled tool invocation (we buffer streaming
 *   fragments and emit one chunk per call for consumer simplicity).
 * - `done` — terminal chunk with usage and finish reason.
 */
export type StreamChunk =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolCall: LlmToolCall }
  | {
      type: 'done';
      usage: { inputTokens: number; outputTokens: number };
      finishReason: LlmFinishReason;
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
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  tier: ModelTier;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  maxContext: number;
  supportsTools: boolean;
  available?: boolean;
}
