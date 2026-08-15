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

import OpenAI, { toFile } from 'openai';
import type { TranscriptionVerbose } from 'openai/resources/audio/transcriptions';
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
import {
  deriveParamProfile,
  supportedReasoningEfforts,
} from '@/lib/orchestration/llm/model-heuristics';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
  ProviderError,
  buildRequestOptions,
  toProviderError,
  toProviderErrorWithUsage,
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
  ParamProfile,
  StreamChunk,
  TranscribeOptions,
  TranscribeResponse,
} from '@/lib/orchestration/llm/types';
import { getTextContent } from '@/lib/orchestration/llm/types';
import { isCompleteJson } from '@/lib/orchestration/llm/json-completeness';

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

/** Default token cap when the caller doesn't supply one. Applied to whichever
 *  field the model accepts — `max_tokens` for legacy chat models, or
 *  `max_completion_tokens` for OpenAI's reasoning / gpt-5 families.
 *  Param-shape selection is owned by `resolveParamProfile`. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Resolve the wire-level parameter convention for `modelId`.
 *
 * Authority order:
 *   1. Registry hit (DB-backed `AiProviderModel.paramProfile`, surfaced
 *      via `dbModelToModelInfo`). This is the source of truth — admins
 *      pick the profile from a dropdown on the Provider Model form, and
 *      it round-trips through `getModel()` here.
 *   2. Heuristic fallback (`deriveParamProfile`). Covers the cases the
 *      registry can't: OpenRouter-only entries (no DB row), legacy
 *      seeds, fine-tuned ids. Strips known provider prefixes so an
 *      OpenRouter id like `openai/gpt-5-mini` resolves the same as
 *      bare `gpt-5-mini`.
 *
 * Replacing the previous regex-on-raw-id approach was motivated by a
 * production failure: a `gpt-5`-family id with an `openai/` prefix
 * slipped past the anchored regex and 400'd with `'max_tokens' is not
 * supported with this model. Use 'max_completion_tokens' instead.`
 */
function resolveParamProfile(modelId: string, providerName: string): ParamProfile {
  const info = getModel(modelId);
  return info?.paramProfile ?? deriveParamProfile(modelId, providerName);
}

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

    const requestOptions = buildRequestOptions(options);

    let completion: ChatCompletion;
    try {
      completion = await withRetry<ChatCompletion>(
        () => this.client.chat.completions.create(params, requestOptions),
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

    const content = choice.message.content ?? '';
    const reasoningTokens = completion.usage?.completion_tokens_details?.reasoning_tokens;
    /**
     * Any JSON-shaped request, with no tools — `json_object` as well as
     * `json_schema`.
     *
     * Deliberately wider than the `json_schema`-only test this replaced. A
     * caller asking for `json_object` wants parseable JSON just as much as one
     * supplying a schema, and truncated JSON is unusable under either — but the
     * narrow test meant the orchestrator's planner (which requests
     * `json_object`) sailed through the guard, failed `JSON.parse`, spent a
     * clarifying retry into the same cap, and surfaced as the misleading
     * `planner_parse_failed` (#594).
     */
    const wantsParseableJson =
      (options.responseFormat?.type === 'json_object' ||
        options.responseFormat?.type === 'json_schema') &&
      !options.tools?.length;

    // Truncation guard. For reasoning models (o-series, gpt-5) the
    // `max_completion_tokens` cap covers reasoning tokens AND visible
    // output combined; when reasoning consumes the entire budget the
    // API returns `finish_reason: 'length'` with empty content. Without
    // this check we'd silently emit `''` and downstream steps would
    // mistake the void for a valid empty result — what bit the audit
    // workflow in production. Raise it as a retriable provider error
    // so the operator sees a clear "raise maxTokens" message in the
    // step trace instead of a mysterious downstream validation loop.
    //
    // A structured extraction needs the wider rule (matching the Anthropic
    // adapter, which has always had it): reasoning usually eats *most* of the
    // budget rather than all of it, leaving a few hundred tokens of an object
    // cut off mid-string. Content is non-empty, so the empty-content test
    // above cannot see it, and the partial JSON then fails to parse and reads
    // as a schema violation — sending the operator to fix a schema that was
    // never wrong (#587). Truncated JSON is never usable, so any `length`
    // stop during extraction is a truncation.
    if (
      choice.finish_reason === 'length' &&
      ((wantsParseableJson && !isCompleteJson(content)) ||
        (content.length === 0 && toolCalls.length === 0))
    ) {
      const cap =
        (params as { max_completion_tokens?: number; max_tokens?: number }).max_completion_tokens ??
        (params as { max_tokens?: number }).max_tokens;
      const reasoningNote =
        reasoningTokens !== undefined
          ? ` Reasoning consumed ${reasoningTokens} tokens of the ${cap ?? 'configured'} budget.`
          : '';
      throw new ProviderError(
        `Model "${options.model}" hit max_completion_tokens before producing ${
          wantsParseableJson ? 'a complete structured response' : 'visible output'
        }.${reasoningNote} Raise the agent/step maxTokens (current cap: ${cap ?? 'unset'}).`,
        {
          code: 'truncated_no_output',
          retriable: false,
          // The call was billed in full even though it produced nothing
          // usable — carry it so the caller's error path can still cost it.
          // Omitted entirely when the host reported nothing: a zeroed row
          // would tell the cost dashboard this turn was free, which is a
          // worse lie than the missing row it replaced.
          ...(completion.usage
            ? {
                usage: {
                  inputTokens: completion.usage.prompt_tokens ?? 0,
                  outputTokens: completion.usage.completion_tokens ?? 0,
                },
              }
            : {}),
        }
      );
    }

    const response: LlmResponse = {
      content,
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
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
      stream = await this.client.chat.completions.create(params, buildRequestOptions(options));
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
    /**
     * Any JSON-shaped request (`json_schema` OR `json_object`), with no tools.
     * See the non-streaming guard for why this is wider than the schema-only
     * test it replaced (#594).
     */
    const wantsParseableJson =
      (options.responseFormat?.type === 'json_object' ||
        options.responseFormat?.type === 'json_schema') &&
      !options.tools?.length;
    // Accumulated for any JSON-shaped request, so the truncation guard after
    // the loop can tell a complete object that ended at the cap from one cut
    // off mid-value. Bounded by maxTokens.
    //
    // This condition MUST match the guard's. When it was the narrower
    // schema-only test while the guard asked the wider question, a
    // `json_object` stream left this empty, `isCompleteJson('')` is false, and
    // the guard fired on every `length` finish — including complete JSON.
    let structuredText = '';

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
          if (wantsParseableJson) structuredText += choice.delta.content;
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
      // Usually still 0 here — this API reports usage in a final chunk, so an
      // error before it has nothing to attach and the helper drops the zeroes
      // rather than logging the turn as free. A gateway that streams usage
      // earlier gets the same treatment as Anthropic, for free (#592).
      throw toProviderErrorWithUsage(err, 'OpenAI-compatible stream iteration failed', {
        inputTokens,
        outputTokens,
      });
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

    // Mirror the non-streaming extraction guard (and the Anthropic streaming
    // one): a `length` stop during structured extraction means the JSON
    // already yielded as text chunks is incomplete, and incomplete JSON is
    // not usable at any cap. Surface it before the `done` chunk rather than
    // letting the consumer treat partial JSON as a finished answer (#587).
    // `streaming-handler.ts` forwards an agent's configured responseFormat on
    // this path whenever the turn has no tools, so this is a live route.
    if (finishReason === 'length' && wantsParseableJson && !isCompleteJson(structuredText)) {
      const cap =
        (params as { max_completion_tokens?: number; max_tokens?: number }).max_completion_tokens ??
        (params as { max_tokens?: number }).max_tokens;
      throw new ProviderError(
        `Model "${options.model}" hit max_completion_tokens before producing a complete structured response. Raise the agent/step maxTokens (current cap: ${cap ?? 'unset'}).`,
        // `stream_options.include_usage` asks for a final usage chunk, and
        // the loop above has already consumed it — but a local host or
        // gateway may ignore the option, in which case these are still 0 and
        // a zeroed cost row would read as "this turn was free".
        {
          code: 'truncated_no_output',
          retriable: false,
          ...(inputTokens > 0 || outputTokens > 0 ? { usage: { inputTokens, outputTokens } } : {}),
        }
      );
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

  async transcribe(
    audio: Blob | Buffer | ArrayBuffer | Uint8Array,
    options: TranscribeOptions
  ): Promise<TranscribeResponse> {
    logger.info('OpenAI-compatible transcribe request', {
      provider: this.name,
      model: options.model,
      hasLanguage: Boolean(options.language),
      isLocal: this.isLocal,
    });

    const filename = options.filename ?? 'audio.webm';
    const mimeType =
      options.mimeType ?? (audio instanceof Blob ? audio.type : 'application/octet-stream');

    let upload: Awaited<ReturnType<typeof toFile>>;
    try {
      upload = await toFile(audio, filename, mimeType ? { type: mimeType } : undefined);
    } catch (err) {
      throw toProviderError(err, 'failed to prepare audio upload');
    }

    let result: TranscriptionVerbose;
    try {
      result = await withRetry<TranscriptionVerbose>(
        () =>
          this.client.audio.transcriptions.create({
            file: upload,
            model: options.model,
            response_format: 'verbose_json',
            ...(options.language ? { language: options.language } : {}),
            ...(options.prompt ? { prompt: options.prompt } : {}),
          }),
        {
          maxRetries: this.maxRetries,
          isLocal: this.isLocal,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          operation: 'openai.audio.transcriptions.create',
        }
      );
    } catch (err) {
      throw toProviderError(err, 'OpenAI-compatible transcribe request failed');
    }

    return {
      text: result.text,
      durationMs: Math.round((result.duration ?? 0) * 1000),
      ...(result.language ? { language: result.language } : {}),
      model: options.model,
    };
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
    const tokenCap = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const profile = resolveParamProfile(options.model, this.name);
    const isReasoning = profile === 'openai-reasoning';

    // OpenAI's reasoning / gpt-5 families reject `max_tokens` (400:
    // "Unsupported parameter") and reject any temperature other than
    // the default 1. Branch on the resolved param profile.
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: options.model,
      messages: messages.map(toSdkMessage),
      ...(isReasoning ? { max_completion_tokens: tokenCap } : { max_tokens: tokenCap }),
    };
    // Skip the temperature send for reasoning models — they only
    // accept the default. Legacy chat models honour any value the
    // caller supplied.
    if (!isReasoning && options.temperature !== undefined) {
      params.temperature = options.temperature;
    }
    // `reasoning_effort` is only honoured by the reasoning family. The
    // OpenAI SDK types only widen to include it on reasoning models, so
    // we cast through a Record<string, unknown> for the field set. Non-
    // reasoning models drop the field silently — no 400, mirrors how
    // unsupported `max_tokens` was previously the trap.
    //
    // Within the reasoning family, the per-model accepted enum varies:
    // o-series rejects `'minimal'` (which gpt-5 added), so we filter
    // the value against `supportedReasoningEfforts()` before sending.
    // Caller intent is still recorded on the trace's requestParams so
    // a misconfigured "minimal on o3-mini" is visible after the fact.
    if (isReasoning && options.reasoningEffort !== undefined) {
      const accepted = supportedReasoningEfforts(options.model, this.name);
      if (accepted.has(options.reasoningEffort)) {
        (params as unknown as Record<string, unknown>).reasoning_effort = options.reasoningEffort;
      }
    }
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
    if (part.type === 'document') {
      // PDFs use OpenAI's native `file` content part — Chat Completions
      // gained inline PDF support in late 2024. The model reads both
      // the text layer and renders each page as an image. 32 MB / 100-
      // page inline cap; Sunrise's 5 MB per-attachment ceiling keeps
      // us well below either limit, so no Files-API upload path is
      // needed for v1.
      if (part.source.mediaType === 'application/pdf') {
        return {
          type: 'file' as const,
          file: {
            filename: part.name,
            file_data: `data:application/pdf;base64,${part.source.data}`,
          },
        };
      }
      // Non-PDF documents (txt/csv/md/docx): no native shape — decode
      // the base64 as UTF-8 and emit as a text part. Works cleanly for
      // text formats; docx round-trips as garbage but the picker only
      // surfaces image + PDF MIMEs in v1, so this is a defensive
      // fallback for callers that bypass the picker.
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
