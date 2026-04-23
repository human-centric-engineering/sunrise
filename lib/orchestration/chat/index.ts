/**
 * Streaming chat handler — public barrel.
 *
 * Consumers should import from here. `buildMessages` is intentionally
 * internal so the public surface stays small and the SSE route layer
 * only ever sees a single entry point.
 */

export type { ChatRequest, ChatStream } from '@/lib/orchestration/chat/types';
export { MAX_HISTORY_MESSAGES, MAX_TOOL_ITERATIONS } from '@/lib/orchestration/chat/types';
export {
  StreamingChatHandler,
  streamChat,
  ChatError,
} from '@/lib/orchestration/chat/streaming-handler';
export {
  buildContext,
  invalidateContext,
  clearContextCache,
} from '@/lib/orchestration/chat/context-builder';
