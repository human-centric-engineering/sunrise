/**
 * Tests: the named resource-update hooks and the audience each one declares
 * (§108 t-716)
 *
 * The file is three one-line helpers, and the line that matters in each is the
 * second argument. Every org's MCP sessions subscribe to the same
 * `sunrise://agents` string, so the URI is not an org discriminator and the
 * audience is the only thing deciding whether one org's agent edit tells every
 * other org that its agent list changed.
 *
 * **This file exists because a negative run found nothing testing that.**
 * Flipping all three helpers from `'this-org'` to `'every-org'` — exactly the
 * behaviour t-716 was written to remove — left the whole MCP suite green: the
 * barrel's own test mocks `getSubscribers` and asserts the notification shape,
 * and the session manager's tests cover `getSubscribers` given an audience but
 * nothing asserted which audience these callers ask for.
 *
 * The counterpart assertion — that a resource DEFINITION change is
 * `'every-org'`, because `McpExposedResource` is global config — lives with its
 * caller in the admin resources route.
 *
 * @see lib/orchestration/mcp/resource-update-hooks.ts
 * @see lib/orchestration/mcp/session-manager.ts (McpResourceAudience)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const broadcastResourceUpdated = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/mcp', () => ({
  broadcastMcpResourceUpdated: broadcastResourceUpdated,
}));

import {
  notifyMcpAgentsChanged,
  notifyMcpWorkflowsChanged,
  notifyMcpKnowledgeChanged,
} from '@/lib/orchestration/mcp/resource-update-hooks';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the named hooks', () => {
  it.each([
    [notifyMcpAgentsChanged, 'sunrise://agents'],
    [notifyMcpWorkflowsChanged, 'sunrise://workflows'],
    [notifyMcpKnowledgeChanged, 'sunrise://knowledge/search'],
  ])('%# announces its URI to THIS ORG only', (notify, uri) => {
    notify();

    // Both arguments asserted together on purpose: the URI is what the helper
    // exists to centralise, and the audience is what keeps the notification
    // inside the org whose rows changed.
    expect(broadcastResourceUpdated).toHaveBeenCalledExactlyOnceWith(uri, 'this-org');
  });

  it('never asks for every-org — the contents these announce are tenant-owned', () => {
    notifyMcpAgentsChanged();
    notifyMcpWorkflowsChanged();
    notifyMcpKnowledgeChanged();

    const audiences = broadcastResourceUpdated.mock.calls.map(([, audience]) => audience);
    expect(audiences).toEqual(['this-org', 'this-org', 'this-org']);
  });

  it('passes an audience at all — an omitted one would not reach the type-checker here', () => {
    // The mock accepts any arity, so this file cannot lean on the required
    // parameter the way the production call sites do. Asserting the argument
    // count is what makes a dropped audience fail in THIS file rather than only
    // in `tsc`, which a test run does not execute.
    notifyMcpAgentsChanged();
    expect(broadcastResourceUpdated.mock.calls[0]).toHaveLength(2);
  });
});
