import { describe, it, expect, vi, beforeEach } from 'vitest';

const broadcastSpy = vi.fn();
const getSubscribersSpy = vi.fn();

vi.mock('@/lib/orchestration/mcp/singletons', () => ({
  getMcpSessionManager: vi.fn(() => ({
    broadcastNotification: broadcastSpy,
    getSubscribers: getSubscribersSpy,
  })),
  getMcpRateLimiter: vi.fn(),
}));

import {
  broadcastMcpToolsChanged,
  broadcastMcpResourcesChanged,
  broadcastMcpPromptsChanged,
  broadcastMcpResourceUpdated,
} from '@/lib/orchestration/mcp';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('broadcastMcpToolsChanged', () => {
  it('pushes notifications/tools/list_changed to all sessions (no target filter)', () => {
    broadcastMcpToolsChanged();
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [notification, targets] = broadcastSpy.mock.calls[0];
    expect(notification).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
    expect(targets).toBeUndefined();
  });
});

describe('broadcastMcpResourcesChanged', () => {
  it('pushes notifications/resources/list_changed to all sessions', () => {
    broadcastMcpResourcesChanged();
    const [notification, targets] = broadcastSpy.mock.calls[0];
    expect(notification.method).toBe('notifications/resources/list_changed');
    expect(targets).toBeUndefined();
  });
});

describe('broadcastMcpPromptsChanged', () => {
  it('pushes notifications/prompts/list_changed to all sessions', () => {
    broadcastMcpPromptsChanged();
    const [notification, targets] = broadcastSpy.mock.calls[0];
    expect(notification.method).toBe('notifications/prompts/list_changed');
    expect(targets).toBeUndefined();
  });
});

describe('broadcastMcpResourceUpdated', () => {
  it('no-ops when no session is subscribed to the URI', () => {
    getSubscribersSpy.mockReturnValue([]);
    broadcastMcpResourceUpdated('sunrise://agents');
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('targets only sessions subscribed to the URI', () => {
    getSubscribersSpy.mockReturnValue(['session-a', 'session-b']);
    broadcastMcpResourceUpdated('sunrise://agents');

    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [notification, targets] = broadcastSpy.mock.calls[0];
    expect(notification).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: 'sunrise://agents' },
    });
    expect(targets).toEqual(['session-a', 'session-b']);
  });

  it('round-trips the URI in the params', () => {
    getSubscribersSpy.mockReturnValue(['s-1']);
    broadcastMcpResourceUpdated('sunrise://knowledge/search');
    const [notification] = broadcastSpy.mock.calls[0];
    expect((notification.params as { uri: string }).uri).toBe('sunrise://knowledge/search');
  });
});
