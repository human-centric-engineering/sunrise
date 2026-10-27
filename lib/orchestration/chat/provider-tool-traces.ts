/**
 * Trace entries for the tools a provider ran itself (web search, on Anthropic
 * and on OpenAI's Responses path), read from the replayable blocks a turn
 * returned (`LlmReasoningBlock`).
 *
 * They go in the same `capabilityCalls` list as the capabilities the chat
 * handler dispatched, so the live strip and the conversation trace show a
 * search beside the tool calls without a surface of their own. The slug is
 * prefixed so it can't be read as a capability's.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { isBilledSearch } from '@/lib/orchestration/llm/openai-responses';
import { WEB_SEARCH_USD_PER_REQUEST, type LlmReasoningBlock } from '@/lib/orchestration/llm/types';
import { isRecord } from '@/lib/utils';
import type { ToolCallTrace } from '@/types/orchestration';

/** The trace slug of a provider's own web search. */
export const PROVIDER_WEB_SEARCH_SLUG = 'provider:web_search';

/** Matches `toolCallTraceSchema.resultPreview`. */
const RESULT_PREVIEW_MAX = 2000;

/**
 * One trace entry per web search in `blocks`, in the order the model ran
 * them. Latency is 0: neither provider reports one per search.
 *
 * - Anthropic: one per `server_tool_use`. A search with no result block (the
 *   turn ended first) reads as failed.
 * - OpenAI: one per `web_search_call` item, including the `open_page` and
 *   `find_in_page` steps a reasoning model takes, which aren't billed. One
 *   cut short by the search limit reads as failed, though OpenAI bills it.
 */
export function providerToolTraces(
  blocks: readonly LlmReasoningBlock[] | undefined
): ToolCallTrace[] {
  if (!blocks) return [];
  const traces: ToolCallTrace[] = [];
  for (const block of blocks) {
    if (block.type === 'openai_web_search_call') {
      traces.push(openAiSearchTrace(block));
      continue;
    }
    if (block.type !== 'server_tool_use') continue;
    const result = blocks.find(
      (candidate) => candidate.type === 'web_search_tool_result' && candidate.toolUseId === block.id
    );
    const found = result?.type === 'web_search_tool_result' ? result : undefined;
    const errorCode = found ? found.errorCode : 'no_result';
    const trace: ToolCallTrace = {
      slug: PROVIDER_WEB_SEARCH_SLUG,
      arguments: block.input,
      latencyMs: 0,
      success: errorCode === undefined,
    };
    if (errorCode !== undefined) {
      trace.errorCode = errorCode;
    } else if (found) {
      // A failed search is not billed.
      trace.costUsd = WEB_SEARCH_USD_PER_REQUEST;
      trace.resultPreview = found.results
        .map((page) => `${page.title} — ${page.url}`)
        .join('\n')
        .slice(0, RESULT_PREVIEW_MAX);
    }
    traces.push(trace);
  }
  return traces;
}

function openAiSearchTrace(
  block: Extract<LlmReasoningBlock, { type: 'openai_web_search_call' }>
): ToolCallTrace {
  // What the model asked for, without the sources it got back.
  const { sources, ...action } = block.action;
  const trace: ToolCallTrace = {
    slug: PROVIDER_WEB_SEARCH_SLUG,
    arguments: action,
    latencyMs: 0,
    success: block.status === 'completed',
  };
  if (block.status !== 'completed') trace.errorCode = block.status;
  if (isBilledSearch(block)) trace.costUsd = WEB_SEARCH_USD_PER_REQUEST;
  const urls = Array.isArray(sources)
    ? sources.flatMap((source) =>
        isRecord(source) && typeof source.url === 'string' ? [source.url] : []
      )
    : [];
  if (urls.length > 0) trace.resultPreview = urls.join('\n').slice(0, RESULT_PREVIEW_MAX);
  return trace;
}
