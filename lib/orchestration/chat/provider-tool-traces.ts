/**
 * Trace entries for the tools a provider ran itself (web search and code
 * execution, on Anthropic and on OpenAI's Responses path), read from the
 * replayable blocks a turn returned (`LlmReasoningBlock`).
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

/** The trace slug of a provider's own code run. */
export const PROVIDER_CODE_EXECUTION_SLUG = 'provider:code_execution';

/** What Python prints first when the code raised an exception it didn't catch. */
const PYTHON_TRACEBACK = 'Traceback (most recent call last):';

/** Matches `toolCallTraceSchema.resultPreview`. */
const RESULT_PREVIEW_MAX = 2000;

/**
 * One trace entry per web search and code run in `blocks`, in the order the
 * model ran them.
 *
 * - Anthropic: one per `server_tool_use`. A search or run with no result
 *   block (the turn ended first) reads as failed.
 * - OpenAI: one per `web_search_call` item, including the `open_page` and
 *   `find_in_page` steps a reasoning model takes, which aren't billed, and
 *   one per `code_interpreter_call` item. A search cut short by the search
 *   limit reads as failed, though OpenAI bills it.
 *
 * A search's latency is 0, since neither provider reports one; a code run's
 * is its measured run time. A run has no cost of its own: its container is
 * billed per reply, with a minimum (`code-execution.ts`), so its cost is on
 * the call's cost row.
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
    if (block.type === 'openai_code_interpreter_call') {
      traces.push(openAiCodeTrace(block));
      continue;
    }
    if (block.type !== 'server_tool_use') continue;
    if (block.name !== 'web_search') {
      traces.push(anthropicCodeTrace(block, blocks));
      continue;
    }
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

function anthropicCodeTrace(
  call: Extract<LlmReasoningBlock, { type: 'server_tool_use' }>,
  blocks: readonly LlmReasoningBlock[]
): ToolCallTrace {
  const found = blocks.find(
    (candidate) =>
      candidate.type === 'code_execution_tool_result' && candidate.toolUseId === call.id
  );
  const result = found?.type === 'code_execution_tool_result' ? found : undefined;
  const trace: ToolCallTrace = {
    slug: PROVIDER_CODE_EXECUTION_SLUG,
    arguments: call.input,
    latencyMs: result?.durationMs ?? 0,
    success: false,
  };
  if (!result) {
    trace.errorCode = 'no_result';
    return trace;
  }
  const content = result.content;
  switch (content.type) {
    case 'bash_code_execution_result':
      trace.success = content.return_code === 0;
      if (!trace.success) trace.errorCode = `exit_${content.return_code}`;
      setPreview(trace, [content.stdout, content.stderr], result.fileNames);
      break;
    case 'bash_code_execution_tool_result_error':
    case 'text_editor_code_execution_tool_result_error':
      trace.errorCode = content.error_code;
      break;
    case 'text_editor_code_execution_view_result':
      trace.success = true;
      setPreview(trace, [
        content.file_type === 'text' ? content.content : `[${content.file_type}]`,
      ]);
      break;
    case 'text_editor_code_execution_create_result':
    case 'text_editor_code_execution_str_replace_result':
      trace.success = true;
      break;
  }
  return trace;
}

function openAiCodeTrace(
  block: Extract<LlmReasoningBlock, { type: 'openai_code_interpreter_call' }>
): ToolCallTrace {
  // A run whose code raised still completes: OpenAI reports no exit status,
  // so the traceback Python prints is what marks it failed, as a non-zero
  // exit does on Anthropic.
  const raised = block.outputs.some(
    (output) => output.type === 'logs' && output.logs.includes(PYTHON_TRACEBACK)
  );
  const trace: ToolCallTrace = {
    slug: PROVIDER_CODE_EXECUTION_SLUG,
    arguments: block.code === null ? {} : { code: block.code },
    latencyMs: block.durationMs,
    success: block.status === 'completed' && !raised,
  };
  if (block.status !== 'completed') trace.errorCode = block.status;
  else if (raised) trace.errorCode = 'exception';
  setPreview(
    trace,
    block.outputs.map((output) => (output.type === 'logs' ? output.logs : '[image]')),
    block.fileNames
  );
  return trace;
}

/**
 * What a run printed, then the files it made, which aren't delivered (owner
 * ruling, t-956). Nothing is set when there is nothing to show.
 */
function setPreview(trace: ToolCallTrace, parts: string[], fileNames?: string[]): void {
  const lines = parts.filter((part) => part.length > 0);
  if (fileNames?.length) lines.push(`Files made (not delivered): ${fileNames.join(', ')}`);
  if (lines.length > 0) trace.resultPreview = lines.join('\n').slice(0, RESULT_PREVIEW_MAX);
}

/**
 * A turn's traces fitted to `max`, in order. Provider tool runs go first,
 * from the end: a reply can run code dozens of times, and the dispatched
 * capabilities, which can change things, are the record that matters most.
 * Only when those alone are too many is the list cut, keeping the first.
 */
export function fitToolCallTraces(traces: ToolCallTrace[], max: number): ToolCallTrace[] {
  if (traces.length <= max) return traces;
  let surplus = traces.length - max;
  const kept: ToolCallTrace[] = [];
  for (let i = traces.length - 1; i >= 0; i--) {
    if (surplus > 0 && traces[i].slug.startsWith('provider:')) {
      surplus--;
      continue;
    }
    kept.unshift(traces[i]);
  }
  return kept.slice(0, max);
}
