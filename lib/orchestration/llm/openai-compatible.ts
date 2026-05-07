/**
 * OpenAI-Compatible Provider
 *
 * Single provider class that targets any OpenAI-compatible Chat
 * Completions + Embeddings API. One codebase covers:
 *
 *   - OpenAI proper      (https://api.openai.com/v1)
 *   - Ollama             (http://localhost:11434/v1)
 *   - LM Studio          (http://localhost:1234/v1)
 *   - vLLM               (http://localhost:8000/v1)
 *   - Together AI        (https://api.together.xyz/v1)
 *   - Fireworks          (https://api.fireworks.ai/inference/v1)
 *   - Groq               (https://api.groq.com/openai/v1)
 *   - Any future OpenAI-compatible server
 *
 * Local providers (Ollama, LM Studio, vLLM) need no API key; the
 * OpenAI SDK rejects an empty string, so we pass `'not-needed'` as a
 * sentinel — local servers ignore the `Authorization` header.
 *
 * Local providers also get shorter default timeouts and do NOT retry
 * 5xx responses (per orchestration spec: if Ollama crashes, retrying
 * won't help). 429s are still retried.
 *
 * Platform-agnostic: no Next.js imports.
 */

import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions/completions';

import { logger } from '@/lib/logging';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
  ProviderError,
  toProviderError,
  withRetry,
  type LlmProvider,
  type ProviderTestResult,
} from '@/lib/orchestration/llm/provider';
import type {
  ContentPart,
  LlmFinishReason,
  LlmMessage,
  LlmOptions,
  LlmResponse,
  LlmToolCall,
  LlmToolChoice,
  ModelInfo,
  StreamChunk,
} from '@/lib/orchestration/llm/types';
import { getTextContent } from '@/lib/orchestration/llm/types';

/** Sentinel API key for local servers that require *something* in the header. */
const LOCAL_API_KEY_SENTINEL = 'not-needed';

/**
 * Default embedding model for cloud OpenAI-compatible hosts. Used only
 * as a constructor-default fallback when nobody passes `embeddingModel`
 * to the provider class. The runtime embedding pipeline resolves the
 * model dynamically via `getDefaultModelForTask('embeddings')` in
 * `lib/orchestration/knowledge/embedder.ts`.
 */
const DEFAULT_CLOUD_EMBEDDING_MODEL = 'text-embedding-3-small';

/** Default embedding model for local Ollama-style hosts. */
const DEFAULT_LOCAL_EMBEDDING_MODEL = 'nomic-embed-text';

/** Default max_tokens when caller doesn't supply one. */
const DEFAULT_MAX_TOKENS = 4096;

/** Constructor options for `OpenAiCompatibleProvider`. */
export interface OpenAiCompatibleProviderOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  isLocal: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  /** Override the embedding model when the default is wrong for this host. */
  embeddingModel?: string;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  public readonly name: string;
  public readonly isLocal: boolean;

  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly embeddingModel: string;

  constructor(options: OpenAiCompatibleProviderOptions) {
    if (!options.baseUrl) {
      throw new ProviderError('OpenAiCompatibleProvider requires a baseUrl', {
        code: 'missing_base_url',
        retriable: false,
      });
    }

    this.name = options.name;
    this.isLocal = options.isLocal;
    this.timeoutMs = options.timeoutMs ?? (options.isLocal ? LOCAL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.embeddingModel =
      options.embeddingModel ??
      (options.isLocal ? DEFAULT_LOCAL_EMBEDDING_MODEL : DEFAULT_CLOUD_EMBEDDING_MODEL);

    this.client = new OpenAI({
      apiKey: options.apiKey && options.apiKey.length > 0 ? options.apiKey : LOCAL_API_KEY_SENTINEL,
      baseURL: options.baseUrl,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
  }

  async chat(messages: LlmMessage[], options: LlmOptions): Promise<LlmResponse> {
    const params = this.buildNonStreamingParams(messages, options);
    logger.info('OpenAI-compatible chat request', {
      provider: this.name,
      model: options.model,
      messageCount: messages.length,
      hasTools: Boolean(options.tools?.length),
      isLocal: this.isLocal,
    });

    let completion: ChatCompletion;
    try {
      completion = await withRetry<ChatCompletion>(
        () => this.client.chat.completions.create(params),
        {
          maxRetries: this.maxRetries,
          isLocal: this.isLocal,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          operation: 'openai.chat.completions.create',
        }
      );
    } catch (err) {
      throw toProviderError(err, 'OpenAI-compatible chat request failed');
    }

    const choice = completion.choices[0];
    if (!choice) {
      throw new ProviderError('OpenAI-compatible response contained no choices', {
        code: 'empty_response',
        retriable: false,
      });
    }

    const toolCalls = (choice.message.tool_calls ?? [])
      .map(toolCallFromSdk)
      .filter((c): c is LlmToolCall => c !== null);

    const response: LlmResponse = {
      content: choice.message.content ?? '',
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
      model: completion.model,
      finishReason: mapFinishReason(choice.finish_reason),
    };
    if (toolCalls.length > 0) response.toolCalls = toolCalls;
    return response;
  }

  async *chatStream(messages: LlmMessage[], options: LlmOptions): AsyncIterable<StreamChunk> {
    const params = this.buildStreamingParams(messages, options);
    logger.info('OpenAI-compatible chat stream request', {
      provider: this.name,
      model: options.model,
      messageCount: messages.length,
      hasTools: Boolean(options.tools?.length),
      isLocal: this.isLocal,
    });

    let stream: AsyncIterable<ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(params);
    } catch (err) {
      throw toProviderError(err, 'OpenAI-compatible chat stream failed');
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: LlmFinishReason = 'stop';

    // Tool-call fragments are streamed incrementally and keyed by index.
    // We buffer name + arguments then emit a single `tool_call` chunk on completion.
    interface ToolBuffer {
      id: string;
      name: string;
      arguments: string;
    }
    const toolBuffers = new Map<number, ToolBuffer>();

    try {
      for await (const chunk of stream) {
        if (options.signal?.aborted) {
          throw new ProviderError('request aborted', { code: 'aborted', retriable: false });
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens;
          outputTokens = chunk.usage.completion_tokens;
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.delta.content) {
          yield { type: 'text', content: choice.delta.content };
        }

        if (choice.delta.tool_calls) {
          for (const call of choice.delta.tool_calls) {
            const existing = toolBuffers.get(call.index) ?? { id: '', name: '', arguments: '' };
            if (call.id) existing.id = call.id;
            if (call.function?.name) existing.name = call.function.name;
            if (call.function?.arguments) existing.arguments += call.function.arguments;
            toolBuffers.set(call.index, existing);
          }
        }

        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      }
    } catch (err) {
      throw toProviderError(err, 'OpenAI-compatible stream iteration failed');
    }

    for (const buf of toolBuffers.values()) {
      yield {
        type: 'tool_call',
        toolCall: {
          id: buf.id,
          name: buf.name,
          arguments: safeParseJson(buf.arguments),
        },
      };
    }

    yield {
      type: 'done',
      usage: { inputTokens, outputTokens },
      finishReason,
    };
  }

  async embed(
    text: string,
    _options?: import('@/lib/orchestration/llm/types').EmbedOptions
  ): Promise<number[]> {
    try {
      const result = await withRetry(
        () => this.client.embeddings.create({ model: this.embeddingModel, input: text }),
        {
          maxRetries: this.maxRetries,
          isLocal: this.isLocal,
          operation: 'openai.embeddings.create',
        }
      );
      const first = result.data[0];
      if (!first) {
        throw new ProviderError('Embedding response contained no vectors', {
          code: 'empty_response',
          retriable: false,
        });
      }
      return first.embedding;
    } catch (err) {
      throw toProviderError(err, 'OpenAI-compatible embed request failed');
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const page = await this.client.models.list();
      const models: ModelInfo[] = [];
      for (const entry of page.data) {
        const existing = getModel(entry.id);
        if (existing) {
          models.push({ ...existing, available: true });
        } else {
          models.push({
            id: entry.id,
            name: entry.id,
            provider: this.name,
            tier: this.isLocal ? 'local' : 'mid',
            inputCostPerMillion: 0,
            outputCostPerMillion: 0,
            maxContext: 0,
            supportsTools: false,
            available: true,
          });
        }
      }
      return models;
    } catch (err) {
      throw toProviderError(err, 'OpenAI-compatible listModels failed');
    }
  }

  async testConnection(): Promise<ProviderTestResult> {
    try {
      const models = await this.listModels();
      return { ok: true, models: models.map((m) => m.id) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, models: [], error };
    }
  }

  // --- internal helpers ---

  private buildNonStreamingParams(
    messages: LlmMessage[],
    options: LlmOptions
  ): ChatCompletionCreateParamsNonStreaming {
    return this.buildBaseParams(messages, options);
  }

  private buildStreamingParams(
    messages: LlmMessage[],
    options: LlmOptions
  ): ChatCompletionCreateParamsStreaming {
    return {
      ...this.buildBaseParams(messages, options),
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  private buildBaseParams(
    messages: LlmMessage[],
    options: LlmOptions
  ): ChatCompletionCreateParamsNonStreaming {
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: options.model,
      messages: messages.map(toSdkMessage),
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (options.temperature !== undefined) params.temperature = options.temperature;
    if (options.tools?.length) {
      params.tools = options.tools.map<ChatCompletionTool>((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      const choice = mapToolChoice(options.toolChoice);
      if (choice) params.tool_choice = choice;
    }
    if (options.responseFormat) {
      if (options.responseFormat.type === 'json_object') {
        params.response_format = { type: 'json_object' };
      } else if (options.responseFormat.type === 'json_schema') {
        params.response_format = {
          type: 'json_schema',
          json_schema: {
            name: options.responseFormat.name,
            schema: options.responseFormat.schema,
            ...(options.responseFormat.strict !== undefined
              ? { strict: options.responseFormat.strict }
              : {}),
          },
        };
      }
    }
    return params;
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function toSdkMessage(msg: LlmMessage): ChatCompletionMessageParam {
  switch (msg.role) {
    case 'system':
      return { role: 'system', content: getTextContent(msg.content) };
    case 'user': {
      // Multimodal content — convert ContentPart[] to OpenAI format
      if (Array.isArray(msg.content)) {
        return { role: 'user', content: toOpenAiParts(msg.content) };
      }
      return { role: 'user', content: msg.content };
    }
    case 'assistant': {
      const text = getTextContent(msg.content);
      if (msg.toolCalls?.length) {
        return {
          role: 'assistant',
          content: text || null,
          tool_calls: msg.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        };
      }
      return { role: 'assistant', content: text };
    }
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId ?? '',
        content: getTextContent(msg.content),
      };
  }
}

/** Convert platform-neutral ContentPart[] to OpenAI ChatCompletionContentPart[]. */
function toOpenAiParts(
  parts: ContentPart[]
): import('openai/resources/chat/completions/completions').ChatCompletionContentPart[] {
  return parts.map((part) => {
    if (part.type === 'text') {
      return { type: 'text' as const, text: part.text };
    }
    if (part.type === 'image') {
      if (part.source.type === 'base64') {
        return {
          type: 'image_url' as const,
          image_url: { url: `data:${part.source.mediaType};base64,${part.source.data}` },
        };
      }
      return { type: 'image_url' as const, image_url: { url: part.source.url } };
    }
    // Documents: for OpenAI, embed as text (OpenAI doesn't have native doc blocks)
    if (part.type === 'document') {
      const text = Buffer.from(part.source.data, 'base64').toString('utf-8');
      return { type: 'text' as const, text: `[Document: ${part.name}]\n${text}` };
    }
    return { type: 'text' as const, text: '' };
  });
}

function mapToolChoice(
  choice: LlmToolChoice | undefined
): ChatCompletionToolChoiceOption | undefined {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'none') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function toolCallFromSdk(call: ChatCompletionMessageToolCall): LlmToolCall | null {
  if (call.type !== 'function') return null;
  return {
    id: call.id,
    name: call.function.name,
    arguments: safeParseJson(call.function.arguments),
  };
}

function mapFinishReason(reason: string | null | undefined): LlmFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'error';
    default:
      return 'stop';
  }
}

function safeParseJson(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    logger.warn('Failed to parse OpenAI tool_call arguments', { length: raw.length });
    return {};
  }
}
