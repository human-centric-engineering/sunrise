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
  acceptsNativeStructuredOutput,
  acceptsSamplingTemperature,
  acceptsThinkingBudget,
  anthropicAdaptiveEffort,
  anthropicThinkingBudget,
  refusesForcedToolChoice,
  supportsReasoningEffort,
} from '@/lib/orchestration/llm/model-heuristics';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
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
  LlmReasoningBlock,
  LlmResponse,
  LlmToolCall,
  LlmToolChoice,
  ModelInfo,
  ProviderConfig,
  StreamChunk,
} from '@/lib/orchestration/llm/types';
import { getTextContent } from '@/lib/orchestration/llm/types';
import { isCompleteJson } from '@/lib/orchestration/llm/json-completeness';

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
      // Refuse redirects (#635), for the same reason as `openai-compatible.ts`
      // and with a sharper edge. This constructor passes no `baseURL`, which
      // looks like "it can only reach Anthropic" — and is wrong: the SDK
      // defaults `baseURL` to `readEnv('ANTHROPIC_BASE_URL')`, so pointing this
      // client at a gateway (LiteLLM, a Bedrock/Vertex proxy) is a one-env-var
      // change an operator may well have made.
      //
      // Worse than the OpenAI case if that host redirects: Anthropic
      // authenticates with `x-api-key`, a CUSTOM header name, and the fetch
      // spec strips only `Authorization`, `Cookie` and `Proxy-Authorization`
      // cross-origin. So the second host would receive the prompt AND the key.
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
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

    const requestOptions = buildRequestOptions(options);

    let message: Message;
    try {
      message = await withRetry<Message>(
        () => this.client.messages.create(params, requestOptions),
        {
          maxRetries: this.maxRetries,
          isLocal: this.isLocal,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          operation: 'anthropic.messages.create',
        }
      );
    } catch (err) {
      throw toProviderError(err, 'Anthropic chat request failed');
    }

    const content: string[] = [];
    const toolCalls: LlmToolCall[] = [];
    const reasoning: LlmReasoningBlock[] = [];
    let extracted: string | undefined;
    // Gates the extraction-tool -> JSON-text conversion below. True only when
    // buildBaseParams installed the extraction tool; a `json_schema` request
    // sent as native structured output comes back as ordinary text.
    const isStructuredExtraction = installsExtractionTool(params) && !options.tools?.length;
    /**
     * Any JSON-shaped request, for the truncation guard only — `json_object`
     * as well as `json_schema`.
     *
     * Anthropic has no native JSON mode, so `json_object` is just an
     * instruction and its output arrives as ordinary text. A cut-off response
     * is therefore a partial JSON string in `joinedContent`: non-empty, so the
     * empty-output test below cannot see it, and it then fails to parse
     * downstream and reads as a malformed answer rather than a truncation
     * (#594).
     */
    const wantsParseableJson =
      (options.responseFormat?.type === 'json_object' ||
        options.responseFormat?.type === 'json_schema') &&
      !options.tools?.length;

    for (const block of message.content) {
      if (block.type === 'text') {
        content.push(block.text);
      } else if (block.type === 'thinking') {
        reasoning.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
      } else if (block.type === 'redacted_thinking') {
        reasoning.push({ type: 'redacted_thinking', data: block.data });
      } else if (block.type === 'tool_use') {
        if (isStructuredExtraction && block.name.startsWith(EXTRACTION_TOOL_PREFIX)) {
          // Structured output extraction — convert tool arguments to JSON text
          extracted = JSON.stringify(block.input);
        } else {
          toolCalls.push(toolUseBlockToToolCall(block));
        }
      }
    }

    // The extraction tool's arguments are the whole result. With the tool
    // offered under `auto` (thinking on), the model may also write a line of
    // text before calling it; joining that in would break the JSON.
    const joinedContent = extracted ?? content.join('');

    // Truncation guard. Anthropic returns `stop_reason: 'max_tokens'`
    // when the model hits the cap; with extended thinking turned on
    // the budget can be entirely consumed by thinking blocks (which
    // we do not surface as text), leaving `joinedContent` empty. Same
    // shape as the OpenAI-compatible guard — surface as a clear
    // provider error so the operator sees a "raise maxTokens" message
    // instead of a silent empty-output step that confuses downstream.
    //
    // The structured-extraction path needs special handling: a truncated
    // forced-tool input is still routed into `content` as a partial JSON
    // string (so `joinedContent.length === 0` is false), but that partial
    // JSON won't parse. Treat ANY max_tokens stop on the extraction path as
    // a truncation rather than letting it degrade into a confusing
    // malformed-JSON failure (and a wasted retry) downstream.
    // Completeness applies to `json_object` but NOT to the extraction path:
    // there the payload is rebuilt via `JSON.stringify` from the forced tool's
    // already-parsed input, so even a truncated one is valid JSON and a parse
    // gate would disable the guard entirely. For `json_object` the text is the
    // model's raw output and IS checkable — and without this the adapter threw
    // on a complete object that merely ended at the cap, where the
    // OpenAI-compatible adapter returns it. Two adapters disagreeing about the
    // same response is the divergence #594 set out to remove.
    const truncatedJson =
      wantsParseableJson && (isStructuredExtraction || !isCompleteJson(joinedContent));
    if (
      message.stop_reason === 'max_tokens' &&
      (truncatedJson || (joinedContent.length === 0 && toolCalls.length === 0))
    ) {
      const cap = (params as { max_tokens?: number }).max_tokens;
      throw new ProviderError(
        `Model "${options.model}" hit max_tokens before producing ${
          truncatedJson ? 'a complete structured response' : 'visible output'
        }. Raise the agent/step maxTokens (current cap: ${cap ?? 'unset'}).`,
        {
          code: 'truncated_no_output',
          retriable: false,
          // Billed in full despite producing nothing usable — carry it so the
          // caller's error path can still cost it.
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
          },
        }
      );
    }

    const response: LlmResponse = {
      content: joinedContent,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
      model: message.model,
      finishReason: isStructuredExtraction ? 'stop' : mapStopReason(message.stop_reason),
    };
    if (toolCalls.length > 0) response.toolCalls = toolCalls;
    if (reasoning.length > 0) response.reasoning = reasoning;
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
      stream = await this.client.messages.create(params, buildRequestOptions(options));
    } catch (err) {
      throw toProviderError(err, 'Anthropic chat stream failed');
    }

    // Gates the extraction-tool -> text conversion below; true only when
    // buildBaseParams installed the extraction tool.
    const isStructuredExtraction = installsExtractionTool(params) && !options.tools?.length;
    /** Any JSON-shaped request, for the truncation guard only (#594). */
    const wantsParseableJson =
      (options.responseFormat?.type === 'json_object' ||
        options.responseFormat?.type === 'json_schema') &&
      !options.tools?.length;
    // Raw text accumulated for the `json_object` completeness test below. Only
    // collected when the guard will actually consult it, and bounded by
    // maxTokens. MUST cover exactly what the guard tests: when an accumulator
    // is narrower than its guard, the guard reads an empty string,
    // `isCompleteJson('')` is false, and it fires on every capped turn.
    let streamedText = '';
    // On the extraction path, text is held back rather than streamed: if the
    // model calls the extraction tool, its arguments are the whole result and
    // the text is dropped (it is only a preamble, possible under `auto`); if
    // it never calls the tool, the text is released at the end.
    let heldText = '';
    let extractedViaTool = false;

    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: LlmFinishReason = 'stop';

    // Buffered tool-use blocks by `content_block` index — Anthropic streams
    // `input_json_delta` fragments that we assemble into a single tool call.
    const toolBuffers = new Map<number, { id: string; name: string; partial: string }>();
    // Thinking blocks by `content_block` index, assembled from
    // `thinking_delta` / `signature_delta` events and handed back on `done`
    // in index order, so a tool loop can replay them unchanged.
    const reasoningBlocks = new Map<number, LlmReasoningBlock>();

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
            } else if (block.type === 'thinking') {
              reasoningBlocks.set(event.index, {
                type: 'thinking',
                thinking: block.thinking,
                signature: block.signature,
              });
            } else if (block.type === 'redacted_thinking') {
              reasoningBlocks.set(event.index, { type: 'redacted_thinking', data: block.data });
            }
            break;
          }

          case 'content_block_delta': {
            if (event.delta.type === 'text_delta') {
              if (wantsParseableJson) streamedText += event.delta.text;
              if (isStructuredExtraction) heldText += event.delta.text;
              else yield { type: 'text', content: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              const buf = toolBuffers.get(event.index);
              if (buf) buf.partial += event.delta.partial_json;
            } else if (event.delta.type === 'thinking_delta') {
              const block = reasoningBlocks.get(event.index);
              if (block?.type === 'thinking') block.thinking += event.delta.thinking;
            } else if (event.delta.type === 'signature_delta') {
              const block = reasoningBlocks.get(event.index);
              if (block?.type === 'thinking') block.signature = event.delta.signature;
            }
            break;
          }

          case 'content_block_stop': {
            const buf = toolBuffers.get(event.index);
            if (buf) {
              if (isStructuredExtraction && buf.name.startsWith(EXTRACTION_TOOL_PREFIX)) {
                // Structured output — emit the JSON as text content
                const parsed = safeParseJson(buf.partial);
                extractedViaTool = true;
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
      // Carry what the stream has already been billed for — `inputTokens`
      // lands at `message_start` and `outputTokens` updates on every
      // `message_delta`, so a mid-stream failure knows its own cost (#592).
      throw toProviderErrorWithUsage(err, 'Anthropic stream iteration failed', {
        inputTokens,
        outputTokens,
      });
    }

    // Mirror the non-streaming truncation guard: a max_tokens stop on a
    // JSON-shaped request means the output is incomplete — either a forced
    // extraction tool's input was cut off (so the JSON already emitted as a
    // `text` chunk is partial), or a `json_object` response stopped mid-object.
    // Surface the actionable error before the `done` chunk instead of letting
    // the consumer treat a garbage structured result as success.
    // (`mapStopReason('max_tokens')` is `'length'`.)
    // Same asymmetry as the non-streaming guard: cap alone for the extraction
    // path, cap AND incomplete text for `json_object`.
    if (
      finishReason === 'length' &&
      wantsParseableJson &&
      (isStructuredExtraction || !isCompleteJson(streamedText))
    ) {
      const cap = (params as { max_tokens?: number }).max_tokens;
      throw new ProviderError(
        `Model "${options.model}" hit max_tokens before producing a complete structured response. Raise the agent/step maxTokens (current cap: ${cap ?? 'unset'}).`,
        {
          code: 'truncated_no_output',
          retriable: false,
          // Only when the stream actually reported usage — a zeroed cost row
          // would tell the dashboard this turn was free.
          ...(inputTokens > 0 || outputTokens > 0 ? { usage: { inputTokens, outputTokens } } : {}),
        }
      );
    }

    if (isStructuredExtraction && !extractedViaTool && heldText) {
      yield { type: 'text', content: heldText };
    }

    const reasoning = [...reasoningBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => block);
    yield {
      type: 'done',
      usage: { inputTokens, outputTokens },
      finishReason: isStructuredExtraction ? 'stop' : finishReason,
      ...(reasoning.length > 0 ? { reasoning } : {}),
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
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const params: Omit<MessageCreateParamsNonStreaming, 'stream'> = {
      model: options.model,
      max_tokens: maxTokens,
      messages: [],
    };
    // Extended thinking — Claude Opus 4+ and Sonnet 4.5+ think. We
    // translate the platform-neutral `reasoningEffort` bucket via the
    // heuristics in model-heuristics. Models from Opus 4.7 / Sonnet 5 on
    // refuse a token budget (400) and take adaptive thinking, with depth
    // set by `output_config.effort`; there `minimal` sends the lowest
    // effort and no `thinking` field, since several of them can't turn
    // thinking off. The older models take a budget, and three rules apply:
    //
    //   1. Drop silently when the model doesn't support thinking — no
    //      400, mirroring how unsupported max_tokens used to trap us
    //      before the param-profile rewrite.
    //   2. Clamp the budget so visible output always has ≥ 1024 tokens
    //      to work with. Without the clamp, a high effort on a small
    //      max_tokens would leave no room for the actual reply.
    //   3. With thinking enabled, Anthropic requires `temperature = 1`.
    //      We omit the temperature send entirely in that case, mirroring
    //      how openai-compatible drops temperature on reasoning models.
    let thinkingEnabled = false;
    const effort = supportsReasoningEffort(options.model, this.name, 'anthropic')
      ? options.reasoningEffort
      : undefined;
    if (effort !== undefined && !acceptsThinkingBudget(options.model)) {
      if (effort !== 'minimal') {
        params.thinking = { type: 'adaptive' };
        thinkingEnabled = true;
      }
      params.output_config = { effort: anthropicAdaptiveEffort(effort) };
    } else if (effort !== undefined) {
      const rawBudget = anthropicThinkingBudget(effort);
      if (rawBudget !== undefined) {
        // Anthropic constraints:
        //   - `budget_tokens` MUST be ≥ 1024 (Anthropic API minimum).
        //   - `budget_tokens` MUST be < `max_tokens` (thinking + visible
        //     output share the cap).
        //   - We additionally insist on a 1024-token visible-output
        //     floor so the model has room to actually answer after
        //     thinking.
        //
        // Combined: send thinking only if `max_tokens >= 1024 (min budget)
        // + 1024 (visible floor) = 2048`. Below that, drop silently —
        // sending `budget_tokens < 1024` would be a guaranteed 400, and
        // sending the bare minimum with no visible-output room would
        // truncate the reply.
        const MIN_THINKING_BUDGET = 1024;
        const VISIBLE_OUTPUT_FLOOR = 1024;
        const maxAllowedBudget = maxTokens - VISIBLE_OUTPUT_FLOOR;
        if (maxAllowedBudget >= MIN_THINKING_BUDGET) {
          // `rawBudget` is one of {1024, 4096, 16384} — all ≥ MIN_THINKING_BUDGET.
          // `maxAllowedBudget` is ≥ MIN_THINKING_BUDGET by the branch
          // guard. Their min is therefore ≥ MIN_THINKING_BUDGET too.
          const budget = Math.min(rawBudget, maxAllowedBudget);
          // The Anthropic SDK type union narrows `thinking` to two
          // shapes; we cast through unknown so a future SDK version
          // that adds a field doesn't force a churn here.
          (params as unknown as Record<string, unknown>).thinking = {
            type: 'enabled',
            budget_tokens: budget,
          };
          thinkingEnabled = true;
        }
        // maxAllowedBudget < MIN_THINKING_BUDGET → max_tokens too small
        // to fit Anthropic's minimum budget alongside the visible-output
        // floor. Drop thinking entirely. The caller's intent is still
        // visible on the trace's `requestParams.reasoningEffort`.
      }
      // rawBudget === undefined → reasoningEffort === 'minimal' on
      // Anthropic, which deliberately means "no extended thinking".
    }
    // Split after thinking is settled: a dangling tool call before an
    // opener only has to go when this request thinks.
    const { system, conversation } = splitSystemMessages(messages, thinkingEnabled);
    params.messages = conversation;
    if (system) params.system = system;
    // Claude models from Opus 4.7 / Sonnet 5 / Haiku 5 on refuse any
    // temperature (400), so it is sent only to the older families that
    // honour one. The caller's value stays on the trace's requestParams.
    if (
      !thinkingEnabled &&
      options.temperature !== undefined &&
      acceptsSamplingTemperature(options.model)
    ) {
      params.temperature = options.temperature;
    }
    // Anthropic refuses a forced tool alongside thinking, and Opus 5.5 /
    // Sonnet 5.5 / Fable 5.1 refuse one outright — both a 400.
    const forcedToolRefusal = thinkingEnabled
      ? 'thinking'
      : refusesForcedToolChoice(options.model)
        ? 'model_refuses_forced_tool_choice'
        : undefined;
    if (options.tools?.length) {
      params.tools = options.tools.map<Tool>((t) => ({
        name: t.name,
        description: t.description,
        input_schema: buildToolInputSchema(t.parameters),
      }));
      const toolChoice = mapToolChoice(options.toolChoice);
      // Where a forced tool would be refused, send `auto`, which keeps the
      // tool on offer. No instruction is added to the system prompt: in a
      // tool loop the next request would then carry a different system
      // prompt, which invalidates the thinking blocks it replays.
      if (toolChoice?.type === 'tool' && forcedToolRefusal) {
        logger.info('Anthropic: forced tool choice sent as auto', {
          provider: this.name,
          model: options.model,
          tool: toolChoice.name,
          reason: forcedToolRefusal,
        });
        params.tool_choice = { type: 'auto' };
      } else if (toolChoice) {
        params.tool_choice = toolChoice;
      }
    }
    // Structured output, only when no other tools are present (structured
    // output and regular tool use are mutually exclusive per turn).
    //
    // Models that take native structured output get `output_config.format`:
    // no tool, so nothing to clash with thinking or with a model that refuses
    // a forced `tool_choice`, and the JSON arrives as ordinary text. The rest
    // get the extraction pattern: a tool carrying the schema, whose arguments
    // are read back as the structured result. That tool is forced unless a
    // forced tool would be refused — there it is offered with `auto` and the
    // system prompt asks for it, which is safe because a structured-output
    // request is a single turn with no tool loop.
    if (options.responseFormat && !options.tools?.length) {
      if (options.responseFormat.type === 'json_schema') {
        const inputSchema = buildToolInputSchema(options.responseFormat.schema);
        const acceptsNative = acceptsNativeStructuredOutput(options.model);
        const nativeSchema = acceptsNative ? toNativeOutputSchema(inputSchema) : undefined;
        if (acceptsNative && !nativeSchema) {
          logger.info('Anthropic: structured output sent through the extraction tool', {
            provider: this.name,
            model: options.model,
            reason: 'schema_not_native_safe',
          });
        }
        if (nativeSchema) {
          params.output_config = {
            ...params.output_config,
            format: { type: 'json_schema', schema: nativeSchema },
          };
        } else {
          const extractionToolName = buildExtractionToolName(options.responseFormat.name);
          params.tools = [
            {
              name: extractionToolName,
              description: `Extract structured data matching the ${options.responseFormat.name} schema.`,
              input_schema: inputSchema,
            },
          ];
          if (forcedToolRefusal) {
            logger.info('Anthropic: forced tool choice sent as auto', {
              provider: this.name,
              model: options.model,
              tool: extractionToolName,
              reason: forcedToolRefusal,
            });
            params.tool_choice = { type: 'auto' };
            const instruction = `Respond only by calling the ${extractionToolName} tool with the result.`;
            params.system = system ? `${system}\n\n${instruction}` : instruction;
          } else {
            params.tool_choice = { type: 'tool', name: extractionToolName };
          }
        }
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

function splitSystemMessages(
  messages: LlmMessage[],
  thinkingEnabled: boolean
): {
  system: string | undefined;
  conversation: MessageParam[];
} {
  const systemParts: string[] = [];
  const conversation: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system' && msg.turnInstruction) {
      // Hoisting this one would leave the request ending on whatever came
      // before it: nothing (a 400), an assistant reply (read as a prefill), or
      // a tool result continuing a turn whose thinking was not kept. Anthropic
      // only takes a user turn last, so send it as one, framed so the model
      // does not read it as the person's words.
      const text = getTextContent(msg.content);
      if (!text) continue;
      if (thinkingEnabled) closeUnthinkingToolTurn(conversation);
      conversation.push({ role: 'user', content: `${TURN_INSTRUCTION_HEADING}\n\n${text}` });
      continue;
    }
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
            content: neutraliseTurnInstructionHeading(getTextContent(msg.content), 'tool'),
          },
        ],
      });
      continue;
    }
    if (msg.role === 'assistant' && (msg.toolCalls?.length || msg.reasoning?.length)) {
      // Thinking blocks go back first and unchanged, signatures included:
      // a tool loop on a thinking model must replay them on the turn it
      // continues.
      const blocks: ContentBlockParam[] = (msg.reasoning ?? []).map(toReasoningBlockParam);
      const text = getTextContent(msg.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of msg.toolCalls ?? []) {
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
      conversation.push({
        role: msg.role,
        content: msg.role === 'user' ? neutraliseTextBlocks(blocks) : blocks,
      });
      continue;
    }
    conversation.push({
      role: msg.role,
      content:
        msg.role === 'user' ? neutraliseTurnInstructionHeading(msg.content, 'user') : msg.content,
    });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    conversation,
  };
}

/** Heads a `turnInstruction` sent as a user turn, so it is not read as the person's. */
const TURN_INSTRUCTION_HEADING = '[Instruction from the application, not a message from the user]';

/**
 * The heading as someone might copy it, matched against `foldForMatching`
 * text: any case or spacing, full-width or bracketed differently, with or
 * without its brackets or second clause. The words stop at a closing bracket
 * so they cannot close the re-worded frame early.
 */
const FORGED_HEADING =
  /(?:[[(\u3010\u3014\u3016]\s*)?(instruction\s+from\s+the\s+application\w*[^\])\n\u3011\u3015\u3017]*)[\])\u3011\u3015\u3017]?/g;

/** Zero-width and other invisible format characters (soft hyphen, joiners). */
const FORMAT_CHAR = /\p{Cf}/u;

const FORGED_SOURCE = { user: 'typed by the user', tool: 'written in a tool result' } as const;

/**
 * Re-word any copy of `TURN_INSTRUCTION_HEADING` in text the application did
 * not write (a person's message, a tool result), so it cannot pass as an
 * instruction from the application. Only a `turnInstruction` opener carries
 * the heading as written.
 */
function neutraliseTurnInstructionHeading(
  text: string,
  source: keyof typeof FORGED_SOURCE
): string {
  const { folded, origin } = foldForMatching(text);
  let out = '';
  let copied = 0;
  for (const match of folded.matchAll(FORGED_HEADING)) {
    const start = match.index ?? 0;
    const wordsStart = start + match[0].indexOf(match[1]);
    const words = text
      .slice(origin[wordsStart], origin[wordsStart + match[1].length])
      .replace(/\p{Cf}/gu, '')
      .trim();
    out += `${text.slice(copied, origin[start])}(${FORGED_SOURCE[source]}: ${words})`;
    copied = origin[start + match[0].length];
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * Lower-case, NFKC-normalise (full-width letters and brackets become ASCII)
 * and drop invisible format characters, keeping for each folded UTF-16 unit
 * the index in `text` it came from (`origin[folded.length]` is the end).
 */
function foldForMatching(text: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    if (!FORMAT_CHAR.test(char)) {
      const unit = char.normalize('NFKC').toLowerCase();
      folded += unit;
      for (let i = 0; i < unit.length; i++) origin.push(index);
    }
    index += char.length;
  }
  origin.push(text.length);
  return { folded, origin };
}

/**
 * Neutralise the text blocks of a user turn. Adjacent text blocks read as one
 * text, so a heading split across them is caught by joining the run; the run
 * is merged into one block only when that finds what the blocks alone miss.
 */
function neutraliseTextBlocks(blocks: ContentBlockParam[]): ContentBlockParam[] {
  const result: ContentBlockParam[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const each = run.map((text) => neutraliseTurnInstructionHeading(text, 'user'));
    const joined = neutraliseTurnInstructionHeading(run.join(''), 'user');
    if (each.join('') === joined)
      result.push(...each.map((text) => ({ type: 'text' as const, text })));
    else result.push({ type: 'text', text: joined });
    run = [];
  };
  for (const block of blocks) {
    if (block.type === 'text') {
      run.push(block.text);
    } else {
      flush();
      result.push(block);
    }
  }
  flush();
  return result;
}

/**
 * Close a tool call left unanswered by the assistant at the end of
 * `conversation` when its turn carries no thinking blocks, as a chat history
 * rebuilt from the database does (reasoning is not persisted). A user turn
 * appended straight after its results would sit in the same turn, which on a
 * thinking model is a continuation sent without its thinking. The `tool_use`
 * blocks and their results become a text note on the assistant turn, so the
 * model still knows the call ran (a pending approval is not repeated).
 */
function closeUnthinkingToolTurn(conversation: MessageParam[]): void {
  let resultsStart = conversation.length;
  while (resultsStart > 0 && isToolResultTurn(conversation[resultsStart - 1])) resultsStart--;
  if (resultsStart === conversation.length || resultsStart === 0) return;

  const assistant = conversation[resultsStart - 1];
  if (assistant.role !== 'assistant' || !Array.isArray(assistant.content)) return;
  if (
    assistant.content.some(
      (block) => block.type === 'thinking' || block.type === 'redacted_thinking'
    )
  ) {
    return;
  }

  const results = new Map<string, string>();
  for (const turn of conversation.slice(resultsStart)) {
    if (!Array.isArray(turn.content)) continue;
    for (const block of turn.content) {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        results.set(block.tool_use_id, block.content);
      }
    }
  }
  const kept: ContentBlockParam[] = [];
  const notes: string[] = [];
  for (const block of assistant.content) {
    if (block.type === 'tool_use') {
      notes.push(`[Called ${block.name}; result: ${results.get(block.id) ?? '(none)'}]`);
    } else {
      kept.push(block);
    }
  }
  kept.push({ type: 'text', text: notes.join('\n') });
  conversation.splice(resultsStart - 1, conversation.length, {
    role: 'assistant',
    content: kept,
  });
}

function isToolResultTurn(msg: MessageParam): boolean {
  return (
    msg.role === 'user' &&
    Array.isArray(msg.content) &&
    msg.content.length > 0 &&
    msg.content.every((block) => block.type === 'tool_result')
  );
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
              'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
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

function toReasoningBlockParam(block: LlmReasoningBlock): ContentBlockParam {
  return block.type === 'thinking'
    ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
    : { type: 'redacted_thinking', data: block.data };
}

/** Did buildBaseParams install the structured-output extraction tool? */
function installsExtractionTool(params: { tools?: ReadonlyArray<object> }): boolean {
  const only = params.tools?.length === 1 ? params.tools[0] : undefined;
  return (
    only !== undefined &&
    'name' in only &&
    typeof only.name === 'string' &&
    only.name.startsWith(EXTRACTION_TOOL_PREFIX)
  );
}

/** String formats native structured output accepts. */
const NATIVE_STRING_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/**
 * Rewrite a tool input schema into the subset native structured output
 * accepts: `additionalProperties: false` on every object, `oneOf` as
 * `anyOf`, and any keyword it rejects (numeric and length constraints,
 * patterns, unknown formats) moved into the node's description so the
 * model still reads it. `enum` and `const` are kept.
 *
 * Returns `undefined` — so the caller keeps the extraction tool, which takes
 * the schema as written — for a schema native output would change the
 * meaning of or may reject: an open object (no `properties`, or an
 * `additionalProperties` other than `false`, which closing would silently
 * empty), a union `type` array, a `$ref` (recursion is unsupported), a
 * tuple `items`, or a node with no `type` and no `anyOf` / `allOf` /
 * `enum` / `const`.
 *
 * Not the SDK's `transformJSONSchema`: that moves `enum` and `const` into
 * the description too, so the decoder would no longer enforce them.
 */
function toNativeOutputSchema(node: unknown): Record<string, unknown> | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const source = node as Record<string, unknown>;
  if ('$ref' in source || Array.isArray(source.type)) return undefined;

  const out: Record<string, unknown> = {};
  const moved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    switch (key) {
      case 'type':
      case 'title':
      case 'description':
      case 'enum':
      case 'const':
      case 'required':
        out[key] = value;
        break;
      case 'additionalProperties':
        if (value !== false) return undefined;
        break;
      case 'properties': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const properties: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(value)) {
          const converted = toNativeOutputSchema(child);
          if (!converted) return undefined;
          properties[name] = converted;
        }
        out.properties = properties;
        break;
      }
      case 'items': {
        const converted = toNativeOutputSchema(value);
        if (!converted) return undefined;
        out.items = converted;
        break;
      }
      case 'anyOf':
      case 'oneOf':
      case 'allOf': {
        if (!Array.isArray(value)) return undefined;
        const variants = value.map(toNativeOutputSchema);
        if (variants.some((v) => v === undefined)) return undefined;
        out[key === 'allOf' ? 'allOf' : 'anyOf'] = variants;
        break;
      }
      case 'format':
        if (typeof value === 'string' && NATIVE_STRING_FORMATS.has(value)) out.format = value;
        else moved[key] = value;
        break;
      case 'minItems':
        if (value === 0 || value === 1) out.minItems = value;
        else moved[key] = value;
        break;
      default:
        moved[key] = value;
    }
  }

  if (source.type === 'object') {
    if (out.properties === undefined) return undefined;
    out.additionalProperties = false;
  }
  if (
    out.type === undefined &&
    out.anyOf === undefined &&
    out.allOf === undefined &&
    out.enum === undefined &&
    out.const === undefined
  ) {
    return undefined;
  }
  if (Object.keys(moved).length > 0) {
    const note = `{${Object.entries(moved)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(', ')}}`;
    out.description = typeof out.description === 'string' ? `${out.description}\n\n${note}` : note;
  }
  return out;
}

function mapToolChoice(choice: LlmToolChoice | undefined): ToolChoice | undefined {
  if (!choice) return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  return { type: 'tool', name: choice.name };
}

/** Anthropic tool names must match `^[a-zA-Z0-9_-]{1,64}$`. */
const ANTHROPIC_TOOL_NAME_MAX = 64;
const EXTRACTION_TOOL_PREFIX = '__structured_';

/**
 * Build the forced-extraction tool name from a caller-supplied schema name.
 *
 * Anthropic rejects tool names outside `^[a-zA-Z0-9_-]{1,64}$` (OpenAI accepts
 * the raw `json_schema.name`, so this is an Anthropic-only divergence). Slugify
 * any disallowed character to `_` and truncate the suffix so the prefixed name
 * stays within the cap; the `__structured_` prefix is preserved because the
 * response handler keys on it to route the tool input back into `content`.
 */
function buildExtractionToolName(schemaName: string): string {
  const budget = ANTHROPIC_TOOL_NAME_MAX - EXTRACTION_TOOL_PREFIX.length;
  const slug = schemaName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, budget);
  // Fall back to a fixed suffix if the name slugified to nothing (e.g. all
  // disallowed characters), so the result is always a valid, prefixed name.
  return `${EXTRACTION_TOOL_PREFIX}${slug || 'output'}`;
}

function buildToolInputSchema(parameters: Record<string, unknown>): Tool.InputSchema {
  const { type, ...rest } = parameters;
  // Anthropic requires `type: 'object'` at the top level of a tool input
  // schema. A non-object root (top-level `array`, `oneOf`/`anyOf`, a `$ref`
  // wrapper) can't be represented here — silently coercing it to `object`
  // (the previous behaviour) produced an incoherent schema the model can't
  // satisfy. Reject it with a clear local error instead; callers should wrap
  // such shapes in an object property (see the object-rooted contract in
  // `parse-structured.ts`). A missing root `type` is still defaulted to
  // `object` — the common case for tool params and property-only schemas.
  if (type !== undefined && type !== 'object') {
    throw new ProviderError(
      `Anthropic tool / structured-output schemas must be object-rooted (got type: ${JSON.stringify(
        type
      )}). Wrap the value in an object property.`,
      { code: 'invalid_schema', retriable: false }
    );
  }
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
