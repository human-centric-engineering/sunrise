/**
 * Unit Test: System agent protection (DELETE / PATCH)
 *
 * Tests that system agents (isSystem: true) cannot be deleted or
 * deactivated, and that editing system agent instructions returns
 * a warning header.
 *
 * Test Coverage:
 * - DELETE rejects system agents with 403
 * - DELETE allows non-system agents
 * - PATCH rejects isActive: false on system agents with 403
 * - PATCH allows isActive: false on non-system agents
 * - PATCH rejects systemInstructions changes on system agents with 403
 * - PATCH allows systemInstructions changes on non-system agents
 *
 * @see app/api/v1/admin/orchestration/agents/[id]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE, PATCH } from '@/app/api/v1/admin/orchestration/agents/[id]/route';
import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

const mockVersionFindFirst = vi.fn();
const mockVersionCreate = vi.fn();

vi.mock('@/lib/db/client', () => {
  const mock = {
    aiAgent: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    aiAgentVersion: {
      findFirst: (...args: unknown[]) => mockVersionFindFirst(...args),
      create: (...args: unknown[]) => mockVersionCreate(...args),
    },
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation((fn: (tx: typeof mock) => Promise<unknown>) => fn(mock));
  return { prisma: mock };
});

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', async () => {
  // `computeChanges` is a pure utility — let the real implementation run so
  // tests exercise the real before/after diff. Only `logAdminAction` is
  // stubbed out (it performs a DB write we don't want in unit tests).
  const actual = await vi.importActual<
    typeof import('@/lib/orchestration/audit/admin-audit-logger')
  >('@/lib/orchestration/audit/admin-audit-logger');
  return {
    ...actual,
    logAdminAction: vi.fn(),
  };
});

vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn(),
}));

vi.mock('@/lib/orchestration/webhooks/dispatcher', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';

function makeSystemAgent(overrides = {}) {
  return {
    id: AGENT_ID,
    name: 'Pattern Advisor',
    slug: 'pattern-advisor',
    description: 'System agent',
    systemInstructions: 'You are the Pattern Advisor.',
    systemInstructionsHistory: [],
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    isActive: true,
    isSystem: true,
    createdBy: 'admin-id',
    ...overrides,
  };
}

function makeCustomAgent(overrides = {}) {
  return {
    ...makeSystemAgent({ isSystem: false, slug: 'custom-agent', name: 'Custom Agent' }),
    ...overrides,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeleteRequest(): NextRequest {
  return {
    method: 'DELETE',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}`,
  } as unknown as NextRequest;
}

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'PATCH',
    headers: new Headers({ 'content-type': 'application/json' }),
    url: `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}`,
    json: () => Promise.resolve(body),
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('System agent protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    // Sensible defaults — most tests don't exercise the version path.
    mockVersionFindFirst.mockResolvedValue(null);
    mockVersionCreate.mockResolvedValue({});
  });

  describe('DELETE', () => {
    it('rejects deletion of system agents with 403', async () => {
      mockFindUnique.mockResolvedValue(makeSystemAgent());

      const response = await DELETE(makeDeleteRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toContain('System agents cannot be deleted');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('allows deletion of non-system agents', async () => {
      const agent = makeCustomAgent();
      mockFindUnique.mockResolvedValue(agent);
      mockUpdate.mockResolvedValue({ ...agent, isActive: false });

      const response = await DELETE(makeDeleteRequest(), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.data.isActive).toBe(false);
    });
  });

  describe('PATCH — deactivation guard', () => {
    it('rejects isActive: false on system agents with 403', async () => {
      mockFindUnique.mockResolvedValue(makeSystemAgent());

      const response = await PATCH(makePatchRequest({ isActive: false }), makeParams(AGENT_ID));

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.message).toContain('System agents cannot be deactivated');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('allows isActive: false on non-system agents', async () => {
      const agent = makeCustomAgent();
      mockFindUnique.mockResolvedValue(agent);
      mockUpdate.mockResolvedValue({ ...agent, isActive: false });

      const response = await PATCH(makePatchRequest({ isActive: false }), makeParams(AGENT_ID));

      expect(response.status).toBe(200);
    });
  });

  describe('PATCH — slug protection', () => {
    it('rejects slug change on system agents with 403', async () => {
      mockFindUnique.mockResolvedValue(makeSystemAgent());

      const response = await PATCH(makePatchRequest({ slug: 'new-slug' }), makeParams(AGENT_ID));

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.message).toContain('System agent slugs cannot be changed');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('allows slug change on non-system agents', async () => {
      const agent = makeCustomAgent();
      mockFindUnique.mockResolvedValue(agent);
      mockUpdate.mockResolvedValue({ ...agent, slug: 'renamed-agent' });

      const response = await PATCH(
        makePatchRequest({ slug: 'renamed-agent' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(200);
    });

    it('allows same slug on system agents (no-op)', async () => {
      const agent = makeSystemAgent();
      mockFindUnique.mockResolvedValue(agent);
      mockUpdate.mockResolvedValue(agent);

      const response = await PATCH(
        makePatchRequest({ slug: 'pattern-advisor' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(200);
    });
  });

  describe('PATCH — system instruction guard', () => {
    it('rejects systemInstructions changes on system agents with 403', async () => {
      mockFindUnique.mockResolvedValue(makeSystemAgent());

      const response = await PATCH(
        makePatchRequest({ systemInstructions: 'Updated instructions.' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.message).toContain('System agent instructions cannot be modified');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('allows systemInstructions changes on non-system agents', async () => {
      const agent = makeCustomAgent();
      mockFindUnique.mockResolvedValue(agent);
      mockUpdate.mockResolvedValue({ ...agent, systemInstructions: 'Updated instructions.' });

      const response = await PATCH(
        makePatchRequest({ systemInstructions: 'Updated instructions.' }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(200);
    });

    it('allows no-op systemInstructions patch on system agents (same value)', async () => {
      const agent = makeSystemAgent();
      mockFindUnique.mockResolvedValue(agent);
      mockUpdate.mockResolvedValue(agent);

      const response = await PATCH(
        makePatchRequest({ systemInstructions: agent.systemInstructions }),
        makeParams(AGENT_ID)
      );

      expect(response.status).toBe(200);
    });
  });

  describe('PATCH — outbound notifications', () => {
    it('dual-dispatches agent.updated to event hooks AND agent_updated to webhook subscriptions', async () => {
      // The two outbound subsystems use different event-name conventions
      // (dotted vs underscore). Both must fire so admins configured via
      // either surface receive the notification — historically the
      // webhook-subscription side was silently dropped, which is what
      // this test guards against.
      const before = makeCustomAgent({ description: 'old description' });
      const after = { ...before, description: 'new description' };
      mockFindUnique.mockResolvedValue(before);
      mockUpdate.mockResolvedValue(after);
      // Previous max version is 4 → snapshot creates v5 → payload says agentVersion=5.
      mockVersionFindFirst.mockResolvedValue({ version: 4 });

      const response = await PATCH(
        makePatchRequest({ description: 'new description' }),
        makeParams(AGENT_ID)
      );
      expect(response.status).toBe(200);

      const expectedShape = expect.objectContaining({
        agentId: AGENT_ID,
        agentSlug: after.slug,
        agentName: after.name,
        actorUserId: expect.any(String),
        actorUserName: expect.any(String),
        agentVersion: 5,
        changes: { description: { from: 'old description', to: 'new description' } },
      });
      expect(emitHookEvent).toHaveBeenCalledWith('agent.updated', expectedShape);
      expect(dispatchWebhookEvent).toHaveBeenCalledWith('agent_updated', expectedShape);
    });

    it('agentName reflects the post-update name even when name itself changed', async () => {
      // Rename case: the payload's top-level agentName carries the NEW
      // name, while changes.name carries the from/to transition.
      const before = makeCustomAgent({ name: 'Old Name' });
      const after = { ...before, name: 'New Name' };
      mockFindUnique.mockResolvedValue(before);
      mockUpdate.mockResolvedValue(after);

      await PATCH(makePatchRequest({ name: 'New Name' }), makeParams(AGENT_ID));

      const payload = vi.mocked(dispatchWebhookEvent).mock.calls[0][1] as {
        agentName: string;
        changes: Record<string, { from: unknown; to: unknown }>;
      };
      expect(payload.agentName).toBe('New Name');
      expect(payload.changes.name).toEqual({ from: 'Old Name', to: 'New Name' });
    });

    it('changes contains only fields that actually changed value, with from/to', async () => {
      // The form submits the entire record on save; the route must filter
      // down to fields whose value actually differs between before/after.
      // Object.keys(data) would over-report and ship `name` here even
      // though the submitted value matches what's already stored.
      const before = makeCustomAgent({
        name: 'Same Name',
        description: 'old',
        isActive: true,
        model: 'claude-sonnet-4-6',
      });
      const after = { ...before, description: 'new', isActive: false };
      mockFindUnique.mockResolvedValue(before);
      mockUpdate.mockResolvedValue(after);

      const response = await PATCH(
        // PATCH body includes name (unchanged) plus two real edits.
        makePatchRequest({ name: 'Same Name', description: 'new', isActive: false }),
        makeParams(AGENT_ID)
      );
      expect(response.status).toBe(200);

      const payload = vi.mocked(dispatchWebhookEvent).mock.calls[0][1] as {
        changes: Record<string, { from: unknown; to: unknown }>;
      };
      expect(Object.keys(payload.changes).sort()).toEqual(['description', 'isActive']);
      expect(payload.changes).toEqual({
        description: { from: 'old', to: 'new' },
        isActive: { from: true, to: false },
      });
      // Belt-and-braces: `name` (submitted but unchanged) is not in the diff.
      expect(payload.changes).not.toHaveProperty('name');
    });

    it('truncates from/to values that exceed the per-field length cap', async () => {
      // systemInstructions can run to tens of thousands of characters —
      // sending the full before/after on every edit would blow through a
      // typical webhook receiver's body-size limit.
      const longBefore = 'a'.repeat(2_000);
      const longAfter = 'b'.repeat(2_000);
      const before = makeCustomAgent({ systemInstructions: longBefore });
      const after = { ...before, systemInstructions: longAfter };
      mockFindUnique.mockResolvedValue(before);
      mockUpdate.mockResolvedValue(after);

      await PATCH(makePatchRequest({ systemInstructions: longAfter }), makeParams(AGENT_ID));

      const payload = vi.mocked(dispatchWebhookEvent).mock.calls[0][1] as {
        changes: Record<string, { from: unknown; to: unknown }>;
      };
      const { from, to } = payload.changes.systemInstructions;
      // Both values are capped; the truncation marker proves the truncation
      // happened on purpose (versus the field somehow arriving short).
      expect(from).toMatch(/\[truncated\]$/);
      expect(to).toMatch(/\[truncated\]$/);
      expect(String(from).length).toBeLessThan(longBefore.length);
      expect(String(to).length).toBeLessThan(longAfter.length);
    });

    it('includes actorUserId and actorUserName for the admin who made the change', async () => {
      const before = makeCustomAgent({ description: 'old' });
      const after = { ...before, description: 'new' };
      mockFindUnique.mockResolvedValue(before);
      mockUpdate.mockResolvedValue(after);

      await PATCH(makePatchRequest({ description: 'new' }), makeParams(AGENT_ID));

      // mockAdminUser() returns a session with this fixed CUID + name —
      // any change here means the auth fixture rotated.
      const payload = vi.mocked(dispatchWebhookEvent).mock.calls[0][1] as {
        actorUserId: string;
        actorUserName: string;
      };
      expect(payload.actorUserId).toBe('cmjbv4i3x00003wsloputgwul');
      expect(payload.actorUserName).toBe('Test User');
    });

    it('does not dispatch when the PATCH produced no actual changes', async () => {
      // Form save with no edits — every field matches what's already stored.
      // Subscribers don't want a notification in this case.
      const unchanged = makeCustomAgent({ description: 'same' });
      mockFindUnique.mockResolvedValue(unchanged);
      mockUpdate.mockResolvedValue(unchanged);

      const response = await PATCH(makePatchRequest({ description: 'same' }), makeParams(AGENT_ID));
      expect(response.status).toBe(200);

      // test-review:accept no_arg_called — guards a noise-suppression path; assertion that nothing fires is the contract
      expect(emitHookEvent).not.toHaveBeenCalled();
      expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    });
  });
});
