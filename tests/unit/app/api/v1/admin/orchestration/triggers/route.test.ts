/**
 * Tests: Workflow Inbound Trigger CRUD endpoints.
 *
 * GET  /api/v1/admin/orchestration/triggers
 * POST /api/v1/admin/orchestration/triggers
 * GET    /api/v1/admin/orchestration/triggers/:id
 * PATCH  /api/v1/admin/orchestration/triggers/:id
 * DELETE /api/v1/admin/orchestration/triggers/:id
 *
 * Boundaries:
 *   - signingSecret is plaintext on the DB but MUST be redacted in
 *     responses (replaced with hasSigningSecret: true).
 *   - HMAC triggers require a secret (creation), and the secret cannot
 *     be cleared on update.
 *   - Unknown adapter slugs log a warn but don't reject (the inbound
 *     route 404s anyway until env vars are wired).
 *   - Duplicate (channel, workflowId) collisions surface as a
 *     ValidationError with a helpful message.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowTrigger: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    aiWorkflow: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
  computeChanges: vi.fn(() => ({})),
}));

vi.mock('@/lib/orchestration/inbound/bootstrap', () => ({
  bootstrapInboundAdapters: vi.fn(),
}));

vi.mock('@/lib/orchestration/inbound/registry', () => ({
  listInboundChannels: vi.fn(() => ['hmac', 'slack', 'twilio', 'whatsapp_cloud']),
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { mockAdminUser } from '@/tests/helpers/auth';
import { GET as List, POST as Create } from '@/app/api/v1/admin/orchestration/triggers/route';
import {
  GET as GetOne,
  PATCH as Update,
  DELETE as Remove,
} from '@/app/api/v1/admin/orchestration/triggers/[id]/route';

// Real cuid-shaped id (validates via cuidSchema).
const TRIGGER_ID = 'cmjbv4i3x00003wsloputgwu2';
const WORKFLOW_ID = 'cmjbv4i3x00013wsloputgwu3';

function makeTrigger(overrides: Record<string, unknown> = {}) {
  return {
    id: TRIGGER_ID,
    workflowId: WORKFLOW_ID,
    channel: 'slack',
    name: 'Slack mention trigger',
    metadata: { eventTypes: ['app_mention'] },
    signingSecret: null,
    isEnabled: true,
    lastFiredAt: null,
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    workflow: {
      id: WORKFLOW_ID,
      name: 'Test workflow',
      slug: 'test-workflow',
      isActive: true,
    },
    ...overrides,
  };
}

function makeReq(
  url: string,
  init?: { method?: string; headers?: HeadersInit; body?: string }
): NextRequest {
  return new NextRequest(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
});

// ─── LIST ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/triggers', () => {
  it('returns paginated triggers with enabledChannels in meta', async () => {
    vi.mocked(prisma.aiWorkflowTrigger.findMany).mockResolvedValue([makeTrigger()] as never);
    vi.mocked(prisma.aiWorkflowTrigger.count).mockResolvedValue(1);

    const res = await List(makeReq('http://localhost/api/v1/admin/orchestration/triggers'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(TRIGGER_ID);
    expect(body.meta.enabledChannels).toEqual(['hmac', 'slack', 'twilio', 'whatsapp_cloud']);
  });

  it('redacts the signing secret — exposes hasSigningSecret flag instead', async () => {
    vi.mocked(prisma.aiWorkflowTrigger.findMany).mockResolvedValue([
      makeTrigger({ channel: 'hmac', signingSecret: 'plaintext-secret-must-not-leak' }),
    ] as never);
    vi.mocked(prisma.aiWorkflowTrigger.count).mockResolvedValue(1);

    const res = await List(makeReq('http://localhost/api/v1/admin/orchestration/triggers'));
    const body = await res.json();

    expect(JSON.stringify(body)).not.toContain('plaintext-secret-must-not-leak');
    expect(body.data[0].hasSigningSecret).toBe(true);
    expect(body.data[0].signingSecret).toBeUndefined();
  });

  it('filters by channel when ?channel=... is supplied', async () => {
    vi.mocked(prisma.aiWorkflowTrigger.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.aiWorkflowTrigger.count).mockResolvedValue(0);

    await List(makeReq('http://localhost/api/v1/admin/orchestration/triggers?channel=twilio'));

    expect(prisma.aiWorkflowTrigger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { channel: 'twilio' } })
    );
  });
});

// ─── CREATE ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/triggers', () => {
  it('creates a slack trigger when workflow exists', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: WORKFLOW_ID,
      slug: 'test-workflow',
    } as never);
    vi.mocked(prisma.aiWorkflowTrigger.create).mockResolvedValue(makeTrigger() as never);

    const req = makeReq('http://localhost/api/v1/admin/orchestration/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowId: WORKFLOW_ID,
        channel: 'slack',
        name: 'Slack mention trigger',
        metadata: { eventTypes: ['app_mention'] },
      }),
    });

    const res = await Create(req);
    expect(res.status).toBe(201);
  });

  it('rejects when workflow does not exist with a clean ValidationError', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null as never);

    const req = makeReq('http://localhost/api/v1/admin/orchestration/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowId: WORKFLOW_ID,
        channel: 'slack',
        name: 'X',
      }),
    });
    const res = await Create(req);
    expect(res.status).toBe(400);
  });

  it('rejects HMAC creation without a signingSecret', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: WORKFLOW_ID,
      slug: 'test-workflow',
    } as never);

    const req = makeReq('http://localhost/api/v1/admin/orchestration/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowId: WORKFLOW_ID,
        channel: 'hmac',
        name: 'HMAC integration',
        // no signingSecret
      }),
    });
    const res = await Create(req);
    expect(res.status).toBe(400);
  });

  it('returns a friendly error on duplicate (channel, workflowId) (P2002)', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: WORKFLOW_ID,
      slug: 'test-workflow',
    } as never);
    vi.mocked(prisma.aiWorkflowTrigger.create).mockRejectedValue({ code: 'P2002' } as never);

    const req = makeReq('http://localhost/api/v1/admin/orchestration/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowId: WORKFLOW_ID,
        channel: 'slack',
        name: 'Duplicate',
      }),
    });
    const res = await Create(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/already exists/i);
  });

  it('accepts a Twilio trigger with conversationAgentId metadata', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      id: WORKFLOW_ID,
      slug: 'sms-intake',
    } as never);
    vi.mocked(prisma.aiWorkflowTrigger.create).mockResolvedValue(
      makeTrigger({
        channel: 'twilio',
        metadata: { conversationAgentId: 'agent-1' },
      }) as never
    );

    const req = makeReq('http://localhost/api/v1/admin/orchestration/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowId: WORKFLOW_ID,
        channel: 'twilio',
        name: 'SMS intake',
        metadata: { conversationAgentId: 'agent-1' },
      }),
    });
    const res = await Create(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.channel).toBe('twilio');
  });
});

// ─── GET BY ID ───────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/triggers/:id', () => {
  it('returns the trigger when it exists', async () => {
    vi.mocked(prisma.aiWorkflowTrigger.findUnique).mockResolvedValue(makeTrigger() as never);

    const req = makeReq(`http://localhost/api/v1/admin/orchestration/triggers/${TRIGGER_ID}`);
    const res = await GetOne(req, { params: Promise.resolve({ id: TRIGGER_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(TRIGGER_ID);
  });

  it('returns 404 when missing', async () => {
    vi.mocked(prisma.aiWorkflowTrigger.findUnique).mockResolvedValue(null as never);

    const req = makeReq(`http://localhost/api/v1/admin/orchestration/triggers/${TRIGGER_ID}`);
    const res = await GetOne(req, { params: Promise.resolve({ id: TRIGGER_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid id shape', async () => {
    const req = makeReq('http://localhost/api/v1/admin/orchestration/triggers/not-a-cuid');
    const res = await GetOne(req, { params: Promise.resolve({ id: 'not-a-cuid' }) });
    expect(res.status).toBe(400);
  });
});

// ─── PATCH ───────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/admin/orchestration/triggers/:id', () => {
  it('updates name + isEnabled', async () => {
    vi.mocked(prisma.aiWorkflowTrigger.findUnique).mockResolvedValue(makeTrigger() as never);
    vi.mocked(prisma.aiWorkflowTrigger.update).mockResolvedValue(
      makeTrigger({ name: 'Renamed', isEnabled: false }) as never
    );

    const req = makeReq(`http://localhost/api/v1/admin/orchestration/triggers/${TRIGGER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', isEnabled: false }),
    });
    const res = await Update(req, { params: Promise.resolve({ id: TRIGGER_ID }) });
    expect(res.status).toBe(200);
  });

  it('refuses to clear the signingSecret on an HMAC trigger', async () => {
    vi.mocked(prisma.aiWorkflowTrigger.findUnique).mockResolvedValue(
      makeTrigger({ channel: 'hmac', signingSecret: 'existing' }) as never
    );

    const req = makeReq(`http://localhost/api/v1/admin/orchestration/triggers/${TRIGGER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signingSecret: null }),
    });
    const res = await Update(req, { params: Promise.resolve({ id: TRIGGER_ID }) });
    expect(res.status).toBe(400);
  });

  it('allows rotating the signingSecret on an HMAC trigger', async () => {
    vi.mocked(prisma.aiWorkflowTrigger.findUnique).mockResolvedValue(
      makeTrigger({ channel: 'hmac', signingSecret: 'existing-secret-value' }) as never
    );
    vi.mocked(prisma.aiWorkflowTrigger.update).mockResolvedValue(
      makeTrigger({
        channel: 'hmac',
        signingSecret: 'rotated-secret-replacement-value',
      }) as never
    );

    const req = makeReq(`http://localhost/api/v1/admin/orchestration/triggers/${TRIGGER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signingSecret: 'rotated-secret-replacement-value' }),
    });
    const res = await Update(req, { params: Promise.resolve({ id: TRIGGER_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('rotated-secret-replacement-value');
    expect(body.data.hasSigningSecret).toBe(true);
  });
});

// ─── DELETE ──────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/admin/orchestration/triggers/:id', () => {
  it('deletes the trigger when found', async () => {
    vi.mocked(prisma.aiWorkflowTrigger.findUnique).mockResolvedValue(makeTrigger() as never);
    vi.mocked(prisma.aiWorkflowTrigger.delete).mockResolvedValue(makeTrigger() as never);

    const req = makeReq(`http://localhost/api/v1/admin/orchestration/triggers/${TRIGGER_ID}`, {
      method: 'DELETE',
    });
    const res = await Remove(req, { params: Promise.resolve({ id: TRIGGER_ID }) });
    expect(res.status).toBe(200);
    expect(prisma.aiWorkflowTrigger.delete).toHaveBeenCalledWith({ where: { id: TRIGGER_ID } });
  });

  it('returns 404 when missing', async () => {
    vi.mocked(prisma.aiWorkflowTrigger.findUnique).mockResolvedValue(null as never);

    const req = makeReq(`http://localhost/api/v1/admin/orchestration/triggers/${TRIGGER_ID}`, {
      method: 'DELETE',
    });
    const res = await Remove(req, { params: Promise.resolve({ id: TRIGGER_ID }) });
    expect(res.status).toBe(404);
  });
});
