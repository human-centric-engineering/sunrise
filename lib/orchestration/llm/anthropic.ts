/**
 * Anthropic Claude Provider
 *
 * Implements the `LlmProvider` interface against `@anthropic-ai/sdk`.
 * Responsible for translating our platform-neutral `LlmMessage`,
 * `LlmOptions`, `LlmResponse`, and `StreamChunk` dialect to and from
 * Anthropic's `Message`, `MessageParam`, `Tool`, and `RawMessageStreamEvent`
 * shapes.
 *
 * Anthropic is treated as a cloud provider — default 30s timeout,
 * exponential-backoff retries on 429/5xx via `withRetry`. We disable
 * the SDK's built-in retry (`maxRetries: 0`) so retry policy lives in
 * exactly one place.
 *
 * Embeddings are not supported: Anthropic has no first-party embedding
 * API (they delegate to Voyage), so `embed()` throws a non-retriable
 * `ProviderError`.
 *
 * Platform-agnostic: no Next.js imports.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  StopReason,
  Tool,
  ToolChoice,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { Stream } from '@anthropic-ai/sdk/core/streaming';

import { logger } from '@/lib/logging';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
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
  ProviderConfig,
  StreamChunk,
} from '@/lib/orchestration/llm/types';
import { getTextContent } from '@/lib/orchestration/llm/types';

/** Model used for cheap connectivity pings. */
const PING_MODEL = 'claude-haiku-4-5';

/** Default max_tokens when the caller doesn't supply one. */
const DEFAULT_MAX_TOKENS = 4096;

/** Hard-coded Claude family list. Pricing is also carried by model-registry. */
const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    tier: 'frontier',
    inputCostPerMillion: 15,
    outputCostPerMillion: 75,
    maxContext: 200_000,
    supportsTools: true,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    tier: 'mid',
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    maxContext: 200_000,
    supportsTools: true,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    tier: 'budget',
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    maxContext: 200_000,
    supportsTools: true,
  },
];

export class AnthropicProvider implements LlmProvider {
  public readonly name: string;
  public readonly isLocal: boolean;

  private readonly client: Anthropic;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: ProviderConfig) {
    if (!config.apiKey) {
      throw new ProviderError('AnthropicProvider requires an apiKey', {
        code: 'missing_api_key',
        retriable: false,
      });
    }
    this.name = config.name;
    this.isLocal = config.isLocal;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
  }

  async chat(messages: LlmMessage[], options: LlmOptions): Promise<LlmResponse> {
    const params = this.buildNonStreamingParams(messages, options);
    logger.info('Anthropic chat request', {
      provider: this.name,
      model: options.model,
      messageCount: messages.length,
      hasTools: Boolean(options.tools?.length),
    });

    let message: Message;
    try {
      message = await withRetry<Message>(() => this.client.messages.create(params), {
        maxRetries: this.maxRetries,
        isLocal: this.isLocal,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        operation: 'anthropic.messages.create',
      });
    } catch (err) {
      throw toProviderError(err, 'Anthropic chat request failed');
    }

    const content: string[] = [];
    const toolCalls: LlmToolCall[] = [];
    const isStructuredExtraction =
      options.responseFormat?.type === 'json_schema' && !options.tools?.length;

    for (const block of message.content) {
      if (block.type === 'text') {
        content.push(block.text);
      } else if (block.type === 'tool_use') {
        if (isStructuredExtraction && block.name.startsWith('__structured_')) {
          // Structured output extraction — convert tool arguments to JSON text
          content.push(JSON.stringify(block.input));
        } else {
          toolCalls.push(toolUseBlockToToolCall(block));
        }
      }
    }

    const response: LlmResponse = {
      content: content.join(''),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
      model: message.model,
      finishReason: isStructuredExtraction ? 'stop' : mapStopReason(message.stop_reason),
    };
    if (toolCalls.length > 0) response.toolCalls = toolCalls;
    return response;
  }

  async *chatStream(messages: LlmMessage[], options: LlmOptions): AsyncIterable<StreamChunk> {
    const params = this.buildStreamingParams(messages, options);
    logger.info('Anthropic chat stream request', {
      provider: this.name,
      model: options.model,
      messageCount: messages.length,
      hasTools: Boolean(options.tools?.length),
    });

    let stream: Stream<RawMessageStreamEvent>;
    try {
      stream = await this.client.messages.create(params);
    } catch (err) {
      throw toProviderError(err, 'Anthropic chat stream failed');
    }

    const isStructuredExtraction =
      options.responseFormat?.type === 'json_schema' && !options.tools?.length;

    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: LlmFinishReason = 'stop';

    // Buffered tool-use blocks by `content_block` index — Anthropic streams
    // `input_json_delta` fragments that we assemble into a single tool call.
    const toolBuffers = new Map<number, { id: string; name: string; partial: string }>();

    try {
      for await (const event of stream) {
        if (options.signal?.aborted) {
          throw new ProviderError('request aborted', { code: 'aborted', retriable: false });
        }

        switch (event.type) {
          case 'message_start':
            inputTokens = event.message.usage.input_tokens;
            break;

          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              toolBuffers.set(event.index, { id: block.id, name: block.name, partial: '' });
            }
            break;
          }

          case 'content_block_delta': {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', content: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              const buf = toolBuffers.get(event.index);
              if (buf) buf.partial += event.delta.partial_json;
            }
            break;
          }

          case 'content_block_stop': {
            const buf = toolBuffers.get(event.index);
            if (buf) {
              if (isStructuredExtraction && buf.name.startsWith('__structured_')) {
                // Structured output — emit the JSON as text content
                const parsed = safeParseJson(buf.partial);
                yield { type: 'text', content: JSON.stringify(parsed) };
              } else {
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: buf.id,
                    name: buf.name,
                    arguments: safeParseJson(buf.partial),
                  },
                };
              }
              toolBuffers.delete(event.index);
            }
            break;
          }

          case 'message_delta':
            if (event.delta.stop_reason) finishReason = mapStopReason(event.delta.stop_reason);
            if (event.usage?.output_tokens !== null && event.usage?.output_tokens !== undefined) {
              outputTokens = event.usage.output_tokens;
            }
            break;

          default:
            // message_stop, ping, etc. — no-op.
            break;
        }
      }
    } catch (err) {
      throw toProviderError(err, 'Anthropic stream iteration failed');
    }

    yield {
      type: 'done',
      usage: { inputTokens, outputTokens },
      finishReason: isStructuredExtraction ? 'stop' : finishReason,
    };
  }

  embed(
    _text: string,
    _options?: import('@/lib/orchestration/llm/types').EmbedOptions
  ): Promise<number[]> {
    return Promise.reject(
      new ProviderError('Anthropic does not provide a first-party embeddings API', {
        code: 'not_supported',
        retriable: false,
      })
    );
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(CLAUDE_MODELS.map((m) => ({ ...m })));
  }

  async testConnection(): Promise<ProviderTestResult> {
    try {
      await this.client.messages.create({
        model: PING_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true, models: CLAUDE_MODELS.map((m) => m.id) };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, models: [], error };
    }
  }

  // --- internal helpers ---

  private buildBaseParams(
    messages: LlmMessage[],
    options: LlmOptions
  ): Omit<MessageCreateParamsNonStreaming, 'stream'> {
    const { system, conversation } = splitSystemMessages(messages);
    const params: Omit<MessageCreateParamsNonStreaming, 'stream'> = {
      model: options.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: conversation,
    };
    if (system) params.system = system;
    if (options.temperature !== undefined) params.temperature = options.temperature;
    if (options.tools?.length) {
      params.tools = options.tools.map<Tool>((t) => ({
        name: t.name,
        description: t.description,
        input_schema: buildToolInputSchema(t.parameters),
      }));
      const toolChoice = mapToolChoice(options.toolChoice);
      if (toolChoice) params.tool_choice = toolChoice;
    }
    // Structured output: Anthropic doesn't support response_format natively.
    // We use a tool-based extraction pattern: define a tool with the schema,
    // force the model to use it, and extract the structured data from the
    // tool call arguments. This is only applied when no other tools are present
    // (structured output and regular tool use are mutually exclusive per turn).
    if (options.responseFormat && !options.tools?.length) {
      if (options.responseFormat.type === 'json_schema') {
        const extractionToolName = `__structured_${options.responseFormat.name}`;
        params.tools = [
          {
            name: extractionToolName,
            description: `Extract structured data matching the ${options.responseFormat.name} schema.`,
            input_schema: buildToolInputSchema(options.responseFormat.schema),
          },
        ];
        params.tool_choice = { type: 'tool', name: extractionToolName };
      } else if (options.responseFormat.type === 'json_object') {
        // For json_object mode, instruct the model via system message prefix
        // since Anthropic has no native JSON mode. The caller's system
        // instructions should already request JSON output.
      }
    }
    return params;
  }

  private buildNonStreamingParams(
    messages: LlmMessage[],
    options: LlmOptions
  ): MessageCreateParamsNonStreaming {
    return this.buildBaseParams(messages, options);
  }

  private buildStreamingParams(
    messages: LlmMessage[],
    options: LlmOptions
  ): MessageCreateParamsStreaming {
    return { ...this.buildBaseParams(messages, options), stream: true };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitSystemMessages(messages: LlmMessage[]): {
  system: string | undefined;
  conversation: MessageParam[];
} {
  const systemParts: string[] = [];
  const conversation: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = getTextContent(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === 'tool') {
      conversation.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId ?? '',
            content: getTextContent(msg.content),
          },
        ],
      });
      continue;
    }
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const blocks: ContentBlockParam[] = [];
      const text = getTextContent(msg.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of msg.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      conversation.push({ role: 'assistant', content: blocks });
      continue;
    }
    // Multimodal content — convert ContentPart[] to Anthropic blocks
    if (Array.isArray(msg.content)) {
      const blocks: ContentBlockParam[] = toAnthropicBlocks(msg.content);
      conversation.push({ role: msg.role, content: blocks });
      continue;
    }
    conversation.push({ role: msg.role, content: msg.content });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    conversation,
  };
}

/** Convert platform-neutral ContentPart[] to Anthropic ContentBlockParam[]. */
function toAnthropicBlocks(parts: ContentPart[]): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      if (part.source.type === 'base64') {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.source.mediaType as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: part.source.data,
          },
        });
      } else {
        blocks.push({
          type: 'image',
          source: { type: 'url', url: part.source.url },
        });
      }
    } else if (part.type === 'document') {
      // Anthropic supports native PDF via document blocks; for other
      // formats, fall back to text extraction (content should already
      // have been extracted by the chat handler before reaching here).
      if (part.source.mediaType === 'application/pdf') {
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: part.source.data,
          },
        });
      } else {
        // Non-PDF documents: treat extracted text as a text block
        blocks.push({
          type: 'text',
          text: `[Document: ${part.name}]\n${Buffer.from(part.source.data, 'base64').toString('utf-8')}`,
        });
      }
    }
  }
  return blocks;
}

function mapToolChoice(choice: LlmToolChoice | undefined): ToolChoice | undefined {
  if (!choice) return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  return { type: 'tool', name: choice.name };
}

function buildToolInputSchema(parameters: Record<string, unknown>): Tool.InputSchema {
  const { type: _type, ...rest } = parameters;
  // Anthropic requires `type: 'object'` at the top level; preserve any other JSON Schema keys.
  const schema: Tool.InputSchema = { type: 'object', ...rest };
  return schema;
}

function toolUseBlockToToolCall(block: ToolUseBlock): LlmToolCall {
  return {
    id: block.id,
    name: block.name,
    arguments: (block.input ?? {}) as Record<string, unknown>,
  };
}

function mapStopReason(reason: StopReason | null): LlmFinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'error';
    case null:
      return 'stop';
    default:
      return 'stop';
  }
}

function safeParseJson(partial: string): Record<string, unknown> {
  if (!partial) return {};
  try {
    const parsed = JSON.parse(partial) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    logger.warn('Failed to parse streamed tool_use JSON', { length: partial.length });
    return {};
  }
}
