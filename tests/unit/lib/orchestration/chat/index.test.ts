/**
 * Smoke test for the chat barrel — keeps the public surface honest.
 */

import { describe, it, expect } from 'vitest';

describe('@/lib/orchestration/chat barrel', () => {
  it('re-exports the public surface', async () => {
    const mod = await import('@/lib/orchestration/chat');

    expect(typeof mod.streamChat).toBe('function');
    expect(typeof mod.StreamingChatHandler).toBe('function');
    expect(typeof mod.ChatError).toBe('function');
    expect(typeof mod.buildContext).toBe('function');
    expect(typeof mod.invalidateContext).toBe('function');
    expect(typeof mod.clearContextCache).toBe('function');
    expect(typeof mod.MAX_TOOL_ITERATIONS).toBe('number');
    expect(typeof mod.MAX_HISTORY_MESSAGES).toBe('number');
  });

  it('does not re-export buildMessages (internal)', async () => {
    const mod = (await import('@/lib/orchestration/chat')) as Record<string, unknown>;
    expect(mod.buildMessages).toBeUndefined();
  });
});
