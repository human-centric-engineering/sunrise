/**
 * OpenAI Responses API path
 *
 * The opt-in path `OpenAiCompatibleProvider` takes for an agent that has
 * OpenAI's own web search or code interpreter turned on
 * (`LlmOptions.providerTools`). OpenAI offers both on the Responses API;
 * Chat Completions has web search only on its search models, and no code
 * interpreter. So when the provider is OpenAI itself and the model takes one
 * of the tools, the request goes here, and every other request stays on Chat
 * Completions (see `usesResponsesApi`). Making Responses the OpenAI
 * default was rejected at planning (`f-orch-llm-providers`): it would move
 * every OpenAI agent's request and stream mapping at once.
 *
 * This module maps the platform-neutral types to and from the Responses wire
 * format; the provider class owns the client, retries and errors.
 *
 * - **Stateless.** Every request sends `store: false`, as Chat Completions
 *   stores nothing either, so the conversation is not kept on OpenAI's side.
 *   A tool loop therefore sends the earlier items back itself: the reasoning
 *   items (with their `encrypted_content`), the `web_search_call` items and
 *   the `code_interpreter_call` items travel on `LlmMessage.reasoning` as
 *   `openai_reasoning` / `openai_web_search_call` /
 *   `openai_code_interpreter_call` blocks and are replayed unchanged.
 *   Measured against the live API: leaving the search items out makes the
 *   model write raw citation markup into its answer, and a replayed code
 *   item keeps the next call in the same container.
 * - **Code interpreter** runs in an `auto` container with no network, which
 *   OpenAI reuses while a replayed item names it. Its runs are timed (from
 *   the stream's `interpreting` and `completed` events, or the request's
 *   time) and costed per container (`code-execution.ts`). Files it makes
 *   aren't delivered (owner ruling, t-956).
 * - **Sites are hosts.** OpenAI refuses a filter domain with a path (`400
 *   Invalid domain`), which Anthropic accepts. An entry's path is dropped, so
 *   a block list blocks the whole host and an allow list allows it (owner
 *   ruling, t-955). gpt-4o-mini and gpt-4.1-mini take no site list at all,
 *   so with one set they stay on Chat Completions without search.
 * - **The search limit caps each call**, not the reply as on Anthropic. See
 *   `buildResponsesParams` and the t-955 ruling on `f-orch-llm-providers`.
 * - **Reasoning summaries** are asked for on reasoning models and streamed as
 *   `reasoning` chunks. An organisation OpenAI has not verified gets a 400 for
 *   asking; the provider class retries without them
 *   (`isSummaryVerificationError`).
 * - **Reasoning OpenAI can't decrypt** is a 400 `invalid_encrypted_content`
 *   (measured on changed content). The provider class retries once without
 *   the reasoning items (`isUndecryptableReasoningError`), for a damaged
 *   checkpoint or a fallback onto another organisation's credential.
 * - **Dropped here:** `stopSequences`, which the Responses API does not take.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type {
  FunctionTool,
  Response,
  ResponseCodeInterpreterToolCall,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionWebSearch,
  ResponseIncludable,
  ResponseInputContent,
  ResponseInputItem,
  ResponseStreamEvent,
  Tool,
  ToolChoiceFunction,
  ToolChoiceOptions,
  WebSearchTool,
} from 'openai/resources/responses/responses';
import { z } from 'zod';

import { logger } from '@/lib/logging';
import { isRecord } from '@/lib/utils';
import { billCodeExecution, codeRunOf, type CodeRun } from '@/lib/orchestration/llm/code-execution';
import {
  acceptsFlexTier,
  acceptsOpenAiCodeInterpreter,
  acceptsOpenAiWebSearch,
  acceptsOpenAiWebSearchFilters,
  acceptsVerbosity,
  openAiReasoningEffort,
  reasoningModelAcceptsParallelToolCalls,
  supportedReasoningEfforts,
} from '@/lib/orchestration/llm/model-heuristics';
import { ProviderError, toProviderErrorWithUsage } from '@/lib/orchestration/llm/provider';
import {
  CODE_EXECUTION_USD_PER_HOUR,
  getTextContent,
  type ContentPart,
  type LlmFinishReason,
  type LlmMessage,
  type LlmOptions,
  type LlmReasoningBlock,
  type LlmResponse,
  type LlmToolCall,
  type LlmToolChoice,
  type LlmUsage,
  type StreamChunk,
  type WebSearchOptions,
} from '@/lib/orchestration/llm/types';

/** What the request builder needs to know about the provider and model. */
export interface ResponsesRequestContext {
  /** The provider's resolved param profile is `openai-reasoning`. */
  isReasoning: boolean;
  /** The provider's name, for `supportedReasoningEfforts`. */
  providerName: string;
  /** Ask for reasoning summaries (reasoning models only). */
  summaries: boolean;
  /** The cap sent as `max_output_tokens`. */
  tokenCap: number;
}

/** The provider, as the routing needs it. */
interface RouteContext {
  isOpenAiHost: boolean;
  isReasoning: boolean;
  providerName: string;
}

/**
 * Does this request take the Responses path? Only when the provider is OpenAI
 * itself, the request isn't structured output (text written around a tool
 * call would be joined into the JSON, as on Anthropic), and OpenAI would take
 * at least one of the provider tools it turns on ({@link takenProviderTools}).
 * The answer doesn't depend on how much of the search limit is left, so a
 * reply's tool loop stays on one API.
 */
export function usesResponsesApi(options: LlmOptions, context: RouteContext): boolean {
  if (!context.isOpenAiHost || options.responseFormat) return false;
  const taken = takenProviderTools(options, context);
  return taken.webSearch || taken.codeExecution;
}

/** Which of the request's provider tools OpenAI would take. */
export function takenProviderTools(
  options: LlmOptions,
  context: Omit<RouteContext, 'isOpenAiHost'>
): { webSearch: boolean; codeExecution: boolean } {
  const tools = options.providerTools;
  return {
    webSearch: tools?.webSearch !== undefined && webSearchRefusal(options, context) === undefined,
    codeExecution:
      tools?.codeExecution !== undefined && codeInterpreterRefusal(options, context) === undefined,
  };
}

/**
 * Why OpenAI would refuse this request's web search, or `undefined` when it
 * takes it: the model doesn't offer search, it can't take the site list set
 * (searching every site instead would widen what the admin restricted), or
 * the request would send `minimal` effort, which GPT-5 refuses search at.
 */
export function webSearchRefusal(
  options: LlmOptions,
  context: Omit<RouteContext, 'isOpenAiHost'>
): 'model' | 'site_filters' | 'minimal_effort' | undefined {
  const search = options.providerTools?.webSearch;
  if (!acceptsOpenAiWebSearch(options.model)) return 'model';
  if (
    (search?.allowedDomains?.length || search?.blockedDomains?.length) &&
    !acceptsOpenAiWebSearchFilters(options.model)
  ) {
    return 'site_filters';
  }
  if (sentReasoningEffort(options, context) === 'minimal') return 'minimal_effort';
  return undefined;
}

/**
 * Why OpenAI would refuse this request's code interpreter, or `undefined`
 * when it takes it: the model doesn't offer it, or the request would send
 * `minimal` effort, which GPT-5 refuses it at (a 400, measured).
 */
export function codeInterpreterRefusal(
  options: LlmOptions,
  context: Omit<RouteContext, 'isOpenAiHost'>
): 'model' | 'minimal_effort' | undefined {
  if (!acceptsOpenAiCodeInterpreter(options.model)) return 'model';
  if (sentReasoningEffort(options, context) === 'minimal') return 'minimal_effort';
  return undefined;
}

/** The `reasoning.effort` the request would send, or `undefined`. */
function sentReasoningEffort(
  options: LlmOptions,
  context: { isReasoning: boolean; providerName: string }
): ReturnType<typeof openAiReasoningEffort> | undefined {
  if (!context.isReasoning || options.reasoningEffort === undefined) return undefined;
  const effort = openAiReasoningEffort(options.reasoningEffort);
  return supportedReasoningEfforts(options.model, context.providerName).has(effort)
    ? effort
    : undefined;
}

/**
 * `filters` as the API takes it. The SDK's type has no `blocked_domains`;
 * the API accepts it (measured), up to 100 of either.
 */
interface WebSearchFilters extends WebSearchTool.Filters {
  blocked_domains?: string[];
}

/** A domain list as OpenAI takes it: hosts only, each once. */
function hostsOf(domains: readonly string[]): string[] {
  return [...new Set(domains.map((domain) => domain.split('/')[0].toLowerCase()))];
}

/** The `web_search` tool for these options. */
function webSearchTool(search: WebSearchOptions, model: string): WebSearchTool {
  const list = search.allowedDomains?.length
    ? { key: 'allowed_domains' as const, domains: search.allowedDomains }
    : search.blockedDomains?.length
      ? { key: 'blocked_domains' as const, domains: search.blockedDomains }
      : undefined;
  if (!list) return { type: 'web_search' };
  const hosts = hostsOf(list.domains);
  if (list.domains.some((domain) => domain.includes('/'))) {
    logger.info('OpenAI: web search site paths sent as hosts', { model, list: list.key });
  }
  const filters: WebSearchFilters = { [list.key]: hosts };
  return { type: 'web_search', filters };
}

/** Build the Responses request. Streaming adds `stream: true` to it. */
export function buildResponsesParams(
  messages: LlmMessage[],
  options: LlmOptions,
  context: ResponsesRequestContext
): ResponseCreateParamsNonStreaming {
  const taken = takenProviderTools(options, context);
  const include: ResponseIncludable[] = [];
  if (taken.webSearch) include.push('web_search_call.action.sources');
  if (taken.codeExecution) include.push('code_interpreter_call.outputs');
  if (context.isReasoning) include.push('reasoning.encrypted_content');
  const params: ResponseCreateParamsNonStreaming = {
    model: options.model,
    input: toResponsesInput(messages),
    store: false,
    include,
    max_output_tokens: context.tokenCap,
  };

  // Reasoning models refuse sampling parameters, as on Chat Completions.
  if (!context.isReasoning && options.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (!context.isReasoning && options.topP !== undefined) params.top_p = options.topP;
  if (context.isReasoning) {
    const effort = sentReasoningEffort(options, context);
    const reasoning: NonNullable<ResponseCreateParamsNonStreaming['reasoning']> = {};
    if (effort !== undefined) reasoning.effort = effort;
    if (context.summaries) reasoning.summary = 'auto';
    if (Object.keys(reasoning).length > 0) params.reasoning = reasoning;
  }
  if (options.verbosity !== undefined && acceptsVerbosity(options.model)) {
    params.text = { verbosity: options.verbosity };
  }
  // Only OpenAI itself is ever on this path, so no host check.
  if (
    options.serviceTier !== undefined &&
    (options.serviceTier !== 'flex' || acceptsFlexTier(options.model))
  ) {
    params.service_tier = options.serviceTier;
  }

  const tools: Tool[] = (options.tools ?? []).map<FunctionTool>((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // The Responses API defaults function tools to strict, which refuses
    // most capability schemas. Chat Completions never asked for strict.
    strict: false,
  }));
  const search = options.providerTools?.webSearch;
  if (search && taken.webSearch) {
    // The tool stays on even once a reply has spent its limit: without it,
    // OpenAI drops what the earlier searches found, and barring it with
    // `allowed_tools` measurably spoiled the answers. So each call gets the
    // agent's whole limit (owner ruling, t-955). `max_tool_calls` counts
    // built-in tool calls only, so function calls are unaffected.
    tools.push(webSearchTool(search, options.model));
    const limit = search.replyLimit ?? search.maxUses;
    if (limit !== undefined && limit >= 1) params.max_tool_calls = limit;
  }
  if (taken.codeExecution) {
    // `auto` reuses the container a replayed `code_interpreter_call` item
    // names, and makes a new one when that has expired (both measured), so a
    // step resumed long after still runs. No network, as on Anthropic.
    tools.push({
      type: 'code_interpreter',
      container: { type: 'auto', network_policy: { type: 'disabled' } },
    });
    // `max_tool_calls` counts every built-in call, code runs too, so the
    // search limit would cut data work off without a word. With code on it
    // isn't sent, and searches go uncapped here (owner ruling, t-956); each
    // is still costed and traced.
    delete params.max_tool_calls;
  }
  if (tools.length > 0) {
    params.tools = tools;
    const choice = mapToolChoice(options.toolChoice);
    if (choice) params.tool_choice = choice;
    if (
      options.parallelToolCalls !== undefined &&
      (!context.isReasoning || reasoningModelAcceptsParallelToolCalls(options.model))
    ) {
      params.parallel_tool_calls = options.parallelToolCalls;
    }
  }
  return params;
}

function mapToolChoice(
  choice: LlmToolChoice | undefined
): ToolChoiceOptions | ToolChoiceFunction | undefined {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'none') return choice;
  return { type: 'function', name: choice.name };
}

/**
 * The conversation as Responses input items, in order. An assistant turn
 * replays its OpenAI blocks first (the order they came back in), then its
 * text, then its function calls. Blocks from another provider (Anthropic
 * thinking, after a fallback) are left out.
 */
export function toResponsesInput(messages: LlmMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        items.push({ role: 'system', content: getTextContent(msg.content) });
        break;
      case 'user':
        items.push({
          role: 'user',
          content: Array.isArray(msg.content) ? toInputContent(msg.content) : msg.content,
        });
        break;
      case 'assistant': {
        for (const block of msg.reasoning ?? []) {
          const item = toReplayItem(block);
          if (item) items.push(item);
        }
        const text = getTextContent(msg.content);
        if (text) items.push({ role: 'assistant', content: text });
        for (const call of msg.toolCalls ?? []) {
          items.push({
            type: 'function_call',
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          });
        }
        break;
      }
      case 'tool':
        items.push({
          type: 'function_call_output',
          call_id: msg.toolCallId ?? '',
          output: getTextContent(msg.content),
        });
        break;
    }
  }
  return items;
}

function toReplayItem(block: LlmReasoningBlock): ResponseInputItem | undefined {
  switch (block.type) {
    case 'openai_reasoning':
      return {
        type: 'reasoning',
        id: block.id,
        summary: block.summary.map((text) => ({ type: 'summary_text', text })),
        encrypted_content: block.encryptedContent,
      };
    case 'openai_web_search_call': {
      // The block can come back from a stored `agent_call` checkpoint, so the
      // action is checked against what OpenAI takes before it goes out.
      const action = webSearchActionSchema.safeParse(block.action);
      if (!action.success) {
        logger.warn('OpenAI: web search item left out of replay, action not recognised', {
          id: block.id,
        });
        return undefined;
      }
      return { type: 'web_search_call', id: block.id, status: block.status, action: action.data };
    }
    case 'openai_code_interpreter_call':
      return {
        type: 'code_interpreter_call',
        id: block.id,
        status: block.status,
        container_id: block.containerId,
        code: block.code,
        outputs: block.outputs,
      };
    default:
      return undefined;
  }
}

const urlSourceSchema = z.object({ type: z.literal('url'), url: z.string() });

/** A `web_search_call` item's action, as the Responses API takes it back. */
const webSearchActionSchema: z.ZodType<ResponseFunctionWebSearch['action']> = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('search'),
      queries: z.array(z.string()).optional(),
      query: z.string().optional(),
      // OpenAI also returns sources the SDK doesn't type, such as
      // `{ type: 'api', name: 'oai-weather' }`. Only the `url` ones go back:
      // the item is accepted with them alone, and dropping the item would
      // lose the search (both measured).
      sources: z
        .array(z.unknown())
        .transform((sources) =>
          sources.flatMap((source) => {
            const parsed = urlSourceSchema.safeParse(source);
            return parsed.success ? [parsed.data] : [];
          })
        )
        .optional(),
    }),
    z.object({ type: z.literal('open_page'), url: z.string().nullable().optional() }),
    z.object({ type: z.literal('find_in_page'), pattern: z.string(), url: z.string() }),
  ]
);

function toInputContent(parts: ContentPart[]): ResponseInputContent[] {
  return parts.map<ResponseInputContent>((part) => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    if (part.type === 'image') {
      const url =
        part.source.type === 'base64'
          ? `data:${part.source.mediaType};base64,${part.source.data}`
          : part.source.url;
      return { type: 'input_image', image_url: url, detail: 'auto' };
    }
    // PDFs inline as a file, as on Chat Completions; other documents decode
    // to text (the picker offers only images and PDFs).
    if (part.source.mediaType === 'application/pdf') {
      return {
        type: 'input_file',
        filename: part.name,
        file_data: `data:application/pdf;base64,${part.source.data}`,
      };
    }
    const text = Buffer.from(part.source.data, 'base64').toString('utf-8');
    return { type: 'input_text', text: `[Document: ${part.name}]\n${text}` };
  });
}

/** What a finished response carried, beyond its text. */
interface MappedOutput {
  content: string;
  toolCalls: LlmToolCall[];
  reasoning: LlmReasoningBlock[];
  usage: LlmUsage;
  finishReason: LlmFinishReason;
}

/**
 * How long a response's code runs took, and what ran before it. A stream
 * times each run (`itemMs`, by item id); a call that wasn't streamed shares
 * its request time (`requestMs`) among them.
 */
export interface CodeRunTiming {
  /** The runs the reply made before this call (`earlierCodeRuns`). */
  earlier: readonly CodeRun[];
  itemMs?: ReadonlyMap<string, number>;
  requestMs?: number;
}

/**
 * Read a finished (or incomplete) response's output items. Reasoning items
 * without `encrypted_content` are dropped: with `store: false` there is
 * nothing to replay them by.
 */
function mapOutput(response: Response, timing: CodeRunTiming): MappedOutput {
  let content = '';
  const toolCalls: LlmToolCall[] = [];
  const reasoning: LlmReasoningBlock[] = [];
  let webSearchRequests = 0;
  const codeCalls = response.output.filter(
    (item): item is ResponseCodeInterpreterToolCall => item.type === 'code_interpreter_call'
  );
  const sharedMs = codeCalls.length > 0 ? (timing.requestMs ?? 0) / codeCalls.length : 0;
  // Files the reply's text cites, by container: OpenAI names them there,
  // not on the code item.
  const citedFiles = new Map<string, string[]>();
  for (const item of response.output) {
    switch (item.type) {
      case 'message': {
        // A response can hold more than one message (text before a search,
        // then the answer); each is its own paragraph, as the stream yields it.
        let text = '';
        for (const part of item.content) {
          if (part.type !== 'output_text') continue;
          text += part.text;
          for (const annotation of part.annotations) {
            if (annotation.type !== 'container_file_citation') continue;
            const names = citedFiles.get(annotation.container_id) ?? [];
            if (!names.includes(annotation.filename)) names.push(annotation.filename);
            citedFiles.set(annotation.container_id, names);
          }
        }
        if (text) content += content ? `\n\n${text}` : text;
        break;
      }
      case 'function_call':
        toolCalls.push({
          id: item.call_id,
          name: item.name,
          arguments: safeParseJson(item.arguments),
        });
        break;
      case 'reasoning':
        if (item.encrypted_content) {
          reasoning.push({
            type: 'openai_reasoning',
            id: item.id,
            encryptedContent: item.encrypted_content,
            summary: item.summary.map((part) => part.text),
          });
        }
        break;
      case 'web_search_call': {
        const block = webSearchBlock(item);
        reasoning.push(block);
        if (isBilledSearch(block)) webSearchRequests++;
        break;
      }
      case 'code_interpreter_call':
        reasoning.push(codeInterpreterBlock(item, timing.itemMs?.get(item.id) ?? sharedMs));
        break;
      default:
        break;
    }
  }
  attachCitedFiles(reasoning, citedFiles);
  const runs = reasoning.flatMap((block) => {
    const run = codeRunOf(block);
    return run ? [run] : [];
  });
  const codeExecution = billCodeExecution(timing.earlier, runs, CODE_EXECUTION_USD_PER_HOUR.openai);
  return {
    content,
    toolCalls,
    reasoning,
    usage: { ...usageOf(response, webSearchRequests), ...(codeExecution ? { codeExecution } : {}) },
    finishReason: finishReasonOf(response, toolCalls.length > 0),
  };
}

/** Put each container's cited files on this response's last run in it. */
function attachCitedFiles(
  blocks: LlmReasoningBlock[],
  citedFiles: ReadonlyMap<string, string[]>
): void {
  for (const [containerId, names] of citedFiles) {
    const run = blocks.findLast(
      (block) => block.type === 'openai_code_interpreter_call' && block.containerId === containerId
    );
    if (run?.type === 'openai_code_interpreter_call') run.fileNames = names;
  }
}

function codeInterpreterBlock(
  item: ResponseCodeInterpreterToolCall,
  durationMs: number
): LlmReasoningBlock {
  return {
    type: 'openai_code_interpreter_call',
    id: item.id,
    status: item.status,
    containerId: item.container_id,
    code: item.code,
    outputs: (item.outputs ?? []).map((output) =>
      output.type === 'logs'
        ? { type: 'logs' as const, logs: output.logs }
        : { type: 'image' as const, url: output.url }
    ),
    durationMs: Math.round(durationMs),
  };
}

function webSearchBlock(item: ResponseFunctionWebSearch): LlmReasoningBlock {
  return {
    type: 'openai_web_search_call',
    id: item.id,
    status: item.status,
    action: isRecord(item.action) ? { ...item.action } : {},
  };
}

/**
 * Is this web search item one OpenAI bills? A `search` action is a tool
 * call; `open_page` and `find_in_page` read a page already found. One cut
 * short by `max_tool_calls` (still `searching`) has run, so it counts; a
 * `failed` one does not.
 */
export function isBilledSearch(block: LlmReasoningBlock): boolean {
  return (
    block.type === 'openai_web_search_call' &&
    block.action.type === 'search' &&
    block.status !== 'failed'
  );
}

function usageOf(response: Response, webSearchRequests: number): LlmUsage {
  const usage = response.usage;
  const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens;
  const cacheReadTokens = usage?.input_tokens_details?.cached_tokens;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...pricedTier(response.service_tier),
    ...(webSearchRequests > 0 ? { webSearchRequests } : {}),
  };
}

function finishReasonOf(response: Response, hasToolCalls: boolean): LlmFinishReason {
  if (hasToolCalls) return 'tool_use';
  if (response.status === 'incomplete') {
    return response.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'error';
  }
  return 'stop';
}

/** A response OpenAI reports as failed, as a `ProviderError`. */
function failedResponseError(response: Response, usage: LlmUsage): ProviderError {
  return new ProviderError(response.error?.message ?? 'OpenAI response failed', {
    code: response.error?.code ? `openai_${response.error.code}` : 'provider_error',
    retriable: false,
    ...(usage.inputTokens > 0 || usage.outputTokens > 0 ? { usage } : {}),
  });
}

/**
 * Map a non-streaming Responses result to an `LlmResponse`. A `max_output_tokens`
 * stop with nothing to show is raised, as on Chat Completions: reasoning can
 * spend the whole cap and leave an empty answer.
 */
export function fromResponsesResult(
  response: Response,
  options: LlmOptions,
  timing: CodeRunTiming
): LlmResponse {
  const mapped = mapOutput(response, timing);
  if (response.status === 'failed') throw failedResponseError(response, mapped.usage);
  if (
    mapped.finishReason === 'length' &&
    mapped.content.length === 0 &&
    mapped.toolCalls.length === 0
  ) {
    const reasoningNote =
      mapped.usage.reasoningTokens !== undefined
        ? ` Reasoning consumed ${mapped.usage.reasoningTokens} tokens of the ${response.max_output_tokens ?? 'configured'} budget.`
        : '';
    throw new ProviderError(
      `Model "${options.model}" hit max_output_tokens before producing visible output.${reasoningNote} Raise the agent/step maxTokens (current cap: ${response.max_output_tokens ?? 'unset'}).`,
      { code: 'truncated_no_output', retriable: false, usage: mapped.usage }
    );
  }
  const result: LlmResponse = {
    content: mapped.content,
    usage: mapped.usage,
    model: response.model,
    finishReason: mapped.finishReason,
  };
  if (mapped.toolCalls.length > 0) result.toolCalls = mapped.toolCalls;
  if (mapped.reasoning.length > 0) result.reasoning = mapped.reasoning;
  return result;
}

/**
 * Turn a Responses event stream into `StreamChunk`s. Text and reasoning
 * summaries are yielded as they arrive; everything else (function calls, the
 * replayable blocks, usage) is read from the response the terminal event
 * carries, so it is mapped once, the same way as a non-streaming result.
 */
export async function* fromResponsesStream(
  stream: AsyncIterable<ResponseStreamEvent>,
  signal: AbortSignal | undefined,
  earlier: readonly CodeRun[]
): AsyncIterable<StreamChunk> {
  let final: Response | undefined;
  // Each code run, timed from when its code starts running (`interpreting`,
  // or `in_progress` if that never came) to `completed`: the container's
  // time, not the model's writing of the code.
  const runStarts = new Map<string, number>();
  const itemMs = new Map<string, number>();
  // A later summary part starts a new paragraph in the live panel.
  let reasoningStreamed = false;
  let paragraphPending = false;
  // The message the last text came from; a later message starts a paragraph,
  // as `mapOutput` joins them.
  let textItemId: string | undefined;
  try {
    for await (const event of stream) {
      if (signal?.aborted) {
        throw new ProviderError('request aborted', { code: 'aborted', retriable: false });
      }
      switch (event.type) {
        case 'response.output_text.delta':
          if (event.delta) {
            const startsMessage = textItemId !== undefined && event.item_id !== textItemId;
            textItemId = event.item_id;
            yield { type: 'text', content: startsMessage ? `\n\n${event.delta}` : event.delta };
          }
          break;
        case 'response.reasoning_summary_part.added':
          if (reasoningStreamed) paragraphPending = true;
          break;
        case 'response.reasoning_summary_text.delta':
          if (event.delta) {
            yield {
              type: 'reasoning',
              text: paragraphPending ? `\n\n${event.delta}` : event.delta,
            };
            reasoningStreamed = true;
            paragraphPending = false;
          }
          break;
        case 'response.code_interpreter_call.in_progress':
          if (!runStarts.has(event.item_id)) runStarts.set(event.item_id, Date.now());
          break;
        case 'response.code_interpreter_call.interpreting':
          runStarts.set(event.item_id, Date.now());
          break;
        case 'response.code_interpreter_call.completed': {
          const started = runStarts.get(event.item_id);
          if (started !== undefined) itemMs.set(event.item_id, Date.now() - started);
          break;
        }
        case 'response.completed':
        case 'response.incomplete':
          final = event.response;
          break;
        case 'response.failed':
          throw failedResponseError(
            event.response,
            mapOutput(event.response, { earlier, itemMs }).usage
          );
        case 'error':
          throw new ProviderError(event.message || 'OpenAI stream error', {
            code: event.code ? `openai_${event.code}` : 'provider_error',
            retriable: false,
          });
        default:
          break;
      }
    }
  } catch (err) {
    // Usage arrives only on the terminal event, so an error before it has
    // none, and the helper drops the zeroes rather than costing the turn as free.
    throw toProviderErrorWithUsage(err, 'OpenAI Responses stream iteration failed', {
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  if (!final) {
    throw new ProviderError('OpenAI Responses stream ended without a final response', {
      code: 'empty_response',
      retriable: true,
    });
  }

  const mapped = mapOutput(final, { earlier, itemMs });
  for (const toolCall of mapped.toolCalls) yield { type: 'tool_call', toolCall };
  yield {
    type: 'done',
    usage: mapped.usage,
    finishReason: mapped.finishReason,
    ...(mapped.reasoning.length > 0 ? { reasoning: mapped.reasoning } : {}),
  };
}

/**
 * Is this the 400 OpenAI returns for asking an unverified organisation for
 * reasoning summaries ("Your organization must be verified to generate
 * reasoning summaries")? Read down the `cause` chain: `withRetry` and
 * `toProviderError` wrap the SDK's error.
 */
export function isSummaryVerificationError(err: unknown): boolean {
  return someInCauseChain(err, (node) =>
    /must be verified to generate reasoning summar/i.test(node.message)
  );
}

/**
 * Does `test` hold for `err` or an error in its `cause` chain? `withRetry`
 * and `toProviderError` wrap the SDK's error, so what OpenAI said is a few
 * layers down.
 */
function someInCauseChain(err: unknown, test: (node: Error) => boolean): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < 5 && node instanceof Error; depth++) {
    if (test(node)) return true;
    node = node.cause;
  }
  return false;
}

/**
 * Is this the 400 OpenAI returns for a replayed reasoning item it can't
 * decrypt (`invalid_encrypted_content`: "The encrypted content for item rs_…
 * could not be verified")? Matched on the SDK error's `code`, read down the
 * `cause` chain as `isSummaryVerificationError` does. Measured with a
 * reasoning item whose content was changed or never came from OpenAI.
 * Whether another organisation's content gets the same 400 wasn't measured
 * (it takes two organisations' keys); a damaged checkpoint and such a
 * fallback are what the retry is for.
 */
export function isUndecryptableReasoningError(err: unknown): boolean {
  return someInCauseChain(
    err,
    (node) => 'code' in node && node.code === 'invalid_encrypted_content'
  );
}

/** The ids of the `openai_reasoning` blocks `messages` replays. */
export function replayedReasoningIds(messages: readonly LlmMessage[]): string[] {
  return messages.flatMap((message) =>
    (message.reasoning ?? []).flatMap((block) =>
      block.type === 'openai_reasoning' ? [block.id] : []
    )
  );
}

/**
 * `messages` with `openai_reasoning` blocks left out of the replay (those in
 * `ids`, or every one), or `messages` itself when that leaves out none. The
 * search and code items stay: without the search items the model writes raw
 * citation markup, and a code item keeps the container. Measured on
 * gpt-5-mini: OpenAI takes the turn this way and answers the same.
 */
export function withoutOpenAiReasoning(
  messages: LlmMessage[],
  ids?: ReadonlySet<string>
): LlmMessage[] {
  const isReasoning = (block: LlmReasoningBlock) =>
    block.type === 'openai_reasoning' && (ids === undefined || ids.has(block.id));
  if (!messages.some((message) => message.reasoning?.some(isReasoning))) return messages;
  return messages.map((message) =>
    message.reasoning?.some(isReasoning)
      ? { ...message, reasoning: message.reasoning.filter((block) => !isReasoning(block)) }
      : message
  );
}

/**
 * A tool call's arguments as an object, from either OpenAI API. Anything
 * other than a JSON object is wrapped as `{ value }`; text that isn't JSON
 * becomes `{}`.
 */
export function safeParseJson(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
    return { value: parsed };
  } catch {
    logger.warn('Failed to parse OpenAI tool call arguments', { length: raw.length });
    return {};
  }
}

/**
 * The served tier as `LlmUsage.serviceTier`, when it is one priced apart from
 * the standard rate. `default`, `auto` and `scale` add nothing.
 */
export function pricedTier(tier: string | null | undefined): Pick<LlmUsage, 'serviceTier'> {
  return tier === 'flex' || tier === 'priority' ? { serviceTier: tier } : {};
}
