/**
 * Streaming chat handler — public barrel.
 *
 * Consumers should import from here. `buildMessages` is intentionally
 * internal so the public surface stays small and the SSE route layer
 * only ever sees a single entry point.
 */

export type { ChatRequest, ChatStream } from './types';
export { MAX_HISTORY_MESSAGES, MAX_TOOL_ITERATIONS } from './types';
export { StreamingChatHandler, streamChat, ChatError } from './streaming-handler';
export { buildContext, invalidateContext, clearContextCache } from './context-builder';
